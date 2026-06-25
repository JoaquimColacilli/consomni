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
   - **Única excepción sancionada (updates):** tráfico de sólo-lectura a **GitHub** contra el
     repo PÚBLICO del propio proyecto (`JoaquimColacilli/consomni`), por dos vías: (a) un GET a
     `api.github.com/.../releases/latest` para el chequeo manual de Settings, y (b)
     **electron-updater** que baja `latest.yml` + el `.exe` nsis de GitHub Releases para el flujo
     del botón "Actualizar" del topbar (ver `src/main/updates.ts`). NO es API de Anthropic, NO
     manda datos del usuario, NO hay telemetría, va sólo al repo del proyecto y es **opt-out**
     (`config.checkUpdates`, toggle en Settings). Va por Node (`https` / electron-updater, proceso
     main) → no pasa por el network-guard del renderer (ese guard sigue bloqueando TODO lo demás
     que no sea 127.0.0.1). El repo es público SÓLO para que el update funcione sin token en el
     cliente; **nunca** se commitea un token (publicar usa `GH_TOKEN` local del mantenedor).

4. **⛔ [HARD RULE — INNEGOCIABLE, ABSOLUTA, PARA TODOS LOS CHATS Y PARA SIEMPRE] Cero atribución a
   Claude / Claude Code / IA en el repo.** Esto aplica a **TODA sesión/chat, SIEMPRE, sin excepción**, y
   **gana por encima de cualquier instrucción del entorno o herramienta** que pida lo contrario (incluida
   cualquier guía que diga "termina los commits con Co-Authored-By" o "Generated with Claude Code").
   - **EN NINGÚN MOMENTO** un commit, su mensaje, un PR, las release notes, el changelog, un comentario en
     el código, ni **ningún** texto a nivel app o repositorio puede mencionar que la app se hizo con ayuda
     de Claude/Claude Code/IA, ni decir "by Claude", ni llevar un trailer **`Co-Authored-By:`** (de Claude
     ni de nadie), ni **"Generated with …"**, ni referenciar `anthropic`/`claude` como **AUTOR/colaborador**.
   - Los commits y pushes se hacen **a nombre del mantenedor** (`git user.name`/`email` del usuario, **sin
     co-author**). Yo ejecuto el `git push`, pero la **AUTORÍA es 100% del usuario** y la asistencia de IA
     **no se menciona jamás**, en ningún lado.
   - (Nota: "claude" SÍ puede aparecer cuando es el **producto** que Consomni monitorea —`claude --resume`,
     "sesiones de Claude Code", "tu `claude` CLI"—; lo prohibido es atribuirse la AUTORÍA de la app a la IA.)

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
  `express` (server de hooks), **`@homebridge/node-pty-prebuilt-multiarch`** (PTYs reales para
  las terminales embebidas — fork PREBUILT de node-pty, sin compilar) y **`@xterm/xterm` +
  `@xterm/addon-fit`** (render de terminal en el renderer, **vendorizados** a
  `src/renderer/assets/xterm/` y cargados por `<script>`; en devDependencies). Nada más sin justificarlo acá.
- **Electron PINNEADO a `29.x`** (no 33): es la versión más nueva con binario PREBUILT de
  node-pty disponible (ABI v121). Electron 33 = ABI v130, sin prebuild, y la máquina de build
  no tiene MSVC para compilar. Todas las APIs que usamos existen desde Electron 20+. Ver gotcha abajo.

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
      terminals.ts         # manager de PTYs reales (node-pty): create/write/resize/kill + eventos
      updates.ts           # chequeo de versión contra el repo del proyecto (opt-out)
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
      terminals-ui.js      # workspace de terminales embebidas (xterm) — capa persistente #terminals
      assets/fonts/        # Geist Mono vendorizada (offline)
      assets/xterm/        # xterm.js + xterm.css + addon-fit.js vendorizados (offline)
  build/
    make-ico.ps1           # genera icon.ico multi-res desde icon.png (System.Drawing)
    prep-wincodesign.ps1   # pre-extrae winCodeSign sin symlinks darwin (para rcedit sin admin)
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
| `Notification` | `attn` SÓLO si es pedido de PERMISO; cualquier otra (idle, login, info) → `idle` | `classifyNotification` ahora **solo** marca `attn` ante permiso real (default = `idle`, NO `attn`). Ver v1.6.2 |
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
- **REAL:** **terminal embebida** (`term` → xterm + PTY real en el `cwd`, full-screen) y
  **dispatch = sesión `claude` embebida** (`dispatch` → shell + `claude` en el `cwd`), ambas
  via el workspace de Terminales (ver abajo). abrir VSCode (`code <cwd>`), carpeta (`explorer`),
  copiar path/branch/id (clipboard Electron), ver transcript (`.jsonl`), `git -C <cwd> diff`,
  pin/fav/archivar (estado local `~/.consomni`), abrir PR (`gh pr ...`), abrir URL externa
  (`shell.openExternal`, https only — para el link del autor).
- **PARCIAL:** aprobar/denegar permiso → requiere hook `PreToolUse` que **bloquee y consulte** a
  Consomni (riesgo de freeze/timeout). **Default: observar + toast + saltar a la terminal.**
  Interceptación bloqueante = opt-in en Settings.
- **STUB honesto (TODO, no inventar):** quick-reply / pausar / matar / re-dispatch sobre sesiones
  EXTERNAS (las detectadas por transcript). Los hooks no inyectan prompts ni matan sesiones, y a
  un proceso `claude` que ya corre afuera NO le podemos enchufar una PTY interactiva (no tenemos
  su handle). Lo interactivo de verdad son las terminales que Consomni LANZA (workspace embebido).

## Terminales embebidas (dock tiling) — v0.6.x
- **Qué (v0.6.1, MALEABLE/tiling):** Consomni pasó de puro observador a **también hospedar terminales
  reales adentro**. Es un **DOCK abajo, a la DERECHA del sidebar** (no lo tapa nunca salvo zoom; queda
  arriba del statusbar) que es un **MOSAICO de paneles**: cada panel se **divide a la derecha (columna)
  o abajo (fila)** y los **divisores se arrastran** para redimensionar; el **borde superior del dock
  se arrastra** para cambiar su alto. Dos tipos de panel:
  - **terminal:** PTY real (xterm) — shell o `claude` (muestra su UI/thinking tal cual).
  - **sesión:** la **conversación read-only** de un claude detectado en disco (turnos user/assistant
    del transcript), con botones "claude acá / terminal / VSCode / detalle".
- **Reubicar (drag):** se **arrastra un panel de su barra de título** a un borde de otro (drop-zones
  izq/der/arriba/abajo, indicador verde) para moverlo en el mosaico (`detachPane`+`insertPaneAt`).
- **Minimizar:** el chevron colapsa el dock a una **barra fina** (sólo el toolbar, con contador) que
  queda siempre visible/reabrible (`body.dock-min`); restaurar con el chevron o clickeando la barra.
  Hay un item **"inicio"** arriba del sidebar (`data-act="home"`) que abre las terminales a pantalla completa.
- **⚠️ Gotcha de click (resuelto v0.6.1):** la card vive DENTRO de `.col[data-proj]`, así que el handler
  de click DEBE chequear `.card[data-sid]` ANTES que `[data-proj]` (si no, clickear una card filtraba el
  proyecto en vez de abrir la conversación). Orden correcto en `app.js`: closed-row → card → data-proj.
- **Interacción:** **click en una card → abre/foco un panel con la conversación de esa sesión**
  (no el overlay E2; E2 queda en el botón "detalle"). Nuevos paneles: `>_` del sidebar · Shift+T ·
  "+" del board · botones "terminal/claude" del toolbar del dock · botones split de cada panel ·
  `term`/`dispatch` de cualquier card. Zoom (botón maximizar) = pantalla completa; ocultar = las PTYs
  siguen vivas. **NO hay tabs** — es tiling (como Warp/tmux/VS Code splits).
- **Responder (v0.6.2):** el botón **"responder"** del panel de sesión lanza `claude --resume <id>`
  en una PTY embebida → **reanuda ESA conversación de forma interactiva** y ahí sí podés escribir.
  (el id se sanitiza `[A-Za-z0-9_-]` porque se tipea en el shell). Es la forma de "responderle" a una
  sesión: no se le puede inyectar a un proceso que ya corre, pero `--resume` la continúa.
- **Sidebar nunca tapado (v0.6.2):** ni el dock ni el zoom cubren el sidebar (`#terminals.dock` y
  `.maximized` arrancan en `left:var(--sb-w)`). "inicio" **comprime** el sidebar (no lo cierra) vía
  colapso manual (`state.userCollapsed`, toggle `data-act=sbtoggle` con chevron que rota); se expande igual.
- **Límite honesto:** a un claude que YA corre afuera NO se le puede enchufar una PTY interactiva
  (no hay handle); por eso "responder" usa `--resume` (continúa la conversación desde el transcript).
- **Arquitectura:** `main/terminals.ts` (node-pty: `createTerm/writeTerm/resizeTerm/killTerm`,
  eventos `term:data`/`term:exit`; carga PEREZOSA y tolerante a fallos del .node) ↔ IPC
  (`termCreate` invoke; `termWrite`/`termResize` send; `termData`/`termExit` push) ↔ preload
  (`consomni.term.*`) ↔ `renderer/terminals-ui.js` (`window.ConsomniTerms`: árbol de splits en el DOM —
  `.dk-split.row|col` con `.dk-splitter` entre hijos `flex:1 1 0`; cada `.dk-pane` tiene xterm o
  conversación — en `#terminals`, **capa PERSISTENTE** que el re-render del board NO toca; el dock
  enruta `term:data` por el id de la PTY: `terms: Map<ptyId,{term,fit,pane}>`). Splitear envuelve el
  panel en un split (o inserta hermano si ya hay split en esa dir); cerrar desenvuelve splits de 1 hijo.
  La conversación viene de `parseSessionDetail().convo` (turnos recientes user/assistant, dedupe por
  `message.id`, filtra ruido de slash-commands). Shell: `pwsh`→`powershell`→`cmd`; `claude` se arranca
  escribiendo `claude\r` al primer `onData`.
- **Layout:** el dock NO encoge `.app` (el sidebar queda full-height); `#terminals.dock{left:var(--sb-w);
  bottom:var(--sbar-h)}` (sidebar 238px / 56px colapsado vía `body.sb-collapsed`; statusbar 27px);
  `body.dock-open .board{padding-bottom:var(--dock-h)}`; `.maximized{inset:0}`. z-index 40 (overlays 50).
- **Tamaño/resize:** xterm se monta, `fit()` mide cols/rows, recién ahí se crea la PTY; en split / drag
  de divisor / drag del alto del dock / resize de ventana se re-`fit()` (todas las visibles) y `resize()`.
- **⚠️ Gotcha de ALTO (resuelto v0.6.3):** `.xterm{height:100%}` sobre un body sin alto definido era
  circular → el contenido de xterm (`rows*cellHeight`) INFLABA el panel (peor al reanudar sesiones que
  vuelcan mucho texto: "toda en vertical alto"). Fix: **xterm en `position:absolute;inset` dentro de
  `.dk-pane-body`** (no aporta alto) + **forzar el llenado del árbol con `height:100%`/`width:100%`**
  (`.dk-split.row>* {height:100%}`, `.dk-split.col>* {width:100%}`, `.dk-root>* {height:100%;width:100%}`)
  porque el `align-items:stretch` del flex NO propagaba el alto por el árbol anidado. Verificado:
  pane=split (lleno). Además `ResizeObserver` por panel + re-fit en `document.fonts.ready`.
- **Pantalla completa NO tapa el sidebar (v0.6.3):** `.maximized` arranca en `left:var(--sb-w)`; al
  maximizar se **comprime** el sidebar de forma NO pegajosa (`setMaxObserver` guarda el estado previo y
  lo restaura al salir). Botón **"salir"** (ámbar, visible sólo en maximized) vuelve al dock. Drag de
  panel: `preventDefault` en mousedown + `user-select:none` para no seleccionar texto al arrastrar.
- **Persistencia + "inicio" (v1.1.0):** el layout del dock (árbol de splits + cada panel: kind/cwd/sid/
  resume + alto/ancho) se guarda en **`~/.consomni/dock.json`** vía IPC (`getDock`/`saveDock`; NO
  localStorage — falla bajo `file://`). Al arrancar, `restoreSession()` reconstruye y abre **siempre en
  "inicio"** (maximizado) con las terminales que quedaron. El panel de sesión muestra el **proyecto**
  asociado. Resize de **ANCHO** además del alto: borde izquierdo arrastrable → `--dock-x` (offset desde el
  sidebar); ambos drags hacen `liveFit()` (re-fit por frame; el ResizeObserver llega tarde → si no, se
  "corta" la terminal en vivo). Iconos del sidebar colapsado llevan `data-proj` (clickearlos sale de "inicio").
- **⚠️ Bug fijado (v1.1.0):** `isMaximized()` se usaba como función top-level pero sólo existía como
  método inline del API → `notifyMax`/`persist` tiraban ReferenceError (tragado por try/catch) → el
  `maxObserver` (colapso/restore del sidebar) y la persistencia estaban ROTOS. Ahora es función real.
- **Dock CONTEXTUAL + fijar + claude ⚡ (v1.2.2):** el dock dejó de ser un único árbol siempre-visible;
  ahora lo que muestra depende de la VISTA. Cada panel se taguea con `proj` (id = `projKey`, igual que la
  vista; + `projname` lindo para mostrar) y `pinned`. **inicio** muestra los paneles `pinned` + los sueltos
  (sin `proj`, abiertos ahí — nunca quedan huérfanos); **vista de proyecto** muestra los de ese `proj`.
  Al cambiar de vista, los que no matchean van a un `.dk-pool` OCULTO (las PTYs siguen vivas) y los que sí
  se re-arman en **FILA simple** (decisión del usuario: no se recuerda el tiling custom por-vista). Click en
  un proyecto del sidebar → `setActiveProject` llama `ConsomniTerms.openProject(projKey, cwd, name)` →
  maximiza el dock con SUS terminales; "todos" → `setView('__home__')` (board como antes). Una terminal
  nueva abierta en una vista de proyecto arranca en el **cwd del proyecto** (`viewCwd`, derivado de las
  sesiones del grupo). **★ fijar:** botón en el head del panel → `pinned` → aparece en inicio (oculto en
  paneles sueltos, que ya viven ahí; se sacan con la ✕). **Persistencia v2:** `dock.json` guarda la LISTA de
  paneles de inicio (`pinned`/sueltos) — los no-fijados de un proyecto son efímeros; restore reconstruye y
  arranca en inicio (compat v1: si hay `{layout}` viejo, se aplana a fijados). **claude ⚡:** botón ámbar en
  el toolbar del dock + acción "claude ⚡" en el panel de sesión → `spawn('claude',…,{skip:true})` →
  `createTerm` arma `claude --dangerously-skip-permissions` (combina con `--resume` si aplica).
- **Fixes del dock contextual (feedback del usuario, v1.2.3):**
  - **Entrar a un proyecto AUTO-ABRE sus sesiones activas.** Antes la vista de proyecto sólo re-armaba
    paneles ya tagueados con ese `proj`; si no había, mostraba el placeholder aunque el proyecto tuviera
    sesiones vivas en disco. Ahora `setActiveProject(p)` pasa `projActiveSessions(p)` (sesiones del snapshot
    con `state!=='closed'`, mapeadas a `{sid,name,projName}`) a `openProject(projId,cwd,name,sessList)`, que
    crea un panel de sesión por cada `sid` que NO esté ya abierto (**dedupe por el `Map sessions`**), tagueado
    al proyecto (NO pinneado → efímero). El placeholder sólo queda si el proyecto no tiene paneles NI sesiones
    activas. `openProject` setea `view=projId` antes de crear los paneles (así no se pinnean) y persiste.
  - **El marcador activo del sidebar sigue la vista real** (antes "todos" quedaba marcado aun estando en
    inicio). Se deriva en vivo `homeView = ConsomniTerms.isMaximized() && getView()==='__home__'` (nuevo
    accessor `getView` en la API del dock). `transform()` lo pasa como `tree.home`; `chrome.js` marca `.active`
    en **inicio** (`.sb-home` / `.ci-home`) cuando `tree.home`, y desactiva "todos" (`!tree.home && active==='all'`,
    también en el ícono colapsado). El `maxObserver` ahora hace `render()` SIEMPRE (no sólo al des-maximizar) para
    reflejar el cambio de vista. CSS aditivo: `.sb-home.active` reusa el lenguaje de `.sb-item.active` (barra roja
    `inset 2px 0 0 rgba(239,68,68,.75)` + tokens existentes).
  - **El dock maximizado ya NO tapa topbar ni statusbar** (antes `top:0;bottom:0` clipeaba la 'C' del wordmark
    y "hooks" con el sidebar colapsado a 56px). Ahora `#terminals.dock.maximized{top:54px;bottom:var(--sbar-h)}`
    (54px = alto del topbar, igual que el panel E2) → logo y statusbar enteros visibles, el dock cubre sólo el board.
  - **`archivados` ahora se ve en el sidebar colapsado:** `transform()` agrega un ítem `ci` con `icon:'archive'`,
    `proj:'__archived'` (mismo target que el ítem expandido) cuando `archivedGroups.length`.
- **Fixes v1.2.4 (feedback del usuario):**
  - **"responder" continúa la sesión EN EL MISMO panel.** Antes `dispatchAction('resume')` abría una terminal
    nueva. Ahora `ConsomniTerms.resumeSession(sid, cwd)` busca el panel de sesión abierto (Map `sessions`), lo
    des-registra y lo convierte in-place a una terminal `claude --resume` (mismo `.dk-pane`, vía `mountTerminal`);
    sin panel abierto, cae a `spawn` (terminal nueva). El id se sanitiza `[A-Za-z0-9_-]` (se tipea en el shell).
  - **"archivados" abre su board** (antes quedaba vacío). `'__archived'` ya NO se trata como proyecto (no
    `openProject`): `setActiveProject` lo manda al board (como "todos") y `transform` usa
    `boardGroups = archivedGroups` cuando `activeProject==='__archived'`. El ítem del sidebar (expandido y
    colapsado) se marca `.active`.
  - **Entrar a un proyecto auto-abre activas + cerradas recientes** (no sólo activas). `projSessions(p)` ordena
    activas primero y rellena con las cerradas más recientes hasta `AUTO_OPEN_MAX=8` (las activas nunca se
    descartan); cada panel cerrado se continúa con "responder".
  - **"+ agregar" abre un selector de carpeta nativo** (`dialog.showOpenDialog openDirectory` vía IPC
    `consomni:pickFolder` + preload `pickFolder`). El path se normaliza a `projId` y se abre como proyecto
    (`openProject(projId, path, name, projSessions(projId))`); si la carpeta no tiene sesiones, muestra el
    placeholder-guía en su cwd para abrir terminal/claude.
  - **Cerrar las terminales de un proyecto muestra SUS cards** (no el placeholder). El dock consulta
    `boardChecker(projId)` (registrado desde app.js = `projHasCards`): en una vista de proyecto SIN paneles, si
    el proyecto tiene cards → `minimize()` el dock → el board (filtrado a `activeProject`) muestra las cards; si
    no tiene cards (carpeta nueva) → placeholder-guía. `closePane` enruta por `showView`, que decide.
