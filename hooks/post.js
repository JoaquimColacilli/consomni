#!/usr/bin/env node
/* ════════════════════════════════════════════════════════════════
   Consomni — hooks/post.js
   Helper invocado por los hooks de Claude Code. Lee el payload JSON
   del evento por STDIN y lo postea al server local de Consomni.
   Uso:  node post.js <EventName> [port]
   - Sin dependencias (http nativo).
   - NUNCA bloquea ni rompe la sesión de Claude Code: ante cualquier
     error o timeout sale con código 0.
   ════════════════════════════════════════════════════════════════ */
'use strict';
const http = require('http');

const event = process.argv[2] || 'unknown';
const port = Number(process.env.CONSOMNI_PORT || process.argv[3] || 4517);

let body = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { body += d; });
process.stdin.on('error', () => process.exit(0));
process.stdin.on('end', () => {
  let payload;
  try { payload = body ? JSON.parse(body) : {}; }
  catch { payload = { raw: body }; }

  const data = JSON.stringify({ event: event, ts: Date.now(), payload: payload });
  const req = http.request(
    {
      host: '127.0.0.1',
      port: port,
      path: '/hook',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 2000,
    },
    (res) => { res.resume(); res.on('end', () => process.exit(0)); }
  );
  req.on('error', () => process.exit(0));
  req.on('timeout', () => { req.destroy(); process.exit(0); });
  req.write(data);
  req.end();
});

// Salvavidas: si stdin nunca cierra, salir igual.
setTimeout(() => process.exit(0), 3000);
