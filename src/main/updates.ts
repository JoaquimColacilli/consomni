/* ════════════════════════════════════════════════════════════════
   Consomni — updates.ts
   Updates contra el repo PÚBLICO del proyecto en GitHub Releases.
   Única excepción sancionada a la regla "sólo 127.0.0.1": tráfico de
   sólo-lectura a GitHub (api.github.com / objects de releases), SIN datos
   del usuario, SIN telemetría, opt-out vía Settings (config.checkUpdates).
   Va por el módulo `https` de Node / electron-updater (proceso main) →
   NO pasa por el network-guard del renderer (ese guard gobierna pedidos
   de Chromium, no de Node).

   Dos caminos:
   - checkForUpdate()  → GET liviano a releases/latest (botón manual de
     Settings; anda también en DEV, sin descargar nada).
   - autoUpdate (electron-updater) → flujo real del botón "Actualizar" del
     topbar: chequea al iniciar + cada 30 min, descarga on-demand con
     progreso y aplica con quitAndInstall. SÓLO en app empaquetada
     (electron-updater es no-op en dev).
   ════════════════════════════════════════════════════════════════ */
import * as https from 'https';
import { app, BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';

const REPO = 'JoaquimColacilli/consomni';
const RELEASES_URL = 'https://github.com/' + REPO + '/releases';

export interface UpdateInfo {
  current: string;
  latest: string | null;
  hasUpdate: boolean;
  url: string;
  notes?: string;      // cuerpo del release (changelog markdown) — para el modal de novedades
  name?: string;       // título del release
  publishedAt?: string;
  error?: string;
}

function parseVer(v: string): number[] {
  return String(v || '')
    .replace(/^v/i, '')
    .split(/[.\-+]/)
    .map((n) => parseInt(n, 10))
    .filter((n) => !isNaN(n));
}

function isNewer(latest: string, current: string): boolean {
  const a = parseVer(latest);
  const b = parseVer(current);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

export function checkForUpdate(): Promise<UpdateInfo> {
  const current = app.getVersion();
  return new Promise((resolve) => {
    const done = (info: Partial<UpdateInfo>): void =>
      resolve({ current, latest: null, hasUpdate: false, url: RELEASES_URL, ...info });

    let settled = false;
    const finish = (info: Partial<UpdateInfo>): void => { if (!settled) { settled = true; done(info); } };

    const req = https.get(
      {
        hostname: 'api.github.com',
        path: '/repos/' + REPO + '/releases/latest',
        headers: { 'User-Agent': 'Consomni', Accept: 'application/vnd.github+json' },
        timeout: 6000,
      },
      (res) => {
        const code = res.statusCode || 0;
        if (code === 404) { res.resume(); return finish({}); }            // aún no hay releases publicadas
        if (code !== 200) { res.resume(); return finish({ error: 'HTTP ' + code }); }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; if (body.length > 1_000_000) req.destroy(); });
        res.on('end', () => {
          try {
            const json = JSON.parse(body);
            const tag = String(json.tag_name || json.name || '').replace(/^v/i, '');
            finish({
              latest: tag || null,
              hasUpdate: tag ? isNewer(tag, current) : false,
              url: json.html_url || RELEASES_URL,
              notes: typeof json.body === 'string' ? json.body : undefined,
              name: typeof json.name === 'string' ? json.name : undefined,
              publishedAt: typeof json.published_at === 'string' ? json.published_at : undefined,
            });
          } catch {
            finish({ error: 'parse' });
          }
        });
      }
    );
    req.on('error', (e) => finish({ error: String((e as NodeJS.ErrnoException).code || e) }));
    req.on('timeout', () => { req.destroy(); finish({ error: 'timeout' }); });
  });
}

/* ───────────────────────── auto-update (electron-updater) ───────────────────────── */

let auWired = false;
let auPoll: ReturnType<typeof setInterval> | null = null;
let getWindow: () => BrowserWindow | null = () => null;
// Los chequeos automáticos (arranque/poll) NO deben tirar toast de error (p.ej. 404 si
// todavía no hay releases, o un blip de red). Sólo mostramos error si el usuario disparó
// la descarga. Se baja el flag al iniciar una descarga y se sube en cada auto-check.
let suppressErr = true;

const POLL_MS = 30 * 60 * 1000;   // re-chequeo cada 30 min

function send(channel: string, data?: unknown): void {
  const win = getWindow();
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

/** electron-updater entrega releaseNotes como string O array {version,note}: lo aplanamos a texto. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeNotes(notes: any): string | undefined {
  if (!notes) return undefined;
  if (typeof notes === 'string') return notes;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (Array.isArray(notes)) return notes.map((n: any) => (n && n.version ? '## ' + n.version + '\n' : '') + ((n && n.note) || '')).join('\n\n');
  return undefined;
}

/** Arranca el flujo de auto-update: wiring de eventos + chequeo inicial + polling.
 *  No hace nada en dev (no empaquetado) ni si el usuario lo desactivó (opt-out). */
export function initAutoUpdate(winGetter: () => BrowserWindow | null, enabled: boolean): void {
  getWindow = winGetter;
  if (!app.isPackaged || !enabled) return;

  autoUpdater.autoDownload = false;          // se descarga al click del botón
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;

  if (!auWired) {
    auWired = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    autoUpdater.on('update-available', (info: any) => {
      send('consomni:update-available', { latest: info && info.version, current: app.getVersion(), url: RELEASES_URL, notes: normalizeNotes(info && info.releaseNotes), name: (info && info.releaseName) || undefined });
    });
    autoUpdater.on('update-not-available', () => send('consomni:update-none', {}));
    autoUpdater.on('download-progress', (p: { percent?: number; transferred?: number; total?: number; bytesPerSecond?: number }) => {
      send('consomni:update-progress', {
        percent: Math.max(0, Math.min(100, Math.round(p.percent || 0))),
        transferred: p.transferred, total: p.total, bps: p.bytesPerSecond,
      });
    });
    autoUpdater.on('update-downloaded', (info: { version?: string }) => {
      send('consomni:update-downloaded', { latest: info && info.version });
      // aplicar y relanzar (un toque después para que el renderer muestre "reiniciando…").
      // isSilent=true  → instala EN SILENCIO, sin abrir el panel del instalador (era el bug:
      //                  "te pone todo el panel de Windows como si bajaras la app de 0").
      // isForceRunAfter=true → relanza la app sola al terminar.
      setTimeout(() => { try { autoUpdater.quitAndInstall(true, true); } catch { /* noop */ } }, 1200);
    });
    autoUpdater.on('error', (err: Error) => { if (!suppressErr) send('consomni:update-error', { error: String((err && err.message) || err) }); });
  }

  triggerAutoCheck();
  if (auPoll) clearInterval(auPoll);
  auPoll = setInterval(triggerAutoCheck, POLL_MS);
}

/** Chequeo silencioso (no descarga). Dispara update-available / update-none.
 *  Los errores NO se propagan al renderer (sin toast molesto en arranque/poll). */
export function triggerAutoCheck(): void {
  if (!app.isPackaged) return;
  suppressErr = true;
  autoUpdater.checkForUpdates().catch(() => { /* offline / sin red: silencioso */ });
}

/** Descarga la actualización ya detectada (emite download-progress → update-downloaded).
 *  Iniciada por el usuario → los errores SÍ se muestran. */
export function downloadUpdate(): void {
  if (!app.isPackaged) return;
  suppressErr = false;
  autoUpdater.downloadUpdate().catch(() => { /* el evento 'error' ya avisa al renderer */ });
}