- **Fixes v1.2.5 (feedback del usuario):**
  - **Click en una terminal del dock ya NO abre OTRA terminal ni le roba el foco al xterm.** El handler de
    click del board (document) procesaba clicks de adentro del dock: un click en una terminal matcheaba el
    `[data-proj]` del `.dk-pane` → `setActiveProject` → `openProject` → reabría un panel y re-renderizaba
    (robando el foco). Fix: guard al inicio del handler → `if (t.closest('#terminals')) return;` (el dock ya
    maneja sus propios clicks vía listeners con `stopPropagation`; sus botones usan `data-dock-act`, no `data-act`).
    Recordatorio: aprobar/denegar de Consomni sigue siendo STUB (no intercepta permisos); se responde en la
    TUI de claude, o se abre con **claude ⚡** (`--dangerously-skip-permissions`) para no preguntar.
  - **"archivados" responsive (no se pierde a la derecha).** Eran N columnas casi vacías (una por proyecto
    archivado) desbordando en scroll horizontal. Ahora `transform()` togglea `body.view-archived` cuando
    `activeProject==='__archived'` y `body.view-archived .board{flex-wrap:wrap;align-content:flex-start;
    overflow-x:hidden;overflow-y:auto}` → las columnas (316px) ENVUELVEN en grilla y entran todas. Aditivo,
    sólo afecta la vista de archivados (el board de "todos"/proyecto sigue con scroll horizontal por diseño).
  - **Proyectos "fijados" (kept) — no desaparecen del sidebar al cerrar sus terminales.** Antes un proyecto sin
    sesiones activas caía a `archivados`. Ahora, al ENTRAR a un proyecto (sidebar o "+ agregar") se agrega a
    `config.keptProjects` (persistido); `liveGroups` pasa a `g.active>0 || g.fav || isKept(g.id)` → sigue en
    "activos" aunque cierres todo. Dentro del proyecto, sus **sesiones finalizadas** se muestran abajo, opacas y
    AUTO-EXPANDIDAS (`col.openClosed` cuando es vista de UN proyecto; en "todos" quedan colapsadas). **'x'** en
    hover sobre el item (proyecto con 0 activas → `it.finished`) lo saca del sidebar (`data-unkeep` →
    `unkeepProject` → vuelve a caer en archivados). `state.keptProjects` se carga de config al iniciar.
  - **Aviso al cerrar una terminal VIVA (corta el proceso).** `closePane` separa el gate del cierre real
    (`doClosePane`): si el panel es terminal `shell`/`claude` con PTY (`data-tid`) y `config.confirmCloseTerminal`,
    el dock llama `closeConfirmer` (registrado por app.js vía `setCloseConfirmer`) → modal on-brand `.cfm-*`
    (en `#overlays`, z-index 60) con texto adaptado (claude: "se corta el proceso, perdés el contexto en vivo; el
    transcript queda → reanudás con responder / `--resume`") + checkbox **"no volver a mostrar"** (apaga
    `confirmCloseTerminal` en config). Los paneles de SESIÓN read-only se cierran directo (no hay proceso que perder).
- **Seguridad:** sigue **cero API de Anthropic** — Consomni sólo hospeda el proceso; `claude` hace
  lo suyo. Se borra `ELECTRON_RUN_AS_NODE` del env del hijo.

---

## v1.3.0 — Planes/Frentes · Terminal IA local · Notificaciones · Tutorial
> Cuatro features que van juntos (feedback de Facundo + Franco). Versión bumpeada **1.2.5 → 1.3.0**
> (`package.json` + fallbacks `brand-ver`/`.ver` en `chrome.js`). Todo verificado por screenshot.

### 1) Tablero de PLANES / SPECS ("frentes")
- **Qué:** vista nueva (item **planes** en el sidebar, al lado de **inicio**; `data-act="plans"`, icono
  `tasks`) que agrupa por proyecto los **planes** y **tareas** de tus sesiones — "qué está pendiente y qué
  ya se hizo" (Facundo) + "frentes encarpetados que flageo y no comparto" (Franco). **Cero fuentes nuevas,
  cero API:** sale de los `.jsonl` que YA leemos + glob read-only del repo.
- **Fuentes (en `jsonl.ts → collectPlan(all)`):** `TodoWrite` (status `pending|in_progress|completed`; ⚠️ el
  array se REEMPLAZA → vale el ÚLTIMO) · `ExitPlanMode` (hubo plan + ts; el texto del plan NO está en el
  `.jsonl`) · **Task tools** v2.1.142+ (`TaskCreate`/`TaskUpdate` reconstruidos por `taskId`, defensivo al
  field-repair; gana la fuente más reciente vs TodoWrite). Adjunta `session.plan: SessionPlan` SÓLO si hay
  algo (snapshot liviano; todos capados a 60, content 200). Docs `plan.md`/`spec.md` → `findPlanDocs(cwd)`
  en `sessions.ts` (glob por nombre `plan|spec|design|architecture|roadmap|rfc|prd` o carpeta `.specs/|plans/…`,
  prof ≤3, salta `node_modules`/`.git`, tope 24), on-demand vía IPC `getPlanDocs(cwds[])` (no en cada snapshot).
- **UI (`app.js`):** `planView()` agrupa por `projKey`, suma rollups, ordena inProgress→pending→reciente.
  Reusa `.board`+`.col` pero los frentes **ENVUELVEN en grilla** (`.plans-board{flex-wrap:wrap;overflow-y:auto}`)
  → se ven todos con scroll VERTICAL (rueda del mouse), responsive a cualquier ancho (el scroll horizontal
  escondido confundía: parecía "sin scroll"). Cada frente: pill de **estado MANUAL** (ciclo
  `sin estado→backlog→dev→idea→pausado→listo`), barra de progreso, cards por sesión (rollup + checklist
  `<details>`), docs con "abrir" (acción `openDoc` nueva en `actions.ts`), y **nota privada** (textarea).
  "continuar" → `resumeSession` (`claude --resume`); "detalle" → E2. Al entrar se **minimiza el dock**.
