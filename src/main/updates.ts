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
const API_HOST = 'api.github.com';
// Carpeta de assets de una release puntual: <DL_BASE><tag>/latest.yml + el .exe. La usamos para
// apuntar electron-updater DIRECTO a la release de mayor versión (ver resolveLatestRelease + triggerAutoCheck).
const DL_BASE = 'https://github.com/' + REPO + '/releases/download/';

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

/* ⚠️ Fix "actualiza de a UNA versión en vez de a la última" (bug reportado):
   electron-updater (GitHubProvider, sin prerelease) elige la versión leyendo el puntero "Latest" de
   GitHub (GET /releases/latest). GitHub calcula ese puntero por la FECHA DEL COMMIT de la release (no
   por orden de publicación) + make_latest, así que tras varias releases seguidas puede quedar
   DESFASADO apuntando a una intermedia → el updater ofrece esa intermedia → se avanza de a una.
   Solución: resolvemos NOSOTROS la release de mayor versión (semver) vía la API y apuntamos
   electron-updater DIRECTO a esa release con un generic provider (setFeedURL) → saltea el puntero.
   Si la resolución falla (offline/rate-limit) NO tocamos el feed → queda el provider github default
   (fail-open: las actualizaciones nunca se rompen). */

interface ResolvedRelease { tag: string; version: string; body?: string; name?: string; }
let lastResolved: ResolvedRelease | null = null;

/** GET liviano a la API de GitHub (read-only, sin token, sin telemetría — excepción sancionada a HR3).
 *  Resuelve el JSON parseado o null ante CUALQUIER fallo (no-200, parse, timeout, red). NUNCA rechaza. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function httpGetJson(path: string): Promise<any | null> {
  return new Promise((resolve) => {
    let settled = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const finish = (v: any | null): void => { if (!settled) { settled = true; resolve(v); } };
    const req = https.get(
      { hostname: API_HOST, path, headers: { 'User-Agent': 'Consomni', Accept: 'application/vnd.github+json' }, timeout: 6000 },
      (res) => {
        if ((res.statusCode || 0) !== 200) { res.resume(); return finish(null); }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; if (body.length > 1_000_000) req.destroy(); });
        res.on('end', () => { try { finish(JSON.parse(body)); } catch { finish(null); } });
      }
    );
    req.on('error', () => finish(null));
    req.on('timeout', () => { req.destroy(); finish(null); });
  });
}

/** Release de MAYOR versión semver, NO-draft NO-prerelease, computada por NOSOTROS (no por el puntero
 *  "Latest" de GitHub). Devuelve null ante cualquier fallo → el caller hace fail-open al provider default. */
async function resolveLatestRelease(): Promise<ResolvedRelease | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const arr: any = await httpGetJson('/repos/' + REPO + '/releases?per_page=100');   // 100 = máx de la API, holgura
  if (!Array.isArray(arr)) return null;
  const cands: ResolvedRelease[] = arr
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((r: any) => r && !r.draft && !r.prerelease && typeof r.tag_name === 'string')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((r: any): ResolvedRelease => ({
      tag: r.tag_name,
      version: String(r.tag_name).replace(/^v/i, ''),
      body: typeof r.body === 'string' ? r.body : undefined,
      name: typeof r.name === 'string' ? r.name : undefined,
    }))
    // semver numérico válido y SIN sufijo de prerelease (parseVer descarta lo no-numérico → 1.9.7-beta
    // parsearía igual que 1.9.7; el guard del '-' + el flag prerelease de la API lo cubren por las dudas)
    .filter((r) => parseVer(r.version).length > 0 && !r.version.includes('-'));
  if (!cands.length) return null;
  // mayor versión primero — independiente del orden por fecha de commit / del puntero "Latest"
  cands.sort((a, b) => (isNewer(a.version, b.version) ? -1 : (isNewer(b.version, a.version) ? 1 : 0)));
  return cands[0];
}

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
      // El generic provider lee latest.yml, que NO trae release notes → usamos el body que resolvimos
      // de la API (mismo tag), gateado por versión para que las notas nunca queden de otra versión.
      const v = info && info.version;
      const matched = (lastResolved && lastResolved.version === v) ? lastResolved : null;
      const notes = normalizeNotes(info && info.releaseNotes) || (matched ? matched.body : undefined);
      const name = (info && info.releaseName) || (matched ? matched.name : undefined);
      send('consomni:update-available', { latest: v, current: app.getVersion(), url: RELEASES_URL, notes, name });
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

  void triggerAutoCheck();
  if (auPoll) clearInterval(auPoll);
  auPoll = setInterval(() => { void triggerAutoCheck(); }, POLL_MS);
}

/** Chequeo silencioso (no descarga). Dispara update-available / update-none.
 *  Los errores NO se propagan al renderer (sin toast molesto en arranque/poll).
 *  ANTES de chequear, apunta el feed a la release de MAYOR versión (saltea el puntero "Latest" de
 *  GitHub → siempre salta a la última, no de a una). El <tag> se hornea en la baseURL al construir el
 *  provider, así que hay que re-setear en CADA chequeo. */
export async function triggerAutoCheck(): Promise<void> {
  if (!app.isPackaged) return;
  try {
    const r = await resolveLatestRelease();
    if (r) {
      try {
        // generic provider apuntado a <DL_BASE><tag>/ → electron-updater baja ESE latest.yml (versión
        // exacta), sin consultar /releases/latest. useMultipleRangeRequest:false = mismo comportamiento
        // que el provider github (evita multi-range sobre el CDN de GitHub). channel queda 'latest'.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        autoUpdater.setFeedURL({ provider: 'generic', url: DL_BASE + r.tag, channel: 'latest', useMultipleRangeRequest: false } as any);
        lastResolved = r;
      } catch { /* si setFeedURL falla, queda el provider github default (o el último pin bueno) */ }
    }
    // r == null (offline / rate-limit / sin candidato): NO seteamos feed → fail-open al provider github
    // default (1er chequeo) o al último pin bueno (chequeos siguientes). Nunca deja sin actualizar.
  } catch { /* la resolución NUNCA debe romper el chequeo */ }
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
