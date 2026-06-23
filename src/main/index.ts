/* ════════════════════════════════════════════════════════════════
   Consomni — main/index.ts
   Bootstrap del proceso main: ventana, seguridad, network guard, IPC.
   Hard Rule 3: cero red salvo 127.0.0.1.
   ════════════════════════════════════════════════════════════════ */
import { app, BrowserWindow, ipcMain, session, Notification, dialog, clipboard } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { start as startSessions, stop as stopSessions, buildSnapshot, rescanNow, setHooksConnected, applyHookEvent, getDetail, findSessionFile, findPlanDocs, setAttnCallback, restartWatcher, type AttnInfo } from './sessions';
import { runAction, type ActionPayload } from './actions';
import { startHooksServer, stopHooksServer, isServerListening } from './hooks-server';
import { install as installHooks, uninstall as uninstallHooks, getStatus as getHooksStatus, isInstalled } from './hooks-install';
import { loadConfig, saveConfig, setLocalState, loadDock, saveDock, loadLibrary, saveLibrary, loadNotifications, saveNotifications, detectClaudeProfiles, claudeProjectsPath, resolveClaudeDir, type AppConfig } from './config';
import { checkForUpdate, initAutoUpdate, triggerAutoCheck, downloadUpdate } from './updates';
import { setTerminalWindow, createTerm, writeTerm, resizeTerm, killTerm, listTerms, killAllTerms, terminalsAvailable, nlToCommand } from './terminals';
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