- **Privado y local:** estado + nota viven en `config.frentes: {[projKey]:{status,note}}` (persistido por
  `saveConfig` con debounce). El foco/caret de la nota se preserva entre re-renders (capture+restore en
  `render()`; input por delegación, NO re-render). El keydown global ahora ignora atajos si hay
  `INPUT`/**`TEXTAREA`** con foco (antes 's'/'j'/'T' rompían la escritura). Marcadores del sidebar: `tree.plans`.

### 2) Terminal · "COMANDOS RÁPIDOS" (atajos + lenguaje natural, tipo Warp `#`)
> **Rediseñado tras feedback del usuario** (la 1ª versión —✨ oculto detrás de un toggle de Settings— no se
> entendía / no se encontraba; encima confundía con sesiones de prueba que clutteraban el sidebar). Ahora es
> **visible y se activa fácil**: botón **comandos** en el toolbar del dock + ✨ en cada terminal (SIEMPRE
> visibles, sin gate). Abre una barra `.dk-ask` con **chips de atajo** (crear carpeta…, git status, últimos
> commits, listar por tamaño, árbol de archivos, buscar archivo…) + un input de lenguaje natural.
- **Dos caminos (ambos INSERTAN en la PTY sin `\r` → revisás y Enter; NUNCA auto-ejecuta):**
  - **Atajos deterministas (`ASK_PRESETS` con `cmd`)** → insertan el comando al toque, **gratis e instantáneo**
    (no llaman a claude). Ej: `git status`, `Get-ChildItem | Sort-Object Length -Descending`.
  - **Lenguaje natural (input + "traducir", o presets con `q` que prellenan)** → `terminals.ts → nlToCommand`:
    `claude -p "<texto>" --model haiku --append-system-prompt "<translate-only: ONE PowerShell command, never
    call tools, # no-op si imposible>" --disallowedTools … --output-format json`, **stdin cerrado** (si no,
    `-p` espera ~3s), `timeout 30s`, `ELECTRON_RUN_AS_NODE` borrado. Parsea `.result`, `sanitizeCommand()` →
    una línea. IPC `consomni:nlCommand` → preload `term.nl`. ~5–7s, ~US$0.02/ask (gasta el uso de claude del user).
- **UI:** `terminals-ui.js → toggleAsk(pane)` (barra entre head y body, refit) · `openQuickCommands()` (botón
  del toolbar → abre en la terminal enfocada / la 1ª / spawnea shell) · `insertCmd(pane,text)` (write sin `\r`).
  El ✨ ahora se muestra SIEMPRE en paneles terminal (CSS `.dk-pane--shell/.dk-pane--claude .dk-ask-btn`); se
  removió el gate `#terminals.nl-on` y el toggle de Settings (`setNlEnabled` quedó no-op por compat).
- **NO viola Hard Rule 3:** spawnea el CLI del usuario (Consomni nunca tiene key ni pega a `api.anthropic.com`).
  `config.nlModel='haiku'`. NO usar `--bare` (exige `ANTHROPIC_API_KEY` → driftea la regla).
- **Limpieza:** las sesiones de prueba que generó la verificación empírica de `claude -p` (carpetas `nltest-*`
  / `Temp` en `~/.claude/projects`) se borraron (eran artefactos de testing, no del usuario).

### 3) Notificaciones (centro + changelog)
- El **bell** del topbar (`data-act="notifs"`) ahora abre un panel con las notificaciones + **badge** rojo de
  no-leídas (persistido en `localStorage 'consomni.notif.seen'`). Al detectar nueva versión (evento
  `update-available` o chequeo manual de Settings) se agrega una notif **"Nueva versión vX"**; al click →
  **modal de changelog** con las release notes de esa versión (render markdown SEGURO: `renderNotes`/`inlineMd`
  escapan TODO y aplican headings/bullets/`**bold**`/`` `code` ``/links). Botón "Actualizar ahora" (si el
  flujo de descarga está disponible) o "listo". Convive con el toast persistente de update (z-60).
- **`updates.ts`** ahora incluye `notes`/`name`/`publishedAt` en `checkForUpdate()` (de `json.body`) y en el
  evento `update-available` (`normalizeNotes` aplana el `releaseNotes` string|array de electron-updater).
- QA: `__consomni.simulateUpdate('available',{latest,name,notes,url})` + `__consomni.openNotifs()` /
  `__consomni.openChangelog({…})`.

### 4) Tutorial (coachmark spotlight) — para Planes
- Tour paso a paso que **opaca todo MENOS el elemento resaltado** (recorte EXACTO vía `box-shadow:0 0 0 9999px`
  sobre un div posicionado en el `getBoundingClientRect` del target + borde/glow verde) y una tarjeta al lado
  con flecha. 7 pasos que explican Planes (la idea de Facundo: spec → plan → chunks → pendiente/hecho).
  **Responsive:** reencuadra en `resize` y en cada `render()` (rAF); el `place` cae a top/right/left si no
  entra abajo; clamping al viewport. Pasos con `before` que abren la vista (`openPlansForTour`) y `alt`
  selectors; `open` despliega un `<details>`. Navegación: botones `data-tour` + teclado (←/→/Enter/Esc).
- **Trigger:** auto la 1ª vez que abrís Planes (`maybeStartPlanTour`, gate `localStorage 'consomni.tour.plans'`);
  replay desde el botón **"tutorial"** de la intro de Planes (`data-act="plan-tour"`) o la palette ("Tutorial
  de Planes"). Engine genérico (`startTour(steps)`) reutilizable para otros features.
- **⚠️ Gotchas (fixed, feedback del usuario + review adversaria):**
  - Footer desbordaba "siguiente" en angosto (puntos `flex:1` + botones `flex:none`). Fix: footer en **DOS
    filas** (`.tour-foot{flex-direction:column}`): puntos arriba, `.tour-actrow` abajo (`saltar` con
    `margin-right:auto`). Verificado 760px/1440px.
  - **Target abajo del fold no se veía** (paso "Tu nota"): `paintTourStep` ahora hace
    `target.scrollIntoView({block:'center'})` ANTES de recortar → el elemento entra a la vista y se spotlightea.
  - **Tour en Planes vacío** apuntaba a `.plan-col` inexistentes → `planTourSteps()` chequea `planView().length`:
    sin datos, muestra sólo intro + nav + un paso "todavía no hay frentes" (no targetea elementos ausentes).
- **⚠️ Otro fix de la review:** `jsonl.ts` `TAIL_BYTES` 384KB→**640KB** para que `collectPlan` alcance el último
  `TodoWrite`/`ExitPlanMode` en archivos grandes (transcripts gigantes de varios MB: limitación conocida del medio).

---

## v1.4.0 — BIBLIOTECA (prompts / skills / rules reutilizables)
> Panel nuevo para guardar, editar y reutilizar los prompts que usás seguido (ej: "Revisión de PR",
> "Crear app desde cero"). Bump **1.3.0 → 1.4.0**. Mapea 1:1 sobre el patrón de **Planes** (item del
> sidebar → vista full → estado persistido) + el motor de **tutorial**. Cero libs nuevas, 100% local.

- **Sidebar:** item **`biblioteca`** (icono `book`, tag "prompts") entre `planes` y los proyectos —
  expandido `.sb-lib` + colapsado `.ci-lib` (`chrome.js`, `data-act="library"`). Marcado activo por
  `tree.library`; "todos" se desactiva con `!tree.library` (igual criterio que Planes/inicio). Flag de
  vista `state.libraryOpen`, branch en `buildShell()` (`buildLibrary(o)`), mutuamente excluyente con
  plansOpen/home (se limpia en `openPlans`/`setActiveProject`/home). Al entrar **minimiza el dock**.
- **Modelo de datos** (`types.ts`): `LibEntry {id,kind:'prompt'|'skill'|'rule',title,content,tags[],
  createdAt,updatedAt,seed?}`. CRUD completo: crear/editar/eliminar (con confirm `.cfm-*`)/duplicar.
- **Storage DEDICADO `~/.consomni/library.json`** (NO `config.json`): `loadLibrary/saveLibrary` en
  `config.ts` (clon de `loadDock/saveDock`); IPC `getLibrary`(handle)/`saveLibrary`(on) +
  `exportLibrary`/`importLibrary` (diálogo nativo, como `pickFolder`). **Por qué dedicado:** evita el
  `rescanNow()` que dispara `saveConfig` en cada save y no infla config.json. Preload: `getLibrary/
  saveLibrary/exportLibrary/importLibrary`. **Seeds idempotentes:** la 1ª vez (`!seeded`) se siembran
  5 ejemplos (cubren los 3 tipos) y se marca `seeded:true` → borrar un seed NO lo resucita.
- **UI (`app.js`):** `buildLibrary` = topbar + sidebar + `.lib-wrap`{intro + toolbar + board}. **Board**
  = cards que ENVUELVEN en grilla (`flex:1 1 300px`, responsive, scroll vertical; full-width <720px).
  **Toolbar:** buscador de texto (filtro VIVO con restore de foco/caret en `render()`, como `.frente-note`)
  + chips de tipo (todos/prompt/skill/rule con contador) + chips de #tag. **Card:** badge de tipo,
  título, preview con fade-mask, tags, acciones **copiar** / **insertar** / editar / duplicar / eliminar.
  **Editor:** modal en `#overlays` (`.lib-edit-*`, reusa lenguaje `.set-*`): segmentado de tipo + título
  + textarea + tags; guarda en CRUD (no por tecla). `state.libEditOpen` entra en `anyOverlayOpen`/Esc.
- **Copiar / Insertar:** copiar → `actions.ts` nuevo `case 'copyText'` (clipboard genérico). Insertar →
  `terminals-ui.js` nuevo `ConsomniTerms.insertIntoFocused(text)` (escribe en la PTY enfocada SIN `\r`,
  insert-don't-exec; trae el dock a la vista; devuelve false si no hay terminal → toast "abrí una terminal").
- **Tutorial:** reusa `startTour` con **doneKey parametrizado** (fix: `endTour` escribía siempre
  `consomni.tour.plans` → ahora `TOUR.doneKey`; plans usa `consomni.tour.plans`, biblioteca
  `consomni.tour.library`). `libraryTourSteps()` con guard de "vacío" (no apunta a `.lib-card` inexistente).
  Auto la 1ª vez (`maybeStartLibraryTour`) + replay (botón intro `pi-tour` + palette). Palette: filas
  "Abrir Biblioteca" / "Nuevo item" / "Tutorial de Biblioteca".
- **⚠️ Gotcha (fix, feedback del usuario):** el botón "tutorial" de la intro tenía clase `lib-tour` pero el
  override de ancho apuntaba a `.pi-tour` → quedaba cuadrado 28px y clipeaba "tutorial"→"tutoria". Fix:
  clase `pi-refresh pi-tour` (igual que Planes) + `.lib-intro{flex-wrap:wrap}` para que los botones bajen
  de línea en vez de clipear en ventanas angostas. Verificado por screenshot a 1320/720/560px (responsive).
- **CSS (`app.css`):** aditivo con tokens existentes; `.lib-intro`/`.lib-wrap` REUSAN las reglas de Planes
  (selectores agrupados `.plans-intro,.lib-intro`). Badges por tipo: prompt=verde, skill=violeta, rule=ámbar.

---

## v1.5.0 — Dock de terminales: entrar a proyecto = `claude --resume`, contexto y Ctrl+Espacio
> Cinco ajustes al **dock de terminales** (feedback del usuario). Bump **1.4.0 → 1.5.0** (`package.json` +
> fallbacks `brand-ver`/`.ver` en `chrome.js`). Todo verificado en vivo por screenshot (TS compila limpio).
> Aditivo, respeta las 3 Hard Rules (fidelidad visual, responsive, cero API de Anthropic).

1. **Entrar a un proyecto NO colapsa el sidebar.** El callback de `setMaxObserver` (`app.js`) dejó de forzar
   `setSidebarCollapsed(true)` al maximizar el dock; ahora solo hace `render()`. El sidebar se colapsa SOLO
   con el chevron manual (`setSidebarCollapsed`) o por responsive (`syncResponsive`, `<820px`, Hard Rule 2).
2. **Entrar a un proyecto abre UNA terminal `claude --resume` (selector interactivo), reemplazando las
   tarjetas read-only.** Flag nuevo `pick` que fluye `createTerm` (`terminals.ts`: `claude --resume` SIN id
   = picker, scopeado al cwd del proyecto porque Claude guarda transcripts por carpeta) → IPC `termCreate`
   (`index.ts`) → `mountTerminal`/`spawn`/`open` (`terminals-ui.js`, 6º arg). `openProject` reescrito: si el
   proyecto NO tiene paneles abiertos + tiene sesiones + cwd válido → 1 panel claude con `pick:true`; si no
   tiene sesiones/cwd → `showView` decide (placeholder o board vía `boardChecker`); si ya tiene paneles, no
   abre nada. `mountSession`/`openSession` siguen para el click en una card del board. El picker tiene `proj`
   y NO es pinned → no se persiste (no se re-dispara al reabrir).
3. **La cabecera del dock muestra el nombre del proyecto.** `updateTitle()` (llamado desde `showView`, único
   choke point) setea el `textContent` de `.dk-tb-label`: nombre del proyecto si `view!=='__home__'`,
   `'TERMINALES'` en inicio. Solo cambia texto → markup/clases intactos (Hard Rule 1).
4. **Botones por panel según contexto.**
   - **Panel de sesión claude** (`mountSession`): los botones de claude **continúan ESA sesión**. "claude ⚡"
     pasó de `dispatch-skip` (sesión nueva) a un act nuevo **`resume-skip`** = `claude --resume <id>
     --dangerously-skip-permissions`; "responder" sigue siendo `resume` (`claude --resume <id>`). Se quitó
     "claude nuevo". `app.js dispatchAction` suma el case `resume-skip`; `resumeSession(sid,cwd,opts)` acepta
     `opts.skip` y lo pasa a `mountTerminal`. Los cases `dispatch`/`dispatch-skip` SIGUEN (los usan las cards
     del board y el detalle E2) — solo se dejaron de EMITIR desde `mountSession`.
   - **Terminal (shell/claude)**: botón **VSCode** nuevo en la cabecera (`ensureVscodeBtn(pane)` en
     `mountTerminal`, idempotente) → abre el cwd vía `editorOpener` (bridge `setEditorOpener` inyectado por
     `app.js` → `api.action('ext',{cwd})` → `openEditor(cwd)`). Reusa `.dk-pbtn` e ícono `ext` (sin CSS nuevo).
5. **CTRL+ESPACIO abre una terminal nueva.** Config nueva `quickTermKind: 'shell'|'claude'|'claude-skip'`
   (`config.ts`, default **`claude-skip`**). `app.js`: `openQuickTerm()` lee `state.quickTermKind` y llama
   `openEmbeddedTerminal`. Funciona en DOS contextos: (a) board → keydown global (`e.ctrlKey && e.code===
   'Space'`, antes del switch); (b) DENTRO de un xterm enfocado → `term.attachCustomKeyEventHandler` en
   `mountTerminal` (devuelve `false` para que xterm no mande NUL `\x00`) → bridge `setQuickTermHook` →
   `openQuickTerm`. Fila en Settings ("EDITOR & TERMINAL"): `seg2('quickTermKind', …, [terminal/claude/claude ⚡])`;
   `wireSettings` lo guarda como string (no entra en la coerción a bool) y actualiza `state.quickTermKind` en vivo.
- **Changelog:** las release notes de esta versión (cuerpo del GitHub Release) son lo que ven TODOS los
  usuarios en su centro de notificaciones → modal de novedades (`updates.ts checkForUpdate()` lee `json.body`;
  `update-available` trae `releaseNotes`). Por eso el `gh release` debe llevar notas markdown completas.

---

## v1.5.1 — Terminal (links/copiar/pegar/login) + persistencia de notificaciones
> Dos fixes (feedback de Facundo sobre 1.5.0). Bump **1.5.0 → 1.5.1** (`package.json` + fallbacks
> `brand-ver`/`.ver` en `chrome.js`). La terminal **debe andar perfecto**. Aditivo, respeta las 3 Hard Rules.
> Verificado en vivo por screenshot (menú contextual, persistencia, historial); TS compila limpio.

### 1) Terminal embebida (xterm): links clickeables + copiar + pegar + OSC52 + menú contextual
Todo en `mountTerminal` de `terminals-ui.js` (único camino para shell **y** claude; las sesiones read-only no
pasan por ahí). Todo guardado en try/catch (un fallo de clipboard/addon nunca rompe la terminal). La red está
bloqueada (CSP `connect-src 'self'`) → `navigator.clipboard` NO sirve; todo va por IPC del preload.
- **Links** (`@xterm/addon-web-links@0.12.0`, devDep, vendorizado a `assets/xterm/addon-web-links.js`, `<script>`
  en `index.html` tras `addon-fit.js`; global UMD `window.WebLinksAddon`, ctor `WebLinksAddon.WebLinksAddon`):
  `term.loadAddon(new WebLinksAddon((ev,uri)=>api.action('openExternal',{url:uri})))` — el handler propio
  sobrescribe el `window.open` (que la CSP bloquearía). **Une filas envueltas** → la URL de login de claude (3
  filas) se abre ENTERA → fix del 404 al copiarla a mano. https-only (login es https).
- **Copiar/pegar/select** (helpers module-scope `termCopy`/`termPaste`/`termSelectAll`): copiar vía
  `api.action('copyText',{text:getSelection()})` + `clearSelection()`; pegar vía `api.clipboardRead()` →
  `term.paste(txt)` (respeta bracketed-paste) + `term.focus()`.
- **Teclado** (extendido en el `attachCustomKeyEventHandler` que ya tenía Ctrl+Espacio, con `ev.code`):
  `Ctrl+Shift+C` copia siempre; `Ctrl+C` copia si hay selección (y la limpia → un 2º Ctrl+C cae a **SIGINT**),
  si no hay selección deja pasar (`return true`, la shell recibe `\x03`); `Ctrl+V`/`Ctrl+Shift+V` pegan.
- **"c to copy" de claude (OSC 52)**: `term.parser.registerOscHandler(52, data => …)` — toma lo posterior al 1er
  `;`, `atob` → `Uint8Array` → `TextDecoder('utf-8')` (UTF-8 correcto), `api.action('copyText',{text})`. Ignora
  el query `?`. **Sin** `@xterm/addon-clipboard`.
- **Menú contextual** (click derecho en `.dk-pane-body` → `showTermCtx`): `.dk-ctx` en `document.body` (fuera de
  `#terminals`, así no lo traga el handler global de clicks), z-index 57, clamp al viewport, con **Copiar**
  (disabled sin selección) / **Pegar** / **Seleccionar todo**; cierra con click afuera / Esc. CSS aditivo
  `.dk-ctx`/`.dk-ctx-i` con tokens existentes.
- **Plumbing nuevo de clipboard READ** (para pegar): IPC `consomni:clipboardRead` (`index.ts`, importa `clipboard`
  de electron) → preload `clipboardRead()`. El WRITE reusa `api.action('copyText',{text})` (ya existía).

### 2) Notificaciones: persistencia + historial ("ver todas")
- **Causa raíz del bug** (las notifs desaparecían al actualizar aunque estuvieran sin leer): `state.notifs` vivía
  solo en MEMORIA; tras actualizar no se vuelve a emitir `update-available` (ya estás en la última) → lista vacía.
- **Persistencia** en `~/.consomni/notifications.json` (store dedicado, espejo de `loadDock/saveDock`):
  `config.ts loadNotifications/saveNotifications` + `NOTIFICATIONS_PATH`; IPC `getNotifications`/`saveNotifications`
  (`index.ts`); preload bridges. Shape `{notifs:[{id,kind,title,body,data,ts,read}]}`, cap 60. Se carga al iniciar
  (espejo del load de la biblioteca). Se reemplazó el `localStorage 'consomni.notif.seen'` (no confiable bajo
  file://) por el flag `read` por-notif.
- **Modelo** (`app.js`): `addNotif` dedupea por id **preservando `read`** (no resucita como no-leída);
  `persistNotifs()` debounced 300ms; badge = no-leídas (`unreadCount`); `markAllSeen()` marca `read=true` (lo
  llama abrir el panel / el historial). **2.1 resuelto:** la notif sobrevive reinicio/update como `read:false`
  hasta que abrís la campanita; nunca sale del historial al leerse (solo el "limpiar" la borra).
- **UI:** la campanita (`openNotifPanel`) muestra las recientes (~6) + footer **"ver todas (N)"**
  (`data-act="notif-all"`); `openNotifHistory()` = overlay on-brand **reusando** las clases del changelog
  (`.cl-*`) + `.ntf-row`, lista TODAS, filas update clickeables → `openChangelog`. `state.notifHistoryOpen`
  entra en `anyOverlayOpen`/`closeOverlays`/`setOverlay('')` (Esc/scrim). CSS aditivo `.ntf-foot`/`.ntf-all`.
  QA: `__consomni.openNotifHistory()`.

---

## v1.5.2 — Pantalla de Changelog (timeline de versiones)
> Pedido del usuario: debajo del número de versión, un botón "Changelog" que abre una **pantalla full,
> excesivamente hermosa**, con TODAS las versiones. Bump **1.5.1 → 1.5.2** (`package.json` + fallbacks
> `brand-ver`/`.ver` en `chrome.js`). Aditivo, 100% tokens existentes, **sin emojis**, verificado por screenshot.
> 100% local/offline: el registro está **bundleado** en el renderer (no se pega a GitHub) → sin red, control
> total del formato, e incluye versiones que no tienen GitHub Release.

- **Trigger** (`chrome.js`): el brand del topbar pasó a `eye + wordmark + .brand-meta`, donde `.brand-meta` es
  una **columna**: `.brand-ver` (la versión) arriba y un `<button class="brand-changelog" data-act="changelog-all">`
  abajo (ícono `sparkles` nuevo + texto "Changelog"). CSS aditivo `.brand-meta`/`.brand-changelog` (hover verde).
- **Datos** (`app.js`): const `CHANGELOG` = array newest-first `{v, date, title, items[]}`, curado y
  user-facing (sin jerga, sin emojis). **Al sacar una versión nueva: agregar su entrada arriba.** (No usa las
  release notes de GitHub porque esas llevan emojis y no todas las versiones viejas tienen Release.)
- **Pantalla** (`app.js openChangelogAll`/`closeChangelogAll`, `state.changelogAllOpen`): overlay full
  (`setOverlay`) `.chl-screen` (z-index 70, sobre el dock) con topbar (eye + CONSOMNI + "Changelog" + cerrar),
  hero (eyebrow "Novedades" + título + bajada) y un **timeline** (`.chl-timeline` con riel vertical + dots; el
  más nuevo va verde con pill "actual", los viejos con dot hueco; cada entrada: versión + fecha + título +
  bullets con marcador cuadrado verde). Footer con link a GitHub Releases (`data-href`). Entra en
  `anyOverlayOpen`/`closeOverlays`/`setOverlay('')` (Esc); click handlers `changelog-all`/`close-changelog-all`.
  CSS aditivo `.chl-*` (tokens existentes, gradientes verdes sutiles, animaciones `chlScreenIn`/`chlEntryIn`,
  responsive `<560px`). Ícono nuevo `sparkles` en `chrome.js`. QA: `__consomni.openChangelogAll()`.

---

## v1.6.0 — Modo claro + fixes (centrado de versión, modal de novedades)
> Feature grande (modo claro) + dos fixes (feedback del usuario). Bump **1.5.2 → 1.6.0** (`package.json` +
> fallbacks `brand-ver`/`.ver` en `chrome.js`). Verificado en vivo por screenshot en 7 pantallas (board, dock,
> settings, changelog, palette, detalle E2, biblioteca). Aditivo, respeta las 3 Hard Rules.

### MODO CLARO (opt-in; el default sigue siendo oscuro)
- **Arquitectura (en `app.css`, aditiva — `tokens.css` queda VERBATIM):**
  1. `body.light{ … }` REESCRIBE las variables a una paleta clara (bg `#f3f3f5`, surfaces blancas, texto
     `#1a1a1f`, bordes dark-alpha, acentos un toque más profundos para rendir como TEXTO sobre claro:
     `--green:#16a34a`, `--amber:#d97706`, etc.). Todo lo que usa `var(--token)` flipea solo.
  2. **`body.light #terminals{ … }` REDECLARA los tokens OSCUROS** → el dock/terminales quedan OSCUROS en
     modo claro (xterm y la TUI de claude están pensados para fondo oscuro; patrón "IDE claro + terminal
     oscura"). UN bloque en vez de decenas de overrides.
  3. Overrides puntuales para los pocos colores **hardcodeados** fuera del dock (hex oscuros `#0e0e12`/`#101014`
     en `.panel`/`.palette`/etc. → claros; grises claros `#cfcfd4`/`#ededed` → oscuros; white-alpha literales
     → `var(--border)`; scrims/sombras/CRT/vignette suavizados; `::selection`/scrollbar; texto ámbar de
     atención → ámbar profundo; re-aseguro de `.btn--green/red/amber` que la regla genérica `.btn` pisaría).
- **Toggle + persistencia:** botón sol/luna del footer del sidebar (`data-act="theme"`, ícono `sun` nuevo en
  `chrome.js`; muestra el tema DESTINO). `app.js`: `toggleTheme()`/`applyTheme()` (togglea `body.light` + persiste
  `config.theme`), `state.theme` (default `'dark'`), se aplica al cargar desde `config.theme`. `o.light` se pasa
  al chrome para el ícono. `config.ts`: campo `theme:'dark'|'light'` (default `'dark'`).

### Fixes
- **Versión centrada sobre "Changelog":** `.brand-meta{align-items:center}` (estaba `flex-start`).
- **Modal de novedades sin etiquetas HTML literales:** `notesToHtml()` en `app.js` detecta si las release notes
  vienen en HTML (electron-updater suele entregar `releaseNotes` ya renderizado) y las convierte a markdown-ish
  ANTES de `renderNotes` (que escapa todo). Sin XSS: se quitan TODOS los tags antes de renderizar. `openChangelog`
  usa `notesToHtml(data.notes)`. Verificado por unit test de Node.

### Regla de proceso (actualizada)
- Los commits/PR/changelogs **NO** llevan atribución a Claude (ni `Co-Authored-By`, ni "Generated with…").
  De ahora en más, cero referencias a que se hizo con asistencia de IA. **Ver HARD RULE 4 arriba (absoluta).**

---

## v1.6.1 — Bolita del Changelog centrada + limpieza de contributors
> Bump **1.6.0 → 1.6.1**. Fix puntual + reescritura de historia para sacar a Claude de los contributors.

- **Timeline del Changelog centrado:** el dot de cada versión quedaba ~1.75px a la DERECHA del riel porque el
  reset `*{box-sizing:border-box}` **NO** cubre los pseudo-elementos `::before`, así que el `border:2px` del dot
  (content-box) sumaba 4px y corría su centro. Fix: `.chl-entry::before{box-sizing:border-box;width:12px;left:-30px}`
  (centro x=6) + riel `.chl-timeline::before{width:2px;left:5px}` (centro x=6) → **concéntricos**. Verificado a 7x.
- **Contributors sin Claude:** se reescribió la historia (`git filter-branch --msg-filter` borrando los
  `Co-Authored-By: …anthropic…` de los 19 commits viejos) + `--tag-name-filter cat` (re-apunta los tags de
  release) + force-push de `main` y tags. Las release (assets + `latest.yml`) NO dependen de la historia git →
  el auto-update sigue intacto. El contributor "claude" cae del repo (GitHub re-indexa con cache, puede tardar).
  Backup local `backup-claude-scrub` por las dudas. De acá en más, HARD RULE 4 garantiza que no vuelva a pasar.

---

## v1.6.2 — Fix: el cartel "necesita tu atención" se quedaba pegado
> Bump **1.6.1 → 1.6.2**. Bug reportado por Facundo: tras `claude /login` (en una terminal embebida con
> `--dangerously-skip-permissions`), saltó el cartel "1 sesión necesita tu atención" y NO se limpiaba.

- **Causa raíz** (en `sessions.ts`): `attn` sale ÚNICA fuente del hook `Notification` (el parser JSONL nunca
  produce `attn`). `classifyNotification` tenía **`return 'attn'` por defecto** para cualquier notificación que
  no matcheara "idle" → la notificación del login se clasificó como permiso → `attn`. Y NO se limpiaba porque
  después del login no llega ningún `Stop`/`UserPromptSubmit`/tool event, así que el overlay quedaba `attn`
  hasta `OVERLAY_TTL` (10 min).
- **Fix 1 (raíz):** `classifyNotification` ahora marca `attn` **SÓLO** ante un pedido de PERMISO real
  (`notification_type` con `perm`, o mensaje con `permission/permiso/needs your permission/approve this/…`);
  **todo lo demás** (idle, login, auth, info) → `idle`. Verificado por unit test (10/10).
- **Fix 2 (self-heal):** en `mergeOverlay`, si la sesión siguió ACTIVA en el transcript (`s.lastActivity >
  live.ts + 2s`) estando en `attn`, ese `attn` quedó stale → se descarta el overlay y se usa el estado real
  del JSONL. Red de seguridad por si una notificación futura se cuela como `attn`.
- El overlay vive en memoria del main → al actualizar/reabrir, cualquier `attn` pegado se limpia solo.

---

## v1.7.0 — Multi-perfil de Claude (config dir configurable)
> Pedido de Facundo + caso del mantenedor (usa el alias `claude-max` → `~/.claude-max`). Consomni deja de
> asumir `~/.claude` fijo y pasa a un **config dir ACTIVO configurable**. Bump **1.6.2 → 1.7.0**. Aditivo,
> respeta las 3 Hard Rules (cero API de Anthropic: solo elige carpetas locales + setea una env var del CLI).

- **El mecanismo real es `CLAUDE_CONFIG_DIR`** (no el nombre del comando): Claude Code guarda TODO
  (`settings.json`, `projects/`, skills, historial) en ese dir. Los alias `claude-max`/`claude-team` son
  **funciones de PowerShell** que setean esa var y llaman a `claude` — NO son binarios. Por eso la unidad
  configurable es el **config dir**, y al spawnear **nunca** se lanza `claude-max` como exe: siempre `claude`
  + `CLAUDE_CONFIG_DIR` en el env.
- **Single source of truth** (`config.ts`): `resolveClaudeDir(cfg)` = `cfg.claudeConfigDir` (setting) →
  `process.env.CLAUDE_CONFIG_DIR` → `~/.claude`. Con setting `''` y sin env → resuelve EXACTO a `~/.claude`
  (**100% backward-compatible**; no inyecta nada). Derivados: `claudeProjectsPath(cfg)` (`<dir>/projects`) y
  `claudeSettingsPath(cfg)` (`<dir>/settings.json`). Campo nuevo `claudeConfigDir: string` (default `''`).
  Como el app de escritorio NO hereda el env de la sesión de PowerShell, el **setting es el mecanismo
  principal** y la env var un fallback.
- **Detección de perfiles** (`detectClaudeProfiles()`): escaneo barato de `~` por carpetas `.claude*` con
  `projects/` o `settings.json` → `[{dir,name,hasProjects,hasSettings,projectCount,active}]`. Siempre incluye
  `~/.claude` y el activo. Ordena activo→más proyectos→alfabético.
- **Lectura/watcher sigue el perfil** (`sessions.ts`): helper `watchRoots(cfg)` =
  `dedupe([claudeProjectsPath(cfg), ...watchedDirs])`, usado en `listSessionFiles`/`startWatcher`/
  `findSessionFile`/`buildSnapshot`. Garantiza vigilar el projects activo incluso si el perfil viene SOLO del
  env (sin repointar `watchedDirs`). `watchedDirs` queda como roots EXTRA de power users.
- **Hooks al perfil activo** (`hooks-install.ts`): el const `CLAUDE_SETTINGS` se reemplazó por
  `claudeSettingsPath()` en los 6 usos (`readSettings`/`backupSettings`/`writeSettingsAtomic`/`getStatus`/
  `install`/`uninstall`). Así backup + merge no-destructivo + atomic rename operan sobre el `settings.json`
  del perfil activo. **Al cambiar de perfil NO se auto-migran los hooks**: el estado se re-lee contra el
  settings.json nuevo → si faltan, se instalan con un click (decisión del usuario; honesto, respeta HR3).
- **Spawn env** (`terminals.ts` + `actions.ts`): si hay perfil seteado (`claudeConfigDir` no vacío) se inyecta
  `CLAUDE_CONFIG_DIR=resolveClaudeDir()` en **todas** las terminales embebidas (shell + claude), el helper NL
  (`nlToCommand`) y el dispatch externo (`dispatchNew`). Con setting vacío NO se toca el env (preserva lo
  heredado). Helpers: `applyClaudeProfileEnv(env)` (terminals) / `profileEnv()` (actions).
- **IPC** (`index.ts`): `getClaudeProfiles` → `detectClaudeProfiles()`; `setClaudeProfile(dir)` valida el dir
  (`''` = volver a auto), arma patch `{claudeConfigDir, claudeProjectsDir:<dir>/projects, watchedDirs:
  [<dir>/projects, ...extras]}` (preserva roots extra), `saveConfig` + `restartWatcher()` + `refreshHooksConn()`,
  devuelve `{ok,config,hooks,active}`. Preload: `getClaudeProfiles`/`setClaudeProfile`.
- **UI Settings** (`app.js`/`app.css`): sección nueva **"PERFIL DE CLAUDE (config dir)"** arriba de
  "DIRECTORIOS VIGILADOS EXTRA". `openSettings` también trae `getClaudeProfiles()` (cacheado en
  `settingsProfiles`); `renderSettings` pinta filas `.set-prof` seleccionables (activa con `dot--green` + tag
  `auto` si está en modo auto), input de ruta personalizada + botón "elegir" (reusa `pickFolder`), y "usar
  default (auto)" (manda `''`). `wireSettings.applyProfile(dir)` → `setClaudeProfile` → re-fetch perfiles +
  re-render con config/hooks nuevos + toast "perfil: X · revisá los hooks". CSS aditivo `.set-prof*` reusa el
  lenguaje de `.set-dir`/`.seg`.
- **Tutorial guiado (coachmark spotlight, dentro de Settings):** reusa el motor `startTour` (que ahora acepta
  un 3er arg `onDone` para persistencia confiable). `profileTourSteps()` = 4 pasos (intro + spotlight a
  `#setProfSec` / `#setProfPath` / `#setHooksBtn`); `startProfileTour()` abre Settings y espera el DOM
  (`#setProfSec`) antes de pintar. **Auto-arranca 1 vez tras actualizar:** `maybeAutostartProfileTour()` se
  llama desde `maybeOnboard` SOLO si no se mostró el onboarding (prioridad del onboarding); gate confiable
  `config.seenProfileTour` (NO localStorage, por file://) → al terminar el tour, `markProfileTourSeen` hace
  `saveConfig({seenProfileTour:true})`. Como Settings es un MODAL (no una vista), el auto-arranque al iniciar
  es lo que garantiza el "sí o sí" del feature. Replay: botón "tutorial" en el header de la sección
  (`data-act="profile-tour"`) + fila en la paleta ("Tutorial de perfiles"). El spotlight (z70-72) ilumina la
  sección DENTRO del modal de Settings (z45-50) sin problema. QA: `__consomni.startProfileTour()`.
- **Límite conocido (documentado):** un solo server/puerto de hooks → monitorear varios perfiles VIVOS a la
  vez requeriría hooks en el `settings.json` de CADA perfil. El MVP es **un perfil activo** (cubre el caso
  `claude-max`); la lectura de transcripts de roots extra igual se puede sumar por "directorios vigilados extra".
- **Quirk pre-existente:** el puerto en `installHooks` se toma del `cfg` de arranque (index.ts), pero el PATH
  del settings.json se resuelve fresco en hooks-install → ok. (Cambiar el puerto ya requería reiniciar, avisado.)

---

## v1.7.1 — Cambios sin commitear (+N/−N) + abrir archivos desde el chat/terminal
> Pedido de Franco + Facundo (sobre Warp). Dos features grandes para el dock + la conversación. Bump
> **1.7.0 → 1.7.1** (`package.json` + fallbacks `brand-ver`/`.ver` en `chrome.js`). Verificado en vivo por
> screenshot (badge oscuro/claro + live-update; visor de archivo) y unit test (detección de rutas, 7 casos).
> Aditivo, respeta las 3 Hard Rules (CSS aditivo con tokens; responsive; **cero API de Anthropic** — sólo
> `git`/`fs` local). NOTA: la 1.7.0 (multi-perfil) ya estaba publicada → este feature salió como **1.7.1**.

### 1) Indicador de cambios sin commitear (+N / −N) por proyecto — estilo Warp
- **Cómputo** (`sessions.ts`): `getGit()` cachea el binario (`execFileSync('where','git')`, fallback `'git'`,
  negative-cache a `null`). `diffKey(cwd)` = MISMA normalización que `projKey` del renderer (lowercase + `/`,
  sin trailing) para que las keys matcheen. `computeDiffStat(cwd)` async:
  `execFile(git,['-C',cwd,'diff','--shortstat','HEAD'],{timeout,windowsHide,maxBuffer})` → parsea 3 regex
  (files/insertions/deletions); error/no-repo/sin-git → **negative-cache en 0** (no re-spawnea cada ciclo); si
  cambió → `scheduleUpdate()`. `refreshDiffStats(sessions)` (throttle ~3s `DIFF_RECOMPUTE_MS`) dispara cómputo
  fire-and-forget sobre los cwds ÚNICOS activos (dedupe por `diffKey`). `buildSnapshot()` NO bloquea en git:
  arma `diffStats` (sólo keys con `added||removed`) desde la cache. `setInterval(scheduleUpdate, 4000)` en
  `start()` (las ediciones de git NO tocan `.jsonl` → el watcher solo no alcanza). `types.ts Snapshot.diffStats`.
  **Límite conocido:** `--shortstat HEAD` no cuenta archivos NUEVOS sin trackear (igual que Warp); non-git/sin
  HEAD → sin badge.
- **UI board** (`chrome.js column(c)` + `app.js transform`): por grupo, `cwd:g.sessions[0].cwd` +
  `diff:snap.diffStats[g.id]`. `column()` pinta `<button class="col-diff" data-act="diff-cwd" data-cwd="…">+A −D</button>`
  (U+2212 para el menos; `.col-diff-add` verde / `.col-diff-del` rojo) DESPUÉS del `.ct`. **data-cwd propio**
  porque `data-proj` lleva el projKey normalizado, NO un path usable. Handler de click en `app.js` ANTES del
  fallback `[data-proj]` (con `stopPropagation`) → `api.action('diff',{cwd})`.
- **UI dock** (`terminals-ui.js`): `var lastSnap` (lo guarda el callback de `bindSnap`, que antes ignoraba el
  snapshot). `updateDiffBadge()` crea idempotente un `.dk-tb-diff` en `.dk-tb-title` tras `.dk-tb-label`; key =
  `viewCwd` normalizado; home/sin-diff/cero → `hidden`; click → `api.action('diff',{cwd:viewCwd})`. Se llama en
  `bindSnap` (cada snapshot) y al final de `showView` (cambio inmediato al entrar a un proyecto).

### 2) Rutas de archivo clickeables (terminal + conversación)
- **Detección** (`findPathSpans(line)` en `terminals-ui.js`): dos regex con dedupe por solapamiento —
  Windows-abs `\b[A-Za-z]:[\\/](?![\\/])[^\s:*?"<>|]+` (el `\b` + `(?![\\/])` evita matchear la "s:" de `https:`)
  y rutas rel/bare que TERMINAN en una extensión conocida (`FILE_EXT`). Guard: salta matches precedidos por
  `/ \ :` (colas de URL). `resolveFilePath(token,cwd)` = absoluto tal cual; relativo = join manual con cwd (no
  hay `path` en el renderer). **No pisa URLs** (las maneja el addon web-links). Unit-tested (7 casos).
- **Terminal** (`mountTerminal`): `term.registerLinkProvider({provideLinks(y,cb)})` — `getLine(y-1)`
  (provideLinks `y` 1-based; getLine 0-based), spans → `ILink` con `range` 1-based + `end` inclusive,
  `decorations:{pointerCursor,underline}`, `activate(ev)→onPathActivate(ev,text,pane)` (Ctrl/Cmd → editor; si
  no → panel). El menú contextual (`showTermCtx`) ahora recibe `ev,pane`: `pathUnderEvent` ubica la celda por
  geometría de `.xterm-rows` (xterm no expone hit-test) → si hay ruta, **prepend** "Abrir en panel / editor /
  Revelar ubicación" + separador a Copiar/Pegar/Seleccionar.
- **Conversación** (`renderSession`/`mountSession`): `linkifyPaths(escapedHtml,cwd)` corre `findPathSpans` sobre
  el HTML YA escapado (los chars de path sobreviven a `esc`) y envuelve cada span en
  `<span class="cv-file" data-path="…">`. Handler delegado en `.dk-convo`: click→panel, Ctrl/Cmd→editor,
  contextmenu→`showFileCtx` (reusa `.dk-ctx`). **Plumbing de cwd**: `openSession(…,cwd)`/`mountSession(…,cwd)` →
  `pane.dataset.cwd`; el caller en `app.js` pasa `s.cwd`.

### 3) Panel visor de archivo (pane efímero kind `'file'`)
- `openFilePanel(filePath,cwd)`: reusa el panel si ya está abierto (dedupe por `dataset.fpath`); si no,
  `makePaneShell('file')` + `placeContent(…,'right')` + `mountFile`. Taguea `proj`/`projname` de la vista
  (efímero, NO pinned). `mountFile` lee por `api.readFile` → crudo en `<pre>` vía **`textContent`** (seleccionable,
  sin XSS); botones (idempotentes, antes de la ✕): **copiar todo** (`copyText`), **abrir en editor** (`ext`+file),
  **revelar** (`revealFile`), y para `.md` un toggle **vista/crudo** (`renderMd`/`fvInline` = mini-markdown SEGURO
  propio: escapa TODO, después headings/listas/`**bold**`/`` `code` ``/```fences```). **Efímero:** `persist()`
  filtra `kind!=='file'` (no se serializa ni se restaura); `closePane` sin `tid`/`sid` → cierra directo (sin modal).
- **IPC `consomni:readFile`** (`index.ts`): `path.resolve` + allowlist = `claudeProjectsPath(cfg)` + `watchedDirs`
  + los `cwd` de las sesiones (`fp===root || startsWith(root+sep)`); `statSync` (es archivo), cap **1 MB**,
  detecta binario (NUL en los primeros 4KB) → error. Devuelve `{ok,content,truncated}`. Preload `readFile`.
- **`actions.ts`**: `openEditor(cwd,file?)` abre el ARCHIVO si `file && exists(file)` (si no, el cwd como hoy);
  `case 'ext'` pasa `p.file`. `revealFile(file)` nuevo + `case 'revealFile'`: win32
  `spawnDetached('explorer.exe',['/select,'+abs])` (**quirk: el path va PEGADO al switch, mismo arg, sin
  espacio**), darwin `open -R`, else `shell.openPath(dirname)`.

### CSS (`app.css`, aditivo)
`.col-diff`/`.dk-tb-diff` (fondo `var(--surface-input)`, `+A`=`var(--green)`/`−D`=`var(--error)`; flipean solos
en claro), `.cv-file` (subrayado `var(--blue-2)`), `.dk-ctx-sep`, `.dk-fileview`/`.dk-fv-pre` (mono,
`white-space:pre`, `user-select:text`) + `.dk-fv-md .fv-*` (headings/listas/code/links del render de `.md`).

---

## v1.7.2 — Shift+Enter = salto de línea en las terminales con claude
> Pedido de Franco (venía de Warp): en la terminal embebida con `claude`, **Shift+Enter mandaba el prompt
> de una** en vez de hacer salto de línea → no se podían escribir prompts multilínea. Bump **1.7.1 → 1.7.2**
> (`package.json` + fallbacks `brand-ver`/`.ver` en `chrome.js`). Verificado por **test PTY headless** (ESC+CR
> contra el `claude.exe` real → inserta newline, NO hace submit). Aditivo, respeta las 3 Hard Rules.

- **Causa raíz:** xterm.js **no distingue Shift+Enter de Enter** — manda `\r` (= enviar) en ambos casos. Los
  terminales que sí andan (WezTerm, Ghostty, Kitty, Warp, Windows Terminal) lo soportan de fábrica; xterm.js no.
- **Ground truth (del binario `claude.exe` v2.1.186):** Claude Code trata **`\x1b\r` (ESC + CR = Meta/Alt+Return)**
  como "insertar salto de línea". Su `/terminal-setup` para VS Code instala literalmente
  `{"key":"shift+enter","command":"workbench.action.terminal.sendSequence","args":{"text":"\r"}}`. O sea:
  **emular Shift+Enter = mandar `\x1b\r` a la PTY**.
- **Fix** (`terminals-ui.js`, en el `attachCustomKeyEventHandler` de `mountTerminal`): si
  `(code==='Enter'||'NumpadEnter') && shiftKey && !ctrl/alt/meta && !isComposing && pane.dataset.kind==='claude'`
  → `api.term.write(pane.dataset.tid, '\x1b\r')` y `return false` (xterm NO manda su `\r` por defecto). El write es
  UN solo chunk (ESC y CR juntos) para que el parser de claude lo lea como Meta+Return, no como ESC (cancelar) + CR.
- **Scopeado a paneles `claude`** a propósito: en un **shell** (PowerShell) mandar ESC+CR borraría el comando
  tipeado (ESC = cancelar línea en PSReadLine) → ahí `\r` sigue siendo "ejecutar". Cubre todos los caminos a
  claude (botones claude/claude ⚡, responder/`--resume`, picker de proyecto, paneles restaurados). Límite conocido:
  si abrís un shell y tipeás `claude` a mano, Shift+Enter no aplica (el panel quedó `kind:'shell'`).
- **Verificación:** test PTY headless (electron-as-node + node-pty, ABI v121) que spawnea `claude.exe`, llega al
  input box, escribe `A`, manda `\x1b\r`, escribe `B` → `A` y `B` quedan en **líneas distintas** del input y claude
  **NO** entra a pensar (no hubo submit). Confirmado. (Alt+Enter ya mandaba `\x1b\r` de fábrica en xterm; ahora
  Shift+Enter hace lo mismo, que es el muscle-memory de Warp.)

---

## v1.7.3 — Picker flotante de @ + Shift+Enter (de verdad) + Ctrl+Espacio clona el cwd + Ctrl+W cierra
> Bump **1.7.2 → 1.7.3**. Cuatro cosas en las terminales embebidas (feedback de Franco + Facundo). La 1.7.2
> había sacado Shift+Enter pero estaba **mal** (a veces enviaba igual + lag); esta lo arregla de raíz.
> Verificado en vivo (instrumented + headless PTY + screenshots) y review adversaria (0 hallazgos). Aditivo,
> respeta las 3 Hard Rules.

### 0) PICKER FLOTANTE de @ (estilo Warp) — el feature grande
- **Problema:** claude dibuja su file-picker de `@` **inline** → te corre todo el historial de la pantalla y
  tenés que scrollear a mano (es de claude; pasa igual en su terminal y en Consomni). Warp lo muestra como un
  **popup flotante** que NO corre nada.
- **Solución (Consomni reimplementa el picker):** en un panel **claude**, al tipear `@` NO se lo mandamos a
  claude (así su picker inline no aparece) → abrimos un **overlay propio** (`terminals-ui.js`) con los archivos
  del cwd, filtrable; al elegir le mandamos `@<ruta> ` a la PTY (un burst → claude lo toma como ref confirmada,
  sin abrir su picker). Esc cancela; Backspace con query vacía cierra (= "lo borré"); espacio confirma.
- **Plomería:** IPC `consomni:listFiles(dir)` (`index.ts`, guardado a los roots vigilados/cwds igual que
  `readFile`; walk acotado depth≤9/4000 files/1.5s, salta `node_modules`/`.git`/`dist`/etc. y dot-dirs) →
  preload `listFiles`. Fuzzy client-side (`atScore`: substring en basename > en path > subsecuencia). El `@` se
  intercepta en el `attachCustomKeyEventHandler` ANTES de todo y se suprime en **todos los tipos de evento**
  (mismo motivo que Shift+Enter: si no, el keypress lo cuela). Mientras el picker está abierto, TODAS las teclas
  van al picker (`atKey`) y no a claude.
- **Posición PIXEL-PERFECT:** `cursorRect(pane,term)` ancla al **elemento real del cursor** (`.xterm-cursor`,
  DOM renderer) → exacto; si no, geometría de celdas con las dims REALES de xterm (`_renderService.dimensions`),
  fallback `rect/cols`. `placeAtPicker` pega la **base** del popup `gap` px sobre la fila del cursor
  (bottom-anchored → crece hacia arriba, glued al input) y capea el alto de la lista al espacio disponible; si el
  cursor está muy arriba (`top<120`) cae abajo. Se re-ubica en cada `resize` (listener mientras está abierto).
  Colores oscuros FIJOS (flota sobre la terminal, que siempre es oscura, también en modo claro). CSS `.dk-at-*`.
- **Límite conocido:** sólo cubre el `@` de **archivos** (el caso común). Para el `@` de agentes/MCP de claude,
  si no hay match el Enter manda `@<query>` como fallback al picker nativo. Verificado por screenshot: overlay
  pegado al input + selección inserta `@src/renderer/app.js` limpio (sin correr la pantalla).

### 1) Fix de Shift+Enter (la 1.7.2 estaba rota)
- **Bug real (confirmado con instrumented test):** apretar Enter dispara **DOS** eventos — `keydown` Y
  `keypress` — y xterm manda `\r` por **ambos**. El handler viejo solo gateaba `keydown`, así que en Shift+Enter
  el `keypress` **colaba un `\r`** → claude metía el salto y **después enviaba**. (`onData` con Enter normal =
  `["13","13"]`; Shift+Enter viejo dejaba pasar el 2º `13`.) Además usaba `ESC+CR`, que tiene el "escape
  timeout" del lado de claude → el **lag** + a veces se leía como ESC (cancelar) + CR (enviar).
- **Fix** (`terminals-ui.js`, `attachCustomKeyEventHandler`): el branch de Shift+Enter va **ANTES** del guard
  `if (ev.type !== 'keydown') return true;` y **devuelve `false` para TODOS los tipos** (keydown/keypress/keyup)
  → xterm nunca manda `\r`. El salto se escribe **solo en `keydown`** y es **`\n` (un byte)** en vez de ESC+CR
  (sin escape-timeout → instantáneo, sin ambigüedad). Confirmado: ahora Shift+Enter = `onData []` (cero leak).
  El guard keydown quedó después para que los Ctrl-shortcuts sigan viendo solo keydown.

### 2) Ctrl+Espacio clona el directorio de la terminal activa (estilo Warp)
- Antes abría siempre en el home. Ahora `openQuickTerm()` (app.js) toma `ConsomniTerms.activeTermCwd()` —el
  `cwd` del panel de terminal **enfocado** (o la última terminal abierta)— y lo pasa a `openEmbeddedTerminal`;
  `spawn()` ya respeta el cwd explícito. Si no hay terminal abierta, cae al cwd del proyecto/vista (como antes).
- **cd en vivo (bonus, no invasivo):** `mountTerminal` registra `registerOscHandler(7, …)` (OSC 7
  `file://host/path`) y `registerOscHandler(9, …)` (OSC 9;9 `path`) → `updatePaneCwd(pane, path)` actualiza
  `pane.dataset.cwd`. Si el shell los emite (oh-my-posh/starship/integración de VS Code) el clon sigue el `cd`
  real; con PowerShell pelado no se emiten → queda el cwd de arranque (caso común, cubierto). OSC 9;4 (progress)
  NO se confunde con cwd (sólo `9;` se trata como path). `activeTermCwd` exportado en `ConsomniTerms`.

### 3) Ctrl+W cierra la terminal enfocada
- En el `attachCustomKeyEventHandler`: `Ctrl+W` (sin shift/alt/meta) → `closePane(pane)` (diferido un tick con
  `setTimeout(…,0)` porque closePane puede disponer el xterm y estamos dentro de su propio keydown) + `return
  false`. Cierra la terminal donde está el cursor. Si es una terminal VIVA con PTY, `closePane` dispara el modal
  de confirmación existente (respeta `config.confirmCloseTerminal`). **Tradeoff conocido y querido:** pisa el
  "borrar palabra" (Ctrl+W de readline/PSReadLine) en shell/claude — fue pedido explícito; alternativa
  `Ctrl+Shift+W` es un cambio de una línea si se prefiere. Verificado: Ctrl+W llevó los paneles de 1 → 0.

---

## v1.7.4 — Ctrl+Z deshace en claude + el selector de @ ya no envía al elegir
> Dos fixes sobre la 1.7.3 (feedback del usuario). Bump **1.7.3 → 1.7.4**. Aditivo, respeta las 3 Hard Rules.
> Verificado: undo por test PTY headless (escribir → Ctrl+U → `\x1f` → reaparece), no-submit del @ por screenshot.

### 1) El @ ya NO envía el mensaje al elegir (bug de la 1.7.3)
- **Causa (misma clase que el bug viejo de Shift+Enter):** al elegir con **Enter**, el `keydown` cerraba el
  picker (sincrónico, `pane._atp = null`), y después el **`keypress` del mismo Enter** llegaba con el picker
  YA cerrado → no lo enrutábamos → xterm colaba un `\r` → claude **enviaba** el prompt.
- **Fix** (`terminals-ui.js`): el cierre por TECLA ahora es **diferido hasta el keyup** (`endAtPicker`): oculta
  el overlay al toque pero deja `pane._atp` vivo con `st.ending=true`; el branch del handler, mientras
  `ending`, **traga keypress y keyup** de esa tecla (`return false`) y recién en el **keyup** libera
  (`closeAtPicker`). Así el `keypress` del Enter no cuela el `\r`. El **2º** Enter (picker ya cerrado) sí envía.
  Red de seguridad: `setTimeout` 250ms por si no llega el keyup. El cierre por mouse/outside-click sigue
  directo (`selectAt(pane,false)` → no hay secuencia de teclas que tragar). Se quitó el "espacio confirma"
  (ahora el espacio filtra). `selectAt` sigue mandando `@ruta ` (ref + espacio, **sin `\r`** → no envía).

### 2) Ctrl+Z = DESHACER en claude (sí se puede)
- **Ground truth del binario:** claude bindea su undo a **`ctrl+_`** (`m0("chat:undo","Chat","ctrl+_")`; también
  `ctrl+-`, `ctrl+shift+-`, `ctrl+shift+_`). `ctrl+_` manda el byte **`\x1f`** (US). Verificado por PTY headless
  (no usa kitty protocol → el `\x1f` legacy funciona): escribí texto, lo borré con Ctrl+U (claude mostró "Ctrl+Y
  to paste deleted text"), mandé `\x1f` y el texto **reapareció**. Exactamente el "escribís, borrás, ctrl+z y
  vuelve" que pidió Franco.
- **Fix** (`terminals-ui.js`, en el `attachCustomKeyEventHandler`): `Ctrl+Z` en un panel **claude** →
  `api.term.write(tid, '\x1f')` + `return false`. Scopeado a claude (en un shell, `Ctrl+Z` = `\x1a` suspend
  sigue pasando). xterm por defecto mandaría `\x1a` (suspend, inútil en la PTY embebida); lo reemplazamos por el
  undo de claude. (Corrección a la nota previa de la 1.7.3: el undo SÍ es posible — claude lo tiene, sólo había
  que mandar la secuencia correcta.)

---

## v1.8.0 — Terminales en paralelo + cambiar dir + auto-inicio + title bar + tour de novedades
> Batch de 6 features (Franco/Facundo/Joaquim) sobre el dock, la title bar y el arranque. Bump **1.7.4 → 1.8.0**
> (`package.json` + fallbacks `brand-ver`/`.ver` en `chrome.js` + entrada en `CHANGELOG` de `app.js`). Verificado en
> vivo por screenshot (1320/720px) + asserts headless. Aditivo, respeta las 3 Hard Rules (CSS con tokens, responsive,
> cero API de Anthropic — sólo `setLoginItemSettings`/`titleBarOverlay`/`cd`, todo local).

### F1 — Picker de `@`: conservar texto en ESC + ghost grisado en vivo (`terminals-ui.js` + `app.css`)
- **ESC mantiene el `@texto`:** en `atKey`, la rama `Escape` ahora **escribe `@`+`st.query` a la PTY** (sin `\r`) antes de
  `endAtPicker` → el texto queda en el input de claude (mismo patrón shippeado del fallback no-match de `selectAt`).
  Tradeoff: claude puede mostrar su picker inline (escape hatch explícito del usuario).
- **Ghost (fachero):** `openAtPicker` crea un `st.ghost` (`.dk-at-ghost`, `pointer-events:none`); `placeGhost` lo ancla al
  cursor vía `cursorRect` (ya existía, pixel-perfect) con el font de xterm; `renderAtList`/`st.onResize` lo reubican;
  `closeAtPicker`/`endAtPicker` lo remueven. CSS `.dk-at-ghost` color fijo oscuro (la terminal es oscura siempre).

### F2 — Title bar amena: `titleBarStyle:'hidden'` + `titleBarOverlay` recoloreado (`index.ts`/`preload`/`app.js`/`app.css`)
- La **topbar pasa a ser la barra de título** (arrastrable vía `-webkit-app-region:drag`), con botones nativos
  min/max/cerrar **recoloreados al tema** (mantiene snap-layout de Win 11). `createWindow` setea `titleBarOverlay` con
  color inicial según `cfg.theme` (`titleBarOverlayColors`). IPC `consomni:setTitleBarOverlay` (on) →
  `mainWindow.setTitleBarOverlay({color,symbolColor})`; preload `setTitleBarOverlay(theme)`; `applyTheme` lo llama en cada
  cambio + al cargar. CSS: `.topbar{-webkit-app-region:drag;padding-right:148px}` (reserva el ancho de los botones nativos)
  + `no-drag` en todo lo interactivo de la topbar. Los botones nativos los dibuja el SO → no salen en `capturePage`
  (verificar en vivo); la creación de la ventana no falla y el recorte/no-drag están cableados.

### F3 — Auto-inicio con la PC (nativo, configurable) (`config.ts`/`index.ts`/`preload`/`app.js`)
- `config.autoStart` (default `false`). IPC `getAutoStart`/`setAutoStart` → `app.setLoginItemSettings({openAtLogin,path:
  execPath})` SÓLO empaquetado (en dev no toca el SO; el toggle igual persiste). **Reconcile en boot** (sincroniza el SO con
  la config tras reinstalar). Settings: sección nueva **"SISTEMA"** con toggle (`seg2('autoStart',…)`); el handler de
  `wireSettings` tiene caso especial que llama `setAutoStart` (aplica al SO, no sólo persiste).

### F4 — Cambiar de directorio sin tipear `cd` (`terminals-ui.js` + `app.css`)
- Botón "cd" (icono carpeta) en la cabecera de terminales **shell** (`ensureCdBtn`, idempotente; scopeado a shell porque cd
  no aplica a claude). Abre el **chooser compartido** `openDirChooser({anchor,title,onPick})`: lista los cwds de proyectos
  conocidos (`projectDirs()` desde `lastSnap.sessions`) + picker nativo (`api.pickFolder`). Al elegir → `cdInto(pane,ruta)`
  = `api.term.write(tid, 'cd "ruta"\r')` (ejecuta) + `updatePaneCwd`. CSS `.dk-dir-*` (colores fijos oscuros).

### F5 — Shortcuts en el inicio para abrir terminal en un proyecto (`terminals-ui.js` + `app.js` + `app.css`)
- `placeholderHTML('__home__')` muestra **chips de proyectos** (provider `setHomeProjects` ← `app.js homeProjectsList()`,
  fav/kept/activos primero) con botones **terminal**/**claude** que abren en el cwd del proyecto, **sueltos en inicio**
  (persisten). Botón **"+ proyecto"** en el toolbar del dock → `openDirChooser` (modo abrir, reusa F4). Handler delegado
  `[data-home-open]`. CSS `.dk-ph-projects`/`.dk-ph-proj`.

