/* ════════════════════════════════════════════════════════════════
   Consomni — sessions.ts
   Store de sesiones: escanea los transcripts (read-only), arma Session[],
   vigila el árbol con chokidar y empuja Snapshots al renderer (debounced).
   Los hooks (Fase 3) refinan el estado vivo vía applyHookEvent().
   ════════════════════════════════════════════════════════════════ */
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { execFile, execFileSync } from 'child_process';
import chokidar, { type FSWatcher } from 'chokidar';
import { parseSessionFile, parseSessionDetail, normalizeWorktreeCwd, type SessionDetail } from './jsonl';
import { loadConfig, loadLocalState, claudeProjectsPath, claudeTasksPath, type AppConfig } from './config';
import type { Session, Snapshot, SessionState, SessionMode, SubagentInfo, PlanDoc, PlanTodo, TodoStatus } from './types';

/** Raíces a vigilar: el projects del perfil ACTIVO + los dirs extra de watchedDirs (dedupe).
    Garantiza vigilar el perfil aunque venga solo del env (sin haber repointado watchedDirs). */
function watchRoots(cfg: AppConfig): string[] {
  const roots = [claudeProjectsPath(cfg), ...(Array.isArray(cfg.watchedDirs) ? cfg.watchedDirs : [])];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of roots) {
    const k = path.resolve(String(r || ''));
    if (k && !seen.has(k)) { seen.add(k); out.push(r); }
  }
  return out;
}

let watcher: FSWatcher | null = null;
let onUpdateCb: ((s: Snapshot) => void) | null = null;
let debounceTimer: NodeJS.Timeout | null = null;
let diffTimer: NodeJS.Timeout | null = null;
let hooksConnected = false;

/* ════════ diff stat (+N/−N) por proyecto, estilo Warp ════════
   git diff --shortstat HEAD por cwd ACTIVO, cacheado y throttled (async, nunca bloquea el snapshot).
   key = cwd normalizado IGUAL que projKey del renderer (lowercase + forward-slash) para que matcheen.
   Para MATCHEAR el número de Warp/VS Code sumamos también las líneas de archivos NUEVOS sin trackear
   (git diff --shortstat HEAD NO los cuenta) — lectura read-only, ASÍNCRONA (no bloquea el main) y ACOTADA. */
