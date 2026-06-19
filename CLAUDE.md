# CONSOMNI — Contexto del proyecto (canónico)

> **consola + omni · "un ojo que lo ve todo".**
> App de escritorio (Electron, Windows) que monitorea y orquesta en tiempo real todas las
> sesiones de Claude Code que corren en paralelo, leyendo **data 100% local**. NO usa la API
> de Anthropic para nada. Este archivo + `AGENTS.md` son la fuente de verdad del proyecto y
> deben sobrevivir a cualquier reset de contexto. Si algo acá contradice al código, gana lo
> que esté verificado en el código — actualizá este archivo.

---

## 🛑 HARD RULES (innegociables)

1. **[HARD RULE] Diseño EXACTO al `design-reference`.** `design-reference/tokens.css` se importa
   **verbatim** en el renderer: no se editan sus valores ni se crean estilos que compitan con sus
   clases. Se reusan los builders de `design-reference/chrome.js` y el markup de las pantallas
   (e1–e7). **Cero drift visual.** Las 7 pantallas del reference son el objetivo de aceptación
   **pixel-perfect**. Cualquier estilo nuevo usa las variables CSS existentes (`var(--green)`,
   `var(--surface-card)`, etc.) y es **aditivo de layout** (no reescribe apariencia de componentes).

2. **[HARD RULE] La app debe ser responsive.** El layout se adapta al resize de la ventana sin
   romperse en ningún tamaño: el sidebar **auto-colapsa** (estado E6 ya diseñado) cuando falta
   ancho, el board **scrollea/reflowea**, los overlays (panel de detalle, command palette, toast)
   se reajustan, con **min-widths sensatos**. Probar a distintos tamaños de ventana.

3. **[HARD RULE] Cero llamadas a la API de Anthropic.** Read-only sobre `~/.claude/projects`
   (nunca escribir/mover/borrar transcripts). **Backup de `settings.json` antes de tocarlo.**
   Sin telemetría, sin analytics. Única red permitida: `127.0.0.1` (server de hooks). La fuente
   Geist Mono se vendoriza local (offline 100%).

### Regla de proceso (también dura)
- **NUNCA `git commit` ni `git push` sin aprobación explícita del usuario.** Todo lo demás
  (crear archivos, instalar deps, build) va sin pedir OK entre fases. Avisar al cerrar cada fase.

---

## Stack (fijo)
- **Electron + TypeScript.** Main = Node/TS. Renderer = HTML/CSS/JS vanilla. Preload con
  `contextBridge` (sin `nodeIntegration`, sin `remote`; `contextIsolation: true`).
- Empaquetado: **electron-builder** (Windows: `portable` + `nsis`).
- Sin framework de UI (nada de React/Vue). El renderer reusa el design-reference tal cual.
- Deps permitidas: `electron`, `electron-builder`, `typescript`, `chokidar` (watcher),
  `express` (server de hooks). Nada más sin justificarlo acá.

---

## Estructura de archivos
```
consomni/
  design-reference/        # READ-ONLY. Fuente de verdad visual. NO se toca.
  hooks/
    post.js                # helper Node bundleado: lee stdin JSON → POST 127.0.0.1:<port>
  src/
    main/
      index.ts             # bootstrap, BrowserWindow, IPC, wiring
      jsonl.ts             # parser + watcher (chokidar) de ~/.claude/projects (read-only)
      hooks-server.ts      # express local 127.0.0.1:4517 (configurable)
      hooks-install.ts     # backup + merge no-destructivo en settings.json
      sessions.ts          # store: merge A(JSONL)+B(hooks) → Session[], ordering, throttle
      actions.ts           # abrir VSCode/terminal/folder, copy, git diff, transcript…
      config.ts            # settings persistidas (~/.consomni/config.json)
    preload/preload.ts     # contextBridge: API tipada renderer↔main
    renderer/
      tokens.css           # COPIA VERBATIM de design-reference/tokens.css (no editar valores)
      chrome.js            # versión parametrizada de design-reference/chrome.js (mismo markup/clases)
      app.css              # SOLO reglas aditivas de responsive usando tokens existentes
      index.html           # shell: topbar+sidebar+board+statusbar+crt + overlays
      app.js               # estado renderer, IPC, re-render, interacciones, atajos
      assets/fonts/        # Geist Mono vendorizada (offline)
  package.json  tsconfig.json  electron-builder.yml  README.md
~/.consomni/               # runtime del usuario: config.json, state.json (pin/fav/archivar),
                           # setup.log, backups/settings.json.<ts>.bak
```

