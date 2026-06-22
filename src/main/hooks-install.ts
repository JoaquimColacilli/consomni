/* ════════════════════════════════════════════════════════════════
   Consomni — hooks-install.ts
   Instala/desinstala los hooks de Claude Code en ~/.claude/settings.json.
   Hard Rule 3: SIEMPRE backup antes de tocar. Merge NO-destructivo
   (conserva permissions/model/otros plugins). Eventos confirmados contra
   plugins oficiales. Comando posix + commandWindows (campo real) → node post.js.
   ════════════════════════════════════════════════════════════════ */
import * as fs from 'fs';
import * as path from 'path';
import { claudeSettingsPath, BACKUPS_DIR, ensureConsomniDir, logSetup, loadConfig } from './config';

/** Eventos que registramos (set estable, confirmado en plugins/.../*). */
const EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'Notification', 'Stop', 'SubagentStop', 'SessionEnd',
] as const;

export interface HooksStatus {
  installed: boolean;
  settingsPath: string;
  port: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

function readSettings(): Json {
  const settingsPath = claudeSettingsPath();
  try {
    if (fs.existsSync(settingsPath)) return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (e) { logSetup('WARN no se pudo parsear settings.json: ' + String(e)); }
  return {};
}

/** ¿una entrada de hook es nuestra? (su comando referencia nuestro post.js) */
function isOurEntry(entry: Json): boolean {
  if (!entry || !Array.isArray(entry.hooks)) return false;
  return entry.hooks.some((h: Json) => {
    const cmd = String(h?.command || '') + ' ' + String(h?.commandWindows || '');
    return /post\.js/i.test(cmd) && /consomni/i.test(cmd);
  });
}

/** Ruta del helper post.js, manejando asar (debe ir asar-unpacked). */
export function resolvePostJs(appPath: string): { posix: string; win: string } {
  let p = path.join(appPath, 'hooks', 'post.js');
  if (p.includes('app.asar' + path.sep) && !p.includes('app.asar.unpacked')) {
    p = p.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
  }
  return { posix: p.replace(/\\/g, '/'), win: p.replace(/\//g, '\\') };
}

function hookEntry(event: string, postJs: { posix: string; win: string }, port: number): Json {
  const posix = 'command -v node >/dev/null 2>&1 && node "' + postJs.posix + '" ' + event + ' ' + port + ' || exit 0';
  const win = 'if (Get-Command node -ErrorAction SilentlyContinue) { node "' + postJs.win + '" ' + event + ' ' + port + ' }';
  const entry: Json = { hooks: [{ type: 'command', command: posix, commandWindows: win, timeout: 5 }] };
  if (event === 'SessionStart') entry.matcher = 'startup|resume|clear|compact';
  return entry;
}

export function isInstalled(): boolean {
  const s = readSettings();
  if (!s.hooks) return false;
  return EVENTS.some((ev) => Array.isArray(s.hooks[ev]) && s.hooks[ev].some(isOurEntry));
}

export function getStatus(): HooksStatus {
  return { installed: isInstalled(), settingsPath: claudeSettingsPath(), port: loadConfig().port };
}

function backupSettings(): string | null {
  ensureConsomniDir();
  const settingsPath = claudeSettingsPath();
  if (!fs.existsSync(settingsPath)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(BACKUPS_DIR, 'settings.json.' + stamp + '.bak');
  fs.copyFileSync(settingsPath, dest);
  logSetup('backup settings.json → ' + dest);
  return dest;
}

function writeSettingsAtomic(obj: Json): void {
  const settingsPath = claudeSettingsPath();
  const tmp = settingsPath + '.consomni.tmp';
  const data = JSON.stringify(obj, null, 2) + '\n'; // newline final (convención; deja el archivo limpio)
  JSON.parse(data); // validar
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, settingsPath);
}

export interface InstallResult { ok: boolean; backupPath: string | null; error?: string; }

export function install(appPath: string, port: number): InstallResult {
  try {
    const backupPath = backupSettings();
    const s = readSettings();
    s.hooks = s.hooks || {};
    const postJs = resolvePostJs(appPath);
    for (const ev of EVENTS) {
      const existing: Json[] = Array.isArray(s.hooks[ev]) ? s.hooks[ev] : [];
      const cleaned = existing.filter((e) => !isOurEntry(e)); // quitar consomni previos
      cleaned.push(hookEntry(ev, postJs, port));
      s.hooks[ev] = cleaned;
    }
    writeSettingsAtomic(s);
    logSetup('hooks instalados (puerto ' + port + ', ' + EVENTS.length + ' eventos)');
    return { ok: true, backupPath };
  } catch (e) {
    logSetup('ERROR install: ' + String(e));
    return { ok: false, backupPath: null, error: String(e) };
  }
}

export function uninstall(): InstallResult {
  try {
    const backupPath = backupSettings();
    const s = readSettings();
    if (s.hooks) {
      for (const ev of EVENTS) {
        if (Array.isArray(s.hooks[ev])) {
          const kept = s.hooks[ev].filter((e: Json) => !isOurEntry(e));
          if (kept.length) s.hooks[ev] = kept; else delete s.hooks[ev];
        }
      }
      if (Object.keys(s.hooks).length === 0) delete s.hooks;
    }
    writeSettingsAtomic(s);
    logSetup('hooks desinstalados');
    return { ok: true, backupPath };
  } catch (e) {
    logSetup('ERROR uninstall: ' + String(e));
    return { ok: false, backupPath: null, error: String(e) };
  }
}

/** Para tests/dry-run: devuelve el objeto settings resultante de instalar, sin escribir. */
export function previewInstall(appPath: string, port: number, current: Json): Json {
  const s = JSON.parse(JSON.stringify(current || {}));
  s.hooks = s.hooks || {};
  const postJs = resolvePostJs(appPath);
  for (const ev of EVENTS) {
    const existing: Json[] = Array.isArray(s.hooks[ev]) ? s.hooks[ev] : [];
    const cleaned = existing.filter((e) => !isOurEntry(e));
    cleaned.push(hookEntry(ev, postJs, port));
    s.hooks[ev] = cleaned;
  }
  return s;
}