interface DiffStat { added: number; removed: number; files: number; ts: number; }
const diffCache = new Map<string, DiffStat>();
const DIFF_RECOMPUTE_MS = 3000;
// conteo de untracked ACOTADO (el footgun es un dir generado grande no-ignorado): topes de archivos + tamaño/archivo
const UNTRACKED_MAX_FILES = 200;
const UNTRACKED_MAX_BYTES = 256 * 1024;
let diffLastDriver = 0;
let gitBin: string | null | undefined;
function getGit(): string | null {
  if (gitBin !== undefined) return gitBin;
  try { gitBin = String(execFileSync('where', ['git'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/)[0] || '').trim() || 'git'; }
  catch { gitBin = null; }
  return gitBin;
}
function diffKey(cwd: string): string { return String(cwd || '').toLowerCase().replace(/\\/g, '/').replace(/\/+$/, ''); }
function computeDiffStat(cwd: string): void {
  const git = getGit();
  const key = diffKey(cwd);
  if (!git) { diffCache.set(key, { added: 0, removed: 0, files: 0, ts: Date.now() }); return; }
  // --no-optional-locks: el poller de fondo no refresca/escribe el index → no compite con el git del usuario
  execFile(git, ['--no-optional-locks', '-C', cwd, 'diff', '--shortstat', 'HEAD'], { timeout: 5000, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => {
    let added = 0, removed = 0, files = 0;
    if (!err) {
      const out = String(stdout || '');
      const f = out.match(/(\d+)\s+files?\s+changed/); if (f) files = +f[1];
      const a = out.match(/(\d+)\s+insertions?\(\+\)/); if (a) added = +a[1];
      const d = out.match(/(\d+)\s+deletions?\(-\)/); if (d) removed = +d[1];
    }
    // sumar los archivos NUEVOS sin trackear (para matchear lo que muestra Warp) y recién ahí cachear
    countUntrackedAdds(git, cwd, (uFiles, uAdded) => {
      const tAdded = added + uAdded, tFiles = files + uFiles;
      const prev = diffCache.get(key);
      diffCache.set(key, { added: tAdded, removed, files: tFiles, ts: Date.now() });
      // si cambió respecto a lo cacheado, empujamos un snapshot fresco (eventual-consistente)
      if (!prev || prev.added !== tAdded || prev.removed !== removed || prev.files !== tFiles) scheduleUpdate();
    });
  });
}
/** Cuenta archivos nuevos sin trackear + sus líneas (= additions, como un diff de archivo nuevo).
    ASÍNCRONO (fs.stat/fs.readFile → NO bloquea el event loop del main, ni con muchos archivos) y
    DETERMINÍSTICO: procesa SIEMPRE el mismo set (orden estable de git status, capado por CANTIDAD) → el
    número no parpadea entre recálculos (un break por presupuesto de tiempo daba sumas parciales distintas). */
interface UntrackedEntry { size: number; mtimeMs: number; lines: number; }
// cache de líneas por archivo untracked (key = diffKey(cwd)): sólo se RE-LEE el contenido de un
// archivo si cambió su size/mtime. Antes se leían hasta 200 archivos (≤256KB c/u ≈ 50MB) ENTEROS
// en cada recálculo (~3-4s) — el mayor consumo de disco/CPU en reposo de toda la app.
const untrackedCache = new Map<string, Map<string, UntrackedEntry>>();
function countUntrackedAdds(git: string, cwd: string, cb: (files: number, added: number) => void): void {
  // core.quotepath=false: si no, git C-quotea rutas con espacios/no-ASCII y no resuelven. --untracked-files=all
  // respeta .gitignore (node_modules suele quedar afuera); el tope de archivos es el backstop por las dudas.
  execFile(git, ['--no-optional-locks', '-C', cwd, '-c', 'core.quotepath=false', 'status', '--porcelain', '--untracked-files=all'],
    { timeout: 5000, windowsHide: true, maxBuffer: 4 << 20 }, (err, stdout) => {
    if (err) { cb(0, 0); return; }
    const paths: string[] = [];
    for (const ln of String(stdout || '').split(/\r?\n/)) {
      if (ln.slice(0, 2) !== '??') continue;             // sólo archivos sin trackear
      let p = ln.slice(3).trim();
      if (p.startsWith('"') && p.endsWith('"')) { try { p = JSON.parse(p) as string; } catch { /* dejar como vino */ } }
      if (p) paths.push(p);
      if (paths.length >= UNTRACKED_MAX_FILES) break;    // cap por CANTIDAD (set fijo → determinístico)
    }
    const key = diffKey(cwd);
    if (!paths.length) { untrackedCache.delete(key); cb(0, 0); return; }
    const prev = untrackedCache.get(key);
    const next = new Map<string, UntrackedEntry>();      // map fresco → GC implícito de archivos que ya no están
    let files = 0, added = 0, pending = paths.length;
    const done = (): void => { if (--pending === 0) { untrackedCache.set(key, next); cb(files, added); } };
    for (const rel of paths) {
      const abs = path.join(cwd, rel);
      fs.stat(abs, (e, st) => {
        if (e || !st.isFile()) { done(); return; }
        files++;
        if (st.size > UNTRACKED_MAX_BYTES) { done(); return; }   // grande → contamos el archivo, no las líneas
        const hit = prev && prev.get(rel);
        if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) {   // sin cambios → líneas cacheadas, cero I/O
          added += hit.lines; next.set(rel, hit); done(); return;
        }
        fs.readFile(abs, (e2, buf) => {
          let lines = 0;
          if (!e2 && buf && !buf.subarray(0, 8192).includes(0)) {   // saltar binarios (NUL en el head)
            const txt = buf.toString('utf8');
            if (txt.length) lines = txt.split('\n').length - (txt.endsWith('\n') ? 1 : 0);   // líneas del archivo nuevo
          }
          added += lines;
          next.set(rel, { size: st.size, mtimeMs: st.mtimeMs, lines });
          done();
        });
      });
    }
  });
}
/** Dispara el recálculo (fire-and-forget) de los cwds ACTIVOS únicos que estén vencidos. Throttled. */
function refreshDiffStats(sessions: Session[]): void {
  const now = Date.now();
  if (now - diffLastDriver < DIFF_RECOMPUTE_MS) return;
  diffLastDriver = now;
  const seen = new Set<string>();
  for (const s of sessions) {
    if (s.state === 'closed' || !s.cwd) continue;
    const key = diffKey(s.cwd);
    if (seen.has(key)) continue;
    seen.add(key);
    const c = diffCache.get(key);
    if (!c || now - c.ts > DIFF_RECOMPUTE_MS) computeDiffStat(s.cwd);
  }
}

/* ════════ overlay de estado vivo (eventos de hooks, autoritativo) ════════ */
interface LiveState {
  state: SessionState;
  statusText?: string;
  statusEm?: string;
  attnReason?: string;
  cwd?: string;
  name?: string;
  mode?: SessionMode;
  model?: string;
  ts: number;
}
const overlay = new Map<string, LiveState>();
const OVERLAY_TTL = 10 * 60 * 1000;

/** Callback al transicionar una sesión a 'attn' (lo usa index para la notificación nativa). */
export interface AttnInfo { sid: string; name: string; reason?: string; }
let attnCb: ((info: AttnInfo) => void) | null = null;
export function setAttnCallback(cb: (info: AttnInfo) => void): void { attnCb = cb; }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function hookFirstArg(input: any): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  return input.command || input.file_path || input.pattern || input.path || input.description;
}
function shortEm(tool: string, arg?: string): string {
  let a = arg || '';
  if (a.indexOf('/') > -1 || a.indexOf('\\') > -1) a = path.basename(a);
  a = a.replace(/\s+/g, ' ').trim();
  if (a.length > 22) a = a.slice(0, 22) + '…';
  return tool + (a ? ' ' + a : '');
}
function shortName(prompt: string): string {
  const t = String(prompt).split(/\r?\n/).find((l) => l.trim()) || String(prompt);
  const c = t.replace(/^[#>\s*-]+/, '').trim();
  return c.length > 58 ? c.slice(0, 58) + '…' : (c || 'sesión');
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function classifyNotification(p: any): 'attn' | 'idle' {
  const nt = String(p.notification_type || p.type || '').toLowerCase();
  const msg = String(p.message || p.body || p.title || '').toLowerCase();
  // SÓLO es "atención" un pedido de PERMISO real (lo único accionable desde Consomni).
  // Cualquier otra notificación (idle, "waiting for input", LOGIN/auth, avisos varios) → idle, NO atención.
  // (Antes el default era 'attn' → CUALQUIER notificación —p.ej. la del login— prendía el cartel
  //  "necesita tu atención" y NO se limpiaba, porque después no llegaba ningún Stop/PromptSubmit. Bug v1.6.2.)
  if (nt.indexOf('perm') > -1) return 'attn';
  if (/\bpermission\b|\bpermiso\b|needs? (your )?(permission|approval)|approve this|allow this|to use the .*? tool/.test(msg)) return 'attn';
  return 'idle';
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function permDetail(p: any): string {
  if (p.permission_detail) return String(p.permission_detail);
  if (p.permission_tool_name) return String(p.permission_tool_name);
  if (p.tool_name) return String(p.tool_name) + (p.tool_input && p.tool_input.command ? '(' + String(p.tool_input.command).slice(0, 24) + ')' : '');
  if (p.message) return String(p.message).slice(0, 48);
  return 'permiso';
}

/** Aplica un evento de hook → actualiza el overlay vivo + empuja snapshot. */
export function applyHookEvent(event: string, payload: Record<string, unknown>): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = payload as any;
  hooksConnected = true;
  const sid = String(p.session_id || p.sessionId || '');
  if (!sid) { scheduleUpdate(); return; }
  const prev = overlay.get(sid) || { state: 'working' as SessionState, ts: 0 };
  const live: LiveState = { ...prev, ts: Date.now() };
  if (p.cwd) live.cwd = String(p.cwd);
  if (p.model) live.model = String(p.model);

  switch (event) {
    case 'SessionStart':
      live.state = 'working'; live.statusText = 'sesión iniciada'; live.attnReason = undefined;
      if (p.session_title) live.name = String(p.session_title);
      break;
    case 'UserPromptSubmit':
      live.state = 'working'; live.statusText = 'trabajando…'; live.attnReason = undefined;
      if (p.prompt && !live.name) live.name = shortName(String(p.prompt));
      break;
    case 'PreToolUse': {
      live.state = 'working';
      const t = String(p.tool_name || '');
      const a = hookFirstArg(p.tool_input);
      live.statusText = 'trabajando…';
      live.statusEm = t ? shortEm(t, a) : undefined;
      break;
    }
    case 'PostToolUse':
      live.state = 'working'; live.statusText = 'trabajando…';
      break;
    case 'Notification':
      if (classifyNotification(p) === 'idle') {
        live.state = 'idle'; live.statusText = 'idle'; live.attnReason = undefined; live.statusEm = undefined;
      } else {
        live.state = 'attn'; const d = permDetail(p);
        live.attnReason = d; live.statusText = 'esperando permiso ·'; live.statusEm = d;
      }
      break;
    case 'Stop':
      live.state = 'idle'; live.statusText = 'idle'; live.attnReason = undefined; live.statusEm = undefined;
      break;
    case 'SessionEnd':
      live.state = 'closed'; live.statusText = 'cerrada'; live.attnReason = undefined;
      break;
    case 'SubagentStop':
    default:
      break;
  }
  overlay.set(sid, live);
  if (live.state === 'attn' && prev.state !== 'attn' && attnCb) {
    attnCb({ sid: sid, name: live.name || (live.cwd ? path.basename(live.cwd) : sid), reason: live.attnReason });
  }
  scheduleUpdate();
}

function syntheticSession(sid: string, live: LiveState): Session {
  const cwd = live.cwd || '';                          // crudo (acciones van al worktree real)
  const projRoot = normalizeWorktreeCwd(cwd);          // agrupación → repo padre (igual que el parser JSONL)
  const proj = projRoot ? (path.basename(projRoot) || projRoot) : 'sesión';
  return {
    id: sid,
    name: live.name || proj,
    project: proj,
    projectPath: projRoot || sid,
    cwd,
    branch: '',
    mode: live.mode || 'ask',
    model: live.model || '',
    windowSize: 200000,
    tokensIn: 0, tokensOut: 0, tokensTotal: 0, cache: 0, ctxPct: 0,
    state: live.state,
    statusText: live.statusText || '',
    statusEm: live.statusEm,
    attnReason: live.attnReason,
    lastActivity: live.ts,
    stateSource: 'hook',
  };
}

function mergeOverlay(sessions: Session[]): Session[] {
  if (overlay.size === 0) return sessions;
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const now = Date.now();
  overlay.forEach((live, sid) => {
    if (now - live.ts > OVERLAY_TTL && live.state !== 'closed') { overlay.delete(sid); return; }
    const s = byId.get(sid);
    if (s) {
      // self-heal: si la sesión siguió ACTIVA en el transcript DESPUÉS de la notificación de atención,
      // ese "atención" quedó stale (ya respondió / siguió trabajando) → lo descartamos y mandamos el
      // estado real del JSONL. Evita que el cartel se quede pegado si no llegó un Stop/PromptSubmit.
      if (live.state === 'attn' && s.lastActivity && s.lastActivity > live.ts + 2000) {
        overlay.delete(sid);
        return;
      }
      s.state = live.state;
      s.stateSource = 'hook';
      if (live.statusText != null) s.statusText = live.statusText;
      s.statusEm = live.statusEm;
      s.attnReason = live.attnReason;
    } else {
      sessions.push(syntheticSession(sid, live));
    }
  });
  return sessions;
}

/** Lista los transcripts top-level (projects/<proj>/<id>.jsonl), sin subagents. */
function listSessionFiles(): string[] {
  const cfg = loadConfig();
  // cache TTL: buildSnapshot corre hasta ~1×/s y este listado hacía readdirSync de TODOS los
  // roots + subdirs en cada pasada (I/O de metadata repetido con 100+ proyectos). Un archivo
  // NUEVO llega vía chokidar 'add' → invalida el cache al instante (ver startWatcher).
  const now = Date.now();
  if (fileListCache && now - fileListCache.ts < FILE_LIST_TTL_MS) return fileListCache.files;
  const files: string[] = [];
  for (const root of watchRoots(cfg)) {
    let projDirs: string[] = [];
    try {
      projDirs = fs.readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => path.join(root, d.name));
    } catch { continue; }
    for (const pd of projDirs) {
      let entries: fs.Dirent[] = [];
      try { entries = fs.readdirSync(pd, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (e.isFile() && e.name.toLowerCase().endsWith('.jsonl')) files.push(path.join(pd, e.name));
      }
    }
  }
  fileListCache = { files, ts: now };
  return files;
}
let fileListCache: { files: string[]; ts: number } | null = null;
const FILE_LIST_TTL_MS = 5000;

/* ════════ cache de scan (evita re-parsear transcripts sin cambios) ════════
   buildSnapshot se dispara hasta ~4×/seg (chokidar + hooks + diffTimer); sin cache, cada disparo
   re-leía + JSON.parse de los 100+ .jsonl ENTEROS en el event loop del main = causa #1 del lag.
   Reusamos el Session parseado si el archivo no cambió (mtime+size) NI cambió su estado local
   (pin/fav/archivar). Devolvemos SIEMPRE un shallow-clone porque mergeOverlay muta los campos
   top-level (state/statusText/…) in place → el original cacheado tiene que quedar prístino. */
interface ScanCacheEntry { mtimeMs: number; size: number; localSig: string; session: Session; }
const scanCache = new Map<string, ScanCacheEntry>();

/* ════════ store de tareas en disco (<config-dir>/tasks/<sessionId>/<id>.json) ════════
   Claude Code persiste ahí el estado ACTUAL de sus Task tools:
   { id, subject, description, status, blocks, blockedBy }. Es la fuente PRIMARIA de
   tareas: siempre al día y no sufre el límite del tail del transcript (collectPlan
   pierde los TaskCreate en .jsonl de varios MB). El collectPlan del jsonl queda de
   fallback (TodoWrite / versiones de claude sin store). Se lee sólo en el branch
   NO-cacheado de scan(): cada TaskUpdate también escribe al transcript → su mtime
   cambia → el cache se invalida → acá se relee fresco. */
const TASK_STATUSES = new Set<TodoStatus>(['pending', 'in_progress', 'completed']);
function readTaskStore(root: string, sessionId: string): { todos: PlanTodo[]; at: number } | null {
  const dir = path.join(root, sessionId);
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  const items: { id: number; todo: PlanTodo; mtime: number }[] = [];
  for (const e of entries) {
    if (!e.isFile() || !/\.json$/i.test(e.name)) continue;
    try {
      const full = path.join(dir, e.name);
      const raw = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (!raw || typeof raw !== 'object') continue;
      const status = String(raw.status || '');
      if (!TASK_STATUSES.has(status as TodoStatus)) continue; // cancelled/deleted/etc → fuera
      const content = String(raw.subject || raw.description || '').trim();
      if (!content) continue;
      const todo: PlanTodo = { content: content.slice(0, 200), status: status as TodoStatus };
      if (raw.activeForm) todo.activeForm = String(raw.activeForm).slice(0, 200);
      let mtime = 0;
      try { mtime = fs.statSync(full).mtimeMs; } catch { /* noop */ }
      items.push({ id: Number(raw.id ?? e.name.replace(/\.json$/i, '')) || 0, todo, mtime });
    } catch { /* json corrupto / a medio escribir: saltar */ }
  }
  if (!items.length) return null;
  items.sort((a, b) => a.id - b.id);
  return { todos: items.slice(0, 60).map((x) => x.todo), at: Math.max(...items.map((x) => x.mtime)) };
}

/** Pisa las tareas del plan (reconstruidas del jsonl) con el store en disco si existe.
    Preserva hasPlan/planAt (ExitPlanMode sólo vive en el transcript). Muta s in place. */
function applyTaskStore(s: Session, tasksRoot: string): void {
  const store = readTaskStore(tasksRoot, s.id);
  if (!store) return;
  let pending = 0, inProgress = 0, completed = 0;
  for (const t of store.todos) {
    if (t.status === 'completed') completed++;
    else if (t.status === 'in_progress') inProgress++;
    else pending++;
  }
  const prev = s.plan;
  s.plan = {
    hasPlan: prev?.hasPlan ?? false,
    planAt: prev?.planAt,
    todos: store.todos,
    pending, inProgress, completed,
    todoAt: Math.max(store.at, prev?.todoAt || 0) || undefined,
  };
}

export function scan(): Session[] {
  const local = loadLocalState();
  const tasksRoot = claudeTasksPath();
  const sessions: Session[] = [];
  const seen = new Set<string>();
  for (const f of listSessionFiles()) {
    seen.add(f);
    const id = path.basename(f).replace(/\.jsonl$/i, '');
    let st: fs.Stats;
    try { st = fs.statSync(f); } catch { continue; }  // archivo desaparecido entre listar y statear
    const localSig = JSON.stringify(local[id] ?? null);
    const cached = scanCache.get(f);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size && cached.localSig === localSig) {
      sessions.push({ ...cached.session });  // clone: protege el cacheado de la mutación de mergeOverlay
      continue;
    }
    try {
      const s = parseSessionFile(f, local[id]);
      if (s) {
        applyTaskStore(s, tasksRoot);  // store en disco gana sobre lo pescado del tail del jsonl
        scanCache.set(f, { mtimeMs: st.mtimeMs, size: st.size, localSig, session: s });
        sessions.push({ ...s });
      }
    } catch { /* archivo en escritura / corrupto: saltar este ciclo */ }
  }
  // GC: soltar entradas de transcripts borrados (no dejar crecer el cache sin límite)
  if (scanCache.size > seen.size) { for (const k of scanCache.keys()) if (!seen.has(k)) scanCache.delete(k); }
  return sessions;
}

function isToday(ms: number): boolean {
  const d = new Date(ms);
  const n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

/** cwds del último snapshot construido — para que los handlers IPC (readFile/listFiles) NO tengan
    que re-escanear TODO sólo para sacar la allowlist de cwds (causa #2 del lag: el visor pollea
    readFile cada 1s, el picker @ dispara listFiles mientras tipeás → cada uno era un scan completo). */
let lastCwds: string[] = [];
let lastSessions: Session[] = [];
export function knownCwds(): string[] { return lastCwds; }

export function buildSnapshot(): Snapshot {
  const sessions = mergeOverlay(scan());
  lastCwds = sessions.map((s) => s.cwd).filter(Boolean);
  lastSessions = sessions;
  let tokensToday = 0;
  for (const s of sessions) if (isToday(s.lastActivity)) tokensToday += s.tokensTotal;
  const cfg = loadConfig();
  refreshDiffStats(sessions);   // fire-and-forget; NO bloquea (los resultados llegan en el próximo push)
  const diffStats: Record<string, { added: number; removed: number; files: number }> = {};
  diffCache.forEach((v, k) => { if (v.added || v.removed) diffStats[k] = { added: v.added, removed: v.removed, files: v.files }; });
  return {
    sessions,
    hooksConnected,
    tokensToday,
    generatedAt: Date.now(),
    watchedRoots: watchRoots(cfg),
    appVersion: app.getVersion(),
    diffStats,
  };
}

/* ── modo eco: el trabajo de MONITOREO se pausa cuando nadie mira ──
   Los timers del main NO los throttlea Chromium (es Node) → con la ventana oculta/minimizada
   seguían corriendo parses + git + pushes. Ahora: oculta → se marca dirty y no se hace nada;
   al volver a verse → UN push fresco. Las PTYs/hooks/notificaciones nativas NO pasan por acá
   (attn va por setAttnCallback) → nada de lo que las terminales ejecutan se ve afectado. */
let uiVisible = true;
let uiDirty = false;
let onBattery = false;
export function setUiVisible(v: boolean): void {
  if (uiVisible === v) return;
  uiVisible = v;
  if (v && uiDirty) { uiDirty = false; scheduleUpdate(); }
}
export function setOnBattery(v: boolean): void { onBattery = v; }

let lastBuildTs = 0;
const MIN_BUILD_GAP_MS = 1000;   // máx 1 rebuild/push por segundo (antes hasta 4/s con claude activo)

function pushUpdate(): void {
  lastBuildTs = Date.now();
  if (onUpdateCb) onUpdateCb(buildSnapshot());
}

function scheduleUpdate(): void {
  if (!uiVisible) { uiDirty = true; return; }   // nadie mira → ni parse ni push (refresh al volver)
  if (debounceTimer) clearTimeout(debounceTimer);
  // debounce 250ms + piso de 1s entre rebuilds: el primer evento tras quietud sigue siendo ágil,
  // la escritura CONTINUA del transcript activo ya no re-parsea/re-renderiza 4×/s
  const wait = Math.max(250, MIN_BUILD_GAP_MS - (Date.now() - lastBuildTs));
  debounceTimer = setTimeout(pushUpdate, wait);
}

export function setHooksConnected(v: boolean): void {
  if (hooksConnected !== v) {
    hooksConnected = v;
    scheduleUpdate();
  }
}

function onFs(p: string): void { if (p.toLowerCase().endsWith('.jsonl')) scheduleUpdate(); }
function onFsList(p: string): void { fileListCache = null; onFs(p); }   // add/unlink: invalidar el listado cacheado

function startWatcher(): void {
  const cfg = loadConfig();
  fileListCache = null;
  watcher = chokidar.watch(watchRoots(cfg), {
    ignoreInitial: true,
    depth: 2,
    ignored: /(^|[/\\])subagents([/\\]|$)/,
  });
  watcher.on('add', onFsList).on('change', onFs).on('unlink', onFsList);
}

export function start(onUpdate: (s: Snapshot) => void): void {
  onUpdateCb = onUpdate;
  pushUpdate();   // snapshot inicial inmediato
  startWatcher();
  // refresh periódico del diff (las ediciones de git NO tocan los .jsonl → el watcher solo no alcanza).
  // ANTES: setInterval(scheduleUpdate, 4000) → forzaba un buildSnapshot + push COMPLETO cada 4s aunque
  // todo estuviera idle (causa #3 del lag: el renderer reconstruía el board entero sin que nada cambiara).
  // AHORA: sólo recalcula git diff de los cwds activos; computeDiffStat ya hace scheduleUpdate() SÓLO si
  // un valor cambió → cero push cuando no hay cambios reales (git ni jsonl).
  if (diffTimer) clearInterval(diffTimer);
  // modo eco: con la ventana oculta no se recalcula git (nadie ve el badge); con batería,
  // 1 de cada 8 ticks (~32s) para no quemar spawns de git + Defender todo el día.
  let diffTick = 0;
  diffTimer = setInterval(() => {
    if (!uiVisible) return;
    if (onBattery && (diffTick++ % 8) !== 0) return;
    refreshDiffStats(lastSessions);
  }, 4000);
}

/** Reinicia el watcher (p.ej. tras cambiar watchedDirs en settings). */
export function restartWatcher(): void {
  if (watcher) { void watcher.close(); watcher = null; }
  startWatcher();
  pushUpdate();
}

export function stop(): void {
  if (watcher) { void watcher.close(); watcher = null; }
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  if (diffTimer) { clearInterval(diffTimer); diffTimer = null; }
}

/** Forzar rescan inmediato (lo usa el refresh manual / settings). */
export function rescanNow(): Snapshot {
  const snap = buildSnapshot();
  if (onUpdateCb) onUpdateCb(snap);
  return snap;
}

/* ════════ detalle de una sesión (panel E2) ════════ */
export function findSessionFile(id: string): string | null {
  // reusa el listado cacheado (TTL 5s) en vez de re-caminar todos los roots con readdirSync
  const want = (id + '.jsonl').toLowerCase();
  for (const f of listSessionFiles()) {
    if (path.basename(f).toLowerCase() === want) return f;
  }
  return null;
}

function readSubagents(sessionFile: string, id: string): SubagentInfo[] {
  const dir = path.join(path.dirname(sessionFile), id, 'subagents');
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.meta.json'))
      .map((f): SubagentInfo | null => {
        try {
          const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          let state: SessionState = 'idle';
          try {
            const jl = path.join(dir, f.replace('.meta.json', '.jsonl'));
            const age = Date.now() - fs.statSync(jl).mtimeMs;
            state = age < 90_000 ? 'working' : 'idle';
          } catch { /* sin jsonl */ }
          return { name: String(m.description || m.agentType || 'subagente'), agentType: m.agentType, state };
        } catch { return null; }
      })
      .filter((x): x is SubagentInfo => !!x)
      .slice(0, 12);
  } catch { return []; }
}

/* ════════ docs de plan/spec en el repo (markdown, read-only) ════════
   Los planes/specs que Claude escribe a disco (plan.md, .specs/…, docs/plans/…)
   NO están en el transcript. Los descubrimos glob-eando el cwd: por nombre
   (plan|spec|design|roadmap|rfc|prd) o por carpeta convencional. Sólo lectura. */
const PLAN_NAME_RE = /(?:^|[-_. ])(plan|spec|design|architecture|roadmap|rfc|prd)s?(?:[-_. ]|\.md$)/i;
const PLAN_DIR_RE = /[\\/](\.?specs?|plans?|rfcs?|designs?|proposals?)[\\/]/i;
const PLAN_SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'release', '.next', 'out', 'vendor', 'coverage', '.cache', 'target', '.venv', '__pycache__']);