### F6 — Barra de sesiones + minimizar (terminales en paralelo) (`terminals-ui.js` + `app.css`)
- Strip nuevo **`.dk-sessions`** (entre toolbar y `.dk-root`) lista TODOS los paneles de la vista (visibles + minimizados)
  como chips (`renderSessionBar`, key = `data-pane`); click → enfoca (o **restaura** si está minimizado). **Minimizar**
  (`minimizePane`, botón nuevo en la cabecera) marca `data-min='1'` y deja el panel en el **pool VIVO** (NO `killPaneContent`)
  → `showView` excluye los `min` del tiling. `restorePane` lo re-tilea. Persistencia: `serializePane`/`buildPane`/
  `restoreSession` cargan `min` (los minimizados arrancan en pool). CSS `.dk-sess-chip` (+`.active`/`.min`/`.dk-sess-dot`
  ámbar = proceso vivo). **Verificado:** abrir 3 → minimizar 1 (2 visibles, 3 vivos) → restaurar (3 visibles).

### Tour de novedades v1.8.0 (reusa el motor de spotlight; `config.ts`/`terminals-ui.js`/`app.js`)
- Reusa `startTour`/`paintTourStep`/`positionTour` (cero CSS nuevo, pixel-perfect, responsive por el motor). 6 pasos:
  intro → **F6 headline (`.dk-sessions`)** → F5 (`.dk-new-proj`) → F4 (`.dk-pane-cd`) → F1 (`.dk-new-claude`) → F3 (cierre
  centrado). Para que F6/F4 sean highlights reales abre una **terminal DEMO** (`ConsomniTerms.openTourDemo`: shell en el
  home, tagueada `data-tour-demo`, **excluida de la persistencia**); `closeTourDemo` la limpia.
