/* ════════════════════════════════════════════════════════════════
   Consomni — sessions.ts
   Store de sesiones: escanea los transcripts (read-only), arma Session[],
   vigila el árbol con chokidar y empuja Snapshots al renderer (debounced).
   Los hooks (Fase 3) refinan el estado vivo vía applyHookEvent().
   ════════════════════════════════════════════════════════════════ */
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import chokidar, { type FSWatcher } from 'chokidar';
import { parseSessionFile, parseSessionDetail, type SessionDetail } from './jsonl';
import { loadConfig, loadLocalState } from './config';
import type { Session, Snapshot, SessionState, SessionMode, SubagentInfo } from './types';

let watcher: FSWatcher | null = null;
let onUpdateCb: ((s: Snapshot) => void) | null = null;
let debounceTimer: NodeJS.Timeout | null = null;
let hooksConnected = false;

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
  const msg = String(p.message || p.body || '').toLowerCase();
  if (nt.indexOf('idle') > -1 || /waiting for (your )?input|idle/.test(msg)) return 'idle';
  return 'attn'; // por defecto: permiso (ajustable cuando confirmemos el payload real)
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
  const cwd = live.cwd || '';
  const proj = cwd ? path.basename(cwd) : 'sesión';
  return {
    id: sid,
    name: live.name || proj,
    project: proj,
    projectPath: cwd || sid,
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
  const files: string[] = [];
  for (const root of cfg.watchedDirs) {
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
  return files;
}

export function scan(): Session[] {
  const local = loadLocalState();
  const sessions: Session[] = [];
  for (const f of listSessionFiles()) {
    const id = path.basename(f).replace(/\.jsonl$/i, '');
    try {
      const s = parseSessionFile(f, local[id]);
      if (s) sessions.push(s);
    } catch { /* archivo en escritura / corrupto: saltar este ciclo */ }
  }
  return sessions;
}

function isToday(ms: number): boolean {
  const d = new Date(ms);
  const n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

export function buildSnapshot(): Snapshot {
  const sessions = mergeOverlay(scan());
  let tokensToday = 0;
  for (const s of sessions) if (isToday(s.lastActivity)) tokensToday += s.tokensTotal;
  const cfg = loadConfig();
  return {
    sessions,
    hooksConnected,
    tokensToday,
    generatedAt: Date.now(),
    watchedRoots: cfg.watchedDirs,
    appVersion: app.getVersion(),
  };
}

function pushUpdate(): void {
  if (onUpdateCb) onUpdateCb(buildSnapshot());
}

function scheduleUpdate(): void {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(pushUpdate, 250); // ≤ 1 update / 250ms
}

export function setHooksConnected(v: boolean): void {
  if (hooksConnected !== v) {
    hooksConnected = v;
    scheduleUpdate();
  }
}

function onFs(p: string): void { if (p.toLowerCase().endsWith('.jsonl')) scheduleUpdate(); }

function startWatcher(): void {
  const cfg = loadConfig();
  watcher = chokidar.watch(cfg.watchedDirs, {
    ignoreInitial: true,
    depth: 2,
    ignored: /(^|[/\\])subagents([/\\]|$)/,
  });
  watcher.on('add', onFs).on('change', onFs).on('unlink', onFs);
}

export function start(onUpdate: (s: Snapshot) => void): void {
  onUpdateCb = onUpdate;
  pushUpdate();   // snapshot inicial inmediato
  startWatcher();
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
}

/** Forzar rescan inmediato (lo usa el refresh manual / settings). */
export function rescanNow(): Snapshot {
  const snap = buildSnapshot();
  if (onUpdateCb) onUpdateCb(snap);
  return snap;
}

/* ════════ detalle de una sesión (panel E2) ════════ */
export function findSessionFile(id: string): string | null {
  const cfg = loadConfig();
  for (const root of cfg.watchedDirs) {
    let dirs: string[] = [];
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(root, d.name));
    } catch { continue; }
    for (const d of dirs) {
      const f = path.join(d, id + '.jsonl');
      if (fs.existsSync(f)) return f;
    }
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

export interface FullDetail extends SessionDetail { subagents: SubagentInfo[]; }

export function getDetail(id: string): FullDetail {
  const file = findSessionFile(id);
  const base = file ? parseSessionDetail(file) : { feed: [], files: [], counts: { edits: 0, bash: 0, reads: 0 } };
  const subagents = file ? readSubagents(file, id) : [];
  return { ...base, subagents };
}
