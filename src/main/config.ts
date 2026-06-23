/* ════════════════════════════════════════════════════════════════
   Consomni — config.ts
   Rutas conocidas + settings persistidas + estado local (pin/fav/archivar).
   Todo vive en ~/.consomni/ (config.json, state.json, backups/, setup.log).
   ════════════════════════════════════════════════════════════════ */
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import type { LocalSessionState, LibraryFile } from './types';

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
  quickTermKind: 'shell' | 'claude' | 'claude-skip'; // qué abre CTRL+ESPACIO (terminal shell / claude / claude --dangerously-skip-permissions)
  theme: 'dark' | 'light';     // tema de la app (default oscuro)
  claudeConfigDir: string;     // perfil ACTIVO de Claude Code (config dir). '' = auto (env CLAUDE_CONFIG_DIR → ~/.claude). Multi-perfil (ej ~/.claude-max)
  seenProfileTour: boolean;    // ¿ya vio el tutorial de multi-perfil? (gate confiable bajo file://, no localStorage). Auto-salta 1 vez al actualizar
  seenWhatsNew18: boolean;     // ¿ya vio el tour de novedades v1.8.0? (gate confiable bajo file://). Auto-salta 1 vez tras actualizar
  autoStart: boolean;          // abrir Consomni al iniciar la PC (nativo: app.setLoginItemSettings → registro Run). Sólo aplica empaquetado
  frentes: Record<string, FrenteMeta>; // estado MANUAL de cada frente (proyecto) — privado, local. key = projKey
}

/** Estado manual y privado de un "frente" (= proyecto) en el tablero de Planes. */
export interface FrenteMeta {
  status?: string;   // '', 'backlog', 'dev', 'idea', 'pausado', 'listo'
  note?: string;     // nota / idea privada (nunca sale de la máquina)
  updated?: number;
}

export const HOME = os.homedir();
// Default fallback (perfil clásico ~/.claude). El perfil ACTIVO puede ser otro (ver resolveClaudeDir).
export const CLAUDE_DIR = path.join(HOME, '.claude');
export const CLAUDE_PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
export const CLAUDE_SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
export const CONSOMNI_DIR = path.join(HOME, '.consomni');
export const CONFIG_PATH = path.join(CONSOMNI_DIR, 'config.json');
export const STATE_PATH = path.join(CONSOMNI_DIR, 'state.json');
export const DOCK_PATH = path.join(CONSOMNI_DIR, 'dock.json');
export const LIBRARY_PATH = path.join(CONSOMNI_DIR, 'library.json');
export const NOTIFICATIONS_PATH = path.join(CONSOMNI_DIR, 'notifications.json');
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
  quickTermKind: 'claude-skip',
  theme: 'dark',
  claudeConfigDir: '',
  seenProfileTour: false,
  seenWhatsNew18: false,
  autoStart: false,
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

/* ════════ perfil ACTIVO de Claude Code (config dir) ════════
   Single source of truth: setting del usuario → env CLAUDE_CONFIG_DIR → ~/.claude.
   Con setting '' y sin env → resuelve EXACTO a ~/.claude (backward-compatible). */

/** Expande un `~` inicial a HOME y normaliza a ruta absoluta. */
function expandHome(p: string): string {
  let s = String(p || '').trim();
  if (!s) return s;
  if (s === '~') s = HOME;
  else if (s.startsWith('~/') || s.startsWith('~\\')) s = path.join(HOME, s.slice(2));
  return path.resolve(s);
}

/** Config dir ACTIVO de Claude Code (donde vive settings.json + projects del perfil elegido). */
export function resolveClaudeDir(cfg?: AppConfig): string {
  const c = cfg || loadConfig();
  const fromSetting = (c.claudeConfigDir || '').trim();
  if (fromSetting) return expandHome(fromSetting);
  const fromEnv = (process.env.CLAUDE_CONFIG_DIR || '').trim();
  if (fromEnv) return expandHome(fromEnv);
  return CLAUDE_DIR;
}

/** Raíz de transcripts del perfil activo (<config-dir>/projects). */
export function claudeProjectsPath(cfg?: AppConfig): string {
  return path.join(resolveClaudeDir(cfg), 'projects');
}

