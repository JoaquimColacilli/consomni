/* ════════════════════════════════════════════════════════════════
   Consomni — actions.ts
   Acciones reales del SO (Windows). SIEMPRE execFile/spawn con ARRAYS
   de argumentos (nunca shell string) → cero inyección aunque cwd/branch
   tengan espacios o metacaracteres. Donde se puede, el path va por la
   opción `cwd` del spawn (ni siquiera como argumento parseable).
   ════════════════════════════════════════════════════════════════ */
import { clipboard, shell } from 'electron';
import { execFile, execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig, resolveClaudeDir } from './config';

export interface ActionResult { ok: boolean; message?: string; error?: string; }

/** Env con CLAUDE_CONFIG_DIR del perfil activo si hay uno seteado; si no, undefined
    (el spawn hereda process.env tal cual = comportamiento actual). NUNCA spawnea
    `claude-max` como exe: siempre `claude` + esta env. */
function profileEnv(): NodeJS.ProcessEnv | undefined {
  const cfg = loadConfig();
  if (!(cfg.claudeConfigDir || '').trim()) return undefined;
  return { ...process.env, CLAUDE_CONFIG_DIR: resolveClaudeDir(cfg) };
}

/* ── detección de binarios (cacheada) ── */
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function spawnDetached(file: string, args: string[], opts: any = {}): void {
  const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true, ...opts });
  child.on('error', () => { /* best-effort; nunca tirar */ });
  child.unref();
}

function exists(p: string): boolean { try { return !!p && fs.existsSync(p); } catch { return false; } }

/* ── editor (code/cursor) ── */
function resolveEditorExe(editor: string): string | null {
  const cmdName = editor === 'cursor' ? 'cursor' : 'code';
  const cmd = which(cmdName);                 // p.ej. ...\bin\code.cmd
  if (!cmd) return null;
  const exe = path.join(path.dirname(cmd), '..', editor === 'cursor' ? 'Cursor.exe' : 'Code.exe');
  return exists(exe) ? exe : null;            // si no hallamos el .exe → usar fallback cmd
}

function openEditor(cwd: string, file?: string): ActionResult {
  // si viene un archivo válido, abrimos EL ARCHIVO (code/cursor <file>); si no, la carpeta.
  const target = file && exists(file) ? file : cwd;
  if (!exists(target)) return { ok: false, error: 'ruta no encontrada' };
  const editor = loadConfig().editor;
  const cmdName = editor === 'cursor' ? 'cursor' : 'code';
  const exe = resolveEditorExe(editor);
  if (exe) { spawnDetached(exe, [target]); return { ok: true, message: 'abriendo en ' + editor }; }
  if (which(cmdName)) {
    // fallback: target va como arg FIJO del array (sin shell) → cero inyección
    spawnDetached('cmd.exe', ['/d', '/s', '/c', cmdName, target], { cwd: cwd || undefined });
    return { ok: true, message: 'abriendo en ' + editor };
  }
  return { ok: false, error: editor + ' no está en PATH' };
}

/* ── revelar un archivo en el explorador del SO (lo selecciona dentro de su carpeta) ── */
function revealFile(file: string): ActionResult {
  if (!exists(file)) return { ok: false, error: 'archivo no encontrado' };
  const abs = path.resolve(file);
  if (process.platform === 'win32') {
    // QUIRK: el path va PEGADO al switch, en el MISMO arg ('/select,<path>'); separarlos falla.
    spawnDetached('explorer.exe', ['/select,' + abs]);
    return { ok: true, message: 'archivo revelado' };
  }
  if (process.platform === 'darwin') {
    spawnDetached('open', ['-R', abs]);
    return { ok: true, message: 'archivo revelado' };
  }
  // linux/otros: no hay "select" estándar → abrir la carpeta contenedora
  void shell.openPath(path.dirname(abs));
  return { ok: true, message: 'carpeta abierta' };
}

/* ── terminal (wt → fallback powershell) ── */
function openPowershell(cwd: string): ActionResult {
  spawnDetached('cmd.exe', ['/d', '/s', '/c', 'start', '', 'powershell', '-NoExit'], { cwd });
  return { ok: true, message: 'terminal (powershell)' };
}
function openTerminal(cwd: string): ActionResult {
  if (!exists(cwd)) return { ok: false, error: 'la carpeta no existe' };
  if (loadConfig().terminal === 'powershell') return openPowershell(cwd);
  const wt = which('wt');
  if (wt) { spawnDetached(wt, ['-d', cwd]); return { ok: true, message: 'terminal (wt)' }; }
  return openPowershell(cwd);
}

