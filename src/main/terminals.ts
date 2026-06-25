/* ════════════════════════════════════════════════════════════════
   Consomni — terminals.ts
   Manager de TERMINALES EMBEBIDAS (PTYs reales) via node-pty.
   Cada terminal es un proceso real (shell o `claude`) con pseudo-terminal;
   su salida se piopea al renderer (xterm.js) y la entrada del usuario vuelve
   por IPC. Esto es lo único que "maneja procesos" — el board sigue read-only.

   node-pty es nativo y se instala PREBUILT para el ABI de Electron (sin MSVC):
   por eso se carga de forma perezosa y tolerante a fallos (si faltara el .node,
   el resto de la app sigue funcionando y avisamos por toast).
   ════════════════════════════════════════════════════════════════ */
import { BrowserWindow } from 'electron';
import { execFile, execFileSync } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { loadConfig, resolveClaudeDir } from './config';

/** Si hay un perfil de Claude seteado (config dir distinto del default vía setting),
    inyecta CLAUDE_CONFIG_DIR para que cualquier `claude` lanzado adentro use ese perfil.
    Con setting vacío NO toca el env (preserva lo heredado del shell que lanzó Consomni). */
function applyClaudeProfileEnv(env: NodeJS.ProcessEnv): void {
  const cfg = loadConfig();
  if ((cfg.claudeConfigDir || '').trim()) env.CLAUDE_CONFIG_DIR = resolveClaudeDir(cfg);
}

/** Modo "fullscreen" de Claude Code: ancla el input box ABAJO (alt-screen, como vim/htop) en vez del
    render inline por defecto, que en una sesión sin conversación deja el input ARRIBA con filas vacías
    abajo (la diferencia con WezTerm/Ghostty). Es una env var SÓLO-claude, NO toca disco (respeta Hard
    Rule 3) y no afecta a otros procesos del shell. Verificado en PTY real: con esto claude entra a
    alt-screen y fija el input a la última fila. Opt-out con claudeFullscreen:false. Sólo en las
    terminales INTERACTIVAS embebidas (NO en el helper NL `claude -p`, que parsea JSON de stdout). */
// `want` override POR-PANEL (toggle "scroll nativo" en la cabecera del panel claude):
//   true      → fullscreen: CLAUDE_CODE_NO_FLICKER=1 (input anclado abajo, alt-screen, SIN scrollback nativo).
//   false     → clásico: CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 → claude escribe en la main buffer →
//               la terminal SÍ scrollea hacia arriba (historial completo). (Sólo NO setear NO_FLICKER no
//               alcanza si el setting `tui` guardado de claude es fullscreen — por eso seteamos el disable.)
//   undefined → sigue el default global config.claudeFullscreen.
function applyClaudeFullscreenEnv(env: NodeJS.ProcessEnv, want?: boolean): void {
  const on = (want === undefined) ? (loadConfig().claudeFullscreen !== false) : want;
  if (on) {
    env.CLAUDE_CODE_NO_FLICKER = '1';
    // xterm.js (igual que la terminal de VS Code) manda 1 evento de rueda por "notch" → claude scrollea
    // 1 LÍNEA por notch en fullscreen = lentísimo, se siente "no puedo scrollear" (el síntoma de Franco).
    // El multiplicador 3 (default de vim, recomendado por los docs de claude justo para terminales xterm.js)
    // lo hace usable. Respetamos el valor si el user ya lo seteó; afinable en vivo con /scroll-speed.
    if (!env.CLAUDE_CODE_SCROLL_SPEED) env.CLAUDE_CODE_SCROLL_SPEED = '3';
  } else {
    // Clásico: claude escribe en la main buffer → la terminal SÍ scrollea hacia arriba (historial completo).
    env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN = '1';
  }
}

// Tipos mínimos (evita acoplar el build al .d.ts del fork).
interface IPty {
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}
interface PtyModule {
  spawn(file: string, args: string[] | string, opts: {
    name?: string; cols?: number; rows?: number; cwd?: string;
    env?: NodeJS.ProcessEnv;
  }): IPty;
}

type TermKind = 'shell' | 'claude';
interface Term { id: string; proc: IPty; title: string; cwd: string; kind: TermKind; cols: number; rows: number; bootCmd: string | null; }

const terms = new Map<string, Term>();
let seq = 0;
let getWin: () => BrowserWindow | null = () => null;

export function setTerminalWindow(fn: () => BrowserWindow | null): void { getWin = fn; }

function send(channel: string, payload: unknown): void {
  const w = getWin();
  if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
}