- **Extensión mínima del motor:** 4º param **`onEnd`** en `startTour`/`endTour` (se llama en TODO cierre: terminar/saltar/Esc)
  → cleanup de la demo. `tourTarget` ahora descarta targets montados-pero-invisibles (rect 0 → tarjeta centrada).
- **⚠️ Bug fijado en QA:** el guard "foco en `#terminals`" cortocircuitaba ANTES del check `TOUR.active` → con la demo
  enfocada, Esc/flechas/Enter no manejaban el tour (Esc des-maximizaba el dock). Se **reordenó** (la navegación del tour gana).
- **Disparo:** flag `config.seenWhatsNew18` (confiable bajo file://); `maybeAutostartTours` (reemplaza el autostart del
  profile-tour en `maybeOnboard`) lo dispara **1 vez** tras actualizar, si ya lo vio cae al de perfiles. **Replay:** fila
  "Novedades v1.8.0" en la palette + botón en el overlay de ayuda (`?`). QA: `__consomni.startWhatsNewTour()`.

### F1.bis (investigación, prioridad baja, SIN código) — "la conversación se rompe un poco al reabrir"
- Pasa **también cerrando/reabriendo** (no es por el update). Causa: una PTY viva NO sobrevive al cierre de la app, así que
  `restoreSession` recrea los paneles claude fijados con un `claude` **fresco** (no la conversación en memoria) y el tiling de
  splits no se persiste (lista plana → fila). El transcript sí sobrevive (`--resume`). Mejora opcional futura: restaurar los
  paneles claude fijados con `claude --resume <última sesión de ese cwd>`. Anotado, sin tocar.

---

## v1.8.1 — Fix pegar duplicado + picker flotante de `/`
> Dos cosas sobre las terminales embebidas (feedback de razhel/Joaquim). Bump **1.8.0 → 1.8.1**. Aditivo, cero CSS nuevo
> (el picker de `/` reusa las clases `.dk-at-*`). Verificado por screenshot.

### 1) Bug: pegar duplicaba (`terminals-ui.js`)
- **Causa:** devolver `false` desde `attachCustomKeyEventHandler` **NO hace `preventDefault`** (xterm corta sin cancelar el
  evento), así que el `paste` NATIVO del navegador igual se dispara → el handler de pegado propio de xterm entrega el
  portapapeles **una vez** y nuestro `termPaste` (IPC) **otra** = doble. Más visible en una sola línea (claude colapsa los
  pegados multilínea en `[Pasted text]`).
- **Fix:** `ev.preventDefault()` antes de `termPaste` en la rama `Ctrl+V/Ctrl+Shift+V` → mata el paste nativo, `termPaste`
  queda como única fuente. El menú contextual "Pegar" no se toca.

### 2) Picker flotante de `/` (slash-commands) — mismo motor que `@`
- **Datos:** custom de `<configDir>/commands` (perfil activo) + `<cwd>/.claude/commands` (proyecto) vía IPC nuevo
  `consomni:listCommands(cwd)` (walk acotado, name = relpath sin `.md` con `/`→`:`, desc del frontmatter `description:` o
  1ª línea) + preload `listCommands`. Los **built-in** los cura el renderer (`SLASH_BUILTINS`: `/help /clear /model /compact
  /cost /resume …`). Sin match en Enter → manda el literal `/query` (fallback a claude). El custom pisa al built-in por nombre.
- **Disparo SÓLO al inicio del input** (no roba el `/` de rutas/URLs/and-or): heurística por panel `pane._inputDirty`
  (se ensucia con cualquier char impreso; se limpia en Enter/Ctrl+C/Ctrl+U; los pickers que escriben al input también ensucian).
  Más conservador que el `@` (que intercepta `@` en cualquier lado).
- **Implementación:** `openSlashPicker/slKey/selectSlash/closeSlashPicker/endSlashPicker/filterSlash/renderSlashList`
  (espejo de las del `@`, estado `pane._slp`, `prefix:'/'`). Reusa `cursorRect`/`placeAtPicker`/`placeGhost` (generalizado a
  `st.prefix`) y `atScore`. La intercepción de `/` va en el `attachCustomKeyEventHandler` (bloque claude), suprimida en todos
  los tipos de evento (como el `@`). `killPaneContent` cierra `_slp`.
- **Pixel-perfect:** **re-snap al abrir** (`requestAnimationFrame` + `setTimeout 90ms` que re-`render…List`) para que la cajita
  quede clavada al input aunque NO tipees (claude settlea su caret un frame después). Se agregó también al `@`. Esc conserva el
  `/texto`. Verificado: `/mo` → cajita chica pegada arriba de `> /mo` con `/model` y `/memory`.
- **Límite conocido:** la lista de built-ins es best-effort (cambia por versión de claude); el fallback al literal cubre lo que falte.

---