/* ── carpeta ── */
async function openFolder(cwd: string): Promise<ActionResult> {
  if (!exists(cwd)) return { ok: false, error: 'la carpeta no existe' };
  const err = await shell.openPath(cwd);
  return err ? { ok: false, error: err } : { ok: true, message: 'carpeta abierta' };
}

/* ── git diff → abre el diff en el editor / visor ── */
function gitDiff(cwd: string): Promise<ActionResult> {
  return new Promise((res) => {
    if (!exists(cwd)) return res({ ok: false, error: 'la carpeta no existe' });
    const git = which('git') || 'git';
    execFile(git, ['-C', cwd, 'diff'], { maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      const diff = stdout || '';
      if (err && !diff) return res({ ok: false, error: 'git diff falló (¿es un repo?)' });
      if (!diff.trim()) return res({ ok: true, message: 'sin cambios sin commitear' });
      const tmp = path.join(os.tmpdir(), 'consomni-diff-' + path.basename(cwd) + '.diff');
      try { fs.writeFileSync(tmp, diff, 'utf8'); } catch { /* noop */ }
      const exe = resolveEditorExe(loadConfig().editor);
      if (exe) spawnDetached(exe, [tmp]); else void shell.openPath(tmp);
      res({ ok: true, message: 'diff abierto' });
    });
  });
}

/* ── abrir PR (gh, best-effort) ── */
function openPR(cwd: string): ActionResult {
  if (!exists(cwd)) return { ok: false, error: 'la carpeta no existe' };
  const gh = which('gh');
  if (!gh) return { ok: false, error: 'gh no está en PATH' };
  spawnDetached(gh, ['pr', 'view', '--web'], { cwd });
  return { ok: true, message: 'abriendo PR (gh)' };
}

/* ── dispatch: NUEVA sesión de Claude Code en cwd (terminal + claude) ── */
function dispatchNew(cwd: string): ActionResult {
  if (!exists(cwd)) return { ok: false, error: 'la carpeta no existe' };
  const env = profileEnv();   // perfil activo de Claude Code (multi-perfil), si hay
  const wt = which('wt');
  if (wt) { spawnDetached(wt, ['-d', cwd, 'claude'], env ? { env } : {}); return { ok: true, message: 'dispatch: claude en ' + path.basename(cwd) }; }
  spawnDetached('cmd.exe', ['/d', '/s', '/c', 'start', '', 'powershell', '-NoExit', '-Command', 'claude'], env ? { cwd, env } : { cwd });
  return { ok: true, message: 'dispatch: claude (powershell)' };
}

/* ── clipboard ── */
function copy(value: string, label: string): ActionResult {
  clipboard.writeText(String(value || ''));
  return { ok: true, message: label + ' copiado' };
}

/* ── abrir un archivo cualquiera (transcript) ── */
async function openFile(file: string): Promise<ActionResult> {
  if (!exists(file)) return { ok: false, error: 'archivo no encontrado' };
  const err = await shell.openPath(file);
  return err ? { ok: false, error: err } : { ok: true, message: 'transcript abierto' };
}

/* ── abrir una URL https en el navegador del SO (no es tráfico in-app:
   shell.openExternal delega al navegador, no pasa por el network guard).
   Sólo se permite https para evitar protocolos peligrosos. ── */
async function openExternal(url: string): Promise<ActionResult> {
  let u: URL;
  try { u = new URL(String(url || '')); } catch { return { ok: false, error: 'URL inválida' }; }
  if (u.protocol !== 'https:') return { ok: false, error: 'sólo https' };
  await shell.openExternal(u.toString());
  return { ok: true, message: 'abriendo en el navegador' };
}

export interface ActionPayload { cwd?: string; branch?: string; id?: string; file?: string; url?: string; text?: string; }

export async function runAction(name: string, p: ActionPayload): Promise<ActionResult> {
  const cwd = p.cwd || '';
  switch (name) {
    case 'ext': return openEditor(cwd, p.file);
    case 'term': return openTerminal(cwd);
    case 'folder': return openFolder(cwd);
    case 'revealFile': return revealFile(p.file || '');
    case 'diff': return gitDiff(cwd);
    case 'pr': return openPR(cwd);
    case 'dispatch': return dispatchNew(cwd);
    case 'copy': return copy(cwd, 'path');
    case 'branch': return copy(p.branch || '', 'branch');
    case 'copyId': return copy(p.id || '', 'session id');
    case 'copyText': return copy(p.text || '', p.branch || 'texto');
    case 'transcript': return openFile(p.file || '');
    case 'openDoc': return openFile(p.file || '');
    case 'openExternal': return openExternal(p.url || '');
    default: return { ok: false, error: 'acción desconocida: ' + name };
  }
}
