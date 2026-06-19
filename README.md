<div align="center">

# 👁 CONSOMNI

**consola + omni · "un ojo que lo ve todo"**

Orquestador de escritorio que monitorea **en tiempo real** todas tus sesiones de
Claude Code en paralelo, leyendo data **100% local**. Un board kanban por proyecto,
con estado vivo (working / atención / idle), panel de detalle, command palette y
acciones reales sobre tus repos.

*Electron + TypeScript · Windows · local-first*

</div>

---

## 🔒 Privacidad — local-first

- **Cero llamadas a la API de Anthropic.** Consomni no manda nada a ningún lado.
- **Read-only** sobre `~/.claude/projects`: lee los transcripts `.jsonl` para derivar
  tokens, modelo, contexto, actividad y tool calls. **Nunca** escribe, mueve ni borra transcripts.
- **Única red:** `127.0.0.1` (el server local que recibe los eventos de los hooks).
  Un CSP estricto + un guard de red en el proceso main **bloquean toda red externa**.
- Toca `~/.claude/settings.json` **solo** para instalar/desinstalar los hooks, y **siempre
  con backup previo** en `~/.consomni/backups/` (merge no-destructivo, restaurable).
- Sin telemetría, sin analytics. La fuente Geist Mono va vendorizada local (offline 100%).
- **Única salida de red fuera de 127.0.0.1:** un chequeo de versión de sólo-lectura contra el
  repo del propio proyecto en GitHub (`releases/latest`), para avisarte si hay update. No manda
  datos tuyos, no hay telemetría, y es **opt-out** desde Settings (`buscar al iniciar`).

---

## 🚀 Setup

Requisitos: **Node 18+**, **Windows 10/11**. (Opcionales para acciones: VS Code/Cursor, Windows Terminal, git, gh.)

```bash
npm install        # dependencias
npm run dev        # compila TS + lanza la app
npm run build      # solo compila TS (src/main + src/preload → dist/)
npm run dist       # empaqueta Windows: portable + instalador NSIS → release/
```

> **Icono embebido (máquina sin Developer Mode/admin):** `rcedit` (que embebe el icono en el `.exe`)
> viene dentro del paquete `winCodeSign`, cuya extracción falla por unos symlinks de macOS. Antes del
> primer `npm run dist`, corré una vez `powershell -File build\prep-wincodesign.ps1` (pre-extrae
> `winCodeSign` sin la carpeta `darwin`). El `.ico` multi-resolución se genera con `build\make-ico.ps1`.

Al primer arranque, un onboarding ofrece **instalar los hooks** (con backup). Sin hooks,
Consomni igual funciona en modo read-only mostrando lo que infiere de los transcripts;
con hooks, el estado pasa a ser **en vivo** (working / atención / idle / cerrada).

> Nota: si corrés `electron .` desde un entorno que exporta `ELECTRON_RUN_AS_NODE=1`,
> limpialo antes (`Remove-Item Env:ELECTRON_RUN_AS_NODE`). Usuarios normales no se ven afectados.

---

## 🎨 Pantallas

Board kanban (E1) · Panel de detalle (E2) · Command palette ⌘K (E3) · Flujo de atención
con banner + toast nativo + aprobar/denegar (E4) · Split / grid de feeds en vivo (E5) ·
Sidebar colapsado (E6) · Settings. Diseño dark, monoespaciado (Geist Mono), estética terminal.

---

## ⌨️ Atajos de teclado

| Tecla | Acción | | Tecla | Acción |
|---|---|---|---|---|
| `⌘K` / `Ctrl K` | command palette | | `o` | abrir en VS Code |
| `/` | buscar | | `t` | abrir terminal |
| `j` / `k` | navegar cards | | `y` / `Y` | copiar path / branch |
| `h` / `l` | cambiar de columna | | `r` | responder (stub) |
| `Enter` | expandir detalle | | `a` / `d` | aprobar / denegar (stub) |
| `Space` | peek | | `p` | pin |
| `Esc` | cerrar overlay / split | | `x` | multi-select |
| `⌘1..9` | saltar a proyecto | | `X` | archivar |
| `f` | ciclar filtro de modo | | `⌘↵` | dispatch |
| `s` | ciclar orden | | `g a` | ir a la primera atención |
| `c` | densidad cómodo/compacto | | `m` | mute notificaciones |
| `?` | ayuda (este mapa) | | | |