/** settings.json del perfil activo (donde se instalan los hooks). */
export function claudeSettingsPath(cfg?: AppConfig): string {
  return path.join(resolveClaudeDir(cfg), 'settings.json');
}

export interface ClaudeProfile {
  dir: string;          // ruta absoluta del config dir
  name: string;         // nombre lindo (basename, ej '.claude' / '.claude-max')
  hasProjects: boolean; // tiene subcarpeta projects/
  hasSettings: boolean; // tiene settings.json
  projectCount: number; // subdirs de projects/ (barato, 0 si no existe)
  active: boolean;      // es el perfil activo ahora mismo
}

/** Auto-detecta perfiles: carpetas ~/.claude* con projects/ o settings.json. Incluye siempre ~/.claude. */
export function detectClaudeProfiles(): ClaudeProfile[] {
  const active = resolveClaudeDir();
  const found = new Map<string, ClaudeProfile>();
  const inspect = (dir: string): void => {
    const abs = path.resolve(dir);
    if (found.has(abs)) return;
    let hasProjects = false; let hasSettings = false; let projectCount = 0;
    try { hasProjects = fs.statSync(path.join(abs, 'projects')).isDirectory(); } catch { /* noop */ }
    try { hasSettings = fs.statSync(path.join(abs, 'settings.json')).isFile(); } catch { /* noop */ }
    if (hasProjects) {
      try { projectCount = fs.readdirSync(path.join(abs, 'projects'), { withFileTypes: true }).filter((d) => d.isDirectory()).length; } catch { /* noop */ }
    }
    found.set(abs, { dir: abs, name: path.basename(abs), hasProjects, hasSettings, projectCount, active: abs === active });
  };
  // Escaneo barato de HOME por carpetas .claude*
  try {
    for (const d of fs.readdirSync(HOME, { withFileTypes: true })) {
      if (d.isDirectory() && /^\.claude/i.test(d.name)) inspect(path.join(HOME, d.name));
    }
  } catch { /* noop */ }
  inspect(CLAUDE_DIR);   // ~/.claude siempre presente (aunque no exista)
  inspect(active);       // el activo siempre presente (ej un perfil custom fuera de HOME)
  // ordenar: activo primero, luego con más proyectos, luego alfabético
  return [...found.values()].sort((a, b) =>
    (Number(b.active) - Number(a.active)) || (b.projectCount - a.projectCount) || a.name.localeCompare(b.name));
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

/* ── centro de notificaciones (store dedicado) ──
   La LISTA persiste para que una notif sin leer sobreviva reinicios/updates (solo se va al "limpiar"). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function loadNotifications(): any {
  try { if (fs.existsSync(NOTIFICATIONS_PATH)) return JSON.parse(fs.readFileSync(NOTIFICATIONS_PATH, 'utf8')); } catch { /* noop */ }
  return null;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function saveNotifications(data: any): void {
  ensureConsomniDir();
  try { fs.writeFileSync(NOTIFICATIONS_PATH, JSON.stringify(data), 'utf8'); } catch { /* noop */ }
}

/* ── biblioteca de prompts/skills/rules (store dedicado, NO config.json) ──
   Va aparte para no inflar config.json ni disparar el rescan que hace saveConfig. */
export function loadLibrary(): LibraryFile {
  try {
    if (fs.existsSync(LIBRARY_PATH)) {
      const raw = JSON.parse(fs.readFileSync(LIBRARY_PATH, 'utf8'));
      if (raw && Array.isArray(raw.entries)) return { entries: raw.entries, seeded: !!raw.seeded };
    }
  } catch { /* noop */ }
  return { entries: [], seeded: false };
}
export function saveLibrary(data: LibraryFile): void {
  ensureConsomniDir();
  const safe: LibraryFile = { entries: Array.isArray(data?.entries) ? data.entries : [], seeded: !!data?.seeded };
  try { fs.writeFileSync(LIBRARY_PATH, JSON.stringify(safe, null, 2), 'utf8'); } catch { /* noop */ }
}

export function logSetup(line: string): void {
  ensureConsomniDir();
  const stamp = new Date().toISOString();
  try { fs.appendFileSync(SETUP_LOG, `[${stamp}] ${line}\n`, 'utf8'); } catch { /* noop */ }
}
