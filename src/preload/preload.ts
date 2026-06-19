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
  /** Suscribirse a los pushes de snapshot. Devuelve función para desuscribir. */
  onSnapshot: (cb: (snap: Snapshot) => void): (() => void) => {
    const listener = (_e: unknown, snap: Snapshot): void => cb(snap);
    ipcRenderer.on('consomni:snapshot', listener);
    return () => ipcRenderer.removeListener('consomni:snapshot', listener);
  },

  /* ── detalle / estado local ── */
  getSessionDetail: (id: string): Promise<Snapshot> => ipcRenderer.invoke('consomni:getSessionDetail', id),
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
  checkUpdate: (): Promise<Snapshot> => ipcRenderer.invoke('consomni:checkUpdate'),
  onUpdate: (cb: (info: Snapshot) => void): (() => void) => {
    const listener = (_e: unknown, info: Snapshot): void => cb(info);
    ipcRenderer.on('consomni:update', listener);
    return () => ipcRenderer.removeListener('consomni:update', listener);
  },
};

contextBridge.exposeInMainWorld('consomni', api);

export type ConsomniApi = typeof api;
