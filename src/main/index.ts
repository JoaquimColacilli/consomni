/* ════════════════════════════════════════════════════════════════
   Consomni — main/index.ts
   Bootstrap del proceso main: ventana, seguridad, network guard, IPC.
   Hard Rule 3: cero red salvo 127.0.0.1.
   ════════════════════════════════════════════════════════════════ */
import { app, BrowserWindow, ipcMain, session, Notification } from 'electron';
import * as path from 'path';
import { start as startSessions, stop as stopSessions, buildSnapshot, rescanNow, setHooksConnected, applyHookEvent, getDetail, findSessionFile, setAttnCallback, restartWatcher, type AttnInfo } from './sessions';
import { runAction, type ActionPayload } from './actions';
import { startHooksServer, stopHooksServer, isServerListening } from './hooks-server';
import { install as installHooks, uninstall as uninstallHooks, getStatus as getHooksStatus, isInstalled } from './hooks-install';
import { loadConfig, saveConfig, setLocalState, type AppConfig } from './config';
import type { Snapshot, LocalSessionState } from './types';

const RENDERER_DIR = path.join(__dirname, '..', '..', 'src', 'renderer');
const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');

let mainWindow: BrowserWindow | null = null;
let muted = false;

function jumpToSession(sid: string): void {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send('consomni:jump', sid);
}

function notifyAttn(info: AttnInfo): void {
  if (muted || !Notification.isSupported()) return;
  const n = new Notification({
    title: 'Consomni · esperando permiso',
    body: (info.name || 'sesión') + (info.reason ? ' — ' + info.reason : ' necesita tu atención. Aprobá o denegá.'),
    silent: false,
  });
  n.on('click', () => jumpToSession(info.sid));
  n.show();
}

function isLocalHost(urlStr: string): boolean {
  try {
    const u = new URL(urlStr);
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1';
  } catch {
    return false;
  }
}

/** Bloquea TODO tráfico de red externo (http/https/ws/wss). Sólo 127.0.0.1. */
function installNetworkGuard(): void {
  session.defaultSession.webRequest.onBeforeRequest((details, cb) => {
    const url = details.url;
    if (/^(https?|wss?):\/\//i.test(url) && !isLocalHost(url)) {
      cb({ cancel: true });
    } else {
      cb({ cancel: false });
    }
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: Number(process.env.CONSOMNI_W) || 1440,
    height: Number(process.env.CONSOMNI_H) || 880,
    minWidth: 680,
    minHeight: 460,
    backgroundColor: '#0a0a0b',
    show: false,
    title: 'Consomni',
    icon: path.join(RENDERER_DIR, 'assets', 'logo', 'app-icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  void mainWindow.loadFile(path.join(RENDERER_DIR, 'index.html'));

  if (process.env.CONSOMNI_DEVTOOLS === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  // Dev-only: captura la ventana a PNG y cierra (verificación de fidelidad).
  // CONSOMNI_SHOT=<ruta png>  CONSOMNI_SHOT_W / CONSOMNI_SHOT_H opcionales.
  if (process.env.CONSOMNI_SHOT) {
    const shotPath = process.env.CONSOMNI_SHOT;
    const shotDelay = Number(process.env.CONSOMNI_SHOT_DELAY) || 1400;
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        if (process.env.CONSOMNI_EXEC) {
          try { await mainWindow!.webContents.executeJavaScript(process.env.CONSOMNI_EXEC); } catch { /* noop */ }
          await new Promise((r) => setTimeout(r, 700));
        }
        try {
          const img = await mainWindow!.webContents.capturePage();
          require('fs').writeFileSync(shotPath, img.toPNG());
          console.log('SHOT_OK ' + shotPath);
        } catch (e) {
          console.log('SHOT_ERR ' + String(e));
        }
        app.quit();
      }, shotDelay);
    });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Una sola instancia (evita doble watcher / doble server de hooks).
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    installNetworkGuard();
    const cfg = loadConfig();

    ipcMain.handle('consomni:ping', () => 'pong');
    ipcMain.handle('consomni:getSnapshot', () => buildSnapshot());
    ipcMain.handle('consomni:rescan', () => rescanNow());
    ipcMain.handle('consomni:getSessionDetail', (_e, id: string) => getDetail(String(id)));
    ipcMain.handle('consomni:setLocalState', (_e, arg: { id: string; patch: LocalSessionState }) => {
      setLocalState(String(arg.id), arg.patch || {});
      return rescanNow();
    });

    // acciones reales del SO (transcript resuelve el archivo por sid)
    ipcMain.handle('consomni:action', async (_e, arg: { name: string; payload: ActionPayload & { sid?: string } }) => {
      const name = String(arg?.name || '');
      const payload: ActionPayload = { ...(arg?.payload || {}) };
      if (name === 'transcript' && arg.payload && arg.payload.sid) {
        payload.file = findSessionFile(String(arg.payload.sid)) || '';
      }
      return runAction(name, payload);
    });
    ipcMain.handle('consomni:setMuted', (_e, v: boolean) => { muted = !!v; return muted; });

    // settings
    ipcMain.handle('consomni:getConfig', () => loadConfig());
    ipcMain.handle('consomni:saveConfig', (_e, patch: Partial<AppConfig>) => {
      const before = loadConfig();
      const after = saveConfig(patch || {});
      const dirsChanged = JSON.stringify(before.watchedDirs) !== JSON.stringify(after.watchedDirs);
      if (dirsChanged) restartWatcher(); else rescanNow();
      return after;
    });

    const status = () => ({ ...getHooksStatus(), serverUp: isServerListening() });
    const refreshHooksConn = (): void => { setHooksConnected(isServerListening() && isInstalled()); };
    ipcMain.handle('consomni:getHooksStatus', () => status());
    ipcMain.handle('consomni:installHooks', () => {
      const r = installHooks(app.getAppPath(), cfg.port);
      refreshHooksConn(); rescanNow();
      return { ...r, status: status() };
    });
    ipcMain.handle('consomni:uninstallHooks', () => {
      const r = uninstallHooks();
      refreshHooksConn(); rescanNow();
      return { ...r, status: status() };
    });

    createWindow();

    // Capa de datos: escanea + vigila ~/.claude/projects y empuja snapshots.
    startSessions((snap: Snapshot) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('consomni:snapshot', snap);
      }
    });

    // Notificación nativa del SO cuando una sesión pasa a 'attn'.
    setAttnCallback(notifyAttn);

    // Server de hooks (127.0.0.1). Los eventos refinan el estado vivo.
    await startHooksServer(cfg.port, (event, payload) => applyHookEvent(event, payload));
    refreshHooksConn();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', () => { stopSessions(); stopHooksServer(); });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
