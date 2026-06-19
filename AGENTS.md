# AGENTS.md — Consomni

Reglas operativas para cualquier agente que trabaje en este repo. El contexto profundo
(mapeos JSONL→Session, hooks→estado, shapes de los builders, tablas) está en **`CLAUDE.md`**.
Leé ambos antes de tocar nada.

## Qué es
**Consomni** ("consola + omni · un ojo que lo ve todo"): app de escritorio Electron (Windows)
que monitorea en tiempo real todas las sesiones de Claude Code en paralelo, leyendo **data 100%
local** (transcripts JSONL de `~/.claude/projects` + hooks que postean a un server local). **No usa
la API de Anthropic.** Stack fijo: **Electron + TypeScript** (main Node/TS, renderer HTML/CSS/JS
vanilla, preload con `contextBridge`), empaquetado con **electron-builder** (portable + nsis).
Deps permitidas: `electron`, `electron-builder`, `typescript`, `chokidar`, `express`.

## 🛑 HARD RULES (innegociables)

1. **[HARD RULE] Diseño EXACTO al `design-reference`.** Importar `tokens.css` **verbatim** (no editar
   valores, no crear estilos que compitan). Reusar los builders de `chrome.js` y el markup de las
   pantallas e1–e7. **Cero drift visual** — las 7 pantallas son el objetivo pixel-perfect. Estilos
   nuevos = solo aditivos de layout usando las variables CSS existentes (`var(--…)`).

2. **[HARD RULE] Responsive.** El layout se adapta al resize sin romperse en ningún tamaño: sidebar
   auto-colapsa (estado E6 diseñado) cuando falta ancho, el board scrollea/reflowea, los overlays
   (panel de detalle, command palette, toast) se reajustan, min-widths sensatos. Probar a varios tamaños.

3. **[HARD RULE] Cero API de Anthropic. Read-only sobre `~/.claude/projects`** (nunca escribir/mover/
   borrar transcripts). **Backup de `settings.json` antes de tocarlo.** Sin telemetría. Única red:
   `127.0.0.1` (hooks). Fuente Geist Mono vendorizada local (offline).

## 🛑 Regla de proceso
- **NUNCA `git commit` ni `git push` sin aprobación explícita del usuario.** Crear archivos,
  instalar deps y buildear no requieren OK. **Avisar al cerrar cada fase** para dar visibilidad.
- Seguridad Electron: `contextIsolation:true`, `nodeIntegration:false`, sin `remote`. IPC tipado por preload.

## Seguridad de datos
- `~/.claude/projects`: **solo lectura** (parser + chokidar). Nunca mutar transcripts.
- `~/.claude/settings.json`: tocar **solo** para instalar hooks, **siempre con backup previo**
  (`~/.consomni/backups/settings.json.<ts>.bak`), merge no-destructivo, validar JSON, rollback si falla.

## Mapa rápido (detalle en CLAUDE.md)
- **Estados:** `working | idle | standby | attn | error | closed`. `ctxPct→lvl`: green `<75`, amber `75–90`, red `>90`.
- **Orden default:** `attn > working > error > idle > standby > cerradas`.
- **Modos:** `default→ask`, `plan→plan`, `acceptEdits→edit`, `bypassPermissions→auto`.
- **Puerto hooks:** `4517` (configurable).
- **Tokens:** dedupe por `message.id`; no sumar `cache_read` al costo; `windowSize` inferido del modelo.
- **Acciones:** abrir editor/terminal/folder, copy, diff, transcript = reales · aprobar/denegar = parcial
  (default observar) · dispatch/kill = stub honesto.

## Estructura
```
design-reference/  (READ-ONLY, no tocar)
hooks/post.js
src/main/{index,jsonl,hooks-server,hooks-install,sessions,actions,config}.ts
src/preload/preload.ts
src/renderer/{tokens.css(copia verbatim),chrome.js(parametrizado),app.css(responsive aditivo),index.html,app.js,assets/fonts/}
```

## Verificación
- Fidelidad/responsive con skills de browser (`browse`, `qa`, `design-review`); levantar la app con `verify`/`run`.
- Comparar siempre contra `design-reference/e1..e7` antes de cerrar una fase visual.