/* ── carga perezosa del módulo nativo ── */
let ptyMod: PtyModule | null = null;
let ptyError: string | null = null;
function getPty(): PtyModule | null {
  if (ptyMod) return ptyMod;
  if (ptyError) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ptyMod = require('@homebridge/node-pty-prebuilt-multiarch') as PtyModule;
    return ptyMod;
  } catch (e) {
    ptyError = String((e as Error)?.message || e);
    return null;
  }
}
export function terminalsAvailable(): boolean { return !!getPty(); }

/* ── detección de shell (cacheada) ── */
const whichCache: Record<string, string | null> = {};
function which(bin: string): string | null {
  if (bin in whichCache) return whichCache[bin];
  let res: string | null = null;
  try {
    const out = execFileSync('where', [bin], { encoding: 'utf8', windowsHide: true });
    res = String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || null;
  } catch { res = null; }
  whichCache[bin] = res;
  return res;
}

function resolveShell(): { file: string; args: string[]; label: string } {
  if (which('pwsh.exe')) return { file: 'pwsh.exe', args: ['-NoLogo'], label: 'pwsh' };
  if (which('powershell.exe')) return { file: 'powershell.exe', args: ['-NoLogo'], label: 'powershell' };
  return { file: process.env.COMSPEC || 'cmd.exe', args: [], label: 'cmd' };
}

export interface CreateResult { ok: boolean; id?: string; title?: string; cwd?: string; kind?: TermKind; error?: string; }

export function createTerm(opts: { cwd?: string; kind?: TermKind; cols?: number; rows?: number; resume?: string; skip?: boolean; pick?: boolean; fullscreen?: boolean }): CreateResult {
  const mod = getPty();
  if (!mod) return { ok: false, error: 'node-pty no disponible: ' + (ptyError || 'binario nativo ausente') };

  const cwd = (opts.cwd && fs.existsSync(opts.cwd)) ? opts.cwd : os.homedir();
  const kind: TermKind = opts.kind === 'claude' ? 'claude' : 'shell';
  const cols = Math.max(8, opts.cols || 80);
  const rows = Math.max(2, opts.rows || 24);
  const sh = resolveShell();

  const env: NodeJS.ProcessEnv = { ...process.env, TERM: 'xterm-256color' };
  // El host del agente (Claude CLI) exporta esto y rompería subprocesos de Node.
  delete env.ELECTRON_RUN_AS_NODE;
  // Perfil activo de Claude Code (multi-perfil): cualquier `claude` adentro usa este config dir.
  applyClaudeProfileEnv(env);
  // Input box anclado abajo (fullscreen/alt-screen) vs scroll nativo (clásico). Override por-panel; sin él, el default global.
  applyClaudeFullscreenEnv(env, opts.fullscreen);

  // ¿qué comando tipear cuando el shell muestre el prompt?
  // claude normal, o `claude --resume <id>` para CONTINUAR esa conversación (interactiva).
  let bootCmd: string | null = null;
  let resumed = false;
  if (kind === 'claude') {
    const rid = String(opts.resume || '').replace(/[^A-Za-z0-9_-]/g, '');   // sanitizar (se escribe en el shell)
    // --dangerously-skip-permissions: claude no pide permiso para cada acción (opt-in del usuario).
    const skip = opts.skip ? ' --dangerously-skip-permissions' : '';
    // pick (sin id): `claude --resume` abre el SELECTOR interactivo (flechitas), scopeado al cwd del proyecto.
    bootCmd = (rid ? `claude --resume ${rid}` : (opts.pick ? 'claude --resume' : 'claude')) + skip;
    resumed = !!rid || !!opts.pick;
  }

  let proc: IPty;
  try {
    proc = mod.spawn(sh.file, sh.args, { name: 'xterm-256color', cols, rows, cwd, env });
  } catch (e) {
    return { ok: false, error: 'no pude lanzar ' + sh.label + ': ' + String((e as Error)?.message || e) };
  }

  const id = 't' + (++seq);
  const base = path.basename(cwd) || sh.label;
  const title = kind === 'claude'
    ? (resumed ? 'claude ↻ ' + base : ((opts.skip ? 'claude ⚡ ' : 'claude · ') + base))
    : base + ' · ' + sh.label;
  const t: Term = { id, proc, title, cwd, kind, cols, rows, bootCmd };
  terms.set(id, t);

  proc.onData((data) => {
    // tipear el comando de arranque recién cuando el shell ya muestra prompt (primer chunk)
    if (t.bootCmd) { const cmd = t.bootCmd; t.bootCmd = null; try { proc.write(cmd + '\r'); } catch { /* noop */ } }
    send('term:data', { id, data });
  });
  proc.onExit(({ exitCode }) => { terms.delete(id); send('term:exit', { id, exitCode }); });

  return { ok: true, id, title, cwd, kind };
}

