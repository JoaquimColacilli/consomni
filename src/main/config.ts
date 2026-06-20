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
  keptProjects: string[];      // proyectos "fijados" al sidebar (projKey) → no caen a archivados aunque no tengan sesiones activas
  confirmCloseTerminal: boolean; // avisar antes de cerrar una terminal viva (corta el proceso); "no volver a mostrar" lo apaga
  nlHelper: boolean;           // helper de comando por lenguaje natural en las terminales (claude local; opt-in, default off)
  nlModel: string;             // modelo para el helper NL ('haiku' por costo/latencia)
  frentes: Record<string, FrenteMeta>; // estado MANUAL de cada frente (proyecto) — privado, local. key = projKey
}

/** Estado manual y privado de un "frente" (= proyecto) en el tablero de Planes. */
export interface FrenteMeta {
  status?: string;   // '', 'backlog', 'dev', 'idea', 'pausado', 'listo'
  note?: string;     // nota / idea privada (nunca sale de la máquina)
  updated?: number;
}

export const HOME = os.homedir();
export const CLAUDE_DIR = path.join(HOME, '.claude');
export const CLAUDE_PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
export const CLAUDE_SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
export const CONSOMNI_DIR = path.join(HOME, '.consomni');
export const CONFIG_PATH = path.join(CONSOMNI_DIR, 'config.json');
export const STATE_PATH = path.join(CONSOMNI_DIR, 'state.json');
export const DOCK_PATH = path.join(CONSOMNI_DIR, 'dock.json');
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
  keptProjects: [],
  confirmCloseTerminal: true,
  nlHelper: false,
  nlModel: 'haiku',
  frentes: {},
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

/* ── layout del dock de terminales (persistencia para "inicio") ── */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function loadDock(): any {
  try { if (fs.existsSync(DOCK_PATH)) return JSON.parse(fs.readFileSync(DOCK_PATH, 'utf8')); } catch { /* noop */ }
  return null;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function saveDock(data: any): void {
  ensureConsomniDir();
  try { fs.writeFileSync(DOCK_PATH, JSON.stringify(data), 'utf8'); } catch { /* noop */ }
}

export function logSetup(line: string): void {
  ensureConsomniDir();
  const stamp = new Date().toISOString();
  try { fs.appendFileSync(SETUP_LOG, `[${stamp}] ${line}\n`, 'utf8'); } catch { /* noop */ }
}