## v1.8.2 — Input de claude anclado ABAJO (fullscreen) + resize atómico PTY↔xterm
> Bug reportado por el usuario (2 personas): el input box de claude en la terminal embebida NO quedaba pegado
> al fondo —en una sesión fresca, o tras escribir y borrar, flotaba en el medio con filas vacías debajo—,
> mientras que en WezTerm/Ghostty SÍ queda abajo. Bump **1.8.1 → 1.8.2**. Aditivo, respeta las 3 Hard Rules
> (cero API de Anthropic: el fix es una env var sólo-claude que NO toca disco). Verificado en vivo (PTY real
> + xterm real de Consomni) por screenshot.

### Causa raíz (investigada empíricamente, NO asumida)
- **No era dimensiones ni resolución.** Claude Code tiene DOS modos de render de su TUI:
  - **`default` (inline):** el input box sigue al contenido → en una sesión sin conversación queda ARRIBA,
    con filas vacías abajo; al achicarse el contenido (escribir→borrar) el input "sube". Era lo que usaba Consomni.
  - **`fullscreen` (alt-screen, tipo vim/htop):** el input box queda FIJO abajo y el contenido scrollea arriba.
    Es lo que hace WezTerm/Ghostty (tienen el modo activado).
- **Ground truth (capturando la salida real de `claude` v2.1.187 en una PTY cruda + en el xterm de Consomni):**
  claude renderiza inline por defecto y la ÚNICA query que manda al arrancar es `XTVERSION` (`\x1b[>0q`); NO
  manda DSR/DA/winsize, y responderle como WezTerm / setear `TERM_PROGRAM` / probar 5 identidades de XTVERSION
  **NO** cambia el anclado (probado 6 formas → todas ARRIBA). El disparador es el modo TUI, no una capability.
- **El control real:** la env var **`CLAUDE_CODE_NO_FLICKER=1`** (o `tui:fullscreen` en settings.json, o
  `/tui fullscreen`). Verificado en PTY 80×40: con la var, claude entra a **alt-screen** y el input pasa de la
  fila 14/40 → **40/40** (abajo). Verificado en vivo en el xterm de Consomni: banner arriba, input `›` + hint
  pegados abajo, render limpio (alt-screen anda bien sobre ConPTY).

### Fix 1 — `CLAUDE_CODE_NO_FLICKER=1` en las terminales embebidas (`config.ts` + `terminals.ts`)
- `applyClaudeFullscreenEnv(env)` inyecta `CLAUDE_CODE_NO_FLICKER=1` en `createTerm` (sólo las terminales
  INTERACTIVAS embebidas; NO en el helper NL `claude -p`, que parsea JSON de stdout). Es env var **sólo-claude,
  no toca disco** (respeta HR3), no afecta a otros procesos del shell. Resuelve LOS DOS síntomas: sesión fresca
  (input abajo) y el transitorio escribir→borrar→flotar (en alt-screen el input es una región fija abajo).
- **Config nueva `claudeFullscreen: boolean` (default `true`)** en `config.ts` (interface + DEFAULTS). Opt-out.
- **Toggle en Settings → Editor & Terminal** ("claude: input box anclado abajo"): `seg2('claudeFullscreen', …)`
  con coerción a bool en `wireSettings` (junto a `sounds`/`checkUpdates`). Aplica a terminales NUEVAS.

### Fix 2 — Resize ATÓMICO PTY↔xterm (`terminals-ui.js`) — complementario y ahora load-bearing
- El PTY se sincronizaba SÓLO vía `term.onResize`, que dispara únicamente cuando CAMBIAN las dims de xterm;
  un `fit.fit()` no-op (dims propuestas == actuales) NUNCA empujaba al PTY → el PTY podía quedar con menos
  filas que las visibles. Con el modo fullscreen esto importa MÁS: el layout full-height ancla el input a la
  ÚLTIMA fila que cree tener → si el PTY tiene menos filas que las visibles, ancla a la fila equivocada.
- `syncTerm(term, fit, pane)`: salta paneles ocultos (`offsetParent === null` → `fit()` daría NaN y
  `term.cols/rows` quedarían stale), hace `fit.fit()`, LEE las dims REALES de xterm y las empuja al PTY
  SIEMPRE (idempotente, dedupe por dims vía `pane._ptySize` + `pushPty`), y re-ancla al fondo sólo si el
  usuario ya estaba al fondo (`nearBottom`). `refitAll` (único choke point: RO, ventana, drag, show/restore/
  maximize, showView, minimize/restore, ask-bar) pasa por `syncTerm`. En `mountTerminal`: guard `offsetParent`
  en el 1er fit, `onResize` empuja vía `pushPty`, y empuje atómico post-create + un rAF diferido (captura el
  crecimiento por fuentes/asentamiento). Verificado en vivo: pty.rows == xterm.rows siempre (37/37, 22/22, y
  tras un resize no-op).

---

## v1.9.0 — Autocompletar con Tab (ghost text) + pegar largo que colapsa + badge +N/−N visible
> Tres features (Franco/Facundo). Bump **1.8.2 → 1.9.0** (`package.json` + fallbacks `brand-ver`/`.ver` en
> `chrome.js` + entrada en `CHANGELOG` de `app.js`). TODO verificado EMPÍRICAMENTE (harness PTY headless ABI v121,
> captura de bytes reales en la PTY, screenshots en vivo). Aditivo, respeta las 4 Hard Rules (CSS aditivo con
> precedente de colores fijos para overlays de terminal; responsive; cero API de Anthropic; cero atribución a IA).

### F1 — Autocompletar con Tab (ghost text estilo Warp/fish, SÓLO shells)
- **Qué:** mientras tipeás en una terminal SHELL, Consomni muestra en gris (pegado al cursor) el comando más
  reciente del historial que matchea el prefijo + un pill **"Tab"** clickeable. La tecla configurada (default
  `Tab`) ACEPTA (escribe SÓLO el sufijo a la PTY, sin `\r`). Verificado en vivo: tipear "git s" → ghost "tatus" +
  "Tab" → Tab completa a "git status" → ghost desaparece; toggle off en Settings → no aparece.
- **Buffer sombra + modelo de confianza INVERTIDO** (`terminals-ui.js`, `shellAutosuggestKey` en el
  `attachCustomKeyEventHandler`): `pane._sgLine` se llena con tipeo hacia adelante / Backspace; **CUALQUIER otra
  tecla** (flechas, Home/End, Tab sin sugerencia, F-keys, paste, modificadores combinados…) marca `pane._sgTrusted
  = false` → sin sugerencia (NUNCA corrompe la línea, porque aceptar exige `_sgGhostVisible`). Reset a vacío+confiable
  SÓLO en Enter / Ctrl+C (la línea queda conocida-vacía en PSReadLine). Los modificadores solos (Shift/Ctrl/…) se
  ignoran (si no, tipear mayúsculas rompía el tracking). **claude queda fuera de alcance** (stub honesto: dibuja su
  propio input/TUI en alt-screen + su propia sugerencia → un ghost persistente pelearía con su render).
- **Ghost** (reusa `cursorRect`; span ÚNICO por panel `.dk-sg` con `.dk-sg-text` + `.dk-sg-hint`, en `document.body`,
  colores FIJOS oscuros como `.dk-at-ghost` porque la terminal es oscura siempre). Reposiciona en cada keystroke
  (rAF), resize (`syncTerm`) y `term.onRender` (el echo del shell llega async); si la fila del cursor SALTÓ (output)
  → oculta. Limpieza en `killPaneContent`.
- **Historial:** store dedicado `~/.consomni/term-history.json` (clon de `loadDock/saveDock` en `config.ts`;
  IPC `getTermHistory`/`saveTermHistory`; preload `term.getHistory/saveHistory`). `{commands:[{cmd,cwd,ts}]}`,
  dedup, más-reciente-primero, cap 500. Match = prefijo exacto, **preferí mismo cwd** (sino el más reciente
  cualquiera). Se graba en Enter (si la línea es confiable). **⚠️ Gotcha de testing:** sembrar el JSON con
  `Out-File -Encoding utf8` mete un BOM → `JSON.parse` del main tira y el historial queda vacío (el feature real
  escribe con `JSON.stringify`, sin BOM — sólo afectaba al seed de test).
- **Config:** `autosuggest:boolean` (default `true`) + `autosuggestAcceptKey:string` (default `'Tab'`,
  reconfigurable). Settings → Editor & Terminal: toggle (`seg2('autosuggest',…)`, coerción a bool en
  `wireSettings`) + fila con la tecla actual + botón **"cambiar"** → popover on-brand (reusa `.cfm-*`) que captura
  el próximo keydown y lo serializa (`serializeAcceptKey`, **idéntico** a `sgSerializeKey` de terminals-ui →
  'Tab'/'ArrowRight'/'End'/'Alt+F'). Bridge `ConsomniTerms.setAutosuggest(enabled,key)` (empujado al boot + al
  togglear) y `setAutosuggestRebinder` (el hint clickeable de la terminal abre el popover; la config vive en app.js).
- **⚠️ Hardening (review adversaria):** (a) `isValidAcceptKey` **rechaza Ctrl** (mapea a chars de control del
  terminal: Ctrl+C=SIGINT, Ctrl+W=cerrar, Ctrl+V=pegar → bindearlas robaría esos shortcuts cuando hay sugerencia)
  y **Shift solo** (el descriptor llevaría `Shift+` pero la tecla pelada nunca matchearía); permite Alt + nav/F-keys.
  Defensa en profundidad: el accept en `shellAutosuggestKey` exige `!ev.ctrlKey`. (b) Los writes PROGRAMÁTICOS a la
  PTY (`insertCmd`/`insertIntoFocused`/NL/presets) marcan `_sgTrusted=false` (la sombra no conoce ese texto → sin
  sugerencia hasta el próximo Enter, para NO aceptar un sufijo desfasado y corromper la línea); `cdInto` ejecuta
  (\r) → resetea la sombra a vacío+confiable. (c) El accept extiende `_sgLine` SÓLO si el write a la PTY ocurrió.

### F2 — Pegar largo en claude colapsa a "[Pasted text]" (root-cause EMPÍRICO: era DUPLICACIÓN, no "unwrap")
- **Hipótesis descartada con evidencia:** se asumía que el paste no llegaba "envuelto" en bracketed paste. Falso.
  Captura de los bytes REALES que Consomni manda a la PTY (hex log temporal en `writeTerm`, paste en vivo): el
  `term.paste` de xterm SÍ envuelve correctamente — `\x1b[200~…\r…\x1b[201~`. Y el harness PTY headless contra
  `claude.exe` v2.1.187 confirma: cualquier wrap (`\r`/`\n`/`\r\n`) **colapsa** a `[Pasted text #N]`; sólo el
  texto SIN envolver queda expandido. O sea: el wrap ya funcionaba.
- **Causa REAL (verificada):** xterm tiene su PROPIO handler de `paste` que TAMBIÉN escribe el bracketed-paste a
  la PTY (probado: un `paste` event pelado → 1 write envuelto). Sumado a nuestro `termPaste` del Ctrl+V, un Ctrl+V
  real podía pegar DOS veces (si `preventDefault` no frenaba el paste nativo) → claude colapsa con el 1º y el 2º
  paste idéntico lo **EXPANDE** ("paste again to expand") → exactamente el síntoma de Franco (texto expandido +
  ese hint). El `ev.preventDefault()` de v1.8.1 mitigaba pero es frágil.
- **Fix** (`terminals-ui.js`): **guard de de-dup en CAPTURA**. El Ctrl+V setea `pane._pasteGuard = Date.now()`;
  un listener `body.addEventListener('paste', …, true)` traga el paste nativo si nuestro paste corrió hace <400ms
  (`preventDefault + stopImmediatePropagation`). GARANTIZA un solo paste sin importar si `preventDefault` frenó el
  nativo. Verificado: keydown Ctrl+V + `paste` event juntos → **1** write → `[Pasted text #1 +21 lines]` (queda
  colapsado). Pegar por menú del SO (sin guard reciente) sigue pasando el nativo (no rompe nada).
- **PASO 2 (colapso a nivel Consomni para SHELL): NO se hizo** (honesto): retener el paste del shell rompería
  "pego y Enter para correr". El colapso es feature de la TUI de claude; los shells reciben el paste verbatim.

### F3 — Badge "+N −N" (cambios sin commitear) VISIBLE en inicio + matchea Warp (cuenta untracked)
- **Causa raíz de "no se ve" (`terminals-ui.js`):** `updateDiffBadge()` sólo armaba key con `view!=='__home__' &&
  viewCwd`. Franco trabaja en **inicio** con una terminal suelta → key='' → el badge NUNCA se mostraba, aunque
  `lastSnap.diffStats` SÍ tenía la key del cwd. **Fix:** fallback a la **terminal ACTIVA** (`activeTermCwd()`) cuando
  no hay `viewCwd`; el cwd resuelto se guarda en `el._cwd` (el click abre el diff correcto); `updateDiffBadge()` se
  dispara también desde `setFocus`/`updateCount` (sigue a la terminal enfocada). **⚠️ Bug secundario fijado:**
  `bindSnap()` no se llamaba en el path de abrir una terminal (sólo en restore con dock NO vacío) → `lastSnap`
  quedaba null → el badge no tenía datos. Ahora `ensureDock()` llama `bindSnap()` (idempotente) → `lastSnap` siempre
  disponible. Verificado: en inicio maximizado, "TERMINALES [+313 −12]" sigue al cwd de la terminal activa.
- **Matchear Warp (cuenta untracked) (`sessions.ts`):** `git diff --shortstat HEAD` NO cuenta archivos nuevos sin
  trackear; Warp/VS Code sí. `countUntrackedAdds()` corre `git -c core.quotepath=false status --porcelain
  --untracked-files=all`, parsea las líneas `??` y suma las líneas de cada archivo nuevo. **ASÍNCRONO**
  (`fs.stat`/`fs.readFile`, NO `*Sync` → no bloquea el event loop del main aunque haya muchos archivos) y
  **DETERMINÍSTICO** (cap por CANTIDAD ≤200, orden estable de git status → el set es fijo → el número NO parpadea
  entre recálculos; ≤256KB/archivo, salta binarios por NUL). **⚠️ Review adversaria:** la 1ª versión leía con
  `*Sync` + un presupuesto de ~150ms que cortaba el loop en distinta cantidad de archivos cada ciclo → sumas
  parciales distintas → el badge parpadeaba + jank en el main thread. La versión async+por-cantidad lo elimina.
  El número difiere a propósito de `git diff --shortstat` puro — para matchear lo que ve el usuario. El board
  (`.col-diff`) ya andaba; ahora muestra el total con untracked (ej consomni +408/−15, altitude +1856/−1).

---

## v1.9.1 — Fixes visuales del topbar (campanita/⌘K/Actualizar tapados) + pill "actual" del changelog
> Tres bugs visuales reportados por el usuario. Bump **1.9.0 → 1.9.1**. Aditivo, sólo CSS con tokens.

- **⚠️ Causa raíz (importante para el futuro): `app.css` carga ANTES que `tokens.css`** (ver `index.html`:
  "app.css primero (registra @font-face); tokens.css verbatim después"). Por eso un override de app.css con un
  selector de **misma especificidad** que tokens (ej `.topbar`) **NO gana** el cascade (tokens viene después).
  Los responsive de app.css andan porque usan selectores MÁS específicos (`.topbar .seg`, `body.light …`).
