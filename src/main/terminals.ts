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
import { execFileSync } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

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

export function createTerm(opts: { cwd?: string; kind?: TermKind; cols?: number; rows?: number; resume?: string }): CreateResult {
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

  // ¿qué comando tipear cuando el shell muestre el prompt?
  // claude normal, o `claude --resume <id>` para CONTINUAR esa conversación (interactiva).
  let bootCmd: string | null = null;
  let resumed = false;
  if (kind === 'claude') {
    const rid = String(opts.resume || '').replace(/[^A-Za-z0-9_-]/g, '');   // sanitizar (se escribe en el shell)
    bootCmd = rid ? `claude --resume ${rid}` : 'claude';
    resumed = !!rid;
  }

  let proc: IPty;
  try {
    proc = mod.spawn(sh.file, sh.args, { name: 'xterm-256color', cols, rows, cwd, env });
  } catch (e) {
    return { ok: false, error: 'no pude lanzar ' + sh.label + ': ' + String((e as Error)?.message || e) };
  }

  const id = 't' + (++seq);
  const base = path.basename(cwd) || sh.label;
  const title = kind === 'claude' ? (resumed ? 'claude ↻ ' + base : 'claude · ' + base) : base + ' · ' + sh.label;
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
