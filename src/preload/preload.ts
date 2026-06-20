/* ════════════════════════════════════════════════════════════════
   Consomni — preload/preload.ts
   Puente tipado renderer↔main vía contextBridge. Sin nodeIntegration.
   ════════════════════════════════════════════════════════════════ */
import { contextBridge, ipcRenderer } from 'electron';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Snapshot = any;

const api = {
  platform: process.platform as NodeJS.Platform,
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
  },
};

contextBridge.exposeInMainWorld('consomni', api);

export type ConsomniApi = typeof api;