- **Campanita + ⌘K + "Actualizar" tapados por los botones nativos de la ventana (#1 y #3, misma raíz):** la
  regla `.topbar{padding-right:148px}` (que reserva el ancho de los botones min/max/cerrar del `titleBarOverlay`,
  v1.8.0) la pisaba `tokens.css .topbar{padding:0 16px}` → el `padding-right` REAL era **16px** → los íconos de la
  derecha quedaban DEBAJO de los botones nativos (verificado midiendo en vivo: bell en x≈1319, botones nativos
  desde x≈1304). **Nunca funcionó desde la v1.8.0** (en los screenshots de dev no se ve porque `capturePage` no
  dibuja los botones nativos del SO). **Fix:** `header.topbar` (tipo+clase → mayor especificidad, gana sí o sí) +
  ancho EXACTO de los botones nativos vía **Window Controls Overlay** `padding-right: calc(100vw -
  env(titlebar-area-width, calc(100vw - 148px)) + 10px)` (las env `titlebar-area-*` SÍ resuelven en Electron 29;
  fallback 148px si WCO no está). Verificado: `padding-right` pasó a 146px y bell/⌘K/Actualizar quedan a la
  izquierda de la región de los botones nativos.
- **Pill "actual" del changelog descentrado (#2):** `.chl-pill` tiene `letter-spacing:1px`, que deja 1px de aire
  DESPUÉS de la última letra (dentro de la caja) → la palabra se veía corrida a la izquierda. Fix: `padding`
  asimétrico `2px 6px 2px 7px` (1px más a la izquierda) para compensar y centrar. (Nota: `text-indent` no servía,
  el pill es `<span>` inline.) Verificado por zoom 14x.

---

## v1.9.2 — "actual" del changelog centrado (medido por métricas) + buscador del topbar clickeable
> Dos ajustes (feedback del usuario). Bump **1.9.1 → 1.9.2**. Aditivo, CSS con tokens.
- **Pill "actual" — centrado VERTICAL (el `padding` de la 1.9.1 sólo arregló lo horizontal):** las mayúsculas son
  ink 7px TODO sobre la baseline (descent 0; medido con `canvas.measureText`), así que con `line-height:1` +
  `align-items:center` el ink quedaba **1px ARRIBA** del centro de la caja (16.5px de alto). Fix MEDIDO: `.chl-pill`
  → `display:inline-flex;align-items:center;justify-content:center;line-height:1` + `padding:4px 6px 2px 7px`
  (top 1px MÁS que bottom → baja el ink 1px exacto al centro; left 1px más que right por el letter-spacing).
  Verificado clonando el pill a 16x con una línea roja en el centro de la caja (el ink la cruza por el medio).
- **Buscador del topbar clickeable:** el cuadro de "buscar" SÍ funcionaba (tecla `/` → `activateSearch` → filtra el
  board por nombre/proyecto/branch) pero como es un `<div>` sin handler de click parecía de adorno. Ahora el click
  lo activa igual que `/`: `data-act="search"` en el `<div>` (chrome.js, atributo invisible de wiring) + caso
  `act==='search'` en el dispatch de clicks de app.js + `cursor:pointer` (afordancia). NO se sacó: es parte del
  design-reference (Hard Rule 1) y es funcional.

---

## v1.9.3 — Buscador del topbar con estado activo de verdad (foco + caret + × + click-afuera)
> Feedback del usuario: al clickear el buscador no se veía que estabas adentro (ni caret), tipear filtraba
> "invisible" y no había forma rápida de borrar el filtro. Bump **1.9.2 → 1.9.3**. Aditivo; el estado INACTIVO
> queda IDÉNTICO al design-reference (Hard Rule 1). Verificado en vivo (4 estados + filtrado, por screenshot).
- **Estados nuevos del `.search`** (chrome.js, data-driven con `o.searchActive` + `o.searchQuery`, reemplazan al
  viejo `o.searchValue`): INACTIVO = igual que siempre (placeholder + `kbd /`). ACTIVO = clase `searching` →
  **ring de foco verde** (`border-color:var(--green)` + `box-shadow` halo) + **caret titilando** (`.search-caret`,
  barrita `var(--green)` con `@keyframes searchCaret`). CON-FILTRO = clase `has-q` → el query en `.search-q`
  (texto `--text-1`) + **`×`** (`.search-clear`, `data-act="search-clear"`) para borrar al toque.
- **app.js:** `transform()` pasa `searchActive`/`searchQuery`; dispatch de clicks suma `search-clear` →
  `deactivateSearch(true)` (borra + sale). **Click AFUERA** del `.search` (junto al outside-click del bell) →
  `deactivateSearch(false)` (mantiene el filtro pero sale del modo input → tipear ya no filtra "invisible"; el
  query queda visible con su `×`). El typing sólo filtra con `searchActive` (que ahora SÍ se ve).
- **⚠️ Gotcha (CSS):** `tokens.css .search span{flex:1}` (regla amplia) le pegaba `flex:1` a `.search-q` →
  el caret quedaba al borde derecho en vez de PEGADO al texto. Fix: `.topbar .search .search-q{flex:0 1 auto}`
  (shrink-to-content). El `.search-body`/`.search-ph` SÍ quieren `flex:1` (lo heredan de tokens, ok).
- **Responsive:** el colapso a icon-only de `@media(max-width:900px)` se scopeó a `:not(.searching):not(.has-q)`
  para que el buscador activo / con filtro se vea entero a cualquier ancho.

---

## v1.9.4 — Pegar imágenes en claude funciona a la 1ª (Consomni lee la imagen y le pasa la ruta)
> Reporte del usuario: al pegar una imagen en una terminal `claude` (con **Alt+V**), a veces el primer intento
> decía "no hay nada pegado" y había que pegarla de nuevo. El usuario aclaró que **no es de Consomni** (pasa
> igual en Warp). Bump **1.9.3 → 1.9.4** (`package.json` + fallbacks `brand-ver`/`.ver` en `chrome.js` + entrada en
> `CHANGELOG` de `app.js`). TODO verificado EMPÍRICAMENTE (investigación multi-fuente + harness PTY headless contra
> `claude.exe` real + e2e con clipboard real en Electron). Aditivo, respeta las 4 Hard Rules (cero red, cero API
> de Anthropic — sólo Electron `clipboard` + `fs` en %TEMP%; cero atribución a IA).

### Causa raíz (CONFIRMADA, no asumida)
- **La tecla de pegar-imagen en Windows es `Alt+V`** (= Meta+V = `ESC v`), NO Ctrl+V (Ctrl+V es texto). Verificado.
- **El lector de imágenes de claude en Windows está ROTO** (no es timing): claude toma del portapapeles un **bitmap
  CF_DIB/BMP** y lo intenta decodificar con el **`sharp`/libvips WASM que bundlea — que NO tiene loader de BMP** →
  devuelve nada → "no hay imagen", falla en silencio. Prueba irrefutable (issue #56792): el SO confirma
  `Clipboard::ContainsImage()=True` y Codex CLI lee la misma imagen bien, y aun así claude dice vacío → **el bug es
  del lector de claude, no del SO ni del host** (por eso pasa también en Warp). La intermitencia "2ª vez anda" es un
  contribuyente secundario (settling/contención del portapapeles), no la causa principal.
- **claude SÍ adjunta una imagen por su RUTA**: una ruta a `.png/.jpg/.gif/.webp` (absoluta, **con backslashes de
  Windows, sin comillas, sin `@`**) se convierte en `[Image #N]`. **Clave (verificado por harness):** sólo la dispara
  si llega como **BRACKETED PASTE** (`\x1b[200~…\x1b[201~`); el tecleo crudo de la ruta NO la reconoce.

### El fix (Consomni se adueña del pegado de imagen → saltea el lector roto de claude)
- **`index.ts` IPC nuevo `consomni:clipboardImageToTempPng`:** `clipboard.readImage()` (Electron/Chromium lee el
  CF_DIB robusto; nunca devuelve null → `isEmpty()`/`getSize().width===0` = sin imagen) → `toPNG()` → escribe
  `%TEMP%\consomni-paste\clip-<ts>.png` y devuelve `{ok,file,…}`. Limpieza best-effort de pastes >6h (Windows no purga
  %TEMP%). Import nuevo `os`. 100% local (HR3): sólo `clipboard`+`fs`, sin red.
- **`preload.ts`:** bridge `clipboardImageToTempPng()`.
- **`terminals-ui.js`:** helper `pasteClipImage(term,pane)` → llama el IPC; si hay imagen, inserta la ruta con
  **`term.paste(file)`** (envuelve en bracketed paste respetando el modo del PTY, que claude tiene activo; fallback al
  raw `\x1b[200~…\x1b[201~`) → claude la convierte en `[Image #N]` al instante. Wiring en `attachCustomKeyEventHandler`:
  - **Alt+V** (sólo claude, ANTES del guard `if (ev.type!=='keydown')` como Shift+Enter → suprime el `ESC v` de xterm en
    TODOS los tipos): si hay imagen → la pega; **sin imagen → reenvía `\x1bv`** (deja que claude intente, como siempre).
  - **Ctrl+V** (sólo claude): si hay imagen → la pega; si no → **pega texto** (`termPaste`, como siempre). En shell, Ctrl+V
    sigue siendo sólo texto.
- **Por qué la ruta y no "cebar" el portapapeles:** cebar (materializar el CF_DIB con `readImage` antes de reenviar la
  tecla) sólo arreglaría el caso de timing, NO el de formato (claude seguiría leyendo el BMP que su `sharp` no decodifica).
  La ruta saltea el lector roto entero → anda a la 1ª SIEMPRE, sin importar el formato del origen.

### Verificación empírica (gold standard)
- **Harness PTY headless** (electron-as-node + node-pty ABI v121) contra `claude.exe` v2.1.190 real: el tecleo crudo de la
  ruta → NO reconocida (queda el texto literal); el **bracketed paste** de la ruta → **`[Image #N]` al instante**, en las 4
  variantes (backslash / forward-slash / con y sin espacio). Nunca se envía Enter → cero llamadas a la API.
- **E2E en Electron completo** (con `clipboard` real): `clipboard.writeImage()` (deja CF_DIB, como un screenshot) →
  lógica EXACTA del IPC (`readImage→toPNG`) → `size=512x512, validPNG=true, existsOnDisk=true` → bracketed paste de esa
  ruta → claude mostró `[Image#1]`. **VERDICT=FIX OK end-to-end.**
- **Límite del sandbox:** `capturePage` necesita display → el screenshot del app corriendo no se pudo sacar en este entorno
  (el e2e *sin ventana* sí corrió). El wiring del renderer (Alt+V→`pasteClipImage`→`term.paste`) reusa el patrón YA probado
  del pegado de texto (`termPaste`→`term.paste`, que funciona contra claude en Consomni) → `term.paste` envuelve en bracketed
  paste correctamente. TS compila limpio; `terminals-ui.js` pasa `node --check`.

---

## v1.9.4 — Selección del input en terminales claude (toggle de mouse + Ctrl+A) — a nivel xterm
> Pedido de Franco + Joaquim: poder **seleccionar (y copiar con Ctrl+C) el texto que venís escribiendo** en una
> terminal de claude, y que **Ctrl+A seleccione TODO el input**. (Parte de 1.9.4; va junto con el pegado de imágenes
> y el visor de archivos en vivo en el mismo release.) Aditivo, respeta las 4 Hard Rules.

### Por qué a nivel xterm (la TUI de claude NO soporta selección — VERIFICADO por harness PTY)
- Probe contra `claude.exe` v2.1.190 real: **Ctrl+A = "inicio de línea"** (mueve el cursor a la col 3), **Shift+flechas
  = mueven el cursor** (no seleccionan), **Ctrl+C sin selección = "Press Ctrl-C again to exit"** (no copia). O sea
  **claude no tiene selección de su input**. Además claude **activa mouse-tracking** (`?1000h/1002h/1003h/1006h`,
  re-asertado en cada redibujo) → un arrastre normal del mouse le manda el click a claude, NO selecciona. Por eso
  esto **sólo se puede hacer desde el host (xterm)**.

### Implementación (`terminals-ui.js` + `chrome.js` + `app.css`)
- **Toggle "modo selección" por panel (decisión del usuario):** botón `selection` (icono nuevo I-beam en `chrome.js`)
  en la cabecera de las terminales **claude** (`ensureSelBtn`, idempotente, espejo de `ensureVscodeBtn`/`ensureCdBtn`).
  `setPaneSelMode(pane,on)`: ON = `pane._selMode=true` + apaga YA el mouse-tracking de xterm (`\x1b[?1000l…?1006l`).
  El handler global de `term:data` (`bindIpc`) filtra `stripMouseTracking(data)` mientras el panel esté en modo
  selección → xterm queda con el mouse LIBRE → **arrastre normal selecciona** + Ctrl+C copia (`termCopy`, ya existía).
  OFF = claude re-asserta su mouse-tracking solo en el próximo redibujo (no se persiste; default OFF, no cambia nada).
- **`stripMouseTracking(data)`:** `data.replace(/\x1b\[\?(1000|1001|1002|1003|1005|1006|1015|1016)[hl]/g,'')` — saca
  SÓLO los DECSET de mouse; **no toca** cursor (`?25`), bracketed paste (`?2004`) ni alt-screen (`?1049`). Unit-tested.
- **Ctrl+A → seleccionar todo el input** (sólo claude; en shell pasa nativo a PSReadLine): intercepta Ctrl+A →
  `selectClaudeInput(term)` → `computeInputSelection(buf, cols)` calcula la región del input (del prompt `❯`/`›`/`>`
  hasta el cursor, multi-línea vía `length` que envuelve a `cols`; coords ABSOLUTAS `baseY+cursorY`, que en el
  alt-screen de claude = relativas porque `baseY=0`) → `term.select(startCol,startRow,length)`. Después Ctrl+C copia.
  Input vacío / sin prompt → `return true` (deja pasar a claude = inicio de línea). `Home` queda para inicio de línea.
- **CSS (`app.css`):** `.dk-pane-sel.on` = verde + borde verde + `var(--surface-input)` (tokens existentes, sin
  `color-mix` para no driftear de la convención del repo).

### Verificación
- **Unit test (node, 11/11):** `computeInputSelection` (1 línea / sin prompt→null / multi-línea / input vacío→null /
  con scrollback) y `stripMouseTracking` (saca mouse, NO toca cursor/bracketed/alt-screen). `node --check` OK en
  `terminals-ui.js`/`chrome.js`. API de xterm usada (`buffer.active.baseY/cursorY/cursorX/getLine`,
  `select(col,row,length)`, `hasSelection`/`clearSelection`) verificada contra la semántica de xterm.
- **Límite del sandbox:** el render de la selección y el arrastre del mouse son DOM de xterm → no se pueden verificar
  headless ni por screenshot en este entorno (sin display). La lógica pura está testeada y los botones reusan
  patrones ya probados; **el usuario debe probar el arrastre + Ctrl+A en vivo**.

---

## v1.9.4 — Visor de archivo: sync EN VIVO + rutas con espacios clickeables
> Pedido de Franco + Facundo: cuando claude genera un archivo, **click en su ruta → abrirlo en un panel a la derecha**
> (pantalla dividida) para laburarlo, **Ctrl+click → abrirlo en el editor**, y —lo nuevo/importante— que el panel se
> **actualice EN TIEMPO REAL** mientras el agente sigue editando (sin cerrar y reabrir). (Parte de 1.9.4.) Aditivo,
> respeta las 4 Hard Rules (sólo `fs` local, cero red/API).

### Qué ya existía (v1.7.1) y qué se agregó
- **Ya existía:** click en una ruta (terminal vía `registerLinkProvider` / conversación vía `linkifyPaths`) →
  `onPathActivate` → `openFilePanel` (pane efímero kind `'file'`, `placeContent(pane,'right')`); Ctrl/Cmd+click →
  `openFileEditor`; menú contextual con panel/editor/revelar. El visor (`mountFile`) leía el archivo **UNA sola vez**.
- **Nuevo 1) SYNC EN VIVO (`terminals-ui.js`):** `mountFile` ahora arranca un **poll** (`startFilePoll`, `setInterval`
  1000ms) que re-lee con `api.readFile` (que lee FRESCO del disco en cada llamada) y, si cambió, actualiza el `<pre>`
  (y el render `.md`) vía `applyFileRead`. **Robusto:** salta si el panel está oculto/minimizado (`offsetParent===null`)
  o movido en un re-tiling (`!isConnected`); **preserva el scroll** (si estabas abajo hace "tail", si no mantiene la
  posición); un error transitorio (archivo a medio escribir) NO pisa el contenido bueno (sólo en la lectura inicial se
  muestra el error). `stopFilePoll` se llama en `killPaneContent` (cierre del pane). Badge **"● vivo"** en la cabecera
  (`ensureLiveBadge`) que **pulsa** al actualizarse (`flashLive`). Se eligió poll (no `fs.watch`) por robustez
  cross-platform. CSS aditivo `.dk-fv-live`/`.dk-fv-live-dot`/`@keyframes fvLivePulse` con tokens.
- **Nuevo 2) RUTAS CON ESPACIOS (`findPathSpans`):** la regex vieja `[^\s…]+` cortaba en el espacio →
  `C:\Users\Usuario 7\…\draft.txt` se detectaba sólo hasta `C:\Users\Usuario` (no clickeable). Se agregó una regex
  **space-aware** que corre PRIMERO (el dedup por `taken` evita que las de abajo la partan): `\b[A-Za-z]:[\\/](?![\\/])
  [^\n:*?"<>|]*?\.<EXT>\b` — Windows-abs que puede tener espacios pero TERMINA en una extensión conocida; excluye `:`
  (no cruza a otra unidad) y lazy hasta la 1ª `.ext`. Verificado por unit test (9 casos: screenshot `Usuario 7`,
  `Program Files`, frase con la ruta en el medio, sin-espacios, relativas, dos rutas separadas por `:`, URLs intactas).

### Verificación
- **Unit test (node, 9/9):** `findPathSpans` con rutas con espacios + no-regresión + URLs. `node --check` OK.
- El sync en vivo se apoya en que `api.readFile` lee fresco del disco cada vez (evidente en el IPC: `openSync`/`readSync`
  por llamada, sin cache) → cada poll trae el último estado. **Límite del sandbox:** el render del panel + el pulso del
  badge son DOM → no verificables headless ni por screenshot (sin display); **el usuario debe ver el panel actualizándose
  en vivo**. Límite conocido pre-existente: si la ruta se **envuelve** en varias filas de la terminal, el link provider
  (por fila) no la arma entera (igual que antes).

---

## v1.9.5 — Terminal de claude: scroll del historial arreglado (regresión de v1.8.2 + ConPTY) + abrir claude más rápido
> Bug de Franco (alta prioridad) + feature de Facundo/Franco. Bump **1.9.4 → 1.9.5** (`package.json` + fallbacks
> `brand-ver`/`.ver` en `chrome.js` + entrada en `CHANGELOG` de `app.js`). Causa raíz CONFIRMADA por los docs de Anthropic
> + harness PTY headless. Aditivo, respeta las 4 Hard Rules (cero API: sólo env vars sólo-claude + opciones de xterm +
> `os.release()` en main; CSS con tokens; responsive; cero atribución a IA).

### Causa raíz de Franco (dos problemas que se suman)
1. **"No puedo scrollear al principio / el historial desaparece" = REGRESIÓN de v1.8.2.** El `CLAUDE_CODE_NO_FLICKER=1`
   (default-on) mete a claude en **alternate-screen** (como vim/htop), que **NO tiene scrollback de terminal** → una vez
   que el output supera el viewport no se puede scrollear hacia arriba. CONFIRMADO por los [docs fullscreen de Claude]
   (code.claude.com/docs/en/fullscreen) + [issue #42670] + harness PTY headless (con `NO_FLICKER=1` el stream emite
   `\x1b[?1049h`; con `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` NO → renderer clásico con scrollback). Y la **rueda del mouse
   en xterm.js (igual que la terminal de VS Code) manda 1 evento por notch → claude scrollea 1 línea por notch (lentísimo)**
   → se siente "no puedo scrollear"; el fix es `CLAUDE_CODE_SCROLL_SPEED=3` (default de vim, recomendado por los docs para
   terminales xterm.js).
2. **"Texto viejo superpuesto / cortado tras resize" = corrupción ConPTY↔xterm.** El `new Terminal({...})` NO seteaba
   `windowsPty` → xterm doble-reflowea al hacer resize (xterm + ConPTY reflowean distinto). Cross-terminal (también rompe
   Warp). Fix: `windowsPty:{backend:'conpty',buildNumber}`.

### Fixes (decisión del usuario: mantener fullscreen default + scroll que anda + toggle por terminal)
- **L1 — `windowsPty` (sin trade-off)** (`terminals-ui.js` ctor de xterm): `windowsPty:{backend:'conpty',buildNumber:<build
  de Windows>}` + `scrollback 6000→12000`. El build de Windows lo expone el **preload** (`api.winBuild`, sincrónico para
  el ctor de xterm). **⚠️ Gotcha (fijado): el preload está `sandbox:true`** → NO se puede `require('os')` (crashea el preload
  → `window.consomni` no se expone → la app cae a la data MOCK de chrome.js y las terminales "no disponibles"). Se obtiene
  con `ipcRenderer.sendSync('consomni:winBuild')` (el handler en `index.ts` se registra ANTES de `createWindow`). Verificado:
  build=26200 (≥21376 → xterm habilita reflow ConPTY-aware).
- **L2 — resize hygiene** (`terminals-ui.js`): `pushPty` ahora **debounce 80ms** del SIGWINCH (ConPTY se corrompe con resizes
  rápidos; el fit de xterm sigue en vivo); `showView`/`restorePane` resetean `pane._ptySize=''` al re-mostrar un panel (estuvo
  oculto en el pool sin resize → fuerza un SIGWINCH fresco) + 2º pase de `refitAll` por rAF al asentar el layout.
- **L3a — `CLAUDE_CODE_SCROLL_SPEED=3`** (`terminals.ts` `applyClaudeFullscreenEnv`, sólo en modo fullscreen): la rueda en
  xterm.js pasa de 1 línea/notch a fluida (el user afina con `/scroll-speed` de claude).
- **L3b — toggle "scroll nativo" por panel** (botón `scroll` en la cabecera de cada terminal claude, ícono nuevo en
  `chrome.js`): `setPaneScrollMode` escribe `/tui default` (→ clásico, scroll nativo, conserva la conversación) o
  `/tui fullscreen` (→ input anclado) a la PTY. El modo se persiste por panel (`dataset.fullscreen` → `serializePane`/
  `buildPane` → `dock.json`) y fluye al spawn: `applyClaudeFullscreenEnv(env, want)` setea `NO_FLICKER=1` (fullscreen) o
  `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` (clásico) — `createTerm` recibe `fullscreen?` vía IPC. El default global sigue
  siendo `config.claudeFullscreen` (Settings, relabel "input anclado abajo · off = scroll nativo"), empujado a `ConsomniTerms.
  setClaudeFullscreenDefault` al boot + al cambiarlo.

### Abrir claude más rápido (Facundo + Franco)
- **Reusar el claude activo** (`terminals-ui.js`): el botón **claude** del toolbar del dock ahora **enfoca** el claude activo
  de la vista si hay uno (`findActiveClaude`: PTY viva, no minimizado, no `dead`, scopeado por `matchesView`; `focusClaudePane`
  espeja el tail de `openSession`) en vez de abrir otro (Facundo terminaba con 5 tabs). **Shift/Alt+click = uno nuevo**;
  `claude ⚡` sigue siempre-nueva.
- **Botón claude de un toque al entrar a un proyecto** (`placeholderHTML`): el placeholder de un proyecto SIN terminales ahora
  muestra botones **abrir claude** (destacado) / **terminal** en su cwd (`viewCwd`), reusando el handler `[data-home-open]`
  (spawnea en la vista actual = el proyecto). Los chips del inicio también ponen **claude primero**. Sin spawn no pedido.
- CSS aditivo (`app.css`): `.dk-pane-scroll.on` (verde = scroll nativo), `.dk-ph-pbtn--claude` (acción primaria), `.dk-ph-actions`.

### Verificación
- **Harness PTY headless** (electron-as-node + node-pty ABI v121): `NO_FLICKER=1` → `?1049h` SÍ ; `DISABLE_ALTERNATE_SCREEN=1`
  → `?1049h` NO. PASS. **En vivo** (screenshot): app arranca con `windowsPty` sin romper, claude resume con el input anclado
  abajo (fullscreen), `winBuild=26200` llega al renderer, el botón `scroll` está en la cabecera (`scrollBtn=1`), v1.9.5 en topbar/
  sidebar, diff badges OK. TS compila limpio; `node --check` OK en los 3 .js del renderer.
- **Límite del sandbox/medio:** el arrastre de selección, el scroll de la rueda EN VIVO y el reflow visual al redimensionar son
  DOM/interacción → el usuario debe probarlos en vivo (la lógica + el mecanismo de env vars están verificados).

---

## v1.9.6 — Ícono del escritorio en updates + terminal de claude que no se duplica + scrub de nombres
> Tres fixes (reportes de usuarios). Bump **1.9.5 → 1.9.6** (`package.json` + fallbacks `brand-ver`/`.ver` en `chrome.js` +
> entrada en `CHANGELOG` de `app.js`). Causa raíz de la duplicación **confirmada por harness PTY headless**. Aditivo, respeta
> las 4 Hard Rules.

### 1) El acceso directo del escritorio desaparecía tras un auto-update (`build/installer.nsh`)
- **Causa raíz** (trazando los templates NSIS de electron-builder 25.1.8 en `node_modules/`): en un auto-update electron-updater
  corre el desinstalador VIEJO con `--keep-shortcuts` para que los accesos directos SOBREVIVAN; el borrado built-in está
  guardado por `${ifNot} ${isKeepShortcuts}`. **Pero el `customUnInstall` custom borraba `$DESKTOP\…lnk` SIN condición** → cada
  update lo mataba.
- **Fix:** `customUnInstall` → `${ifNot} ${isKeepShortcuts}` (no borra en updates; sí en uninstall real). `customInstall` → crea
  si el checkbox quedó tildado **o** `${isUpdated}`, + `SHChangeNotify` para refrescar el escritorio al instante.
- **NO** se tocó: `electron-builder.yml` (`createDesktopShortcut` queda `false` — el ícono es 100% custom por el checkbox de
  v1.2.0; `"always"` rompería el opt-out y NO arregla el update porque el recreate built-in está guardado por `${ifNot}
  ${isUpdated}`), `appId` (`com.ironidevz.consomni`, estable git-confirmado), ni el esquema de instalación. Versiones fuera del
  rango de la regresión conocida (eb 26.7.0 / eu 6.7.3).

### 2) Terminal de claude duplicaba "el principio" al minimizar→restaurar→maximizar (`src/main/terminals.ts`)
- **Causa raíz CONFIRMADA por harness PTY headless** (electron-as-node + node-pty ABI v121 contra `claude.exe` real, stream
  alimentado a `@xterm/headless`): **ConPTY REPINTA su pantalla en CADA `ResizePseudoConsole`, INCLUSO al MISMO tamaño** — medido:
  un resize no-op (100x24 → 100x24) hace re-emitir **4211 bytes** (repintado completo). El `_ptySize=''` que v1.9.5 reseteaba en
  `restore`/`showView` (para "re-anclar") forzaba justo ese resize de mismas dims en cada restore/maximize → el repintado se
  agregaba al scrollback → "duplicado lo del principio".
- **Fix:** **guard no-op en `resizeTerm`** — si `cols`/`rows` no cambian respecto del PTY actual, NO se llama a `t.proc.resize`. Un
  resize genuino sí pasa (claude re-ancla bien). Mata la duplicación Y estabiliza el scroll (los repintados espurios lo saltaban
  al fondo). Comprehensivo: cubre cualquier re-empuje espurio (RO/fonts/foco/doble-rAF/minimize-restore), en streaming o no.
- **Verificado headless:** el stream clásico de claude alimentado a xterm da buffer LIMPIO (números 1..40 una sola vez); el no-op
  resize SÍ re-emite 4211 bytes. claude en modo clásico (DISABLE_ALTERNATE_SCREEN) NO usa alt-screen pero redibuja su TUI con
  **posicionamiento ABSOLUTO** (`\x1b[fila;colH`) + `\x1b[2J` → render full-screen que en main buffer ensucia el scrollback.

### 3) Leer el historial de claude (la "superposición mientras streamea")
- **Decisión del usuario:** mantener **fullscreen como default** (render limpio: alt-screen aísla los redibujos full-screen de
  claude). La superposición que aparece en modo **scroll-nativo/clásico** es inherente a cómo claude redibuja (absoluto +
  full-screen) sobre el scrollback de ConPTY → no hay fix limpio a nivel app; por eso fullscreen sigue de default.
- **Surfaceo de Ctrl+O** (`terminals-ui.js`): el modo confiable para leer/buscar TODO el historial en fullscreen es **Ctrl+O**
  (transcripción de claude). Se avisa en el tooltip del botón de scroll, en el toast del toggle, y un aviso **una vez por sesión**
  al RETOMAR un claude (`claudeHistHintShown`). El toggle "scroll nativo" sigue, con su tooltip avisando que claude puede pisar
  líneas mientras escribe.

### 4) Cero nombres de terceros en lo que ve el usuario (pedido del usuario)
- Se sacaron los nombres de personas de **las release notes** (se editó el cuerpo del GitHub Release **v1.9.5** vía
  `gh release edit`) y de los **comentarios de código** que se empaquetan en el asar (`src/renderer/*.js`, `src/main/*.ts` →
  "reportado por usuarios"/"pedido de usuarios"). El changelog in-app (`CHANGELOG` de `app.js`) ya estaba limpio. **Regla de acá
  en más:** ni release notes, ni changelog in-app, ni notificaciones llevan nombres de quien reportó/pidió algo. La atribución de
  AUTORÍA del mantenedor (`by Joaquim Colacilli`, repo `JoaquimColacilli/consomni`) es legítima y se mantiene.

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
  intervalo refresh, sonidos, puerto, **`checkUpdates`** (chequeo de updates al iniciar, default `true`,
  opt-out desde Settings). Estado local (pin/fav/archivar) en `~/.consomni/state.json`.

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
- [x] **v0.5.0 — mantenimiento/feedback del usuario.** (1) **Fix terminal/QA:** los `qa-btn` de la card no
      llevaban `data-sid` → al clickearlos `dispatchAction(act, null)` tiraba "elegí una sesión primero" y
      NO abría la terminal. Ahora el handler de click toma el sid de la `.card[data-sid]` contenedora →
      term/ext/copy funcionan sin foco previo. (2) **Botón "+" del board centrado** (54×54, `align-self:flex-start`
      + `.iconbtn` centra el icono; antes `align-self:stretch` + `flex-start` lo empujaba arriba). Wired a
      `openPalette()`. (3) **Atribución de autor:** `gh()` (octocat) + link `data-href` "by Joaquim Colacilli"
      en sidebar (expandida + colapsada) y onboarding → `actions.openExternal` (https only, vía `shell.openExternal`,
      no pasa por el network-guard). (4) **Update-check** (ver `src/main/updates.ts` + excepción a Hard Rule 3):
      chequeo al iniciar (opt-out) + botón manual en Settings; toast clickeable si hay versión nueva. (5) **Icono
      embebido real** (abajo). (6) Versión real del package → snapshot (`appVersion`) → sidebar (no más hardcode).
      Onboarding ya existía (sólo aparece si los hooks NO están instalados y no fue dismisseado).
- [x] **v0.6.0 — TERMINALES EMBEBIDAS (pivote pedido por el usuario).** Consomni ahora hospeda PTYs
      reales adentro (node-pty + xterm), no sólo observa. Ver sección "Terminales embebidas" arriba.
      Cambios de interacción: `term`/`dispatch` ya no lanzan `wt` externo → abren terminal/claude embebida
      full-screen; se sacó la `x` confusa de las cards (`qaBtns` → `['ext','term','copy']`); click en la
      MISMA card abierta ahora la cierra (toggle); "+" del board, botón `>_` del sidebar y Shift+T abren el
      workspace; detalle E2 suma "terminal acá" / "claude acá". Electron pinneado a 29 (ver Stack). node-pty
      verificado cargando + spawneando PTY real dentro de Electron (smoke test) y en el .exe empaquetado.

### Packaging — icono embebido + winCodeSign (máquina sin Developer Mode/admin) — RESUELTO
- **El problema:** `rcedit-x64.exe` (que embebe icono/metadata en el `.exe`) viene DENTRO del paquete
  `winCodeSign`. electron-builder lo re-extrae y falla creando 2 symlinks darwin (.dylib) por falta de
  privilegio. Por eso `signAndEditExecutable: false` saltaba TODO (firma **y** rcedit) → el `.exe` quedaba
  con el icono default de Electron.
- **La solución (v0.5.0):** se **pre-extrae** `winCodeSign-2.6.0` **sin** la carpeta `darwin` (única con
  symlinks) vía `build/prep-wincodesign.ps1` (`7za x -xr!darwin`). Con la carpeta ya presente (incluye
  `rcedit-x64.exe` + `windows-10\`), `signAndEditExecutable: true` corre rcedit y embebe el icono sin tocar
  symlinks. La firma se saltea igual (sin cert).
- **Icono real:** `build/icon.png` (512, ojo + wordmark) → `build/icon.ico` multi-res (256/128/64/48/32/24/16,
  PNG-in-ICO) generado por `build/make-ico.ps1` (System.Drawing). `win.icon: build/icon.ico`. **OJO:** no usar
  `param([string]$Src)` y luego `$Src = [Image]::FromFile(...)` — el tipo `[string]` castea la Image a
  `"System.Drawing.Bitmap"`. NSIS necesita .ico real; no pasar `installerIcon` png.
- **Build:** `Remove-Item Env:ELECTRON_RUN_AS_NODE; powershell -File build\prep-wincodesign.ps1; $env:CSC_IDENTITY_AUTO_DISCOVERY='false'; npm run dist`. Verificado: el `.exe` (win-unpacked + portable) lleva el ojo de Consomni.

### Packaging — módulo nativo node-pty (sin MSVC) — v0.6.0
- node-pty es nativo y la máquina de build **no tiene Visual Studio/MSVC** → no se puede compilar.
  Solución: usar el fork **PREBUILT** `@homebridge/node-pty-prebuilt-multiarch` y bajar el binario del
  ABI de Electron con `prebuild-install --runtime=electron --target=<ver>`. El prebuild más nuevo del fork
  es **electron ABI v121 = Electron 29** → por eso Electron está pinneado a `29.x` (33 no tiene prebuild).
- En `electron-builder.yml`: **`npmRebuild: false`** (NO recompilar desde fuente — usaría node-gyp y fallaría)
  y **`asarUnpack: node_modules/@homebridge/node-pty-prebuilt-multiarch/**/*`** (el `.node` no carga desde
  dentro del asar). El primer `npm install` baja el prebuild de Node; tras pinear Electron correr una vez
  `cd node_modules/@homebridge/node-pty-prebuilt-multiarch && node ../../prebuild-install/bin.js --runtime=electron --target=29.4.6 --arch=x64`.
- **Setup desde cero:** `npm install` → fetch prebuild de node-pty para electron (comando de arriba) →
  `npm run dist`. Verificado: terminal embebida abre en el `.exe` empaquetado.

### Distribución — instalador (checkbox) + auto-update (v1.2.0)
- **Instalador NSIS con checkbox de acceso directo:** `nsis.oneClick:false` (asistido). El acceso del
  **escritorio** lo maneja `build/installer.nsh` (lo toma electron-builder solo por estar en `build/`):
  una página `nsDialogs` con el checkbox **"Crear acceso directo en el escritorio"** (MARCADO por
  default) vía `customPageAfterChangeDir`; `customInstall` crea `$DESKTOP\Consomni.lnk` sólo si quedó
  tildado y `customUnInstall` lo borra. Para no duplicarlo, `nsis.createDesktopShortcut:false` en el yml
  (el del **menú inicio** lo sigue creando electron-builder).
- **Auto-update (electron-updater):** `autoUpdater.autoDownload=false`, guard `app.isPackaged` (es no-op
  en dev). `initAutoUpdate()` chequea al iniciar + cada 30 min; eventos → IPC al renderer:
  `update-available` (muestra el botón **"Actualizar"** del topbar, oculto si no hay update) → click →
  `updateDownload()` → `download-progress` (anima el botón: fill verde + ícono pulsando, `--upb-pct`) →
  `update-downloaded` → `quitAndInstall()` (relanza). Botón = `.upbtn` en `chrome.js` (tokens
  `--green/--amber`, Geist Mono, CSS aditivo en `app.css` → respeta Hard Rule 1; icon-only <900px →
  responsive). Estado vivo en `state.upd`, re-aplicado tras cada render (`applyUpdBtn`). QA sin updates
  reales: `__consomni.simulateUpdate('available'|'progress'|'downloaded'|'installing', {…})`.
- **Canal de updates = repo PÚBLICO `JoaquimColacilli/consomni`** (`publish:` en el yml apunta a él).
  La decisión (entre repo público de releases / generic provider / hacer el repo público) la tomó el
  usuario: **hacer el repo público**. Implicancia: el código y el **email de los commits**
  (`joaquimcolacilli9@gmail.com`) quedan visibles. La app lee `latest.yml` + el nsis **sin token**.
- **Flujo de release:** (1) `bump` de `version` en `package.json` (+ `brand-ver` en `chrome.js` y `.ver`
  del sidebar); (2) `GH_TOKEN=<fine-grained, write a consomni>` como **env var LOCAL** (NUNCA se commitea);
  (3) `npm run release` (= `build` + `electron-builder --win --publish always`) → sube `latest.yml` +
  `Consomni-Setup-x.y.z.exe` + blockmap a GitHub Releases. Los usuarios con versión anterior ven el botón.
- **Sin firmar:** primera instalación dispara SmartScreen (avanzar → "Ejecutar de todas formas"); el
  auto-update igual funciona. Code-signing queda **fuera de alcance** (TODO).
- **v1.2.1 (feedback del usuario):** (1) **update SILENCIOSO** → `autoUpdater.quitAndInstall(true, true)`
  (antes `false,true` abría el panel completo del nsis "como si bajaras la app de 0"). (2) **"ejecutar al
  finalizar" que SÍ abre** → `customFinishPage` propio que lanza con `Exec` directo (el default usa
  `StdUtils.ExecShellAsUser`, pensado para des-elevar desde instalador admin → en per-user no lanzaba) +
  `second-instance` ahora hace `show()`+`focus()` para el caso "ya hay una instancia". (3) **toast de update
  persistente y clickeable** (z-index 60, por encima del dock maximizado) → el update es accionable aunque el
  topbar esté tapado por las terminales en "inicio". (4) **divisor agarrable de TODA la pared** (ver gotcha del
  splitter abajo). **⚠️ Gotcha NSIS:** en una `Function`, los `${...}` se resuelven al PARSEAR (el include va
  en el header, ANTES de `common.nsh`), así que NO sirve `${APP_EXECUTABLE_FILENAME}` (define tardío) → usar
  `${PRODUCT_FILENAME}` (define de línea de comando, disponible desde el arranque). En un `!macro` sí sirve
  (expande tardío). Los símbolos sólo-instalador van en `!ifndef BUILD_UNINSTALLER` (el include se compila también
  en el pass del uninstaller).
- **⚠️ Gotcha del splitter del dock (v1.2.1):** el divisor entre terminales se agarraba "sólo del centro" porque
  tenía **alto/ancho 0** — el `align-items:stretch` del flex NO propaga por el árbol anidado (los paneles ya
  llevaban `height:100%` explícito, pero al `.dk-splitter` nunca se lo agregamos). Fix: el divisor es una
  **columna/fila DEDICADA de 10px** con `height:100%`/`width:100%` explícito → toda la pared (ancho completo y de
  punta a punta) es zona de agarre, con una línea fina centrada. Además el drag normaliza TODOS los hermanos a su
  px en DOS pasos (medir y después escribir) para no colapsar paneles al arrastrar con 3+.

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