---

## Modelo de sesión (unifica A=JSONL + B=hooks)
```ts
type SessionState = 'working'|'idle'|'standby'|'attn'|'error'|'closed';
interface Session {
  id: string; name: string; project: string; cwd: string; branch: string;
  mode: 'ask'|'plan'|'edit'|'auto'; model: string;
  windowSize: number; tokensIn: number; tokensOut: number; tokensTotal: number; cache: number;
  ctxPct: number; effort?: string;
  state: SessionState; statusText: string; statusEm?: string;
  attnReason?: string; lastActivity: number; cost?: number;
  subagents?: {name:string;state:SessionState}[];
  lastToolCalls?: {tool:string;arg?:string;ts:number}[];
  fav?: boolean; pinned?: boolean; selected?: boolean;
}
```
- `ctxPct → lvl`: green `<75`, amber `75–90`, red `>90`.
- **Orden por defecto** (configurable): `attn > working > error > idle > standby > cerradas`.
  Las `attn` suben al top de su columna y disparan banner + ojo pulsando.
- Sesiones agrupadas por **proyecto** = directorio/repo (soporta monorepo anidado).

---

## A) JSONL → Session  (derivado empíricamente; ver tablas)
Transcripts en `%USERPROFILE%\.claude\projects\<proyecto>\<session-id>.jsonl` (read-only + chokidar).

| Campo | Fuente JSONL |
|---|---|
| `id` | `sessionId` / nombre de archivo `<id>.jsonl` |
| `name` | primer record `type:"user"` con `parentUuid:null` → `message.content` (string o `[0].text`), truncado. NO existe `summary`/`title`. `slug` solo aparece tras compactar (no confiable) |
| `project`/`cwd` | `cwd` (path Windows real) |
| `branch` | `gitBranch` del **último** record |
| `mode` | `permissionMode` último: `default→ask`, `plan→plan`, `acceptEdits→edit`, `bypassPermissions→auto` |
| `model` | `message.model` (assistant), saltar `"<synthetic>"` |
| `windowSize` | **inferir del modelo** (200k; 1_000_000 para variantes `[1m]`). No está en el archivo |
| `tokensIn/Out/cache` | `message.usage.{input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens}` |
| `ctxPct` | `(input+cache_read+cache_creation)` del último turno real / `windowSize` |
| `tokensTotal`(costo) | suma `input+output` sobre turnos. **NO** sumar `cache_read` |
| `lastActivity` | `timestamp` del último record (ISO-8601 UTC) o mtime |
| `subagents[]` | dir `<session>/subagents/agent-<id>.jsonl` + `agent-<id>.meta.json` `{agentType,description,toolUseId}`; records `isSidechain:true` |
| `lastToolCalls[]` | assistant `content[]` con `type:"tool_use"` → `{name,input}`; 1er arg: `command`/`file_path`/`pattern` |

**Gotchas (obligatorio manejarlos en el parser):**
- Turnos assistant **partidos en varias líneas con mismo `message.id`** y **mismo `usage`** →
  **dedupe por `message.id`** o se triplican los tokens.
- `message.content` es **string O array** de bloques. Manejar ambos.
- Archivos de varios MB → leer head+tail+scan, **nunca el archivo entero**.
- `system/compact_boundary` resetea contexto (`compactMetadata.preTokens`→`postTokens`).
- Saltar `type:"queue-operation"`, `type:"attachment"`, `isMeta:true`, y `journal.jsonl` de workflows (no es transcript).
- Records pueden empezar con `permission-mode` + `file-history-snapshot` o directo `queue-operation`/`user`. No asumir línea 1.

## B) Hooks → estado  (eventos CONFIRMADOS contra plugins oficiales en disco)
Server HTTP local express en `127.0.0.1:4517` (default, configurable) recibe POSTs.

| Evento | Estado | Nota |
|---|---|---|
| `SessionStart` (matcher `startup\|resume\|clear\|compact`) | aparece / `working` | |
| `UserPromptSubmit` | `working` | |
| `PreToolUse` | `working` + última tool call | |
| `PostToolUse` | `working` + feed | |
| `Notification` | `attn` (permiso) / `idle` (idle-prompt) | ⚠️ discriminar por payload real — loguear crudo y ajustar |
| `Stop` | `idle` | |
| `SubagentStop` | actualiza subagente | |
| `SessionEnd` | `closed` | |
| `PreCompact` (opc.) | `working` | |

