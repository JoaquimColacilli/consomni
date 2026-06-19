/* ════════════════════════════════════════════════════════════════
   Consomni — updates.ts
   Chequeo de versión contra el repo PROPIO del proyecto en GitHub.
   Única excepción sancionada a la regla "sólo 127.0.0.1": un GET de
   sólo-lectura a api.github.com/.../releases/latest, SIN datos del
   usuario, SIN telemetría, opt-out vía Settings (config.checkUpdates).
   Usa el módulo `https` de Node → NO pasa por el network-guard del
   renderer (ese guard gobierna pedidos de Chromium, no de Node).
   ════════════════════════════════════════════════════════════════ */
import * as https from 'https';
import { app } from 'electron';

const REPO = 'JoaquimColacilli/consomni';
const RELEASES_URL = 'https://github.com/' + REPO + '/releases';

export interface UpdateInfo {
  current: string;
  latest: string | null;
  hasUpdate: boolean;
  url: string;
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