export function writeTerm(id: string, data: string): void {
  const t = terms.get(id);
  if (t) { try { t.proc.write(data); } catch { /* noop */ } }
}

export function resizeTerm(id: string, cols: number, rows: number): void {
  const t = terms.get(id);
  if (t && cols > 0 && rows > 0) { try { t.proc.resize(cols, rows); t.cols = cols; t.rows = rows; } catch { /* noop */ } }
}

export function killTerm(id: string): void {
  const t = terms.get(id);
  if (t) { try { t.proc.kill(); } catch { /* noop */ } terms.delete(id); }
}

export function listTerms(): Array<{ id: string; title: string; cwd: string; kind: TermKind }> {
  return [...terms.values()].map((t) => ({ id: t.id, title: t.title, cwd: t.cwd, kind: t.kind }));
}

export function killAllTerms(): void {
  for (const t of terms.values()) { try { t.proc.kill(); } catch { /* noop */ } }
  terms.clear();
}

/* ════════════════════════════════════════════════════════════════
   Helper "comando por lenguaje natural" (tipo Warp `#`), con el CLI
   LOCAL de claude. NO es API de Anthropic: spawneamos el `claude` del
   usuario (mismo patrón que el dock) en modo print one-shot, forzado a
   TRADUCIR (nunca actuar) y a devolver UNA sola línea de comando.
   El renderer lo INSERTA en la PTY (sin \r) → el usuario revisa y Enter.
   ════════════════════════════════════════════════════════════════ */
export interface NlResult { ok: boolean; command?: string; error?: string; }

const NL_SYS =
  'You are a shell command translator, not an agent. Translate the user request into ONE single ' +
  'Windows PowerShell command line that accomplishes it in the current directory. Output ONLY the ' +
  'command: no explanation, no prose, no markdown, no code fences, no backticks, exactly one line. ' +
  'Never call tools, never read or write files yourself — only emit the command text. If the request ' +
  'is impossible or not a shell task, output exactly: # no-op';

function sanitizeCommand(s: string): string {
  if (!s) return '';
  let t = String(s).replace(/```[a-zA-Z]*\s*/g, '').replace(/```/g, '').trim();
  t = (t.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0]) || '';
  if (!t || /^#\s*no-?op/i.test(t)) return '';
  t = t.replace(/^\$\s+/, '').replace(/^PS\b[^>]*>\s*/i, '').replace(/^`+|`+$/g, '').trim();
  return t.slice(0, 600);
}

let claudeBin: string | null | undefined;
function resolveClaude(): string | null {
  if (claudeBin !== undefined) return claudeBin;
  claudeBin = which('claude') || which('claude.exe') || which('claude.cmd') || null;
  return claudeBin;
}

export function nlToCommand(text: string, cwd?: string): Promise<NlResult> {
  return new Promise((resolve) => {
    const prompt = String(text || '').trim().slice(0, 400);
    if (!prompt) return resolve({ ok: false, error: 'pedido vacío' });
    const claude = resolveClaude();
    if (!claude) return resolve({ ok: false, error: 'claude no está en PATH' });
    const model = loadConfig().nlModel || 'haiku';
    const wd = (cwd && (() => { try { return fs.statSync(cwd).isDirectory(); } catch { return false; } })()) ? cwd : os.homedir();
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;     // rompería al CLI si corre bajo el host del agente
    applyClaudeProfileEnv(env);          // el helper NL traduce con el perfil activo
    const args = [
      '-p', prompt,
      '--model', model,
      '--append-system-prompt', NL_SYS,
      '--disallowedTools', 'Bash,Read,Edit,Write,MultiEdit,Glob,Grep,WebFetch,WebSearch,Task',
      '--output-format', 'json',
    ];
    let done = false;
    const child = execFile(claude, args, { cwd: wd, env, windowsHide: true, timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (done) return; done = true;
        const raw = String(stdout || '').trim();
        if (!raw) return resolve({ ok: false, error: 'claude no respondió: ' + String((stderr || (err && err.message) || '')).slice(0, 100) });
        let result = '';
        try { const j = JSON.parse(raw); result = String(j.result || j.text || j.content || '').trim(); }
        catch { result = raw; }
        const cmd = sanitizeCommand(result);
        if (!cmd) return resolve({ ok: false, error: 'no obtuve un comando' });
        resolve({ ok: true, command: cmd });
      });
    // cerrar stdin: `claude -p` si no, espera ~3s a que llegue algo por stdin
    try { if (child.stdin) child.stdin.end(); } catch { /* noop */ }
  });
}