**Sintaxis de hook confirmada** (de `plugins/.../security-guidance`, `hookify`, `ponytail`):
```jsonc
"<Evento>": [{ "matcher":"...", "hooks":[{
  "type":"command",
  "command":        "node \"<consomni>/hooks/post.js\" <Evento>",   // posix
  "commandWindows": "node \"<consomni>\\hooks\\post.js\" <Evento>",  // Windows (campo real)
  "timeout": 5
}}]]
```
El helper Node lee el JSON por **stdin** y postea a `127.0.0.1:<port>`. `node` confirmado en PATH (v22).
Fallback: `curl.exe`. Tipos `http`/`mcp_tool` NO confirmados en 2.1.181 → usar `command`.

---

## Acciones: reales vs stub honesto
- **REAL:** abrir VSCode (`code <cwd>`), terminal (`wt -d <cwd>`→fallback powershell), carpeta (`explorer`),
  copiar path/branch/id (clipboard Electron), ver transcript (`.jsonl`), `git -C <cwd> diff`,
  pin/fav/archivar (estado local `~/.consomni`), abrir PR (`gh pr ...`).
- **PARCIAL:** aprobar/denegar permiso → requiere hook `PreToolUse` que **bloquee y consulte** a
  Consomni (riesgo de freeze/timeout). **Default: observar + toast + saltar a la terminal.**
  Interceptación bloqueante = opt-in en Settings.
- **STUB honesto (TODO, no inventar):** dispatch / quick-reply / pausar / matar / re-dispatch.
  Los hooks no inyectan prompts ni matan sesiones. Dispatch real = spawnear `claude` nuevo;
  matar = `taskkill` al PID (OS-level). Dejar wired como stub claro.

---

## Diseño: qué parametrizar (sin cambiar markup ni clases)
`window.Chrome = { icon, svg, eye, card, column, qa, topbar, sidebar, statusbar, board, crt, mount, DATA, I }`
(todos devuelven **HTML string**; `mount(o)` reemplaza `[data-chrome]` por `el.outerHTML`).
- `card(d)` y `column(c)` **ya son data-driven** → alimentar con objetos vivos.
  - `card d`: `{name, mode:'ask|plan|edit|auto', ctx:0-100, lvl:'green|amber|red|dim', tokens:'45k', model, state:'working|attn|idle|standby|error', sel:bool, qaBtns:['ext','term','copy','x'], status:{kind:'attn|green|idle|standby|error', text, em?, spinner?:bool}}`
  - `column c`: `{name, fav:bool, count, meta:[{dot,label,color?}], cards:[card…], closedCount, closed:[{name,tokens}]}`
- `topbar/sidebar/statusbar/board` tienen **mocks hardcodeados** ("24 sesiones", árbol sidebar, "Σ 9.0M tok", "v0.4.2", "cómodo", "prioridad") → **agregar params** manteniendo clases/orden de nodos **byte-idénticos**. `mount(o)` es el punto de entrada: extender `o`, no cambiar el dispatch.
- Builders no escapan HTML → **agregar escape de `& < > "`** para datos vivos (nombres/branches/cmds), sin alterar estructura.
- No hay diff/re-render → re-render con **throttle ~250ms**; cuidar scroll/foco/estado de `<details>` y reinicio de animaciones.
- Markup de overlays (verbatim de los HTML): panel detalle (e2), palette (e3), banner+toast+`.perm` aprobar/denegar (e4), panes split (e5), sidebar colapsado (e6, lo genera chrome.js).

## Responsive (Hard Rule 2) — cómo, sin romper Hard Rule 1
- **Sidebar:** alternar el estado **colapsado E6 ya diseñado** vía JS según ancho de ventana (breakpoint).
- **Board:** fila flex de columnas de ancho fijo → **scroll horizontal natural**.
- **Overlays:** `app.css` aditivo con `max-width`/`clamp`/media queries usando **tokens existentes**
  para que panel/palette/toast se reajusten en ventanas chicas. No sobreescribe apariencia de componentes.
- QA a múltiples tamaños con skills de browser (ver abajo).

---

## Config / puerto
- Puerto hooks: **4517** default, configurable.
- Settings persistidas en `~/.consomni/config.json`: editor, terminal, dirs vigilados, umbral ctx,
  intervalo refresh, sonidos, puerto. Estado local (pin/fav/archivar) en `~/.consomni/state.json`.

