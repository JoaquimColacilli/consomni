/* ════════════════════════════════════════════════════════════════
   Consomni — config.ts
   Rutas conocidas + settings persistidas + estado local (pin/fav/archivar).
   Todo vive en ~/.consomni/ (config.json, state.json, backups/, setup.log).
   ════════════════════════════════════════════════════════════════ */
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import type { LocalSessionState } from './types';

export interface AppConfig {
  port: number;                // server de hooks
  editor: 'code' | 'cursor';   // editor preferido
  terminal: 'wt' | 'powershell';
  ctxWarnThreshold: number;    // % de contexto para avisar
  refreshMs: number;           // intervalo de refresh "visual" del statusbar
  sounds: boolean;
  claudeProjectsDir: string;   // raíz de transcripts (read-only)
  watchedDirs: string[];       // dirs vigilados (incluye claudeProjectsDir)
  approveBlocking: boolean;    // interceptación bloqueante de permisos (opt-in)
  checkUpdates: boolean;       // chequeo de updates al iniciar (sólo al repo del proyecto, opt-out)
}

export const HOME = os.homedir();
export const CLAUDE_DIR = path.join(HOME, '.claude');
export const CLAUDE_PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
export const CLAUDE_SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
export const CONSOMNI_DIR = path.join(HOME, '.consomni');
export const CONFIG_PATH = path.join(CONSOMNI_DIR, 'config.json');
export const STATE_PATH = path.join(CONSOMNI_DIR, 'state.json');
export const BACKUPS_DIR = path.join(CONSOMNI_DIR, 'backups');
export const SETUP_LOG = path.join(CONSOMNI_DIR, 'setup.log');

const DEFAULTS: AppConfig = {
  port: 4517,
  editor: 'code',
  terminal: 'wt',
  ctxWarnThreshold: 90,
  refreshMs: 2000,
  sounds: true,
  claudeProjectsDir: CLAUDE_PROJECTS_DIR,
  watchedDirs: [CLAUDE_PROJECTS_DIR],
  approveBlocking: false,
  checkUpdates: true,
};

function ensureDir(p: string): void {
  try { fs.mkdirSync(p, { recursive: true }); } catch { /* noop */ }
}

export function ensureConsomniDir(): void {
  ensureDir(CONSOMNI_DIR);
  ensureDir(BACKUPS_DIR);
}

let cached: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cached) return cached;
  ensureConsomniDir();
  let cfg = { ...DEFAULTS };
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      cfg = { ...cfg, ...raw };
      // watchedDirs siempre incluye la raíz de projects
      if (!Array.isArray(cfg.watchedDirs) || cfg.watchedDirs.length === 0) {
        cfg.watchedDirs = [cfg.claudeProjectsDir];
      }
    }
  } catch { /* usar defaults */ }
  cached = cfg;
  return cfg;
}

export function saveConfig(patch: Partial<AppConfig>): AppConfig {
  const cfg = { ...loadConfig(), ...patch };
  cached = cfg;
  ensureConsomniDir();
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8'); } catch { /* noop */ }
  return cfg;
}

/* ── estado local por sesión (pin/fav/archivar) ── */
let stateCache: Record<string, LocalSessionState> | null = null;

export function loadLocalState(): Record<string, LocalSessionState> {
  if (stateCache) return stateCache;
  let st: Record<string, LocalSessionState> = {};
  try {
    if (fs.existsSync(STATE_PATH)) st = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch { /* noop */ }
  stateCache = st;
  return st;
}

export function setLocalState(sessionId: string, patch: LocalSessionState): void {
  const st = loadLocalState();
  st[sessionId] = { ...st[sessionId], ...patch };
  stateCache = st;
  ensureConsomniDir();
  try { fs.writeFileSync(STATE_PATH, JSON.stringify(st, null, 2), 'utf8'); } catch { /* noop */ }
}

export function logSetup(line: string): void {
  ensureConsomniDir();
  const stamp = new Date().toISOString();
  try { fs.appendFileSync(SETUP_LOG, `[${stamp}] ${line}\n`, 'utf8'); } catch { /* noop */ }
}
