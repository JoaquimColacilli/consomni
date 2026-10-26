#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════
   Consomni — hooks/statusline.js
   Comando de `statusLine` de Claude Code. Claude le pasa por STDIN el
   JSON de la sesión, que incluye `rate_limits.five_hour` / `seven_day`
   (uso del plan: sesión 5h + semanal). Este helper:
     1) imprime una línea compacta para la barra de la TUI de claude
     2) postea el uso al server local de Consomni (127.0.0.1)
   Uso:  node statusline.js [port]
   - Sin dependencias. NUNCA rompe la TUI: ante cualquier error sale 0.
   ════════════════════════════════════════════════════════════════ */
'use strict';
const http = require('http');

const port = Number(process.env.CONSOMNI_PORT || process.argv[2] || 4517);

function pct(w) { return w && typeof w.used_percentage === 'number' ? Math.round(w.used_percentage) + '%' : null; }

let body = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { body += d; });
process.stdin.on('error', () => process.exit(0));
process.stdin.on('end', () => {
  let p = {};
  try { p = body ? JSON.parse(body) : {}; } catch { process.exit(0); }
  const rl = p.rate_limits || null;

  const parts = [];
  const a = pct(rl && rl.five_hour), b = pct(rl && rl.seven_day);
  if (a) parts.push('5h ' + a);
  if (b) parts.push('7d ' + b);
  if (parts.length) process.stdout.write(parts.join(' · '));

  if (!rl) process.exit(0);
  const data = JSON.stringify({ event: 'StatusLine', ts: Date.now(), payload: { session_id: p.session_id, rate_limits: rl } });
  const req = http.request(
    {
      host: '127.0.0.1', port: port, path: '/hook', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 1500,
    },
    (res) => { res.resume(); res.on('end', () => process.exit(0)); }
  );
  req.on('error', () => process.exit(0));
  req.on('timeout', () => { req.destroy(); process.exit(0); });
  req.write(data);
  req.end();
});

setTimeout(() => process.exit(0), 2500);