---

## Skills de Claude Code en uso (Hard Rule: documentar)
Disponibles en el entorno (no requirieron instalación externa); se usan para QA de fidelidad/responsive:
- **gstack `browse` / `qa` / `qa-only`** — navegador headless: cargar el renderer/HTML y QA visual + a distintos viewports (sirve a Hard Rules 1 y 2).
- **gstack `design-review`** — ojo de diseñador: detecta inconsistencia visual/espaciado/jerarquía → fidelidad pixel-perfect.
- **`verify` / `run`** — levantar y manejar la app Electron para confirmar cambios en vivo.
- **`code-review` / `review`** — review de diffs antes de cerrar fases.
> Si durante el build aparece necesidad de una skill externa (p.ej. específica de Electron/packaging), investigar en internet, instalar y **documentarla acá** (cuál y para qué).

---

## Estado de fases
- [x] **Fase 0** — Exploración + plan (reporte posteado).
- [x] **Fase 1** — Scaffold Electron+TS + dashboard estático en Electron. Fidelidad verificada por
      screenshot (wide 1320 = idéntico a e1; narrow 720 = sidebar colapsa E6 + board scrollea).
- [x] **Fase 2** — Capa de datos read-only. `jsonl.ts` (parser head+tail), `sessions.ts` (scan+chokidar+
      snapshot debounced), `config.ts`, IPC (getSnapshot/onSnapshot/rescan). `chrome.js` parametrizado
      (mismo markup; sólo se agregaron atributos `data-*` invisibles para wiring + `esc()`). `app.js`
      transforma Session[]→builders. Verificado con datos reales (105 sesiones). Notas:
      windowSize se infiere del modelo y se sube a 1M si ctx>200k (el sufijo [1m] no está en el JSONL);
      estado JSONL es heurístico (los hooks lo refinan en Fase 3). PENDIENTE polish: overflow del topbar
      con counters largos → ajuste responsive en Fase 4.
- [x] **Fase 3** — Hooks. `hooks-server.ts` (express 127.0.0.1:4517: /hook + /health), `hooks-install.ts`
      (backup con timestamp + merge NO-destructivo + uninstall + detección + asar-unpack path + `commandWindows`),
      overlay de estado vivo en `sessions.ts` (`applyHookEvent`: SessionStart/UserPromptSubmit/Pre/PostToolUse→working,
      Notification→attn|idle, Stop→idle, SessionEnd→closed) + sesiones sintéticas para sesiones sólo-hook,
      onboarding on-brand (modal token-based en #overlays). Verificado: dry-run del merge (preserva permissions/
      model/effortLevel), POST de eventos → card attn + eye pulse + counters, y roundtrip real post.js→server.
      NOTA: NO instalé hooks en el settings.json real — queda a criterio del usuario vía el botón de onboarding.
- [x] **Fase 4** — Interacciones. Búsqueda (captura de teclado, filtra board por nombre/proyecto/branch),
      pills de modo (toggle), orden (dropdown + `s` cicla, 5 criterios), densidad cómodo/compacto,
      filtro por proyecto (sidebar/⌘1-9), panel de detalle E2 (vivo, con getSessionDetail: counts/files/
      subagentes/feed/sparkline est.), command palette E3 (fuzzy, sesiones/proyectos/acciones), mapa
      completo de atajos + help (?), multi-select, pin (setLocalState), toast, sidebar colapsado E6
      (responsive), polish responsive del topbar. Logos PNG en onboarding con cursor parpadeante.
      Overlays viven en #overlays (persistente); CSS de e2/e3 levantado a app.css con position:fixed.
      NOTA: atajos de ACCIÓN (o/t/y/Y/r/a/d/X) y botones del action-bar muestran toast "Fase 5" —
      las acciones reales se cablean en Fase 5.

### Logos
`build/consomni-logo-png-1.png` (con cursor ▮) y `-png-2.png` (sin cursor), RGBA transparente.
Copiados a `src/renderer/assets/logo/cursor-on.png` y `cursor-off.png`. El LOGO GRANDE (onboarding/
splash/about) alterna las dos cada 500ms (cursor parpadeante), pausa al perder foco. El wordmark del
topbar queda como Geist Mono real (NO se reemplaza por PNG). `consomni-logo-1.png`/`-2.png` (con fondo)
quedan para icono de la app en Fase 6.