// Colores del overlay de la title bar (botones nativos min/max/cerrar) según el tema.
// `color` = fondo de la barra (matchea el --bg-chrome de la topbar); `symbolColor` = color de los glifos.
function titleBarOverlayColors(theme?: string): { color: string; symbolColor: string; height: number } {
  return theme === 'light'
    ? { color: '#fbfbfc', symbolColor: '#1a1a1f', height: 54 }
    : { color: '#0c0c0f', symbolColor: '#e6e6e6', height: 54 };
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
    // Title bar "amena" (punto intermedio): la topbar pasa a ser la barra (arrastrable vía -webkit-app-region),
    // con botones nativos min/max/cerrar recoloreados al tema → mantiene el snap-layout de Windows 11.
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarOverlayColors(loadConfig().theme),
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
          await new Promise((r) => setTimeout(r, Number(process.env.CONSOMNI_EXEC_WAIT) || 700));
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
    // Una 2da instancia (p.ej. "ejecutar al finalizar" del instalador, o reabrir) NO arranca
    // otra ventana por el lock; traemos al frente la existente de forma visible (show + focus).
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    installNetworkGuard();
    const cfg = loadConfig();

    // Reconcilia el auto-inicio del SO con la config (p.ej. tras reinstalar). Sólo empaquetado.
    try { if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!cfg.autoStart, path: process.execPath }); } catch { /* noop */ }

    ipcMain.handle('consomni:ping', () => 'pong');
    ipcMain.handle('consomni:getSnapshot', () => buildSnapshot());
    ipcMain.handle('consomni:rescan', () => rescanNow());
    ipcMain.handle('consomni:getSessionDetail', (_e, id: string) => getDetail(String(id)));
    // docs de plan/spec (markdown) por cwd → tablero de Planes (read-only, on-demand)
    ipcMain.handle('consomni:getPlanDocs', (_e, cwds: string[]) => {
      const out: Record<string, ReturnType<typeof findPlanDocs>> = {};
      (Array.isArray(cwds) ? cwds : []).slice(0, 40).forEach((c) => { const cc = String(c || ''); if (cc && !(cc in out)) out[cc] = findPlanDocs(cc); });
      return out;
    });
    // comando por lenguaje natural → claude LOCAL (print one-shot, translate-only). Devuelve {ok,command}.
    ipcMain.handle('consomni:nlCommand', (_e, arg: { text: string; cwd?: string }) =>
      nlToCommand(String(arg?.text || ''), arg?.cwd ? String(arg.cwd) : undefined));
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

    // chequeo de actualizaciones (manual desde Settings; ver updates.ts)
    ipcMain.handle('consomni:checkUpdate', () => checkForUpdate());
    // auto-update (electron-updater): re-chequeo manual + iniciar descarga
    ipcMain.on('consomni:updateCheck', () => triggerAutoCheck());
    ipcMain.on('consomni:updateDownload', () => downloadUpdate());

    // ── terminales embebidas (PTYs reales; ver terminals.ts) ──
    ipcMain.handle('consomni:termAvailable', () => terminalsAvailable());
    ipcMain.handle('consomni:termCreate', (_e, opts: { cwd?: string; kind?: 'shell' | 'claude'; cols?: number; rows?: number; resume?: string; skip?: boolean; pick?: boolean }) => createTerm(opts || {}));
    ipcMain.on('consomni:termWrite', (_e, arg: { id: string; data: string }) => writeTerm(String(arg?.id), String(arg?.data ?? '')));
    ipcMain.on('consomni:termResize', (_e, arg: { id: string; cols: number; rows: number }) => resizeTerm(String(arg?.id), Number(arg?.cols), Number(arg?.rows)));
    ipcMain.handle('consomni:termKill', (_e, id: string) => { killTerm(String(id)); return true; });
    ipcMain.handle('consomni:termList', () => listTerms());
    // selector de carpeta nativo para "agregar proyecto" → devuelve el path elegido o null
    ipcMain.handle('consomni:pickFolder', async () => {
      const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
      const res = win
        ? await dialog.showOpenDialog(win, { properties: ['openDirectory'], title: 'Agregar proyecto — elegí la carpeta raíz' })
        : await dialog.showOpenDialog({ properties: ['openDirectory'], title: 'Agregar proyecto — elegí la carpeta raíz' });
      if (res.canceled || !res.filePaths.length) return null;
      return res.filePaths[0];
    });
    // persistencia del layout del dock (para arrancar siempre en "inicio")
    ipcMain.handle('consomni:getDock', () => loadDock());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ipcMain.on('consomni:saveDock', (_e, data: any) => saveDock(data));

    // lectura del portapapeles (para PEGAR en la terminal embebida; navigator.clipboard está bloqueado por la CSP)
    ipcMain.handle('consomni:clipboardRead', () => { try { return clipboard.readText(); } catch { return ''; } });

    // lectura de un archivo para el VISOR embebido (click en una ruta del chat/terminal). GUARDADO:
    // solo dentro de los roots vigilados / projects del perfil / cwds de sesiones; cap 1MB; rechaza binarios.
    ipcMain.handle('consomni:readFile', (_e, filePath: string) => {
      try {
        const fp = path.resolve(String(filePath || ''));
        if (!fp) return { ok: false, error: 'sin ruta' };
        const cfg = loadConfig();
        const roots = [
          claudeProjectsPath(cfg),
          ...(Array.isArray(cfg.watchedDirs) ? cfg.watchedDirs : []),
          ...buildSnapshot().sessions.map((s) => s.cwd).filter(Boolean),
        ].map((r) => path.resolve(String(r))).filter(Boolean);
        const allowed = roots.some((root) => fp === root || fp.startsWith(root + path.sep));
        if (!allowed) return { ok: false, error: 'fuera del alcance permitido' };
        const st = fs.statSync(fp);
        if (!st.isFile()) return { ok: false, error: 'no es un archivo' };
        const CAP = 1024 * 1024;
        const truncated = st.size > CAP;
        // leer SÓLO los primeros CAP bytes (no el archivo entero) → un .log/.jsonl gigante no infla la RAM del main
        const want = Math.min(st.size, CAP);
        const buf = Buffer.alloc(want);
        const fd = fs.openSync(fp, 'r');
        let read = 0;
        try { read = fs.readSync(fd, buf, 0, want, 0); } finally { fs.closeSync(fd); }
        const data = read < want ? buf.subarray(0, read) : buf;
        if (data.subarray(0, Math.min(data.length, 4096)).includes(0)) return { ok: false, error: 'archivo binario' };
        return { ok: true, content: data.toString('utf8'), truncated };
      } catch { return { ok: false, error: 'no se pudo leer' }; }
    });

    // listado de archivos del cwd para el PICKER flotante de @ (estilo Warp). GUARDADO igual que readFile:
    // sólo dentro de los roots vigilados / cwds de sesión. Walk acotado (depth/count/tiempo), salta ignorados.
    ipcMain.handle('consomni:listFiles', (_e, dir: string) => {
      try {
        const base = path.resolve(String(dir || ''));
        if (!base) return { ok: false, error: 'sin dir' };
        const cfg = loadConfig();
        const roots = [
          claudeProjectsPath(cfg),
          ...(Array.isArray(cfg.watchedDirs) ? cfg.watchedDirs : []),
          ...buildSnapshot().sessions.map((s) => s.cwd).filter(Boolean),
        ].map((r) => path.resolve(String(r))).filter(Boolean);
        const allowed = roots.some((root) => base === root || base.startsWith(root + path.sep));
        if (!allowed) return { ok: false, error: 'fuera del alcance permitido' };
        const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', '.cache', 'coverage', 'release', '.turbo', '.venv', 'venv', '__pycache__', '.idea', '.vscode-test']);
        const CAP = 4000, MAXDEPTH = 9, MAXMS = 1500;
        const files: string[] = [];
        const start = Date.now();
        const walk = (d: string, rel: string, depth: number): void => {
          if (files.length >= CAP || depth > MAXDEPTH || Date.now() - start > MAXMS) return;
          let ents: import('fs').Dirent[];
          try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
          for (const e of ents) {
            if (files.length >= CAP) return;
            const nm = e.name;
            if (e.isDirectory()) {
              if (IGNORE.has(nm) || nm.startsWith('.')) continue;
              walk(path.join(d, nm), rel ? rel + '/' + nm : nm, depth + 1);
            } else if (e.isFile()) {
              files.push(rel ? rel + '/' + nm : nm);
            }
          }
        };
        walk(base, '', 0);
        return { ok: true, files, truncated: files.length >= CAP };
      } catch { return { ok: false, error: 'no se pudo listar' }; }
    });

    // slash-commands para el picker flotante de '/': lee los comandos CUSTOM (markdown) del perfil activo
    // (<configDir>/commands) y del proyecto (<cwd>/.claude/commands). Los built-in los cura el renderer.
    ipcMain.handle('consomni:listCommands', (_e, cwd: string) => {
      try {
        const cfg = loadConfig();
        const dirs: Array<{ dir: string; source: 'user' | 'project' }> = [
          { dir: path.join(resolveClaudeDir(cfg), 'commands'), source: 'user' },
        ];
        const c = path.resolve(String(cwd || ''));
        if (c) dirs.push({ dir: path.join(c, '.claude', 'commands'), source: 'project' });
        const out: Array<{ name: string; source: string; desc: string }> = [];
        const seen = new Set<string>();
        const MAXDEPTH = 4, CAP = 300;
        const readDesc = (fp: string): string => {
          try {
            const raw = fs.readFileSync(fp, 'utf8').slice(0, 2048);
            const fm = raw.match(/^---\s*[\r\n]([\s\S]*?)[\r\n]---/);
            if (fm) { const m = fm[1].match(/description\s*:\s*(.+)/i); if (m) return m[1].trim().replace(/^["']|["']$/g, '').slice(0, 80); }
            for (const ln of raw.split(/\r?\n/)) { const t = ln.trim(); if (t && !t.startsWith('---') && !t.startsWith('#')) return t.slice(0, 80); }
          } catch { /* noop */ }
          return '';
        };
        const walk = (d: string, rel: string, depth: number, source: string): void => {
          if (out.length >= CAP || depth > MAXDEPTH) return;
          let ents: import('fs').Dirent[];
          try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
          for (const e of ents) {
            if (out.length >= CAP) return;
            if (e.isDirectory()) { if (!e.name.startsWith('.')) walk(path.join(d, e.name), rel ? rel + '/' + e.name : e.name, depth + 1, source); }
            else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
              const base = e.name.slice(0, -3);
              const name = (rel ? rel + '/' + base : base).replace(/[\\/]+/g, ':');
              if (seen.has(name)) continue;
              seen.add(name);
              out.push({ name, source, desc: readDesc(path.join(d, e.name)) });
            }
          }
        };
        for (const { dir, source } of dirs) walk(dir, '', 0, source);
        out.sort((a, b) => a.name.localeCompare(b.name));
        return { ok: true, commands: out };
      } catch { return { ok: false, error: 'no se pudo listar comandos' }; }
    });

    // centro de notificaciones persistido (sobrevive reinicios/updates; solo se va al "limpiar")
    ipcMain.handle('consomni:getNotifications', () => loadNotifications());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ipcMain.on('consomni:saveNotifications', (_e, data: any) => saveNotifications(data));

    // ── biblioteca de prompts/skills/rules (store dedicado, 100% local) ──
    ipcMain.handle('consomni:getLibrary', () => loadLibrary());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ipcMain.on('consomni:saveLibrary', (_e, data: any) => saveLibrary(data));
    // exportar a un .json elegido por el usuario (respaldo / compartir)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ipcMain.handle('consomni:exportLibrary', async (_e, entries: any) => {
      const list = Array.isArray(entries) ? entries : [];
      const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
      const opts = { title: 'Exportar biblioteca', defaultPath: 'consomni-biblioteca.json', filters: [{ name: 'JSON', extensions: ['json'] }] };
      const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
      if (res.canceled || !res.filePath) return { ok: false };
      try { fs.writeFileSync(res.filePath, JSON.stringify({ entries: list }, null, 2), 'utf8'); return { ok: true, path: res.filePath, count: list.length }; }
      catch (e) { return { ok: false, error: String((e as Error)?.message || e) }; }
    });
    // importar desde un .json → devuelve las entries leídas (el renderer mergea)
    ipcMain.handle('consomni:importLibrary', async () => {
      const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
      const opts = { title: 'Importar biblioteca', properties: ['openFile' as const], filters: [{ name: 'JSON', extensions: ['json'] }] };
      const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
      if (res.canceled || !res.filePaths.length) return { ok: false };
      try {
        const raw = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf8'));
        const entries = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.entries) ? raw.entries : null);
        if (!entries) return { ok: false, error: 'el archivo no tiene una lista de entries' };
        return { ok: true, entries };
      } catch (e) { return { ok: false, error: String((e as Error)?.message || e) }; }
    });

    // settings
    ipcMain.handle('consomni:getConfig', () => loadConfig());
    ipcMain.handle('consomni:saveConfig', (_e, patch: Partial<AppConfig>) => {
      const before = loadConfig();
      const after = saveConfig(patch || {});
      const dirsChanged = JSON.stringify(before.watchedDirs) !== JSON.stringify(after.watchedDirs);
      if (dirsChanged) restartWatcher(); else rescanNow();
      return after;
    });

    // ── auto-inicio con la PC (nativo: registro Run de Windows vía setLoginItemSettings) ──
    // En dev (!isPackaged) NO se toca el SO (registraría electron.exe); el toggle igual persiste para la UI.
    ipcMain.handle('consomni:getAutoStart', () => {
      try { return app.isPackaged ? app.getLoginItemSettings().openAtLogin : !!loadConfig().autoStart; } catch { return false; }
    });
    ipcMain.handle('consomni:setAutoStart', (_e, enabledArg: boolean) => {
      const enabled = !!enabledArg;
      try { if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath }); } catch { /* noop */ }
      saveConfig({ autoStart: enabled });
      return enabled;
    });

    // Recolorea los botones nativos de la title bar al cambiar de tema (claro/oscuro).
    ipcMain.on('consomni:setTitleBarOverlay', (_e, theme: string) => {
      try {
        const c = titleBarOverlayColors(theme);
        mainWindow?.setTitleBarOverlay({ color: c.color, symbolColor: c.symbolColor, height: c.height });
      } catch { /* noop si la plataforma no soporta overlay */ }
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

    // ── perfil ACTIVO de Claude Code (config dir; multi-perfil) ──
    ipcMain.handle('consomni:getClaudeProfiles', () => detectClaudeProfiles());
    ipcMain.handle('consomni:setClaudeProfile', (_e, dirArg: string) => {
      const dir = String(dirArg || '').trim();   // '' = volver al default (env → ~/.claude)
      if (dir) {
        let okDir = false;
        try { okDir = fs.statSync(dir).isDirectory(); } catch { okDir = false; }
        if (!okDir) return { ok: false, error: 'la carpeta no existe', config: loadConfig(), hooks: status() };
      }
      const before = loadConfig();
      const oldProjects = path.resolve(claudeProjectsPath(before));
      const newProjects = claudeProjectsPath({ ...before, claudeConfigDir: dir });
      // preservar roots extra (los que el usuario agregó), repointando el projects del perfil
      const extras = (Array.isArray(before.watchedDirs) ? before.watchedDirs : [])
        .filter((d) => path.resolve(String(d || '')) !== oldProjects);
      const watchedDirs = [newProjects, ...extras].filter((d, i, a) =>
        a.findIndex((x) => path.resolve(String(x || '')) === path.resolve(String(d || ''))) === i);
      const after = saveConfig({ claudeConfigDir: dir, claudeProjectsDir: newProjects, watchedDirs });
      restartWatcher();      // re-apunta el watcher al projects del perfil nuevo (push de snapshot fresco)
      refreshHooksConn();    // el estado de hooks ahora se lee contra el settings.json del perfil activo
      return { ok: true, config: after, hooks: status(), active: resolveClaudeDir(after) };
    });

    createWindow();
    setTerminalWindow(() => mainWindow);

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

    // Auto-update al iniciar + cada 30 min (opt-out). electron-updater contra el
    // repo público del proyecto; no-op en dev. Dispara el botón "Actualizar" del topbar.
    initAutoUpdate(() => mainWindow, cfg.checkUpdates !== false);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', () => { killAllTerms(); stopSessions(); stopHooksServer(); });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
