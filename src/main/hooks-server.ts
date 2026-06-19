/* ════════════════════════════════════════════════════════════════
   Consomni — hooks-server.ts
   Server HTTP local (express) en 127.0.0.1:<port>. Recibe los POSTs del
   helper hooks/post.js con los eventos de Claude Code. Sólo localhost.
   ════════════════════════════════════════════════════════════════ */
import express from 'express';
import type { Server } from 'http';

export type HookHandler = (event: string, payload: Record<string, unknown>) => void;

let server: Server | null = null;
let listening = false;

/** Arranca el server. Resuelve true si quedó escuchando, false si el puerto está ocupado. */
export function startHooksServer(port: number, onEvent: HookHandler): Promise<boolean> {
  return new Promise((resolve) => {
    const appx = express();
    appx.use(express.json({ limit: '4mb' }));

    appx.post('/hook', (req, res) => {
      const body = (req.body || {}) as { event?: string; payload?: Record<string, unknown> };
      try { onEvent(body.event || 'unknown', body.payload || {}); } catch { /* nunca romper */ }
      res.json({ ok: true });
    });

    appx.get('/health', (_req, res) => res.json({ ok: true, app: 'consomni' }));

    const srv = appx.listen(port, '127.0.0.1', () => { listening = true; resolve(true); });
    srv.on('error', () => { listening = false; resolve(false); });
    server = srv;
  });
}

export function isServerListening(): boolean { return listening; }

export function stopHooksServer(): void {
  if (server) { server.close(); server = null; listening = false; }
}