---

## 🟢 Leyenda de estados

| Estado | Color | Significado |
|---|---|---|
| `working` | verde (glow + spinner) | la sesión está ejecutando algo |
| `attn` | ámbar (glow + pip + banner + toast) | espera tu permiso / decisión |
| `error` | rojo/rosa | el último turno falló |
| `idle` | gris | esperando tu input |
| `standby` | atenuado | en espera de dispatch |
| `cerrada` | tenue | sesión terminada / archivada (sección colapsable) |

**Barra de contexto:** verde `<75%` · ámbar `75–90%` · rojo `>90%`.
**Modos** (del `permissionMode`): `ask` (default) · `plan` · `edit` (acceptEdits) · `auto` (bypassPermissions).
**Orden por defecto:** `atención > working > error > idle > standby > cerradas`.

---

## ⚡ Acciones — real vs stub honesto

El control surface de Claude Code limita qué puede hacer una app externa. Lo que es
posible de verdad está cableado; el resto es un **stub honesto** con un toast claro
(no inventamos integraciones).

**Reales:** abrir editor (`code`/`cursor`), terminal (`wt` → fallback PowerShell), carpeta,
copiar path / branch / session id, ver transcript, `git diff`, abrir PR (`gh`),
**dispatch de una sesión nueva** (abre una terminal con `claude` en el proyecto),
pin / favorito / archivar, y **notificación nativa** del SO al pedir atención
(click → enfoca la ventana y salta a la sesión).

**Stubs honestos (con TODO):**
- **Aprobar / denegar** un permiso: requiere un hook `PreToolUse` **bloqueante** que consulte
  a Consomni; los hooks instalados son fire-and-forget. Por seguridad no se activa por defecto
  (podría congelar tus sesiones reales). El toast te manda a la terminal.
- **Quick-reply** a una sesión EN CURSO: los hooks no inyectan prompts en una sesión interactiva.
- **Pausar / matar**: no lo expone el control surface.

Todas las acciones del SO se lanzan con `execFile`/`spawn` pasando **arrays de argumentos**
(nunca shell strings) → sin inyección aunque los paths tengan espacios o metacaracteres.

> **¿Cómo disparo una acción (p.ej. abrir la terminal)?** Tres formas: (1) pasá el mouse sobre una
> card → aparecen los **mini-botones** arriba a la derecha (abrir editor · terminal · copiar · cerrar);
> (2) clickeá la card para abrir el **panel de detalle** y usá su grilla de acciones; (3) con una card
> enfocada, atajo `t` (terminal), `o` (editor), etc. La terminal abre Windows Terminal (`wt`) en el
> `cwd` de la sesión, con fallback a PowerShell.

---

## 🏗 Arquitectura

```
design-reference/   fuente de verdad visual (read-only): tokens.css + chrome.js + e1..e7
hooks/post.js       helper que postea eventos de hooks a 127.0.0.1:<port>
src/main/           proceso main (TS): index, jsonl (parser), sessions (store+watcher),
                    hooks-server (express), hooks-install (backup+merge), actions, config
src/preload/        contextBridge tipado (sin nodeIntegration)
src/renderer/       tokens.css (verbatim) + chrome.js (builders) + app.js + app.css + assets
~/.consomni/        runtime del usuario: config.json, state.json, backups/, setup.log
```

**Datos:** A) transcripts JSONL (read-only + watcher chokidar) + B) hooks (eventos en vivo)
se unifican en un `Session[]` y se empujan al renderer (debounced ~250ms), que re-arma el
board/sidebar/statusbar con los builders compartidos — markup pixel-idéntico al diseño.

---

*Hecho con un ojo en todo. Cero nube.*

<div align="center">

**by [Joaquim Colacilli](https://github.com/JoaquimColacilli)**

</div>