export function findPlanDocs(cwd: string): PlanDoc[] {
  if (!cwd) return [];
  try { if (!fs.statSync(cwd).isDirectory()) return []; } catch { return []; }
  const out: PlanDoc[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 5 || out.length >= 60) return;  // prof 5: cubre docs anidados (ej syl/docs/superpowers/plans/x.md)
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= 60) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!e.name.startsWith('.git') && !PLAN_SKIP.has(e.name.toLowerCase())) walk(full, depth + 1);
      } else if (e.isFile() && /\.md$/i.test(e.name) && (PLAN_NAME_RE.test(e.name) || PLAN_DIR_RE.test(full))) {
        let mtime = 0;
        try { mtime = fs.statSync(full).mtimeMs; } catch { /* noop */ }
        out.push({ path: full, name: e.name, mtime });
      }
    }
  };
  walk(cwd, 0);
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, 24);
}

export interface FullDetail extends SessionDetail { subagents: SubagentInfo[]; }

export function getDetail(id: string): FullDetail {
  const file = findSessionFile(id);
  const base = file ? parseSessionDetail(file) : { feed: [], files: [], counts: { edits: 0, bash: 0, reads: 0 }, convo: [] };
  const subagents = file ? readSubagents(file, id) : [];
  return { ...base, subagents };
}
