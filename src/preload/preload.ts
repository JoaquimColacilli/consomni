/* ════════════════════════════════════════════════════════════════
   Consomni — preload/preload.ts
   Puente tipado renderer↔main vía contextBridge. Sin nodeIntegration.
   ════════════════════════════════════════════════════════════════ */
import { contextBridge, ipcRenderer } from 'electron';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Snapshot = any;

// Build de Windows (sincrónico, como `platform`). xterm lo necesita al CONSTRUIR el Terminal
// (windowsPty:{backend:'conpty',buildNumber}) para aplicar la detección de líneas envueltas
// ConPTY-aware y reflowear bien al hacer resize. El preload está SANDBOXED → NO podemos `require('os')`
// (crashea el preload); lo pedimos a main por IPC síncrono (el handler ya está registrado antes de cargar
// la ventana). os.release() en Win11 → "10.0.26200" → 26200.
const WIN_BUILD: number = (() => {
  try {
    if (process.platform !== 'win32') return 0;
    const v = ipcRenderer.sendSync('consomni:winBuild');
    return (typeof v === 'number' && v > 0) ? v : 0;
  } catch { return 0; }
})();

const api = {
  platform: process.platform as NodeJS.Platform,
  /** Build de Windows (0 si no es win32) → xterm windowsPty.buildNumber. */
  winBuild: WIN_BUILD,
  ping: (): Promise<string> => ipcRenderer.invoke('consomni:ping'),

  /** Snapshot actual (el renderer lo pide al cargar). */
  getSnapshot: (): Promise<Snapshot> => ipcRenderer.invoke('consomni:getSnapshot'),
  /** Forzar rescan inmediato. */
  rescan: (): Promise<Snapshot> => ipcRenderer.invoke('consomni:rescan'),
  /** Selector de carpeta nativo (agregar proyecto) → path elegido o null. */
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('consomni:pickFolder'),
  /** Suscribirse a los pushes de snapshot. Devuelve función para desuscribir. */
  onSnapshot: (cb: (snap: Snapshot) => void): (() => void) => {
    const listener = (_e: unknown, snap: Snapshot): void => cb(snap);
    ipcRenderer.on('consomni:snapshot', listener);
    return () => ipcRenderer.removeListener('consomni:snapshot', listener);
  },

  /* ── detalle / estado local ── */
  getSessionDetail: (id: string): Promise<Snapshot> => ipcRenderer.invoke('consomni:getSessionDetail', id),
  /** Docs de plan/spec (markdown) por cwd → tablero de Planes. */
  getPlanDocs: (cwds: string[]): Promise<Record<string, Array<{ path: string; name: string; mtime: number }>>> =>
    ipcRenderer.invoke('consomni:getPlanDocs', cwds),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setLocalState: (id: string, patch: any): Promise<Snapshot> => ipcRenderer.invoke('consomni:setLocalState', { id, patch }),

  /* ── acciones del SO ── */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  action: (name: string, payload: any): Promise<{ ok: boolean; message?: string; error?: string }> =>
    ipcRenderer.invoke('consomni:action', { name, payload }),
  setMuted: (v: boolean): Promise<boolean> => ipcRenderer.invoke('consomni:setMuted', v),
  /** Lee el portapapeles del SO (para PEGAR en la terminal; navigator.clipboard está bloqueado por la CSP). */
  clipboardRead: (): Promise<string> => ipcRenderer.invoke('consomni:clipboardRead'),
  /** Lee una IMAGEN del portapapeles → la guarda como PNG temporal y devuelve su ruta (para pegarla en una
      terminal `claude`: la ruta se inserta por bracketed paste y claude la convierte en [Image #N]). */
  clipboardImageToTempPng: (): Promise<{ ok: boolean; file?: string; reason?: string; width?: number; height?: number; bytes?: number }> =>
    ipcRenderer.invoke('consomni:clipboardImageToTempPng'),
  /** Lee un archivo (visor embebido); guardado a los roots vigilados / cwds de sesión + el cwd del panel, cap 1MB, sin binarios. */
  readFile: (p: string, cwd?: string, searchIfMissing?: boolean): Promise<{ ok: boolean; content?: string; error?: string; truncated?: boolean; resolvedPath?: string }> =>
    ipcRenderer.invoke('consomni:readFile', p, cwd, searchIfMissing),
  /** Lista archivos del cwd (picker flotante de @); guardado a los roots vigilados; walk acotado. */
  listFiles: (dir: string): Promise<{ ok: boolean; files?: string[]; error?: string; truncated?: boolean }> =>
    ipcRenderer.invoke('consomni:listFiles', dir),
  /** Lista los slash-commands CUSTOM (perfil + proyecto) para el picker flotante de '/'. */
  listCommands: (cwd: string): Promise<{ ok: boolean; commands?: Array<{ name: string; source: string; desc: string }>; error?: string }> =>
    ipcRenderer.invoke('consomni:listCommands', cwd),
  /** El main pide saltar a una sesión (click en la notificación nativa). */
  onJump: (cb: (sid: string) => void): (() => void) => {
    const listener = (_e: unknown, sid: string): void => cb(sid);
    ipcRenderer.on('consomni:jump', listener);
    return () => ipcRenderer.removeListener('consomni:jump', listener);
  },

  /* ── settings ── */
  getConfig: (): Promise<Snapshot> => ipcRenderer.invoke('consomni:getConfig'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  saveConfig: (patch: any): Promise<Snapshot> => ipcRenderer.invoke('consomni:saveConfig', patch),
  /** Auto-inicio con la PC (nativo). getter lee el estado real del SO (empaquetado) o la config (dev). */
  getAutoStart: (): Promise<boolean> => ipcRenderer.invoke('consomni:getAutoStart'),
  setAutoStart: (enabled: boolean): Promise<boolean> => ipcRenderer.invoke('consomni:setAutoStart', enabled),
  /** Recolorea los botones nativos de la title bar al tema activo ('dark' | 'light'). */
  setTitleBarOverlay: (theme: string): void => ipcRenderer.send('consomni:setTitleBarOverlay', theme),

  /* ── perfil de Claude Code (config dir; multi-perfil) ── */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getClaudeProfiles: (): Promise<any[]> => ipcRenderer.invoke('consomni:getClaudeProfiles'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setClaudeProfile: (dir: string): Promise<any> => ipcRenderer.invoke('consomni:setClaudeProfile', dir),

  /* ── biblioteca de prompts/skills/rules (store dedicado, 100% local) ── */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getLibrary: (): Promise<{ entries: any[]; seeded: boolean }> => ipcRenderer.invoke('consomni:getLibrary'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  saveLibrary: (data: any): void => ipcRenderer.send('consomni:saveLibrary', data),
  /* ── centro de notificaciones (store dedicado, persiste hasta "limpiar") ── */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getNotifications: (): Promise<any> => ipcRenderer.invoke('consomni:getNotifications'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  saveNotifications: (data: any): void => ipcRenderer.send('consomni:saveNotifications', data),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  exportLibrary: (entries: any[]): Promise<{ ok: boolean; path?: string; count?: number; error?: string }> =>
    ipcRenderer.invoke('consomni:exportLibrary', entries),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  importLibrary: (): Promise<{ ok: boolean; entries?: any[]; error?: string }> =>
    ipcRenderer.invoke('consomni:importLibrary'),

  /* ── hooks ── */
  getHooksStatus: (): Promise<Snapshot> => ipcRenderer.invoke('consomni:getHooksStatus'),
  installHooks: (): Promise<Snapshot> => ipcRenderer.invoke('consomni:installHooks'),
  uninstallHooks: (): Promise<Snapshot> => ipcRenderer.invoke('consomni:uninstallHooks'),

  /* ── actualizaciones (chequeo al repo del proyecto, opt-out) ── */
  // chequeo liviano manual (Settings) — anda también en dev, no descarga nada.
  checkUpdate: (): Promise<Snapshot> => ipcRenderer.invoke('consomni:checkUpdate'),
  // ── auto-update real (electron-updater) ──
  // dispara un re-chequeo / inicia la descarga de la versión detectada.
  updateCheck: (): void => ipcRenderer.send('consomni:updateCheck'),
  updateDownload: (): void => ipcRenderer.send('consomni:updateDownload'),
  // estado del update pendiente (re-consulta al boot → re-muestra el botón aunque se recargue el renderer)
  getUpdateStatus: (): Promise<{ latest: string; current: string; url: string; notes?: string; name?: string } | null> =>
    ipcRenderer.invoke('consomni:getUpdateStatus'),
  // eventos del flujo: available → (click) → progress* → downloaded → (relanza)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onUpdateEvent: (cb: (phase: string, data: any) => void): (() => void) => {
    const map: Record<string, string> = {
      'consomni:update-available': 'available',
      'consomni:update-none': 'none',
      'consomni:update-progress': 'progress',
      'consomni:update-downloaded': 'downloaded',
      'consomni:update-error': 'error',
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const listeners: Array<[string, (e: unknown, d: any) => void]> = [];
    Object.keys(map).forEach((ch) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const l = (_e: unknown, d: any): void => cb(map[ch], d);
      ipcRenderer.on(ch, l);
      listeners.push([ch, l]);
    });
    return () => listeners.forEach(([ch, l]) => ipcRenderer.removeListener(ch, l));
  },

  /* ── terminales embebidas (PTYs reales) ── */
  term: {
    available: (): Promise<boolean> => ipcRenderer.invoke('consomni:termAvailable'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    create: (opts: any): Promise<any> => ipcRenderer.invoke('consomni:termCreate', opts),
    write: (id: string, data: string): void => ipcRenderer.send('consomni:termWrite', { id, data }),
    /** Traducir lenguaje natural → comando (claude local). Devuelve {ok,command} o {ok:false,error}. */
    nl: (text: string, cwd?: string): Promise<{ ok: boolean; command?: string; error?: string }> =>
      ipcRenderer.invoke('consomni:nlCommand', { text, cwd }),
    resize: (id: string, cols: number, rows: number): void => ipcRenderer.send('consomni:termResize', { id, cols, rows }),
    kill: (id: string): Promise<boolean> => ipcRenderer.invoke('consomni:termKill', id),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    list: (): Promise<any[]> => ipcRenderer.invoke('consomni:termList'),
    onData: (cb: (p: { id: string; data: string }) => void): (() => void) => {
      const l = (_e: unknown, p: { id: string; data: string }): void => cb(p);
      ipcRenderer.on('term:data', l);
      return () => ipcRenderer.removeListener('term:data', l);
    },
    onExit: (cb: (p: { id: string; exitCode: number }) => void): (() => void) => {
      const l = (_e: unknown, p: { id: string; exitCode: number }): void => cb(p);
      ipcRenderer.on('term:exit', l);
      return () => ipcRenderer.removeListener('term:exit', l);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getDock: (): Promise<any> => ipcRenderer.invoke('consomni:getDock'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    saveDock: (data: any): void => ipcRenderer.send('consomni:saveDock', data),
    // historial de comandos para el autosuggest ghost text
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getHistory: (): Promise<any> => ipcRenderer.invoke('consomni:getTermHistory'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    saveHistory: (data: any): void => ipcRenderer.send('consomni:saveTermHistory', data),
  },
};

contextBridge.exposeInMainWorld('consomni', api);

export type ConsomniApi = typeof api;