### Verificación de UI sin ojos humanos
`CONSOMNI_EXEC=<js>` corre JS antes del screenshot (p.ej. `window.__consomni.openPalette()`,
`openDetail(firstSid())`, `openHelp()`). Útil para capturar overlays.
- [x] **Fase 5** — Acciones + atención + split. `actions.ts` (execFile/spawn con ARRAYS, detección de
      binario, fallbacks; paths van por opción `cwd` o como elemento único a exes reales → cero inyección).
      Atención: banner E4 + `.perm` inline aprobar/denegar + **notificación nativa** (Electron Notification;
      click → focus + jump a la sesión) + eye pulsando, todo alimentado por attn reales. Split/grid E5
      (panes con feed en vivo). Verificado: copy real e2e (clipboard), banner+perm por POST, split.
      **REAL:** abrir editor (code/cursor config), terminal (wt→powershell), carpeta, copy path/branch/id,
      transcript, git diff, abrir PR (gh), dispatch NUEVA sesión (wt/powershell + claude), pin/fav/archivar,
      multi-select, notificación nativa.
      **STUB honesto (toast + TODO):** aprobar/denegar (necesita hook PreToolUse bloqueante opt-in; nuestros
      hooks son fire-and-forget → no puede aprobar; dirige a la terminal), quick-reply a sesión EN CURSO
      (los hooks no inyectan prompts), pausar/matar (no expuesto por el control surface), re-dispatch.
- [x] **Fase 6** — Settings (overlay on-brand: editor/terminal/dirs vigilados/umbral/refresh/sonidos/
      puerto + instalar/desinstalar hooks) con persistencia (config IPC getConfig/saveConfig; watcher se
      reinicia si cambian dirs). electron-builder (portable + nsis) con icono. README (setup, atajos,
      leyenda de estados, real-vs-stub, privacidad). icon en build/icon.png.

### Packaging — gotcha winCodeSign (máquina sin Developer Mode/admin)
electron-builder re-extrae `winCodeSign` y falla creando 2 symlinks darwin (.dylib) por falta de
privilegio (necesita Developer Mode o admin). Como NO firmamos, lo evitamos con
`win.signAndEditExecutable: false` (+ `CSC_IDENTITY_AUTO_DISCOVERY=false` al buildear). Trade-off: el
`.exe` crudo no lleva icono/metadata embebidos vía rcedit; el icono SÍ va en el instalador NSIS, los
accesos directos (win.icon png→ico auto) y la ventana de la app (`BrowserWindow.icon` = assets/logo/app-icon.png).
NSIS necesita .ico real → no pasar `installerIcon` png; dejar que electron-builder derive de win.icon.
Build: `Remove-Item Env:ELECTRON_RUN_AS_NODE; $env:CSC_IDENTITY_AUTO_DISCOVERY='false'; npm run dist`.

### git
consomni NO tenía .git propio; el repo de `~/OneDrive/Escritorio` (vacío) lo contenía. Se hizo
`git init` dentro de consomni (repo propio), remote → github.com/JoaquimColacilli/consomni.git.

## Comandos de dev
- `npm install` — deps (Electron, TS, electron-builder, chokidar, express).
- `npm run build` — compila TS (`src/main` + `src/preload` → `dist/`). El renderer es vanilla, no se compila.
- `npm run dev` / `npm start` — compila + lanza Electron.
- `npm run dist` — empaqueta Windows (portable + nsis) en `release/`.

### ⚠️ GOTCHA al correr Electron desde el entorno del agente (Claude CLI)
El host del Claude CLI exporta **`ELECTRON_RUN_AS_NODE=1`** globalmente. Si lanzás
`electron .` con esa var puesta, corre como **Node puro** y falla con
`Cannot read properties of undefined (reading 'requestSingleInstanceLock')` (porque
`require('electron').app` es undefined). **Antes de lanzar, limpiala:**
`Remove-Item Env:ELECTRON_RUN_AS_NODE`. Usuarios normales / la app empaquetada NO sufren esto.

### Verificación visual sin ojos humanos
`main/index.ts` tiene un screenshot dev-only: `CONSOMNI_SHOT=<png>` captura la ventana y cierra.
`CONSOMNI_W` / `CONSOMNI_H` fijan el tamaño (para probar responsive). `CONSOMNI_DEVTOOLS=1` abre devtools.
Ejemplo: `Remove-Item Env:ELECTRON_RUN_AS_NODE; $env:CONSOMNI_SHOT="$env:TEMP\s.png"; $env:CONSOMNI_W=720; electron .`
