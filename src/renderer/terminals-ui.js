/* ════════════════════════════════════════════════════════════════
   Consomni — terminals-ui.js
   DOCK de terminales/conversaciones MALEABLE (tipo IDE / tiling), CONTEXTUAL:
   - "inicio" muestra las terminales FIJADAS (★) + las sueltas abiertas ahí.
   - una VISTA de proyecto muestra las terminales de ESE proyecto.
   - Mosaico de paneles: dividir a derecha/abajo, ARRASTRAR divisores para
     redimensionar, y ARRASTRAR un panel a un borde de otro para reubicarlo.
   - Borde superior arrastrable (alto del dock). Minimizar a barra. Zoom full.
   - Cada panel: PTY real (xterm: shell / claude / claude ⚡ sin permisos) o
     conversación read-only.
   Vive en #terminals: capa PERSISTENTE que el re-render del board NO toca.
   Al cambiar de vista los paneles que no matchean se guardan en un pool oculto
   (las PTYs siguen vivas) y se re-arman en FILA simple en la vista activa.

   API: window.ConsomniTerms = { spawn, open, openSession, show, hide,
     minimize, restore, toggle, home, setView, openProject, isOpen, count,
     refreshActive, setNotifier, setActionHandler, setMaxObserver,
     restoreSession, isMaximized }
   ════════════════════════════════════════════════════════════════ */
(function (g) {
  'use strict';
  var C = g.Chrome, api = g.consomni, Terminal = g.Terminal, FitNS = g.FitAddon, WebLinksNS = g.WebLinksAddon, WebglNS = g.WebglAddon;
  var gpuRender = true;   // render por GPU (WebGL) — mucho más fluido en claude; opt-out por si una GPU rinde mal (lo empuja app.js)
  var floatingPickers = true;   // selector flotante de @ y / (estilo Warp) en paneles claude; opt-out si molesta (lo empuja app.js)

  var host = null, rootEl = null, poolEl = null, dropInd = null, countEl = null, sessBarEl = null;
  var lastSnap = null;         // último snapshot (para el badge de diff del dock)
  var terms = new Map();       // ptyId -> { term, fit, pane, ro }
  var sessions = new Map();    // sid   -> pane
  var paneSeq = 0;
  var focused = null;
  // "comandos rápidos": atajos deterministas (insertan al toque, gratis) + traducción
  // por lenguaje natural con tu claude LOCAL. Siempre visibles en las terminales.
  var ASK_PRESETS = [
    { label: 'crear carpeta…', q: 'crear una carpeta llamada ' },
    { label: 'git status', cmd: 'git status' },
    { label: 'últimos commits', cmd: 'git log --oneline -15' },
    { label: 'listar por tamaño', cmd: 'Get-ChildItem | Sort-Object Length -Descending' },
    { label: 'árbol de archivos', cmd: 'Get-ChildItem -Recurse -Name' },
    { label: 'buscar archivo…', q: 'buscar archivos cuyo nombre contenga ' }
  ];
  var bound = false, snapBound = false, restoring = false;
  var view = '__home__';       // vista activa: '__home__' (inicio) o id de proyecto (projKey)
  var viewCwd = '';            // cwd por defecto para terminales nuevas en la vista de proyecto
  var viewName = '';           // nombre lindo del proyecto activo (para mostrar; el id es un path)
  var notifier = function () {}, actionHandler = function () {}, maxObserver = function () {}, boardChecker = null, closeConfirmer = null;
  var editorOpener = null;     // abre un cwd en el editor (lo inyecta app.js → api.action('ext',{cwd}))
  var quickTermHook = null;    // CTRL+ESPACIO dentro de un xterm → abre una terminal nueva (lo inyecta app.js)
  var homeProjects = null;     // provider de proyectos para el inicio (lo inyecta app.js) → [{id,name,cwd,fav}]
  var claudeFsDefault = true;  // default global config.claudeFullscreen (lo empuja app.js); fullscreen=input anclado abajo
  var claudeHistHintShown = false;  // tip "Ctrl+O = historial completo" una sola vez por sesión (al retomar un claude en fullscreen)
  function isMaximized() { return !!host && host.classList.contains('maximized'); }
  function notifyMax() { try { maxObserver(isMaximized()); } catch (e) {} }

  /* ── persistencia (~/.consomni/dock.json vía main; localStorage NO es confiable bajo file://) ──
     Guardamos la LISTA de paneles que viven en inicio (fijados o sueltos): son los que
     sobreviven al reinicio. Los no-fijados de un proyecto son efímeros (sólo la sesión). */
  var persistTimer = null;
  function persist() {
    if (restoring) return;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(function () {
      try {
        var list = allPanes().filter(inInicio).filter(function (p) { return p.dataset.kind !== 'file' && p.dataset.tourDemo !== '1'; }).map(serializePane);
        var rs = document.documentElement.style;
        if (api && api.term && api.term.saveDock) api.term.saveDock({ v: 2, max: isMaximized(), dh: rs.getPropertyValue('--dock-h') || '', panes: list });
      } catch (e) { /* noop */ }
    }, 350);
  }
  function serializePane(el) {
    var d = el.dataset, o = { kind: d.kind || 'shell' };
    if (d.kind === 'session') { o.sid = d.sid; o.name = d.sname || ''; }
    else { o.cwd = d.cwd || ''; if (d.resume) o.resume = d.resume; if (d.skip === '1') o.skip = 1; }
    if (d.kind === 'claude' && (d.fullscreen === '0' || d.fullscreen === '1')) o.fullscreen = d.fullscreen === '1' ? 1 : 0;   // modo render elegido por-panel (scroll nativo vs anclado)
    if (d.proj) o.proj = d.proj;
    if (d.projname) o.projname = d.projname;
    if (d.pinned === '1') o.pinned = 1;
    if (d.min === '1') o.min = 1;   // F6: minimizada (sigue viva en la barra de sesiones)
    return o;
  }
  function buildPane(o) {
    var kind = o.kind === 'session' ? 'session' : (o.kind === 'claude' ? 'claude' : 'shell');
    var pane = makePaneShell(kind);
    pane.dataset.kind = kind;
    if (o.proj) pane.dataset.proj = o.proj;
    if (o.projname) pane.dataset.projname = o.projname;
    if (o.pinned) pane.dataset.pinned = '1';
    if (o.min) pane.dataset.min = '1';   // F6: restaura minimizada (queda en el pool, viva)
    if (kind === 'session') { pane.dataset.sid = o.sid || ''; pane.dataset.sname = o.name || ''; }
    else { if (o.cwd) pane.dataset.cwd = o.cwd; if (o.resume) pane.dataset.resume = o.resume; if (o.skip) pane.dataset.skip = '1'; }
    if (kind === 'claude' && (o.fullscreen === 0 || o.fullscreen === 1)) pane.dataset.fullscreen = o.fullscreen ? '1' : '0';
    return pane;
  }
  // compat v1: el dock viejo guardaba un árbol {layout}; extraemos sus paneles (como fijados).
  function flattenLayout(node, out) {
    if (!node) return out;
    if (node.t === 'pane' || node.kind) {
      out.push({ kind: node.kind || 'shell', sid: node.sid, name: node.name, cwd: node.cwd, resume: node.resume, proj: node.proj, pinned: 1 });
    } else if (node.children) {
      node.children.forEach(function (c) { flattenLayout(c.node || c, out); });
    }
    return out;
  }
  function restoreSession() {
    ensureDock();
    if (!api || !api.term || !api.term.getDock) return;
    api.term.getDock().then(function (data) {
      if (!data) return;
      var list = data.panes;
      if (!list && data.layout) list = flattenLayout(data.layout, []);   // compat v1
      if (!list || !list.length) return;
      restoring = true;
      poolEl.innerHTML = ''; rootEl.innerHTML = ''; terms.clear(); sessions.clear();
      list.forEach(function (o) {
        var pane = buildPane(o);
        poolEl.appendChild(pane);
        if (pane.dataset.kind === 'session') mountSession(pane, pane.dataset.sid, pane.dataset.sname, pane.dataset.proj);
        else mountTerminal(pane, pane.dataset.kind || 'shell', pane.dataset.cwd || undefined, pane.dataset.resume || null, pane.dataset.skip === '1');
      });
      restoring = false;
      var rs = document.documentElement.style;
      if (data.dh) rs.setProperty('--dock-h', data.dh);
      bindIpc(); bindSnap();
      view = '__home__'; viewCwd = '';
      showView('__home__');
      // arrancar SIEMPRE en INICIO (pantalla completa) con las terminales fijadas restauradas
      host.hidden = false; host.classList.remove('minimized'); host.classList.add('maximized');
      document.body.classList.add('dock-open'); document.body.classList.remove('dock-min');
      notifyMax(); refitSoon(); persist();
    }).catch(function () { /* noop */ });
  }

  var THEME = {
    background: '#0a0a0b', foreground: '#e6e6e6', cursor: '#4ade80', cursorAccent: '#0a0a0b',
    selectionBackground: 'rgba(74,222,128,.28)',
    black: '#16161a', red: '#f87171', green: '#4ade80', yellow: '#fbbf24', blue: '#60a5fa',
    magenta: '#c084fc', cyan: '#22d3ee', white: '#d4d4d8', brightBlack: '#52525b', brightRed: '#fca5a5',
    brightGreen: '#86efac', brightYellow: '#fde68a', brightBlue: '#93c5fd', brightMagenta: '#d8b4fe',
    brightCyan: '#67e8f9', brightWhite: '#fafafa'
  };

  function esc(s) { return C ? C.esc(s) : String(s == null ? '' : s); }
  function svg(n, a, b) { return C ? C.svg(n, a, b) : ''; }
  function maxIcon() { return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5"/><path d="M20 9V4h-5"/><path d="M4 15v5h5"/><path d="M20 15v5h-5"/></svg>'; }
  function splitRIcon() { return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="7.5" height="16" rx="1.2"/><rect x="13.5" y="4" width="7.5" height="16" rx="1.2"/></svg>'; }
  function splitDIcon() { return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="3" width="16" height="7.5" rx="1.2"/><rect x="4" y="13.5" width="16" height="7.5" rx="1.2"/></svg>'; }
  function elemChildren(el) { return Array.prototype.filter.call(el.children, function (c) { return c.nodeType === 1; }); }
  function panesOf() { return rootEl ? Array.prototype.slice.call(rootEl.querySelectorAll('.dk-pane')) : []; }
  function allPanes() { return host ? Array.prototype.slice.call(host.querySelectorAll('.dk-pane')) : []; }

  /* ════════ rutas de archivo clickeables (terminal + conversación) ════════
     Detecta rutas, las resuelve contra el cwd del panel y las abre (panel / editor / revelar).
     Sólo Windows-paths absolutos y rutas (rel/bare) que TERMINAN en una extensión conocida → bajo ruido,
     no pisa URLs (que ya maneja el addon web-links). */
  var FILE_EXT = '(?:js|jsx|ts|tsx|mjs|cjs|json|jsonc|md|markdown|mdx|css|scss|sass|less|html|htm|py|rs|go|java|kt|rb|php|c|h|cc|cpp|hpp|cs|swift|sh|bash|zsh|ps1|bat|cmd|yml|yaml|toml|ini|env|txt|log|sql|vue|svelte|astro|xml|svg|lock|cfg|conf)';
  function findPathSpans(line) {
    var spans = [], taken = [];
    function overlaps(s, e) { for (var i = 0; i < taken.length; i++) if (s < taken[i][1] && e > taken[i][0]) return true; return false; }
    function run(rx) {
      var m;
      while ((m = rx.exec(line))) {
        var s = m.index, e = s + m[0].length;
        var pc = s > 0 ? line.charAt(s - 1) : '';
        // saltar si es continuación de algo mayor (URL/path ya empezado) → preced. por / \ :
        if (m[0].length < 3 || overlaps(s, e) || pc === '/' || pc === '\\' || pc === ':') continue;
        taken.push([s, e]); spans.push({ text: m[0], start: s, end: e });
      }
    }
    // Windows abs CON espacios que TERMINA en una extensión conocida (ej: C:\Users\Usuario 7\...\draft.txt).
    // Va PRIMERO para reclamar la ruta COMPLETA (el dedup por `taken` evita que las regex de abajo la partan en
    // el espacio). Excluye ':' (no cruza a otra unidad) y los chars shell-especiales; lazy hasta el 1er .ext.
    run(new RegExp('\\b[A-Za-z]:[\\\\/](?![\\\\/])[^\\n:*?"<>|]*?\\.' + FILE_EXT + '\\b', 'g'));
    // Windows abs (sin extensión / carpetas): \b para no confundir la "s:" de "https:"; (?![\\/]) rechaza "://"
    run(/\b[A-Za-z]:[\\/](?![\\/])[^\s:*?"<>|]+/g);
    run(new RegExp('(?:\\.{1,2}[\\\\/])?(?:[\\w.\\-]+[\\\\/])*[\\w.\\-]+\\.' + FILE_EXT + '\\b', 'g'));
    spans.sort(function (a, b) { return a.start - b.start; });
    return spans;
  }
  function findPathToken(line, col) { var sp = findPathSpans(line); for (var i = 0; i < sp.length; i++) if (col >= sp[i].start && col < sp[i].end) return sp[i]; return null; }
  function resolveFilePath(token, cwd) {
    if (/^([A-Za-z]:[\\/]|\/)/.test(token)) return token;
    var base = String(cwd || '').replace(/[\\/]+$/, '');
    return base ? base + '/' + token.replace(/^[.][\\/]/, '') : token;
  }
  // envuelve las rutas en `<span class="cv-file" data-path>` SOBRE html YA escapado (los chars de path
  // sobreviven a esc). Las URLs no se tocan (no terminan en extensión conocida).
  function linkifyPaths(escapedHtml, cwd) {
    var spans = findPathSpans(escapedHtml);
    if (!spans.length) return escapedHtml;
    var out = '', last = 0;
    for (var i = 0; i < spans.length; i++) {
      var sp = spans[i];
      out += escapedHtml.slice(last, sp.start) +
        '<span class="cv-file" data-path="' + esc(resolveFilePath(sp.text, cwd)) + '">' + escapedHtml.slice(sp.start, sp.end) + '</span>';
      last = sp.end;
    }
    return out + escapedHtml.slice(last);
  }
  function openFileEditor(resolved, cwd) { if (api && api.action) api.action('ext', { cwd: cwd || '', file: resolved }).then(function (r) { if (r && !r.ok) notifier('✗ ' + (r.error || 'editor'), 'err'); }).catch(function () {}); }
  function revealFilePath(resolved) { if (api && api.action) api.action('revealFile', { file: resolved }).then(function (r) { if (r && !r.ok) notifier('✗ ' + (r.error || 'revelar'), 'err'); }).catch(function () {}); }
  function onPathActivate(ev, token, pane) {
    var cwd = (pane && pane.dataset.cwd) || (view !== '__home__' ? viewCwd : '') || '';
    var resolved = resolveFilePath(token, cwd);
    if (ev && (ev.ctrlKey || ev.metaKey)) openFileEditor(resolved, cwd);
    else openFilePanel(resolved, cwd);
  }
  // menú contextual de archivo (reusa .dk-ctx + closeTermCtx/onCtxOutside/onCtxKey)
  function showFileCtx(x, y, resolved, cwd) {
    closeTermCtx();
    var m = g.document.createElement('div'); m.id = 'dkCtx'; m.className = 'dk-ctx';
    m.innerHTML =
      '<button class="dk-ctx-i" data-fctx="panel">Abrir en panel</button>' +
      '<button class="dk-ctx-i" data-fctx="editor">Abrir en editor</button>' +
      '<button class="dk-ctx-i" data-fctx="reveal">Revelar ubicación</button>';
    g.document.body.appendChild(m);
    var mw = m.offsetWidth || 180, mh = m.offsetHeight || 96;
    m.style.left = Math.max(4, Math.min(x, g.innerWidth - mw - 4)) + 'px';
    m.style.top = Math.max(4, Math.min(y, g.innerHeight - mh - 4)) + 'px';
    m.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-fctx]'); if (!b) return;
      var act = b.getAttribute('data-fctx');
      if (act === 'panel') openFilePanel(resolved, cwd); else if (act === 'editor') openFileEditor(resolved, cwd); else if (act === 'reveal') revealFilePath(resolved);
      closeTermCtx();
    });
    setTimeout(function () { g.document.addEventListener('mousedown', onCtxOutside, true); g.document.addEventListener('keydown', onCtxKey, true); }, 0);
  }

  /* ════════ panel VISOR de archivo (pane efímero kind 'file') ════════ */
  function fileBase(fp) { return String(fp).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || fp; }
  function fileDir(fp) { var s = String(fp).replace(/[\\/]+$/, ''); var i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')); return i > 0 ? s.slice(0, i) : ''; }
  // mini-render markdown SEGURO (escapa TODO primero; headings/listas/**bold**/`code`/```fences```)
  function fvInline(s) {
    var e = esc(s);
    e = e.replace(/`([^`]+)`/g, '<code>$1</code>');
    e = e.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    e = e.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<span class="fv-link" data-href="$2">$1</span>');
    return e;
  }
  function renderMd(md) {
    var lines = String(md == null ? '' : md).replace(/\r/g, '').split('\n');
    var out = [], inList = false, inCode = false;
    function cl() { if (inList) { out.push('</ul>'); inList = false; } }
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i], t = ln.trim();
      if (/^```/.test(t)) { if (inCode) { out.push('</pre>'); inCode = false; } else { cl(); out.push('<pre class="fv-code">'); inCode = true; } continue; }
      if (inCode) { out.push(esc(ln)); continue; }
      if (!t) { cl(); continue; }
      var h = t.match(/^(#{1,6})\s+(.*)$/);
      if (h) { cl(); out.push('<div class="fv-h fv-h' + h[1].length + '">' + fvInline(h[2]) + '</div>'); continue; }
      var li = t.match(/^[-*+]\s+(.*)$/);
      if (li) { if (!inList) { out.push('<ul class="fv-ul">'); inList = true; } out.push('<li>' + fvInline(li[1]) + '</li>'); continue; }
      cl(); out.push('<p class="fv-p">' + fvInline(t) + '</p>');
    }
    if (inCode) out.push('</pre>'); cl();
    return out.join('');
  }
  function openFilePanel(filePath, cwd) {
    if (!filePath) return;
    ensureDock(); show();
    var ex = allPanes().filter(function (p) { return p.dataset.kind === 'file' && p.dataset.fpath === filePath; })[0];
    if (ex) { if (!rootEl.contains(ex)) showView(view); setFocus(ex); return; }
    var pane = makePaneShell('file');
    pane.dataset.kind = 'file'; pane.dataset.fpath = filePath;
    if (cwd) pane.dataset.cwd = cwd;
    if (view !== '__home__') { pane.dataset.proj = view; if (viewName) pane.dataset.projname = viewName; }
    else pane.dataset.pinned = '1';
    placeContent(pane, 'right');
    mountFile(pane, filePath);
    persist();
  }
  function mountFile(pane, fpath) {
    pane.classList.remove('dk-pane--shell', 'dk-pane--claude', 'dk-pane--session');
    pane.classList.add('dk-pane--file');
    pane.dataset.kind = 'file'; pane.dataset.fpath = fpath;
    var base = fileBase(fpath), dir = fileDir(fpath), isMd = /\.(md|markdown|mdx)$/i.test(base);
    setPaneMeta(pane, svg('ext', 12, 1.8), base, projLabel(pane));
    updatePinUI(pane);
    ensureFileBtns(pane, fpath, dir, isMd);
    var body = pane.querySelector('.dk-pane-body');
    body.innerHTML = '<div class="dk-fileview"><pre class="dk-fv-pre">cargando…</pre><div class="dk-fv-md" hidden></div></div>';
    // links de la vista .md: el handler global de app.js corta los clicks dentro de #terminals → se cablean acá
    body.querySelector('.dk-fileview').addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('.fv-link[data-href]'); if (!a) return;
      e.preventDefault(); e.stopPropagation();
      if (api && api.action) api.action('openExternal', { url: a.getAttribute('data-href') });
    });
    var st = { content: '', view: false }; pane._fileState = st;
    ensureLiveBadge(pane);                                  // indicador "● vivo" (sync en tiempo real)
    refreshFile(pane, fpath, body, isMd, true);            // lectura inicial
    startFilePoll(pane, fpath, body, isMd);                // y mantenerlo sincronizado mientras el agente lo edita
  }

  /* ── sync en VIVO del visor: re-lee el archivo mientras el panel está abierto y actualiza si cambió
     (pedido de usuarios: "real en tiempo real", sin tener que cerrar y reabrir el panel). Pollea
     (no fs.watch → robusto cross-platform), salta si el panel está oculto/minimizado, preserva el scroll
     (y hace "tail" si estabas abajo), y NO pisa el contenido bueno ante un error transitorio (archivo a
     medio escribir). El lector (api.readFile) lee FRESCO del disco en cada llamada → siempre el último estado. ── */
  function applyFileRead(pane, body, r, isMd, isInitial) {
    var pre = body.querySelector('.dk-fv-pre'); if (!pre || !pre.isConnected) return;
    var st = pane._fileState; if (!st) return;
    if (!r || !r.ok) { if (isInitial) { pre.textContent = '✗ ' + ((r && r.error) || 'no se pudo abrir'); pre.classList.add('dk-fv-empty'); } return; }
    var content = r.content || '';
    if (!isInitial && content === st.content) return;     // sin cambios → no tocar el DOM (ni el scroll)
    var changed = content !== st.content;
    st.content = content;
    // el contenedor que SCROLLEA es .dk-fileview (overflow:auto), no el <pre>
    var sc = body.querySelector('.dk-fileview');
    var atBottom = sc ? (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 12) : true, prevTop = sc ? sc.scrollTop : 0;
    pre.classList.remove('dk-fv-empty');
    pre.textContent = content + (r.truncated ? '\n\n… (truncado a 1 MB)' : '');
    if (isMd) { var md = body.querySelector('.dk-fv-md'); if (md) md.innerHTML = renderMd(content); }
    if (sc) sc.scrollTop = atBottom ? sc.scrollHeight : prevTop;   // tail si estabas abajo; si no, mantené la posición
    if (!isInitial && changed) flashLive(pane);
  }
  function refreshFile(pane, fpath, body, isMd, isInitial) {
    if (!api || !api.readFile) { if (isInitial) { var p0 = body.querySelector('.dk-fv-pre'); if (p0) p0.textContent = 'lector de archivos no disponible'; } return; }
    // pasamos el cwd del panel → el main lo suma al allowlist (un .md abierto desde una terminal cuyo cwd
    // no es una sesión JSONL trackeada se rechazaba con "fuera del alcance" → "no se pudo leer"). Bug fix.
    api.readFile(fpath, (pane && pane.dataset.cwd) || '').then(function (r) { applyFileRead(pane, body, r, isMd, isInitial); })
      .catch(function () { if (isInitial) { var pre = body.querySelector('.dk-fv-pre'); if (pre) pre.textContent = '✗ error al leer'; } });
  }
  function startFilePoll(pane, fpath, body, isMd) {
    stopFilePoll(pane);
    pane._filePoll = g.setInterval(function () {
      if (!pane.isConnected || pane.offsetParent === null) return;   // movido (re-tiling) / oculto / minimizado → esperar
      refreshFile(pane, fpath, body, isMd, false);
    }, 1000);
  }
  function stopFilePoll(pane) { if (pane && pane._filePoll) { try { g.clearInterval(pane._filePoll); } catch (e) {} pane._filePoll = null; } }
  function ensureLiveBadge(pane) {
    var head = pane.querySelector('.dk-pane-head'); if (!head || head.querySelector('.dk-fv-live')) return;
    var b = g.document.createElement('span'); b.className = 'dk-fv-live'; b.title = 'se actualiza en vivo (sync en tiempo real)';
    b.innerHTML = '<i class="dk-fv-live-dot"></i>vivo';
    var title = head.querySelector('.dk-pane-title');
    if (title && title.nextSibling) head.insertBefore(b, title.nextSibling); else if (title) head.appendChild(b);
  }
  function flashLive(pane) {
    var b = pane.querySelector('.dk-fv-live'); if (!b) return;
    b.classList.add('pulse');
    if (pane._liveT) { try { g.clearTimeout(pane._liveT); } catch (e) {} }
    pane._liveT = g.setTimeout(function () { b.classList.remove('pulse'); }, 700);
  }
  function ensureFileBtns(pane, fpath, dir, isMd) {
    var btns = pane.querySelector('.dk-pane-btns'); if (!btns || btns.querySelector('.dk-fv-copy')) return;
    var x = btns.querySelector('.dk-pane-x');
    function mk(cls, title, ic, fn) {
      var b = g.document.createElement('button'); b.className = 'dk-pbtn ' + cls; b.title = title; b.innerHTML = svg(ic, 12, 1.8);
      b.addEventListener('click', function (e) { e.stopPropagation(); setFocus(pane); fn(); });
      if (x) btns.insertBefore(b, x); else btns.appendChild(b); return b;
    }
    if (isMd) mk('dk-fv-view', 'vista / crudo', 'eye', function () {
      var s = pane._fileState; if (!s) return; s.view = !s.view;
      var bd = pane.querySelector('.dk-pane-body'); bd.querySelector('.dk-fv-pre').hidden = s.view; bd.querySelector('.dk-fv-md').hidden = !s.view;
    });
    mk('dk-fv-copy', 'copiar todo', 'copy', function () { var s = pane._fileState; if (s && api && api.action) api.action('copyText', { text: s.content }).then(function () { notifier('archivo copiado'); }); });
    mk('dk-fv-edit', 'abrir en editor', 'ext', function () { openFileEditor(fpath, dir); });
    mk('dk-fv-reveal', 'revelar ubicación', 'folder', function () { revealFilePath(fpath); });
  }
  // cabecera del dock: "TERMINALES" en inicio; el NOMBRE del proyecto cuando estás dentro de uno.
  function updateTitle() {
    var lbl = host && host.querySelector('.dk-tb-label');
    if (!lbl) return;
    lbl.textContent = (view === '__home__' || !viewName) ? 'TERMINALES' : viewName;
  }
  // etiqueta linda del proyecto del panel (el id `proj` es un path; mostramos el nombre o el último segmento)
  function projLabel(pane) {
    var d = pane.dataset; if (d.projname) return d.projname;
    if (!d.proj) return ''; var p = d.proj.replace(/[\\/]+$/, ''); return p.split(/[\\/]/).pop() || p;
  }

  /* ── DOM base ── */
  function ensureDock() {
    if (host) return host;
    host = document.getElementById('terminals');
    if (!host) return null;
    host.classList.add('dock');
    host.innerHTML =
      '<div class="dk-resize" title="arrastrá para cambiar el ALTO"></div>' +
      '<div class="dk-toolbar">' +
        '<span class="dk-tb-title">' + (C ? C.eye(20, false) : '') + '<span class="dk-tb-label">TERMINALES</span><span class="dk-count"></span></span>' +
        '<span class="dk-tb-actions">' +
          '<button class="dk-newbtn dk-new-term" title="nueva terminal">' + svg('term', 12, 2) + ' terminal</button>' +
          '<button class="dk-newbtn dk-new-claude" title="claude: enfoca el activo si hay (Shift+click = uno nuevo)">' + svg('dispatch', 12, 2) + ' claude</button>' +
          '<button class="dk-newbtn dk-new-claude-skip" title="claude SIN permisos (--dangerously-skip-permissions)">' + svg('dispatch', 12, 2) + ' claude ⚡</button>' +
          '<span class="dk-div"></span>' +
          '<button class="dk-newbtn dk-new-cmd" title="comandos rápidos: atajos (crear carpeta, git status…) + describilo en castellano y lo traduce tu claude">' + svg('dispatch', 12, 2) + ' comandos</button>' +
          '<button class="dk-newbtn dk-new-proj" title="abrir una terminal en un proyecto (sin ir a buscarlo)">' + svg('folder', 12, 2) + ' proyecto</button>' +
          '<span class="dk-div"></span>' +
          '<button class="dk-newbtn dk-exit" title="salir de pantalla completa (volver al board)">' + svg('chevD', 13, 2.4) + ' salir</button>' +
          '<button class="dk-pb dk-max" title="pantalla completa / restaurar">' + maxIcon() + '</button>' +
          '<button class="dk-pb dk-min" title="minimizar / ocultar">' + svg('chevD', 15, 2.4) + '</button>' +
        '</span>' +
      '</div>' +
      '<div class="dk-sessions" hidden></div>' +
      '<div class="dk-root"></div>' +
      '<div class="dk-pool" style="display:none"></div>' +
      '<div class="dk-dropind"></div>';
    rootEl = host.querySelector('.dk-root');
    poolEl = host.querySelector('.dk-pool');
    dropInd = host.querySelector('.dk-dropind');
    countEl = host.querySelector('.dk-count');
    sessBarEl = host.querySelector('.dk-sessions');
    sessBarEl.addEventListener('click', function (e) {
      var c = e.target.closest && e.target.closest('[data-sess-pane]'); if (!c) return;
      e.stopPropagation();
      var pane = paneByKey(c.getAttribute('data-sess-pane')); if (!pane) return;
      if (pane.dataset.min === '1') restorePane(pane);
      else { setFocus(pane); try { var pt = paneTerm(pane); if (pt) pt.focus(); } catch (e2) {} renderSessionBar(); }
    });
    host.querySelector('.dk-new-term').addEventListener('click', function () { spawn('shell'); });
    // claude: REUSA el activo de la vista si hay (en vez de abrir otro y llenar de tabs). Shift/Alt+click = uno nuevo.
    host.querySelector('.dk-new-claude').addEventListener('click', function (ev) {
      if (!ev.shiftKey && !ev.altKey) { var ex = findActiveClaude(); if (ex) { focusClaudePane(ex); notifier('claude activo — enfocado (Shift+click = uno nuevo)'); return; } }
      spawn('claude');
    });
    host.querySelector('.dk-new-claude-skip').addEventListener('click', function () { spawn('claude', null, null, { skip: true }); });
    host.querySelector('.dk-new-cmd').addEventListener('click', openQuickCommands);
    host.querySelector('.dk-new-proj').addEventListener('click', function (e) {
      openDirChooser({ anchor: e.currentTarget, title: 'abrir terminal en…', onPick: function (ruta) { spawn('shell', ruta, 'right'); } });
    });
    // chips de proyecto del placeholder de inicio (F5): abrir terminal/claude en el cwd del proyecto (suelta en inicio)
    host.addEventListener('click', function (e) {
      var hb = e.target.closest && e.target.closest('[data-home-open]');
      if (!hb) return;
      e.stopPropagation();
      spawn(hb.getAttribute('data-home-open') === 'claude' ? 'claude' : 'shell', hb.getAttribute('data-cwd') || null, 'right');
    });
    host.querySelector('.dk-exit').addEventListener('click', function () { host.classList.remove('maximized'); notifyMax(); refitSoon(); persist(); });
    host.querySelector('.dk-max').addEventListener('click', toggleMax);
    host.querySelector('.dk-min').addEventListener('click', toggleMin);
    host.querySelector('.dk-tb-title').addEventListener('click', function () { if (host.classList.contains('minimized')) restore(); });
    wireDockResize();
    wireSplitterDrag();
    wirePaneDrag();
    bindSnap();   // escuchar snapshots desde que el dock existe → lastSnap siempre disponible para el badge +N/−N
    return host;
  }

  function bindIpc() {
    if (bound || !api || !api.term) return;
    bound = true;
    api.term.onData(function (p) {
      var t = terms.get(p.id); if (!t) return;
      var data = p.data;
      // modo selección ON (sólo claude): filtrá el mouse-tracking que claude re-asserta → xterm queda con el mouse
      // libre para SELECCIONAR (arrastre normal) en vez de mandarle el click a claude.
      if (t.pane && t.pane._selMode && t.pane.dataset.kind === 'claude') data = stripMouseTracking(data);
      t.term.write(data);
    });
    api.term.onExit(function (p) {
      var t = terms.get(p.id); if (!t) return;
      try { t.term.write('\r\n\x1b[90m[proceso finalizado · code ' + p.exitCode + ']\x1b[0m\r\n'); } catch (e) {}
      if (t.pane) t.pane.classList.add('dead');
    });
  }
  function bindSnap() {
    if (snapBound || !api || !api.onSnapshot) return;
    snapBound = true;
    api.onSnapshot(function (snap) {
      lastSnap = snap || lastSnap;
      updateDiffBadge();
      sessions.forEach(function (pane) { if (host && !host.hidden && !host.classList.contains('minimized') && rootEl.contains(pane)) renderSession(pane); });
    });
  }
  // badge "+N −N" en la cabecera del dock (cambios git sin commitear, estilo Warp). El cwd se resuelve con
  // FALLBACK a la terminal ACTIVA (no sólo viewCwd): así también aparece en "inicio" con una terminal suelta
  // (donde view==='__home__' → no había key → el badge NUNCA se mostraba; era el bug reportado por el user).
  function updateDiffBadge() {
    if (!host) return;
    var title = host.querySelector('.dk-tb-title'); if (!title) return;
    var el = title.querySelector('.dk-tb-diff');
    var norm = function (p) { return String(p || '').toLowerCase().replace(/\\/g, '/').replace(/\/+$/, ''); };
    // vista de PROYECTO → el diff de ESE proyecto (viewCwd, matchea el nombre del header). INICIO → la terminal
    // ACTIVA (no hay nombre de proyecto que contradecir). Así el número nunca pertenece a otro proyecto que el del título.
    var rawCwd = (view !== '__home__' && viewCwd) ? viewCwd : activeTermCwd();
    var key = rawCwd ? norm(rawCwd) : '';
    var ds = (key && lastSnap && lastSnap.diffStats) ? lastSnap.diffStats[key] : null;
    if (!ds || (!ds.added && !ds.removed)) { if (el) el.hidden = true; return; }
    if (!el) {
      el = g.document.createElement('button'); el.className = 'dk-tb-diff'; el.title = 'cambios sin commitear · ver git diff';
      el.addEventListener('click', function () { var cw = el._cwd || viewCwd; if (api && api.action) api.action('diff', { cwd: cw }).then(function (r) { notifier(r && r.ok ? (r.message || 'diff abierto') : ((r && r.error) || 'no se pudo'), r && r.ok ? '' : 'err'); }); });
      var lbl = title.querySelector('.dk-tb-label'); if (lbl && lbl.nextSibling) title.insertBefore(el, lbl.nextSibling); else title.appendChild(el);
    }
    el._cwd = rawCwd;   // el cwd resuelto (puede ser el de la terminal activa) → el click abre el diff correcto
    el.hidden = false;
    el.innerHTML = '<span class="a">+' + ds.added + '</span><span class="d">−' + ds.removed + '</span>';
  }

  function updateCount() { if (countEl) { var n = panesOf().length; countEl.textContent = n ? ('· ' + n) : ''; } updateDiffBadge(); }
  function setFocus(pane) {
    if (focused === pane) { renderSessionBar(); return; }
    focused = pane;
    panesOf().forEach(function (p) { p.classList.toggle('focused', p === pane); });
    renderSessionBar();
    updateDiffBadge();   // el badge +N/−N sigue a la terminal enfocada (fallback activeTermCwd en inicio)
  }

  /* ── F6 · barra de sesiones + minimizar ──
     Lista TODAS las terminales/sesiones vivas de la vista actual (visibles + minimizadas) como chips.
     Minimizar = sacar el panel del tiling al pool (PTY VIVO) marcándolo data-min; el chip lo restaura. */
  function paneByKey(k) { var a = allPanes(); for (var i = 0; i < a.length; i++) if (a[i].dataset.pane === k) return a[i]; return null; }
  function paneChipTitle(pane) {
    var t = pane.querySelector('.dk-pane-title');
    var s = (t ? (t.textContent || '') : '').replace(/\s+/g, ' ').trim();
    if (s && s !== '…') return s;
    if (pane.dataset.kind === 'session') return pane.dataset.sname || 'sesión';
    var cw = pane.dataset.cwd || ''; return cw.split(/[\\/]/).filter(Boolean).pop() || (pane.dataset.kind === 'claude' ? 'claude' : 'shell');
  }
  function paneChipIcon(pane) {
    var k = pane.dataset.kind;
    return svg(k === 'claude' ? 'dispatch' : (k === 'session' ? 'reply' : 'term'), 11, 1.8);
  }
  function renderSessionBar() {
    if (!sessBarEl) return;
    if (host && host.classList.contains('minimized')) { sessBarEl.hidden = true; return; }
    var list = allPanes().filter(function (p) { return matchesView(p, view); });
    if (!list.length) { sessBarEl.hidden = true; sessBarEl.innerHTML = ''; return; }
    sessBarEl.hidden = false;
    sessBarEl.innerHTML = list.map(function (p) {
      var min = p.dataset.min === '1', act = (p === focused) && !min;
      // sin title nativo redundante (el .dk-sess-nm ya muestra el label); sólo en minimizadas el tooltip útil
      return '<button class="dk-sess-chip' + (act ? ' active' : '') + (min ? ' min' : '') + '" data-sess-pane="' + esc(p.dataset.pane) + '"' +
        (min ? ' title="minimizada (proceso vivo)"' : '') + '>' +
        paneChipIcon(p) + '<span class="dk-sess-nm">' + esc(paneChipTitle(p)) + '</span>' +
        (min ? '<span class="dk-sess-dot"></span>' : '') + '</button>';
    }).join('');
  }
  function minimizePane(pane) {
    if (!pane || pane.dataset.min === '1') return;
    pane.dataset.min = '1';
    if (focused === pane) focused = null;
    if (pane._sgGhost) hideShellGhost(pane);   // que el ghost del autosuggest no quede flotando sobre el board
    showView(view);   // re-arma el tiling SIN ésta (queda viva en el pool) + refresca la barra
    persist();
  }
  function restorePane(pane) {
    if (!pane) return;
    pane.removeAttribute('data-min');
    pane._ptySize = '';   // estuvo oculta (sin resize) → forzar un SIGWINCH fresco al re-mostrarse (showView ya lo hace; belt-and-suspenders)
    show();
    showView(view);   // re-incluye la terminal en el tiling de la vista
    setFocus(pane);
    try { var t = paneTerm(pane); if (t) t.focus(); } catch (e) {}
    refitSoon(); persist();
  }
  function updatePinUI(pane) {
    var star = pane.querySelector('.dk-pin'); if (!star) return;
    pane.classList.toggle('no-proj', !pane.dataset.proj);   // sueltas (sin proyecto) no muestran el ★
    star.classList.toggle('on', pane.dataset.pinned === '1');
  }

  /* ── vistas: inicio (fijadas/sueltas) vs proyecto (su proj) ── */
  function inInicio(p) { return p.dataset.pinned === '1' || !p.dataset.proj; }
  function matchesView(p, v) { return v === '__home__' ? inInicio(p) : (p.dataset.proj === v); }
  function placeholderHTML(v) {
    if (v === '__home__') {
      var projs = [];
      try { if (homeProjects) projs = homeProjects() || []; } catch (e) { projs = []; }
      var chips = '';
      if (projs.length) {
        chips = '<div class="dk-ph-sub">Abrí una terminal directo en un proyecto</div><div class="dk-ph-projects">' +
          projs.map(function (p) {
            return '<div class="dk-ph-proj" title="' + esc(p.cwd) + '">' +
              '<span class="dk-ph-pname">' + svg(p.fav ? 'star' : 'folder', 13, 1.7) + esc(p.name) + '</span>' +
              '<span class="dk-ph-pacts">' +
                '<button class="dk-ph-pbtn dk-ph-pbtn--claude" data-home-open="claude" data-cwd="' + esc(p.cwd) + '">' + svg('dispatch', 11, 2) + ' claude</button>' +
                '<button class="dk-ph-pbtn" data-home-open="shell" data-cwd="' + esc(p.cwd) + '">' + svg('term', 11, 2) + ' terminal</button>' +
              '</span></div>';
          }).join('') + '</div>';
      }
      return '<div class="dk-placeholder">' + (C ? C.eye(40, false) : '') +
        '<div class="dk-ph-title">Inicio sin terminales fijadas</div>' +
        '<div class="dk-ph-text">Fijá una terminal con la ★ (en cualquier proyecto) y va a aparecer acá, lista para vos.<br>O abrí una nueva con <b>terminal</b> / <b>claude</b> de arriba.</div>' +
        chips +
        '</div>';
    }
    return '<div class="dk-placeholder">' + svg('term', 38, 1.5) +
      '<div class="dk-ph-title">Sin terminales en este proyecto</div>' +
      '<div class="dk-ph-text">Abrí claude (o una terminal) en la carpeta del proyecto. Fijala con ★ para tenerla también en inicio.</div>' +
      (viewCwd ? '<div class="dk-ph-actions">' +
        '<button class="dk-ph-pbtn dk-ph-pbtn--claude" data-home-open="claude" data-cwd="' + esc(viewCwd) + '">' + svg('dispatch', 12, 2) + ' abrir claude</button>' +
        '<button class="dk-ph-pbtn" data-home-open="shell" data-cwd="' + esc(viewCwd) + '">' + svg('term', 12, 2) + ' terminal</button>' +
      '</div>' : '') +
      '</div>';
  }
  // re-arma rootEl en FILA simple con los paneles que matchean la vista (el resto al pool)
  function showView(v) {
    ensureDock();
    view = v;
    updateTitle();   // cabecera del dock: nombre del proyecto / "TERMINALES" en inicio
    updateDiffBadge();   // badge +N/−N del proyecto activo
    // 1) todo lo visible al pool
    panesOf().forEach(function (p) { poolEl.appendChild(p); });
    rootEl.innerHTML = '';
    // 2) los que matchean Y NO están minimizados, a una fila (los minimizados quedan vivos en el pool → barra)
    var match = allPanes().filter(function (p) { return matchesView(p, v) && p.dataset.min !== '1'; });
    if (!match.length) {
      // vista de proyecto sin terminales pero CON cards (sesiones) → mostrar su board en vez del placeholder
      if (v !== '__home__' && boardChecker && boardChecker(v)) { rootEl.innerHTML = ''; updateCount(); renderSessionBar(); minimize(); return; }
      rootEl.innerHTML = placeholderHTML(v); updateCount(); renderSessionBar(); return;
    }
    if (match.length === 1) { match[0].style.flex = '1 1 0'; rootEl.appendChild(match[0]); }
    else {
      var split = document.createElement('div'); split.className = 'dk-split row';
      match.forEach(function (p, i) { if (i) split.appendChild(makeSplitter()); p.style.flex = '1 1 0'; split.appendChild(p); });
      rootEl.appendChild(split);
    }
    if (!focused || !rootEl.contains(focused)) setFocus(match[0]);
    // los paneles que recién (re)entran a la vista estuvieron ocultos en el pool → su PTY pudo quedar con dims
    // viejas (syncTerm saltea ocultos; pushPty dedupea por dims). Reseteamos la cache → el refit garantiza un
    // SIGWINCH fresco → claude/ConPTY re-anclan bien (raíz del "corrupto tras minimizar/restaurar").
    match.forEach(function (p) { p._ptySize = ''; });
    updateCount(); renderSessionBar();
    // doble pase: el primero por rAF + uno extra cuando el layout se asienta (mismo patrón que el post-create)
    refitSoon();
    if (g.requestAnimationFrame) g.requestAnimationFrame(function () { g.requestAnimationFrame(refitAll); });
  }
  function setView(v, cwd, name) {
    ensureDock();
    if (v == null) v = '__home__';
    viewCwd = (v === '__home__') ? '' : (cwd || '');
    viewName = (v === '__home__') ? '' : (name || '');
    showView(v);
  }
  // abrir un proyecto: muestra SUS terminales a pantalla completa (DE UNA) +
  // auto-abre un panel de sesión por cada sesión ACTIVA del proyecto que NO esté ya abierta (dedupe por sid).
  function openProject(projId, cwd, name, sessList) {
    ensureDock(); bindIpc(); bindSnap();
    viewCwd = cwd || ''; viewName = name || '';
    view = projId;   // vista activa ANTES de crear paneles → no se pinnean, quedan scoped al proyecto
    // ¿el proyecto ya tiene paneles abiertos (terminales/sesiones)? entonces NO abrimos nada nuevo.
    var existing = allPanes().filter(function (p) { return p.dataset.proj === projId; });
    // Sin paneles + hay sesiones + cwd válido → abrir UNA terminal `claude --resume` (SELECTOR interactivo,
    // flechitas, scopeado SOLO a las sesiones de ESTE proyecto por su cwd). Reemplaza las viejas tarjetas read-only.
    if (!existing.length && cwd && (sessList || []).length) {
      var pane = makePaneShell('claude');
      pane.dataset.proj = projId;
      if (name) pane.dataset.projname = name;
      poolEl.appendChild(pane);                                   // showView lo trae a la vista (proj === projId)
      mountTerminal(pane, 'claude', cwd, null, false, /*pick*/ true);
    }
    // Sin sesiones (o sin cwd) → showView decide: placeholder-guía o board de cards (vía boardChecker).
    showView(projId);
    host.hidden = false; host.classList.remove('minimized'); host.classList.add('maximized');
    document.body.classList.add('dock-open'); document.body.classList.remove('dock-min');
    notifyMax(); refitSoon(); persist();
  }
  function pinToggle(pane) {
    if (!pane.dataset.proj) return;   // sueltas siempre en inicio; no se fijan/desfijan
    if (pane.dataset.pinned === '1') pane.removeAttribute('data-pinned'); else pane.dataset.pinned = '1';
    updatePinUI(pane);
    notifier(pane.dataset.pinned === '1' ? '★ fijada en inicio' : 'quitada de inicio');
    persist();
    showView(view);   // reflejar (si la desfijás en inicio, sale de la vista)
  }

  /* ── panel (cáscara común) ── */
  function makePaneShell(kindCls) {
    var pane = document.createElement('div');
    pane.className = 'dk-pane dk-pane--' + kindCls;
    pane.dataset.pane = 'p' + (++paneSeq);
    pane.style.flex = '1 1 0';
    pane.innerHTML =
      '<div class="dk-pane-head" title="arrastrá para reubicar">' +
        '<span class="dk-pane-ic"></span>' +
        '<span class="dk-pane-title">…</span>' +
        '<span class="dk-pane-btns">' +
          '<button class="dk-pbtn dk-ask-btn" title="comandos rápidos (atajos + IA local)">' + svg('dispatch', 12, 1.8) + '</button>' +
          '<button class="dk-pbtn dk-pin" title="fijar en inicio (★ favorito)">' + svg('star', 12, 1.8) + '</button>' +
          '<button class="dk-pbtn dk-split-r" title="dividir a la derecha">' + splitRIcon() + '</button>' +
          '<button class="dk-pbtn dk-split-d" title="dividir abajo">' + splitDIcon() + '</button>' +
          '<button class="dk-pbtn dk-pane-min" title="minimizar (la sesión sigue viva en la barra)">' + svg('chevD', 13, 2.2) + '</button>' +
          '<button class="dk-pbtn dk-pane-x" title="cerrar panel">' + svg('x', 12, 2) + '</button>' +
        '</span>' +
      '</div>' +
      '<div class="dk-pane-body"></div>';
    pane.addEventListener('mousedown', function () { setFocus(pane); });
    pane.querySelector('.dk-ask-btn').addEventListener('click', function (e) { e.stopPropagation(); setFocus(pane); toggleAsk(pane); });
    pane.querySelector('.dk-pin').addEventListener('click', function (e) { e.stopPropagation(); pinToggle(pane); });
    pane.querySelector('.dk-split-r').addEventListener('click', function (e) { e.stopPropagation(); setFocus(pane); spawn('shell', null, 'right'); });
    pane.querySelector('.dk-split-d').addEventListener('click', function (e) { e.stopPropagation(); setFocus(pane); spawn('shell', null, 'down'); });
    pane.querySelector('.dk-pane-min').addEventListener('click', function (e) { e.stopPropagation(); minimizePane(pane); });
    pane.querySelector('.dk-pane-x').addEventListener('click', function (e) { e.stopPropagation(); closePane(pane); });
    return pane;
  }
  // botón VSCode en la cabecera de una TERMINAL (abre su cwd en el editor). Idempotente (no duplica al re-montar).
  function ensureVscodeBtn(pane) {
    var btns = pane.querySelector('.dk-pane-btns');
    if (!btns || btns.querySelector('.dk-pane-vscode')) return;
    var vb = document.createElement('button');
    vb.className = 'dk-pbtn dk-pane-vscode';
    vb.title = 'abrir esta carpeta en VSCode/Cursor';
    vb.innerHTML = svg('ext', 12, 1.8);
    vb.addEventListener('click', function (e) { e.stopPropagation(); setFocus(pane); if (editorOpener) editorOpener(pane.dataset.cwd); });
    var x = btns.querySelector('.dk-pane-x');
    if (x) btns.insertBefore(vb, x); else btns.appendChild(vb);
  }
  // botón "cd" en la cabecera de una terminal SHELL: cambia de directorio sin teclear cd a mano (F4). Idempotente.
  function ensureCdBtn(pane) {
    var btns = pane.querySelector('.dk-pane-btns');
    if (!btns || btns.querySelector('.dk-pane-cd')) return;
    var cb = document.createElement('button');
    cb.className = 'dk-pbtn dk-pane-cd';
    cb.title = 'cambiar de directorio (cd)';
    cb.innerHTML = svg('folder', 12, 1.8);
    cb.addEventListener('click', function (e) {
      e.stopPropagation(); setFocus(pane);
      openDirChooser({ anchor: cb, title: 'cambiar a (cd)…', onPick: function (ruta) { cdInto(pane, ruta); } });
    });
    var vb = btns.querySelector('.dk-pane-vscode'), x = btns.querySelector('.dk-pane-x');
    if (vb) btns.insertBefore(cb, vb); else if (x) btns.insertBefore(cb, x); else btns.appendChild(cb);
  }
  function setPaneMeta(pane, icon, title, proj) {
    pane.querySelector('.dk-pane-ic').innerHTML = icon;
    pane.querySelector('.dk-pane-title').innerHTML = esc(title) + (proj ? ' <span class="dk-pt-proj">· ' + esc(proj) + '</span>' : '');
    // NO seteamos pane.title: el head del panel YA muestra el título visible, y un title nativo sobre el panel
    // entero flotaba en el medio de la terminal al hacer hover ("claude ⚡ X · X"). Sin tooltip redundante.
    renderSessionBar();   // F6: el chip de la barra usa este título
  }

  /* ── tiling: insertar / dividir / detach ── */
  function makeSplitter() { var s = document.createElement('div'); s.className = 'dk-splitter'; s.title = 'arrastrá para redimensionar'; return s; }

  function placeContent(pane, dir) {
    ensureDock();
    var ph = rootEl.querySelector('.dk-placeholder'); if (ph) rootEl.innerHTML = '';   // vista vacía → sacar placeholder
    if (!rootEl.querySelector('.dk-pane')) { rootEl.appendChild(pane); setFocus(pane); updateCount(); return; }
    var target = (focused && rootEl.contains(focused)) ? focused : rootEl.querySelector('.dk-pane');
    insertPaneAt(target, pane, dir === 'down' ? 'bottom' : 'right');
    setFocus(pane); updateCount(); refitSoon();
  }

  function insertPaneAt(target, pane, edge) {
    var wantRow = (edge === 'left' || edge === 'right');
    var before = (edge === 'left' || edge === 'top');
    var cls = wantRow ? 'row' : 'col';
    var parent = target.parentNode;
    pane.style.flex = '1 1 0';
    if (parent.classList.contains('dk-split') && parent.classList.contains(cls)) {
      if (before) { parent.insertBefore(pane, target); parent.insertBefore(makeSplitter(), target); }
      else { var nx = target.nextSibling; parent.insertBefore(makeSplitter(), nx); parent.insertBefore(pane, nx); }
    } else {
      var split = document.createElement('div');
      split.className = 'dk-split ' + cls;
      split.style.flex = target.style.flex || '1 1 0';
      parent.replaceChild(split, target);
      target.style.flex = '1 1 0';
      if (before) { split.appendChild(pane); split.appendChild(makeSplitter()); split.appendChild(target); }
      else { split.appendChild(target); split.appendChild(makeSplitter()); split.appendChild(pane); }
    }
  }

  function detachPane(pane) {
    var parent = pane.parentNode;
    if (parent === rootEl) { rootEl.removeChild(pane); return; }
    if (pane.nextElementSibling && pane.nextElementSibling.classList.contains('dk-splitter')) parent.removeChild(pane.nextElementSibling);
    else if (pane.previousElementSibling && pane.previousElementSibling.classList.contains('dk-splitter')) parent.removeChild(pane.previousElementSibling);
    parent.removeChild(pane);
    var kids = elemChildren(parent).filter(function (c) { return !c.classList.contains('dk-splitter'); });
    if (kids.length === 1 && parent !== rootEl) {
      var only = kids[0]; only.style.flex = parent.style.flex || '1 1 0';
      parent.parentNode.replaceChild(only, parent);
    }
  }

  function killPaneContent(pane) {
    if (pane._atp) closeAtPicker(pane);   // cerrar el picker flotante de @ si quedó abierto
    if (pane._slp) closeSlashPicker(pane);   // ídem el picker de '/'
    if (pane._filePoll) stopFilePoll(pane);   // visor de archivo: cortar el sync en vivo
    if (pane._sgRaf) { try { g.cancelAnimationFrame(pane._sgRaf); } catch (e) {} pane._sgRaf = 0; }   // autosuggest: cancelar rAF pendiente
    if (pane._sgGhost) { try { if (pane._sgGhost.parentNode) pane._sgGhost.parentNode.removeChild(pane._sgGhost); } catch (e) {} pane._sgGhost = null; pane._sgGhostVisible = false; }   // y quitar el ghost
    var pid = pane.dataset.tid;
    if (pid) { var t = terms.get(pid); if (t) { try { t.term.dispose(); } catch (e) {} if (t.ro) try { t.ro.disconnect(); } catch (e2) {} } terms.delete(pid); if (api && api.term) api.term.kill(pid); }
    if (pane.dataset.sid) sessions.delete(pane.dataset.sid);
  }

  function closePane(pane) {
    // terminal VIVA (shell/claude con PTY) → confirmar (cerrar corta el proceso). Panel de sesión read-only → directo.
    var kind = pane.dataset.kind || 'shell';
    var liveTerm = (kind === 'shell' || kind === 'claude') && !!pane.dataset.tid;
    if (liveTerm && closeConfirmer) {
      closeConfirmer({ kind: kind, name: pane.dataset.cwd || '' }, function () { doClosePane(pane); });
      return;
    }
    doClosePane(pane);
  }
  function doClosePane(pane) {
    killPaneContent(pane);
    detachPane(pane);
    if (poolEl && poolEl.contains(pane)) poolEl.removeChild(pane);
    updateCount();
    if (!rootEl.querySelector('.dk-pane')) { focused = null; showView(view); persist(); return; }   // vacío → board/placeholder
    setFocus(rootEl.querySelector('.dk-pane'));
    refitAll(); persist();
  }
  function setCloseConfirmer(fn) { if (typeof fn === 'function') closeConfirmer = fn; }

  /* ── panel de TERMINAL ── */
  function spawn(kind, cwd, dir, opts) {
    if (!Terminal) { notifier('xterm no cargó', 'err'); return; }
    if (!api || !api.term) { notifier('terminales no disponibles', 'err'); return; }
    ensureDock(); bindIpc(); show();
    opts = opts || {};
    var proj = (opts.proj != null) ? opts.proj : (view === '__home__' ? '' : view);
    var projName = opts.projName || (proj && proj === view ? viewName : '');
    var pinned = (opts.pinned != null) ? opts.pinned : (view === '__home__');   // abierta en inicio → suelta/pinneada
    if (!cwd) cwd = (view !== '__home__' ? viewCwd : '') || undefined;
    var pane = makePaneShell(kind === 'claude' ? 'claude' : 'shell');
    if (proj) pane.dataset.proj = proj;
    if (projName) pane.dataset.projname = projName;
    if (pinned) pane.dataset.pinned = '1';
    placeContent(pane, dir || 'right');
    mountTerminal(pane, kind, cwd, opts.resume || null, !!opts.skip, !!opts.pick);
    persist();
  }

  // actualiza el cwd de un panel (del cd en vivo vía OSC) sin romper nada si no cambió
  function updatePaneCwd(pane, cwd) {
    if (!pane || !cwd) return;
    cwd = String(cwd).replace(/[\\/]+$/, '');
    if (!cwd || pane.dataset.cwd === cwd) return;
    pane.dataset.cwd = cwd;
    persist();
  }
  // cwd de la terminal ACTIVA (la enfocada, o la última terminal abierta) → para clonar su directorio
  // al abrir una terminal nueva con Ctrl+Espacio (estilo Warp). '' si no hay ninguna terminal abierta.
  function activeTermCwd() {
    var isTerm = function (p) { return p && (p.dataset.kind === 'shell' || p.dataset.kind === 'claude'); };
    var p = (isTerm(focused) && rootEl && rootEl.contains(focused)) ? focused : null;
    if (!p) { var ts = panesOf().filter(isTerm); p = ts.length ? ts[ts.length - 1] : null; }
    return (p && p.dataset.cwd) || '';
  }

  // claude ACTIVO en la vista actual (PTY viva, no minimizado, no finalizado) → para REUSAR en vez de
  // abrir uno nuevo cada vez (se terminaba con 5 tabs). Prioriza el enfocado; si no, el último de la
  // vista (visible o, en su defecto, minimizado). Scopeado por vista (matchesView): inicio reusa el de
  // inicio/fijados; un proyecto reusa el SUYO (no te arrastra a otro). null si no hay ninguno.
  function findActiveClaude() {
    var ok = function (pp) { return pp && pp.dataset.kind === 'claude' && pp.dataset.tid && pp.dataset.min !== '1' && !pp.classList.contains('dead'); };
    if (ok(focused) && rootEl && rootEl.contains(focused) && matchesView(focused, view)) return focused;
    var inView = allPanes().filter(function (pp) { return ok(pp) && matchesView(pp, view); });
    if (!inView.length) return null;
    var vis = inView.filter(function (pp) { return rootEl && rootEl.contains(pp); });
    return vis.length ? vis[vis.length - 1] : inView[inView.length - 1];
  }
  // enfocar un claude existente (espejo del tail de openSession): traerlo a la vista si hace falta + foco
  function focusClaudePane(pane) {
    if (!pane) return;
    show();
    if (!rootEl.contains(pane)) { if (pane.dataset.min === '1') pane.removeAttribute('data-min'); showView(view); }
    setFocus(pane);
    try { var t = paneTerm(pane); if (t) t.focus(); } catch (e) {}
    refitSoon();
  }

  /* ════════ PICKER FLOTANTE de @ (estilo Warp) ════════
     En un panel claude, al tipear '@' NO se lo mandamos a claude (evita su picker inline que corre la
     pantalla): abrimos un overlay propio con los archivos del cwd, filtrable; al elegir le mandamos
     '@ruta ' a claude (ref de archivo confirmada). Esc cancela; Backspace con query vacía cierra. */
  function paneTerm(pane) { try { var t = terms.get(pane.dataset.tid); return t ? t.term : null; } catch (e) { return null; } }
  function atOpen(pane) { return !!(pane && pane._atp); }
  // posiciona el picker PIXEL-PERFECT pegado al input: ancla al elemento real del cursor si existe
  // (DOM renderer de xterm), si no a la geometría de celdas con las dimensiones REALES de xterm.
  function cursorRect(pane, term) {
    try {
      var ce = pane.querySelector('.xterm-rows .xterm-cursor') || pane.querySelector('.xterm-cursor');
      if (ce) { var r = ce.getBoundingClientRect(); if (r.width && r.height) return { left: r.left, top: r.top, h: r.height }; }
    } catch (e) {}
    try {
      var rowsEl = pane.querySelector('.xterm-rows'); if (!rowsEl) return null;
      var rect = rowsEl.getBoundingClientRect();
      var cw, ch;
      try { var d = term._core._renderService.dimensions; cw = (d.css && d.css.cell.width) || d.actualCellWidth; ch = (d.css && d.css.cell.height) || d.actualCellHeight; } catch (e2) {}
      if (!cw || !ch) { cw = rect.width / (term.cols || 80); ch = rect.height / (term.rows || 24); }
      var cx = term.buffer.active.cursorX || 0, cy = term.buffer.active.cursorY || 0;
      return { left: rect.left + cx * cw, top: rect.top + cy * ch, h: ch };
    } catch (e) { return null; }
  }
  function placeAtPicker(pane, term, el) {
    var c = cursorRect(pane, term); if (!c) return;
    var gap = 6, ow = el.offsetWidth || 340;
    var listEl = el.querySelector('.dk-at-list'), headH = 30;
    el.style.left = Math.max(8, Math.min(Math.round(c.left), g.innerWidth - ow - 8)) + 'px';
    if (c.top >= 120) {
      // ARRIBA del input: base PEGADA (gap px sobre la fila del cursor); crece hacia arriba, cap al espacio
      el.style.top = 'auto';
      el.style.bottom = Math.round(g.innerHeight - c.top + gap) + 'px';
      if (listEl) listEl.style.maxHeight = Math.max(72, Math.min(244, Math.round(c.top - gap - headH - 10))) + 'px';
    } else {
      // sin lugar arriba (cursor muy alto) → ABAJO del input
      el.style.bottom = 'auto';
      el.style.top = Math.round(c.top + c.h + gap) + 'px';
      if (listEl) listEl.style.maxHeight = Math.max(72, Math.min(244, Math.round(g.innerHeight - (c.top + c.h + gap) - 10))) + 'px';
    }
  }
  // ghost grisado pegado al cursor: muestra @query EN VIVO en el input mientras el picker está abierto (fachero).
  // Es puramente visual (no se manda nada a claude → su picker inline no corre la pantalla). Matchea el monospace de xterm.
  function placeGhost(pane, term, st) {
    if (!st || !st.ghost) return;
    var c = cursorRect(pane, term);
    if (!c) { st.ghost.style.display = 'none'; return; }
    st.ghost.textContent = (st.prefix || '@') + st.query;
    st.ghost.style.display = '';
    st.ghost.style.left = Math.round(c.left) + 'px';
    st.ghost.style.top = Math.round(c.top) + 'px';
    st.ghost.style.height = Math.round(c.h) + 'px';
    st.ghost.style.lineHeight = Math.round(c.h) + 'px';
    try { if (term.options && term.options.fontSize) st.ghost.style.fontSize = term.options.fontSize + 'px'; } catch (e) {}
    try { if (term.options && term.options.fontFamily) st.ghost.style.fontFamily = term.options.fontFamily; } catch (e) {}
  }
  function atScore(p, q) {
    p = p.toLowerCase();
    var base = p.split('/').pop();
    var bi = base.indexOf(q); if (bi >= 0) return 1000 - bi;
    var pi = p.indexOf(q); if (pi >= 0) return 500 - pi * 0.1;
    var qi = 0; for (var i = 0; i < p.length && qi < q.length; i++) if (p.charAt(i) === q.charAt(qi)) qi++;
    return qi === q.length ? 100 : -1;
  }
  function filterAt(pane) {
    var st = pane._atp; if (!st) return;
    var q = st.query.toLowerCase(), scored = [];
    if (!q) { st.matches = st.files.slice(0, 12); if (st.sel >= st.matches.length) st.sel = 0; return; }
    for (var i = 0; i < st.files.length; i++) { var s = atScore(st.files[i], q); if (s > 0) scored.push([s, st.files[i]]); }
    scored.sort(function (a, b) { return b[0] - a[0] || a[1].length - b[1].length; });
    st.matches = scored.slice(0, 12).map(function (x) { return x[1]; });
    if (st.sel >= st.matches.length) st.sel = Math.max(0, st.matches.length - 1);
  }
  function renderAtList(pane) {
    var st = pane._atp; if (!st || !st.el) return;
    var items = st.matches.map(function (f, i) {
      var base = f.split('/').pop(), dir = f.slice(0, f.length - base.length).replace(/\/$/, '');
      return '<div class="dk-at-item' + (i === st.sel ? ' sel' : '') + '" data-at-i="' + i + '">' +
        svg('ext', 12, 1.7) + '<span class="dk-at-name">' + esc(base) + '</span>' +
        (dir ? '<span class="dk-at-dir">' + esc(dir) + '</span>' : '') + '</div>';
    }).join('');
    st.el.innerHTML =
      '<div class="dk-at-head"><span class="dk-at-q">@' + esc(st.query) + '</span>' +
        '<span class="dk-at-hint">' + (st.loading ? 'cargando…' : 'Enter elige · Esc cancela') + '</span></div>' +
      '<div class="dk-at-list">' + (items || '<div class="dk-at-empty">' + (st.loading ? '' : 'sin coincidencias') + '</div>') + '</div>';
    var term = paneTerm(pane); if (term) { placeAtPicker(pane, term, st.el); placeGhost(pane, term, st); }
    var selEl = st.el.querySelector('.dk-at-item.sel'); if (selEl && selEl.scrollIntoView) try { selEl.scrollIntoView({ block: 'nearest' }); } catch (e) {}
  }
  function openAtPicker(pane) {
    if (pane._atp) return;
    var term = paneTerm(pane); if (!term) return;
    var el = g.document.createElement('div'); el.className = 'dk-at-picker';
    g.document.body.appendChild(el);
    var ghost = g.document.createElement('span'); ghost.className = 'dk-at-ghost';   // @texto grisado en vivo al cursor (fachero)
    g.document.body.appendChild(ghost);
    var st = { el: el, ghost: ghost, prefix: '@', files: [], matches: [], query: '', sel: 0, loading: true };
    pane._atp = st;
    el.addEventListener('mousedown', function (e) {
      var it = e.target.closest && e.target.closest('[data-at-i]');
      if (it) { e.preventDefault(); st.sel = parseInt(it.getAttribute('data-at-i'), 10) || 0; selectAt(pane, false); }
    });
    st.outside = function (e) { if (st.el && !st.el.contains(e.target)) closeAtPicker(pane); };
    setTimeout(function () { try { g.document.addEventListener('mousedown', st.outside, true); } catch (e) {} }, 0);
    st.onResize = function () { var t = paneTerm(pane); if (t && pane._atp) { placeAtPicker(pane, t, st.el); placeGhost(pane, t, st); } };   // pixel-perfect en cualquier resize
    try { g.addEventListener('resize', st.onResize); } catch (e) {}
    renderAtList(pane);
    // re-snap al cursor tras abrir (claude puede settlear su caret un frame después) → pixel-perfect aunque no tipees
    requestAnimationFrame(function () { if (pane._atp) renderAtList(pane); });
    setTimeout(function () { if (pane._atp) renderAtList(pane); }, 90);
    if (api && api.listFiles) {
      st.bailT = setTimeout(function () { if (pane._atp && pane._atp.loading) failOpenAt(pane); }, 1800);   // si listar hangea → no atrapar al usuario
      api.listFiles(pane.dataset.cwd || '').then(function (r) {
        if (!pane._atp) return;
        try { clearTimeout(st.bailT); } catch (e) {}
        var files = (r && r.ok && r.files) ? r.files : [];
        if (!files.length) { failOpenAt(pane); return; }   // sin archivos (error/fuera de alcance/vacío) → escribí el '@' literal y seguí
        st.files = files; st.loading = false; filterAt(pane); renderAtList(pane);
      }).catch(function () { if (pane._atp) failOpenAt(pane); });
    } else { failOpenAt(pane); }
  }
  // FAIL-OPEN del picker de '@': si no puede listar (error / fuera de alcance / sin archivos / sin API / hang),
  // NO atrapamos al usuario → escribimos el '@'+lo tipeado a la PTY (claude muestra su picker inline) y cerramos.
  // Garantiza que el '@' SIEMPRE se pueda tipear (bug reportado: el picker quedaba vacío tragando teclas).
  function failOpenAt(pane) {
    var st = pane._atp; if (!st || st.ending) return;
    var tid = pane.dataset.tid, q = st.query;
    try { if (st.bailT) clearTimeout(st.bailT); } catch (e) {}
    closeAtPicker(pane);
    if (tid && api && api.term && api.term.write) api.term.write(tid, '@' + (q || ''));
    pane._inputDirty = true;
    try { var t = paneTerm(pane); if (t) t.focus(); } catch (e) {}
  }
  // cierre DIRECTO (mouse / outside-click): libera pane._atp ya (no hay secuencia de teclas que tragar)
  function closeAtPicker(pane) {
    var st = pane._atp; if (!st) return;
    try { if (st.endTimer) { clearTimeout(st.endTimer); st.endTimer = null; } } catch (e) {}
    try { if (st.bailT) { clearTimeout(st.bailT); st.bailT = null; } } catch (e) {}
    try { if (st.outside) g.document.removeEventListener('mousedown', st.outside, true); } catch (e) {}
    try { if (st.onResize) g.removeEventListener('resize', st.onResize); } catch (e) {}
    try { if (st.el && st.el.parentNode) st.el.parentNode.removeChild(st.el); } catch (e) {}
    try { if (st.ghost && st.ghost.parentNode) st.ghost.parentNode.removeChild(st.ghost); } catch (e) {}
    pane._atp = null;
  }
  // cierre por TECLA: oculta el overlay YA pero deja pane._atp vivo (st.ending) hasta el keyup → el keypress
  // y el keyup de ESA tecla quedan suprimidos. CLAVE para que Enter (elegir) NO envíe el prompt: si cerrara
  // sincrónico, el keypress del Enter colaría un \r a claude (= submit). El 2º Enter (con el picker ya cerrado)
  // sí envía. La red de seguridad cierra solo si por algún motivo no llega el keyup.
  function endAtPicker(pane) {
    var st = pane._atp; if (!st || st.ending) return;
    st.ending = true;
    try { if (st.outside) g.document.removeEventListener('mousedown', st.outside, true); } catch (e) {}
    try { if (st.onResize) g.removeEventListener('resize', st.onResize); } catch (e) {}
    try { if (st.el && st.el.parentNode) st.el.parentNode.removeChild(st.el); } catch (e) {}
    try { if (st.ghost && st.ghost.parentNode) st.ghost.parentNode.removeChild(st.ghost); } catch (e) {}
    st.endTimer = setTimeout(function () { closeAtPicker(pane); }, 250);
  }
  function selectAt(pane, viaKey) {
    var st = pane._atp; if (!st || st.ending) return;
    var tid = pane.dataset.tid, pick = st.matches[st.sel], q = st.query;
    if (viaKey) endAtPicker(pane); else closeAtPicker(pane);
    if (tid && api && api.term && api.term.write) {
      if (pick) api.term.write(tid, '@' + pick + ' ');     // INSERTA @ruta + espacio (sin \r): NO envía el prompt
      else if (q) api.term.write(tid, '@' + q);            // sin match → fallback al @ nativo de claude
    }
    pane._inputDirty = true;   // hay texto en el input → el '/' deja de disparar el picker
    try { var t = paneTerm(pane); if (t) t.focus(); } catch (e) {}
  }
  function atKey(pane, ev) {
    var st = pane._atp; if (!st || st.ending) return;
    var k = ev.key;
    // ESC cierra el picker PERO deja el @texto tipeado en el input (lo escribe a la PTY, sin \r → no envía).
    // Mismo patrón que el fallback no-match de selectAt; claude puede mostrar su picker inline (escape hatch explícito).
    if (k === 'Escape') {
      var etid = pane.dataset.tid;
      if (etid && api && api.term && api.term.write) api.term.write(etid, '@' + st.query);
      pane._inputDirty = true;
      endAtPicker(pane); return;
    }
    if (k === 'Enter' || k === 'Tab') { selectAt(pane, true); return; }       // elige e INSERTA (no envía); el keyup cierra
    if (k === 'ArrowDown') { st.sel = Math.min(st.sel + 1, Math.max(0, st.matches.length - 1)); renderAtList(pane); return; }
    if (k === 'ArrowUp') { st.sel = Math.max(st.sel - 1, 0); renderAtList(pane); return; }
    if (k === 'Backspace') { if (st.query.length) { st.query = st.query.slice(0, -1); filterAt(pane); renderAtList(pane); } else { endAtPicker(pane); } return; }
    if (k && k.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) { st.query += k; filterAt(pane); renderAtList(pane); return; }
  }

  /* ════════ picker flotante de '/' (slash-commands) — mismo motor que @, datos distintos ════════
     Custom (de .claude/commands: perfil + proyecto) + built-ins curados. Dispara SOLO al inicio del
     input (heurística pane._inputDirty). Esc conserva el /texto; sin match, Enter manda el literal /query. */
  var SLASH_BUILTINS = [
    { name: 'help', desc: 'ayuda y lista de comandos' }, { name: 'clear', desc: 'limpiar la conversación' },
    { name: 'compact', desc: 'compactar el contexto' }, { name: 'cost', desc: 'uso y costo de la sesión' },
    { name: 'model', desc: 'cambiar de modelo' }, { name: 'resume', desc: 'reanudar una conversación' },
    { name: 'config', desc: 'configuración' }, { name: 'memory', desc: 'editar la memoria (CLAUDE.md)' },
    { name: 'review', desc: 'revisar un PR' }, { name: 'init', desc: 'generar CLAUDE.md del repo' },
    { name: 'agents', desc: 'subagentes' }, { name: 'mcp', desc: 'servidores MCP' },
    { name: 'status', desc: 'estado de la sesión' }, { name: 'doctor', desc: 'diagnóstico de la instalación' },
    { name: 'export', desc: 'exportar la conversación' }, { name: 'vim', desc: 'modo vim en el editor' },
    { name: 'terminal-setup', desc: 'atajos del terminal (Shift+Enter)' }, { name: 'add-dir', desc: 'agregar un directorio de trabajo' },
    { name: 'hooks', desc: 'configurar hooks' }, { name: 'login', desc: 'iniciar sesión' },
    { name: 'logout', desc: 'cerrar sesión' }, { name: 'release-notes', desc: 'novedades de la versión' },
    { name: 'bug', desc: 'reportar un problema' }
  ];
  function slItems(custom) {
    var seen = {}, out = [];
    (custom || []).forEach(function (c) { if (c && c.name && !seen[c.name]) { seen[c.name] = 1; out.push({ name: c.name, desc: c.desc || '', tag: c.source === 'project' ? 'proyecto' : 'custom' }); } });
    SLASH_BUILTINS.forEach(function (c) { if (!seen[c.name]) { seen[c.name] = 1; out.push({ name: c.name, desc: c.desc, tag: '' }); } });
    return out;
  }
  function filterSlash(pane) {
    var st = pane._slp; if (!st) return;
    var q = st.query.toLowerCase(), scored = [];
    if (!q) { st.matches = st.files.slice(0, 14); if (st.sel >= st.matches.length) st.sel = 0; return; }
    for (var i = 0; i < st.files.length; i++) { var s = atScore(st.files[i].name, q); if (s > 0) scored.push([s, st.files[i]]); }
    scored.sort(function (a, b) { return b[0] - a[0] || a[1].name.length - b[1].name.length; });
    st.matches = scored.slice(0, 14).map(function (x) { return x[1]; });
    if (st.sel >= st.matches.length) st.sel = Math.max(0, st.matches.length - 1);
  }
  function renderSlashList(pane) {
    var st = pane._slp; if (!st || !st.el) return;
    var items = st.matches.map(function (c, i) {
      return '<div class="dk-at-item' + (i === st.sel ? ' sel' : '') + '" data-at-i="' + i + '">' +
        svg('dispatch', 12, 1.7) + '<span class="dk-at-name">/' + esc(c.name) + '</span>' +
        (c.desc || c.tag ? '<span class="dk-at-dir">' + esc(c.desc) + (c.desc && c.tag ? ' · ' : '') + esc(c.tag) + '</span>' : '') + '</div>';
    }).join('');
    st.el.innerHTML =
      '<div class="dk-at-head"><span class="dk-at-q">/' + esc(st.query) + '</span>' +
        '<span class="dk-at-hint">' + (st.loading ? 'cargando…' : 'Enter elige · Esc cancela') + '</span></div>' +
      '<div class="dk-at-list">' + (items || '<div class="dk-at-empty">' + (st.loading ? '' : 'sin coincidencias') + '</div>') + '</div>';
    var term = paneTerm(pane); if (term) { placeAtPicker(pane, term, st.el); placeGhost(pane, term, st); }
    var selEl = st.el.querySelector('.dk-at-item.sel'); if (selEl && selEl.scrollIntoView) try { selEl.scrollIntoView({ block: 'nearest' }); } catch (e) {}
  }
  function openSlashPicker(pane) {
    if (pane._slp || pane._atp) return;
    var term = paneTerm(pane); if (!term) return;
    var el = g.document.createElement('div'); el.className = 'dk-at-picker';
    g.document.body.appendChild(el);
    var ghost = g.document.createElement('span'); ghost.className = 'dk-at-ghost';
    g.document.body.appendChild(ghost);
    var st = { el: el, ghost: ghost, prefix: '/', files: slItems([]), matches: [], query: '', sel: 0, loading: true };
    pane._slp = st;
    el.addEventListener('mousedown', function (e) {
      var it = e.target.closest && e.target.closest('[data-at-i]');
      if (it) { e.preventDefault(); st.sel = parseInt(it.getAttribute('data-at-i'), 10) || 0; selectSlash(pane, false); }
    });
    st.outside = function (e) { if (st.el && !st.el.contains(e.target)) closeSlashPicker(pane); };
    setTimeout(function () { try { g.document.addEventListener('mousedown', st.outside, true); } catch (e) {} }, 0);
    st.onResize = function () { var t = paneTerm(pane); if (t && pane._slp) { placeAtPicker(pane, t, st.el); placeGhost(pane, t, st); } };
    try { g.addEventListener('resize', st.onResize); } catch (e) {}
    filterSlash(pane); renderSlashList(pane);
    // re-snap al cursor tras abrir (claude settlea su caret un frame después) → pixel-perfect aunque no tipees
    requestAnimationFrame(function () { if (pane._slp) renderSlashList(pane); });
    setTimeout(function () { if (pane._slp) renderSlashList(pane); }, 90);
    if (api && api.listCommands) {
      api.listCommands(pane.dataset.cwd || '').then(function (r) {
        if (!pane._slp) return;
        st.files = slItems((r && r.ok && r.commands) ? r.commands : []);
        st.loading = false; filterSlash(pane); renderSlashList(pane);
      }).catch(function () { if (pane._slp) { st.loading = false; filterSlash(pane); renderSlashList(pane); } });
    } else { st.loading = false; }
  }
  function closeSlashPicker(pane) {
    var st = pane._slp; if (!st) return;
    try { if (st.endTimer) { clearTimeout(st.endTimer); st.endTimer = null; } } catch (e) {}
    try { if (st.outside) g.document.removeEventListener('mousedown', st.outside, true); } catch (e) {}
    try { if (st.onResize) g.removeEventListener('resize', st.onResize); } catch (e) {}
    try { if (st.el && st.el.parentNode) st.el.parentNode.removeChild(st.el); } catch (e) {}
    try { if (st.ghost && st.ghost.parentNode) st.ghost.parentNode.removeChild(st.ghost); } catch (e) {}
    pane._slp = null;
  }
  function endSlashPicker(pane) {
    var st = pane._slp; if (!st || st.ending) return;
    st.ending = true;
    try { if (st.outside) g.document.removeEventListener('mousedown', st.outside, true); } catch (e) {}
    try { if (st.onResize) g.removeEventListener('resize', st.onResize); } catch (e) {}
    try { if (st.el && st.el.parentNode) st.el.parentNode.removeChild(st.el); } catch (e) {}
    try { if (st.ghost && st.ghost.parentNode) st.ghost.parentNode.removeChild(st.ghost); } catch (e) {}
    st.endTimer = setTimeout(function () { closeSlashPicker(pane); }, 250);
  }
  function selectSlash(pane, viaKey) {
    var st = pane._slp; if (!st || st.ending) return;
    var tid = pane.dataset.tid, pick = st.matches[st.sel], q = st.query;
    if (viaKey) endSlashPicker(pane); else closeSlashPicker(pane);
    if (tid && api && api.term && api.term.write) {
      if (pick) api.term.write(tid, '/' + pick.name + ' ');   // inserta /comando + espacio (sin \r): el user agrega args y Enter
      else if (q) api.term.write(tid, '/' + q);               // sin match → fallback al / nativo de claude
    }
    pane._inputDirty = true;
    try { var t = paneTerm(pane); if (t) t.focus(); } catch (e) {}
  }
  function slKey(pane, ev) {
    var st = pane._slp; if (!st || st.ending) return;
    var k = ev.key;
    if (k === 'Escape') {
      var etid = pane.dataset.tid;
      if (etid && api && api.term && api.term.write) api.term.write(etid, '/' + st.query);   // deja el /texto en el input
      pane._inputDirty = true; endSlashPicker(pane); return;
    }
    if (k === 'Enter' || k === 'Tab') { selectSlash(pane, true); return; }
    if (k === 'ArrowDown') { st.sel = Math.min(st.sel + 1, Math.max(0, st.matches.length - 1)); renderSlashList(pane); return; }
    if (k === 'ArrowUp') { st.sel = Math.max(st.sel - 1, 0); renderSlashList(pane); return; }
    if (k === 'Backspace') { if (st.query.length) { st.query = st.query.slice(0, -1); filterSlash(pane); renderSlashList(pane); } else { endSlashPicker(pane); } return; }
    if (k && k.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) { st.query += k; filterSlash(pane); renderSlashList(pane); return; }
  }

  /* ── copiar / pegar / seleccionar (clipboard vía IPC; navigator.clipboard está bloqueado por la CSP) ── */
  function termCopy(term) {
    try {
      if (term.hasSelection && term.hasSelection()) {
        var sel = term.getSelection();
        if (sel && api && api.action) api.action('copyText', { text: sel }).catch(function () {});
        try { term.clearSelection(); } catch (e) {}   // así un 2º Ctrl+C cae a SIGINT
        return true;
      }
    } catch (e) {}
    return false;   // sin selección → el caller deja pasar la tecla
  }
  function termPaste(term) {
    try {
      if (api && api.clipboardRead) api.clipboardRead().then(function (txt) {
        if (txt) { try { term.paste(txt); } catch (e) {} }   // term.paste respeta bracketed-paste
        try { term.focus(); } catch (e) {}                    // re-focus (la lectura es async)
      }).catch(function () {});
    } catch (e) {}
  }
  function termSelectAll(term) { try { term.selectAll(); } catch (e) {} }

  /* ── pegar una IMAGEN del portapapeles en una terminal CLAUDE ──
     claude lee la imagen del portapapeles él mismo, pero en Windows su lector está ROTO (toma un BMP/DIB y su
     sharp-WASM no lo decodifica → "no hay imagen", falla a la 1ª; pasa igual en Warp). En vez de eso, Consomni
     lee la imagen (Electron, robusto), la guarda como PNG temporal y le pasa la RUTA por BRACKETED PASTE →
     claude la convierte en [Image #N] al instante, a la 1ª, siempre. Verificado por harness PTY contra claude
     real: el tecleo crudo de la ruta NO dispara el reconocimiento; el bracketed paste SÍ (con backslashes de
     Windows, sin comillas). Devuelve Promise<bool> (true si había imagen y se pegó). */
  function pasteClipImage(term, pane) {
    if (!api || !api.clipboardImageToTempPng) return Promise.resolve(false);
    return api.clipboardImageToTempPng().then(function (res) {
      if (res && res.ok && res.file) {
        // term.paste() envuelve en bracketed paste (\x1b[200~…\x1b[201~) respetando el modo del PTY (claude lo
        // tiene activo) → claude reconoce la ruta como imagen. Fallback al raw por si el modo no estuviera trackeado.
        try { term.paste(res.file); } catch (e) {
          try { var tid = pane && pane.dataset.tid; if (tid) api.term.write(tid, '\x1b[200~' + res.file + '\x1b[201~'); } catch (e2) {}
        }
        try { term.focus(); } catch (e3) {}
        return true;
      }
      return false;
    }).catch(function () { return false; });
  }

  /* ── SELECCIÓN del input en terminales CLAUDE (la TUI de claude NO soporta selección de su input —
     verificado: Ctrl+A mueve el cursor, Shift+flechas mueven, Ctrl+C sin selección sólo interrumpe; y
     claude "agarra" el mouse con mouse-tracking → un arrastre normal no selecciona). Por eso lo hace
     Consomni a nivel xterm.) ── */

  // Quita las secuencias de MOUSE TRACKING (DECSET ?1000/1002/1003/1006/1005/1015/1016 h|l) del stream de
  // claude → xterm nunca prende el modo mouse → un arrastre normal SELECCIONA (en vez de mandarle el click a
  // claude). Se aplica sólo mientras el "modo selección" del panel está ON (toggle por panel).
  function stripMouseTracking(data) {
    try { return String(data).replace(/\x1b\[\?(1000|1001|1002|1003|1005|1006|1015|1016)[hl]/g, ''); }
    catch (e) { return data; }
  }

  // Calcula la región del INPUT de claude en el buffer del xterm: desde el prompt (❯ / › / >) hasta el cursor
  // (soporta input de varias líneas vía length que envuelve a `cols`). Pura → testeable. Devuelve {startCol,
  // startRow, length} (coords ABSOLUTAS del buffer, base 0) o null si no encuentra el prompt.
  function computeInputSelection(buf, cols) {
    if (!buf || !cols) return null;
    var curRow = (buf.baseY || 0) + (buf.cursorY || 0);
    var curCol = buf.cursorX || 0;
    function promptStart(row) {
      var line = buf.getLine(row); if (!line) return -1;
      var s = line.translateToString(true);              // texto plano, trim derecho
      var m = s.match(/^(\s*)(❯|›|>)\s/);       // ❯ / › / >  seguido de espacio
      return m ? m[0].length : -1;                        // columna (0-based) donde arranca el texto del input
    }
    var startRow = curRow, startCol = promptStart(curRow);
    if (startCol < 0) {                                   // ¿input multi-línea? subir hasta la fila con el prompt
      for (var r = curRow - 1; r >= Math.max(0, curRow - 12); r--) {
        var p = promptStart(r);
        if (p >= 0) { startRow = r; startCol = p; break; }
      }
      if (startCol < 0) return null;                      // sin prompt → no arriesgar una selección equivocada
    }
    var length = (curRow - startRow) * cols + (curCol - startCol);
    if (length <= 0) return null;
    return { startCol: startCol, startRow: startRow, length: length };
  }

  // Ctrl+A en claude → selecciona TODO el input que escribiste (a nivel xterm). Luego Ctrl+C lo copia (termCopy).
  function selectClaudeInput(term) {
    try {
      var buf = term.buffer && term.buffer.active;
      var sel = computeInputSelection(buf, term.cols);
      if (!sel) return false;
      try { term.clearSelection(); } catch (e) {}
      term.select(sel.startCol, sel.startRow, sel.length);
      try { term.focus(); } catch (e2) {}
      return !!(term.hasSelection && term.hasSelection());
    } catch (e) { return false; }
  }

  // Toggle del "modo selección" de un panel claude: ON = Consomni ignora el mouse de claude → arrastre normal
  // selecciona + Ctrl+C copia. OFF = el mouse vuelve a ser de claude (claude re-activa su mouse-tracking solo).
  function setPaneSelMode(pane, on) {
    pane._selMode = !!on;
    var btn = pane.querySelector('.dk-pane-sel');
    if (btn) { btn.classList.toggle('on', !!on); btn.title = on ? 'modo selección ON (arrastrá para seleccionar · click para volver el mouse a claude)' : 'modo selección: arrastrá para seleccionar el texto que escribís'; }
    if (on) {
      // apagá YA el mouse-tracking que claude tenga activo en xterm (los re-activos se filtran en bindIpc)
      var t = terms.get(pane.dataset.tid);
      if (t && t.term) { try { t.term.write('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l\x1b[?1005l'); } catch (e) {} }
    }
    // OFF: no hacemos nada; claude re-asserta su mouse-tracking en el próximo redibujo.
  }

  // botón "selección" en la cabecera de una terminal CLAUDE (toggle del modo selección con mouse). Idempotente.
  function ensureSelBtn(pane) {
    var btns = pane.querySelector('.dk-pane-btns');
    if (!btns || btns.querySelector('.dk-pane-sel')) return;
    var sb = document.createElement('button');
    sb.className = 'dk-pbtn dk-pane-sel';
    sb.title = 'modo selección: arrastrá para seleccionar el texto que escribís';
    sb.innerHTML = svg('selection', 12, 1.9);
    sb.addEventListener('click', function (e) { e.stopPropagation(); setFocus(pane); setPaneSelMode(pane, !pane._selMode); });
    var vb = btns.querySelector('.dk-pane-vscode'), x = btns.querySelector('.dk-pane-x');
    if (vb) btns.insertBefore(sb, vb); else if (x) btns.insertBefore(sb, x); else btns.appendChild(sb);
  }

  // toggle "scroll del historial" en la cabecera de una terminal CLAUDE. Cambia entre:
  //   - ANCLADO (fullscreen/alt-screen): el input queda abajo, pero la terminal NO scrollea hacia arriba
  //     (claude scrollea adentro con PgUp/Ctrl+Inicio/rueda; Ctrl+O = modo transcripción + búsqueda).
  //   - NATIVO (clásico): claude escribe en la terminal normal → scrolleás hacia arriba con la rueda como
  //     cualquier terminal y leés todo el historial (el input deja de quedar anclado abajo).
  // Usa el comando NATIVO de claude (/tui default | /tui fullscreen): relanza su renderer CONSERVANDO la
  // conversación. Idempotente.
  function ensureScrollBtn(pane) {
    var btns = pane.querySelector('.dk-pane-btns');
    if (!btns || btns.querySelector('.dk-pane-scroll')) return;
    var rb = document.createElement('button');
    rb.className = 'dk-pbtn dk-pane-scroll';
    rb.innerHTML = svg('scroll', 12, 1.9);
    rb.addEventListener('click', function (e) { e.stopPropagation(); setFocus(pane); setPaneScrollMode(pane, pane.dataset.fullscreen === '1'); });
    var sel = btns.querySelector('.dk-pane-sel'), vb = btns.querySelector('.dk-pane-vscode'), x = btns.querySelector('.dk-pane-x');
    if (sel) btns.insertBefore(rb, sel); else if (vb) btns.insertBefore(rb, vb); else if (x) btns.insertBefore(rb, x); else btns.appendChild(rb);
    updateScrollBtn(pane);
  }
  function updateScrollBtn(pane) {
    var btn = pane.querySelector('.dk-pane-scroll'); if (!btn) return;
    var nativo = pane.dataset.fullscreen === '0';   // clásico = scroll nativo activo
    btn.classList.toggle('on', nativo);
    btn.title = nativo
      ? 'scroll nativo ON — leé el historial con la rueda · ojo: claude puede pisar líneas mientras escribe (limitación del modo) · click = volver al input anclado abajo (recomendado)'
      : 'input anclado abajo (render limpio). Para leer TODO el historial sin cortes: Ctrl+O (modo transcripción + búsqueda de claude) · o scrolleá con la rueda/PgUp · click = scroll nativo de la terminal';
  }
  // pasa el panel claude a scroll NATIVO (native=true) o ANCLADO (native=false), en VIVO via /tui.
  function setPaneScrollMode(pane, native) {
    if (!pane || pane.dataset.kind !== 'claude') return;
    pane.dataset.fullscreen = native ? '0' : '1';
    var tid = pane.dataset.tid;
    if (tid && api && api.term && api.term.write) {
      try { api.term.write(tid, (native ? '/tui default' : '/tui fullscreen') + '\r'); } catch (e) {}
    }
    updateScrollBtn(pane);
    notifier(native ? 'claude: scroll nativo (historial con la rueda)' : 'claude: input anclado abajo · Ctrl+O = historial completo + búsqueda');
    persist();
  }
  function setClaudeFullscreenDefault(on) { claudeFsDefault = (on !== false); }
  function setGpuRender(on) { gpuRender = (on !== false); }   // aplica a terminales NUEVAS (las abiertas siguen con su renderer)
  function setFloatingPickers(on) { floatingPickers = (on !== false); }   // @ y / flotantes; OFF = van crudos a claude (su picker inline)
  // ¿hay una sesión de claude VIVA (PTY viva, no minimizada, no finalizada)? → para avisar antes de actualizar (corta la sesión)
  function hasActiveClaudeSessions() {
    return allPanes().some(function (p) {
      return p && p.dataset.kind === 'claude' && p.dataset.tid && p.dataset.min !== '1' && !p.classList.contains('dead');
    });
  }

  // menú contextual (copiar/pegar/seleccionar todo) sobre la terminal. Vive en document.body (fuera de
  // #terminals) → no lo traga el handler global de clicks de app.js.
  function closeTermCtx() {
    var m = g.document.getElementById('dkCtx'); if (m) m.remove();
    g.document.removeEventListener('mousedown', onCtxOutside, true);
    g.document.removeEventListener('keydown', onCtxKey, true);
  }
  function onCtxOutside(e) { if (!e.target.closest || !e.target.closest('#dkCtx')) closeTermCtx(); }
  function onCtxKey(e) { if (e.key === 'Escape') { e.preventDefault(); closeTermCtx(); } }
  // ruta de archivo bajo la celda donde se hizo click derecho (xterm no expone hit-test → geometría)
  function pathUnderEvent(term, ev) {
    try {
      var rows = term.element && term.element.querySelector('.xterm-rows'); if (!rows) return null;
      var rect = rows.getBoundingClientRect();
      var cw = rect.width / term.cols, ch = rect.height / term.rows;
      if (!cw || !ch) return null;
      var col = Math.floor((ev.clientX - rect.left) / cw);
      var srow = Math.floor((ev.clientY - rect.top) / ch);
      var bufY = (term.buffer.active.viewportY || 0) + srow;
      var line = term.buffer.active.getLine(bufY); if (!line) return null;
      return findPathToken(line.translateToString(true), col);
    } catch (e) { return null; }
  }
  function showTermCtx(x, y, term, ev, pane) {
    closeTermCtx();
    var hasSel = false; try { hasSel = !!(term.hasSelection && term.hasSelection()); } catch (e) {}
    var tok = (ev && pane) ? pathUnderEvent(term, ev) : null;
    var resolved = null, fcwd = '';
    if (tok) { fcwd = (pane && pane.dataset.cwd) || (view !== '__home__' ? viewCwd : '') || ''; resolved = resolveFilePath(tok.text, fcwd); }
    var m = g.document.createElement('div');
    m.id = 'dkCtx'; m.className = 'dk-ctx';
    m.innerHTML =
      (resolved
        ? '<button class="dk-ctx-i" data-fctx="panel">Abrir en panel</button>' +
          '<button class="dk-ctx-i" data-fctx="editor">Abrir en editor</button>' +
          '<button class="dk-ctx-i" data-fctx="reveal">Revelar ubicación</button>' +
          '<div class="dk-ctx-sep"></div>'
        : '') +
      '<button class="dk-ctx-i" data-ctx="copy"' + (hasSel ? '' : ' disabled') + '>Copiar</button>' +
      '<button class="dk-ctx-i" data-ctx="paste">Pegar</button>' +
      '<button class="dk-ctx-i" data-ctx="all">Seleccionar todo</button>';
    g.document.body.appendChild(m);
    var mw = m.offsetWidth || 168, mh = m.offsetHeight || 96;
    m.style.left = Math.max(4, Math.min(x, g.innerWidth - mw - 4)) + 'px';
    m.style.top = Math.max(4, Math.min(y, g.innerHeight - mh - 4)) + 'px';
    m.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-ctx],[data-fctx]'); if (!b || b.disabled) return;
      var fa = b.getAttribute('data-fctx');
      if (fa) { if (fa === 'panel') openFilePanel(resolved, fcwd); else if (fa === 'editor') openFileEditor(resolved, fcwd); else if (fa === 'reveal') revealFilePath(resolved); closeTermCtx(); return; }
      var act = b.getAttribute('data-ctx');
      if (act === 'copy') termCopy(term); else if (act === 'paste') termPaste(term); else if (act === 'all') termSelectAll(term);
      closeTermCtx(); try { term.focus(); } catch (e2) {}
    });
    setTimeout(function () {
      g.document.addEventListener('mousedown', onCtxOutside, true);
      g.document.addEventListener('keydown', onCtxKey, true);
    }, 0);
  }

  /* ── chooser de carpeta (compartido F4/F5): lista cwds de proyectos conocidos (del último snapshot,
     read-only) + picker nativo. F4 lo usa para 'cd' en la terminal actual; F5 para abrir una nueva. ── */
  function projectDirs() {
    var out = [], seen = {};
    try {
      var ss = (lastSnap && lastSnap.sessions) ? lastSnap.sessions : [];
      for (var i = 0; i < ss.length; i++) {
        var cw = String(ss[i].cwd || '').trim(); if (!cw) continue;
        var k = cw.toLowerCase(); if (seen[k]) continue; seen[k] = 1;
        out.push({ cwd: cw, name: cw.split(/[\\/]/).filter(Boolean).pop() || cw });
      }
    } catch (e) {}
    out.sort(function (a, b) { return a.name.localeCompare(b.name); });
    return out;
  }
  function closeDirChooser() {
    var m = g.document.getElementById('dkDir'); if (m) m.remove();
    g.document.removeEventListener('mousedown', onDirOutside, true);
    g.document.removeEventListener('keydown', onDirKey, true);
  }
  function onDirOutside(e) { if (!e.target.closest || !e.target.closest('#dkDir')) closeDirChooser(); }
  function onDirKey(e) { if (e.key === 'Escape') { e.preventDefault(); closeDirChooser(); } }
  function openDirChooser(opts) {
    opts = opts || {};
    closeDirChooser();
    var dirs = projectDirs();
    function rowsHtml(filter) {
      var f = (filter || '').toLowerCase().trim();
      var list = f ? dirs.filter(function (d) { return d.name.toLowerCase().indexOf(f) >= 0 || d.cwd.toLowerCase().indexOf(f) >= 0; }) : dirs;
      if (!list.length) return '<div class="dk-dir-empty">' + (dirs.length ? 'sin coincidencias' : 'no hay proyectos conocidos — usá "otra…"') + '</div>';
      return list.map(function (d) {
        return '<button class="dk-dir-item" data-cwd="' + esc(d.cwd) + '">' + svg('folder', 12, 1.7) +
          '<span class="dk-dir-name">' + esc(d.name) + '</span><span class="dk-dir-path">' + esc(d.cwd) + '</span></button>';
      }).join('');
    }
    var m = g.document.createElement('div'); m.id = 'dkDir'; m.className = 'dk-dir-chooser';
    m.innerHTML =
      '<div class="dk-dir-head"><span class="dk-dir-title">' + esc(opts.title || 'elegir directorio') + '</span>' +
        '<button class="dk-dir-pick" title="elegir otra carpeta">' + svg('folder', 12, 1.8) + ' otra…</button></div>' +
      '<input class="dk-dir-inp" placeholder="filtrar…" spellcheck="false">' +
      '<div class="dk-dir-list">' + rowsHtml('') + '</div>';
    g.document.body.appendChild(m);
    var aw = m.offsetWidth || 320, ah = m.offsetHeight || 240;
    if (opts.anchor && opts.anchor.getBoundingClientRect) {
      var r = opts.anchor.getBoundingClientRect();
      m.style.left = Math.max(8, Math.min(Math.round(r.left), g.innerWidth - aw - 8)) + 'px';
      m.style.top = Math.max(8, Math.min(Math.round(r.bottom + 5), g.innerHeight - ah - 8)) + 'px';
    } else {
      m.style.left = Math.round((g.innerWidth - aw) / 2) + 'px';
      m.style.top = '84px';
    }
    function pick(ruta) { closeDirChooser(); if (opts.onPick) opts.onPick(ruta); }
    m.querySelector('.dk-dir-pick').addEventListener('click', function (e) {
      e.stopPropagation();
      if (api && api.pickFolder) api.pickFolder().then(function (p) { if (p) pick(p); });
    });
    var inp = m.querySelector('.dk-dir-inp'), listEl = m.querySelector('.dk-dir-list');
    inp.addEventListener('input', function () { listEl.innerHTML = rowsHtml(inp.value); });
    m.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('.dk-dir-item'); if (!b) return;
      pick(b.getAttribute('data-cwd'));
    });
    setTimeout(function () {
      g.document.addEventListener('mousedown', onDirOutside, true);
      g.document.addEventListener('keydown', onDirKey, true);
      try { inp.focus(); } catch (e) {}
    }, 0);
  }
  // cd en la terminal: manda `cd "ruta"` (con \r → ejecuta) y actualiza el cwd del panel (para @ picker / clonar).
  function cdInto(pane, ruta) {
    ruta = String(ruta || '').trim(); if (!ruta || !pane) return;
    var tid = pane.dataset.tid;
    if (tid && api && api.term && api.term.write) api.term.write(tid, 'cd "' + ruta + '"\r');
    updatePaneCwd(pane, ruta);
    pane._sgLine = ''; pane._sgTrusted = true; if (pane._sgGhost) hideShellGhost(pane);   // ejecuta (\r) → prompt fresco: reset de la línea sombra del autosuggest
    try { var t = paneTerm(pane); if (t) t.focus(); } catch (e) {}
  }

  /* ════════ AUTOSUGGEST (ghost text estilo Warp/fish) — sólo terminales SHELL ════════
     Mantenemos un BUFFER SOMBRA de la línea tipeada (pane._sgLine) y mostramos en gris, pegado al cursor,
     el comando más reciente del historial que matchea el prefijo. La tecla configurada (default Tab) ACEPTA
     (escribe sólo el sufijo a la PTY, sin \r). Modelo de confianza INVERTIDO: sólo confiamos tras tipeo
     hacia adelante / Backspace; CUALQUIER otra tecla (flechas, Home/End, Tab sin sugerencia, F-keys, paste,
     historial…) marca la línea como "no confiable" → sin sugerencia (NUNCA corrompemos la línea). Reseteo a
     confiable y vacío SÓLO en Enter / Ctrl+C (la línea queda vacía y conocida). Claude queda fuera de alcance
     (dibuja su propio input/TUI y su propia sugerencia → un ghost pelearía con su render). */
  var termHistory = [];                 // [{cmd, cwd, ts}] más-reciente-primero (cap 500)
  var autosuggestEnabled = true;        // config.autosuggest (lo empuja app.js vía bridge)
  var autosuggestAcceptKey = 'Tab';     // config.autosuggestAcceptKey (reconfigurable)
  var autosuggestRebinder = null;       // callback a app.js para reasignar la tecla (dueño de la config)
  var sgSaveTimer = 0;
  function setAutosuggest(enabled, acceptKey) {
    autosuggestEnabled = enabled !== false;
    if (acceptKey) autosuggestAcceptKey = acceptKey;
    if (!autosuggestEnabled) { try { allPanes().forEach(function (p) { if (p._sgGhost) hideShellGhost(p); }); } catch (e) {} }
    else { try { allPanes().forEach(function (p) { if (p._sgGhostHint) p._sgGhostHint.textContent = prettyKey(autosuggestAcceptKey); }); } catch (e) {} }
  }
  function setAutosuggestRebinder(fn) { if (typeof fn === 'function') autosuggestRebinder = fn; }
  function loadTermHistoryStore() {
    try { if (api && api.term && api.term.getHistory) api.term.getHistory().then(function (d) { if (d && Array.isArray(d.commands)) termHistory = d.commands.slice(0, 500); }).catch(function () {}); } catch (e) {}
  }
  function saveTermHistoryStore() {
    if (sgSaveTimer) clearTimeout(sgSaveTimer);
    sgSaveTimer = setTimeout(function () { sgSaveTimer = 0; try { if (api && api.term && api.term.saveHistory) api.term.saveHistory({ v: 1, commands: termHistory }); } catch (e) {} }, 500);
  }
  function sgRecordHistory(pane) {
    var line = (pane._sgLine || '').trim();
    if (!line || !pane._sgTrusted || line.length > 800) return;
    termHistory = termHistory.filter(function (h) { return h && h.cmd !== line; });   // dedupe → al frente
    termHistory.unshift({ cmd: line, cwd: pane.dataset.cwd || '', ts: Date.now() });
    if (termHistory.length > 500) termHistory = termHistory.slice(0, 500);
    saveTermHistoryStore();
  }
  // mejor match del historial: prefijo exacto; preferí el mismo cwd (sino el más reciente cualquiera)
  function bestHistoryMatch(prefix, cwd) {
    var ncwd = String(cwd || '').toLowerCase().replace(/\\/g, '/').replace(/\/+$/, ''), any = null;
    for (var i = 0; i < termHistory.length; i++) {
      var h = termHistory[i]; if (!h || !h.cmd) continue;
      if (h.cmd.length > prefix.length && h.cmd.lastIndexOf(prefix, 0) === 0) {
        var hc = String(h.cwd || '').toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
        if (hc === ncwd) return h.cmd;        // mismo cwd → gana (el 1º es el más reciente de ese cwd)
        if (!any) any = h.cmd;                // sino, recordá el más reciente cualquiera
      }
    }
    return any;
  }
  function prettyKey(k) { var m = { ArrowRight: '→', ArrowLeft: '←', ArrowUp: '↑', ArrowDown: '↓' }; return m[k] || k; }
  // serializa una tecla a un descriptor estable + legible: 'Tab' · 'ArrowRight' · 'End' · 'Ctrl+F'
  function sgSerializeKey(ev) {
    var mods = ''; if (ev.ctrlKey) mods += 'Ctrl+'; if (ev.altKey) mods += 'Alt+'; if (ev.shiftKey) mods += 'Shift+';
    var base; var c = ev.code || '';
    if (c.indexOf('Key') === 0) base = c.slice(3); else if (c.indexOf('Digit') === 0) base = c.slice(5); else base = c || ev.key;
    return mods + base;
  }
  // ghost: un span ÚNICO por panel (.dk-sg) con el sufijo gris + un pill "Tab" clickeable para reasignar.
  // Vive en document.body (fuera de #terminals) y usa colores FIJOS oscuros (la terminal es oscura siempre,
  // también en modo claro) — mismo criterio que .dk-at-ghost/.dk-at-picker.
  function ensureShellGhost(pane) {
    if (pane._sgGhost) return pane._sgGhost;
    var wrap = g.document.createElement('span'); wrap.className = 'dk-sg';
    var txt = g.document.createElement('span'); txt.className = 'dk-sg-text';
    var hint = g.document.createElement('span'); hint.className = 'dk-sg-hint'; hint.title = 'cambiar la tecla para aceptar la sugerencia';
    wrap.appendChild(txt); wrap.appendChild(hint);
    hint.addEventListener('mousedown', function (e) { e.preventDefault(); e.stopPropagation(); if (autosuggestRebinder) autosuggestRebinder(); });
    g.document.body.appendChild(wrap);
    pane._sgGhost = wrap; pane._sgGhostText = txt; pane._sgGhostHint = hint;
    return wrap;
  }
  function placeShellGhost(pane, term) {
    var wrap = pane._sgGhost; if (!wrap) return;
    var c = cursorRect(pane, term);
    if (!c || !pane._sgSuffix) { wrap.style.display = 'none'; pane._sgGhostVisible = false; return; }
    pane._sgGhostText.textContent = pane._sgSuffix;
    pane._sgGhostHint.textContent = prettyKey(autosuggestAcceptKey);
    wrap.style.display = '';
    wrap.style.left = Math.round(c.left) + 'px';
    wrap.style.top = Math.round(c.top) + 'px';
    wrap.style.height = Math.round(c.h) + 'px';
    try { if (term.options) { pane._sgGhostText.style.fontSize = term.options.fontSize + 'px'; pane._sgGhostText.style.fontFamily = term.options.fontFamily; pane._sgGhostText.style.lineHeight = Math.round(c.h) + 'px'; } } catch (e) {}
    try { pane._sgCursorY = term.buffer.active.cursorY; } catch (e) {}
    pane._sgGhostVisible = true;
  }
  function hideShellGhost(pane) {
    pane._sgSuffix = '';
    if (pane._sgGhost) pane._sgGhost.style.display = 'none';
    pane._sgGhostVisible = false;
  }
  function computeShellSuggest(pane) {
    if (!autosuggestEnabled || pane.dataset.kind !== 'shell' || !pane._sgTrusted) { hideShellGhost(pane); return; }
    var line = pane._sgLine || '';
    if (!line) { hideShellGhost(pane); return; }
    var sug = bestHistoryMatch(line, pane.dataset.cwd || '');
    if (!sug || sug.lastIndexOf(line, 0) !== 0 || sug.length <= line.length) { hideShellGhost(pane); return; }
    pane._sgSuffix = sug.slice(line.length);
    var term = paneTerm(pane);
    if (term) { ensureShellGhost(pane); placeShellGhost(pane, term); } else hideShellGhost(pane);
  }
  function scheduleShellSuggest(pane) {
    if (pane._sgRaf) return;
    pane._sgRaf = g.requestAnimationFrame(function () { pane._sgRaf = 0; computeShellSuggest(pane); });
  }
  // maneja el autosuggest en el keydown de un panel SHELL. Devuelve true si CONSUMIÓ el evento (aceptar).
  function shellAutosuggestKey(pane, ev) {
    if (pane.dataset.kind !== 'shell' || !autosuggestEnabled) return false;
    var k = ev.key, code = ev.code;
    if (k === 'Shift' || k === 'Control' || k === 'Alt' || k === 'Meta' || k === 'CapsLock' || k === 'Dead' || k === 'Process' || k === 'AltGraph') return false;  // modificador solo → ignorar
    // 1) ACEPTAR con la tecla configurada (sólo si hay ghost visible). NUNCA con Ctrl: esas teclas mapean a
    // chars de control del terminal (Ctrl+C=SIGINT, Ctrl+W=cerrar pane, Ctrl+V=pegar) → aceptar las robaría
    // (defensa por si quedó una config vieja con Ctrl+X; el bind ya las rechaza en isValidAcceptKey de app.js).
    if (!ev.ctrlKey && pane._sgGhostVisible && pane._sgSuffix && sgSerializeKey(ev) === autosuggestAcceptKey) {
      var tid = pane.dataset.tid;
      if (tid && api.term && api.term.write) {
        api.term.write(tid, pane._sgSuffix);
        pane._sgLine = (pane._sgLine || '') + pane._sgSuffix;   // extender la sombra (escribimos de verdad → siguen matcheando)
        hideShellGhost(pane);
        ev.preventDefault();   // que xterm NO mande \t (si era Tab) — return false NO hace preventDefault
        return true;
      }
      hideShellGhost(pane); return false;   // sin tid (no debería pasar con ghost visible) → no consumir la tecla
    }
    // 2) tracking del buffer sombra (reset SÓLO en Enter / Ctrl+C → línea vacía y conocida)
    if (code === 'Enter' || code === 'NumpadEnter') { sgRecordHistory(pane); pane._sgLine = ''; pane._sgTrusted = true; hideShellGhost(pane); }
    else if (ev.ctrlKey && !ev.altKey && !ev.shiftKey && code === 'KeyC') { pane._sgLine = ''; pane._sgTrusted = true; hideShellGhost(pane); }
    else if (code === 'Backspace') { if (pane._sgTrusted) { pane._sgLine = (pane._sgLine || '').slice(0, -1); scheduleShellSuggest(pane); } else hideShellGhost(pane); }
    else if (!ev.ctrlKey && !ev.metaKey && !ev.altKey && k && k.length === 1) { if (pane._sgTrusted) { pane._sgLine = (pane._sgLine || '') + k; scheduleShellSuggest(pane); } }
    else { pane._sgTrusted = false; hideShellGhost(pane); }   // cualquier otra tecla → no modelable → untrust
    return false;
  }

  // monta xterm + PTY dentro de un panel YA colocado (lo usa spawn y la restauración)
  // pick (sin resume): `claude --resume` abre el SELECTOR interactivo scopeado al cwd del proyecto.
  function mountTerminal(pane, kind, cwd, resume, skip, pick) {
    kind = (kind === 'claude') ? 'claude' : 'shell';
    pane.dataset.kind = kind;
    pane._sgLine = ''; pane._sgTrusted = true; pane._sgSuffix = ''; pane._sgGhostVisible = false;   // autosuggest: buffer sombra arranca vacío y confiable
    if (cwd) pane.dataset.cwd = cwd;
    if (resume) pane.dataset.resume = resume; else pane.removeAttribute('data-resume');
    if (skip) pane.dataset.skip = '1'; else pane.removeAttribute('data-skip');
    pane.classList.remove('dk-pane--session', 'dk-pane--shell', 'dk-pane--claude');
    pane.classList.add('dk-pane--' + kind);
    // modo render del panel claude: '1'=fullscreen (input anclado abajo) · '0'=clásico (scroll nativo del
    // historial). Si no está fijado (panel nuevo), tomar el default global. El restore/toggle ya lo dejan seteado.
    if (kind === 'claude' && pane.dataset.fullscreen !== '0' && pane.dataset.fullscreen !== '1') pane.dataset.fullscreen = claudeFsDefault ? '1' : '0';
    var ic = kind === 'claude' ? '<span class="dk-tdot"></span>' : svg('term', 11, 2);
    var lbl = kind === 'claude' ? ((resume || pick) ? 'claude ↻…' : (skip ? 'claude ⚡…' : 'claude…')) : 'shell…';
    setPaneMeta(pane, ic, lbl, projLabel(pane));
    updatePinUI(pane);
    ensureVscodeBtn(pane);   // botón VSCode en la cabecera de la terminal (abre su cwd en el editor)
    if (kind === 'shell') ensureCdBtn(pane);   // botón "cd" sólo en shells (cambiar de dir sin teclear cd a mano)
    if (kind === 'claude') { ensureSelBtn(pane); ensureScrollBtn(pane); }   // claude: selección + toggle scroll nativo/anclado
    // Al RETOMAR un claude en fullscreen, el historial vive en el alt-screen (sin scrollback nativo) → el modo
    // confiable para leerlo/buscarlo entero es Ctrl+O (transcripción de claude). Lo avisamos UNA vez por sesión
    // (justo cuando lo necesitás: retomaste un chat y querés releer). El toggle "scroll nativo" sigue disponible.
    if (kind === 'claude' && (resume || pick) && pane.dataset.fullscreen === '1' && !claudeHistHintShown) {
      claudeHistHintShown = true;
      setTimeout(function () { try { notifier('retomada: Ctrl+O abre el historial completo (+ búsqueda)'); } catch (e) {} }, 1200);
    }
    var body = pane.querySelector('.dk-pane-body');
    body.innerHTML = '';

    var termOpts = {
      fontFamily: "'Geist Mono', ui-monospace, 'Cascadia Mono', monospace",
      fontSize: 12.5, lineHeight: 1.15, cursorBlink: true, cursorStyle: 'bar',
      allowProposedApi: true, scrollback: 12000, smoothScrollDuration: 120, theme: THEME   // scroll de rueda suave (polish)
    };
    // ConPTY-aware: en Windows xterm necesita saber que el backend es ConPTY para detectar bien las
    // líneas ENVUELTAS y NO doble-reflowear al hacer resize (xterm + ConPTY reflowean distinto → el
    // texto viejo se superponía/cortaba tras achicar/agrandar — bug reportado). buildNumber gatea la
    // heurística por versión de Windows. Si no hay build válido NO se setea (no regresiona vs antes).
    var WIN_BUILD = (api && typeof api.winBuild === 'number') ? api.winBuild : 0;
    if (api && api.platform === 'win32' && WIN_BUILD) termOpts.windowsPty = { backend: 'conpty', buildNumber: WIN_BUILD };
    var term = new Terminal(termOpts);
    var fit = new FitNS.FitAddon();
    term.loadAddon(fit);
    // links clickeables: une filas envueltas (la URL de login de claude entra en 3 filas) → abre la URL ENTERA
    // en el navegador del SO. El handler propio sobrescribe el window.open del addon (que la CSP bloquearía).
    try {
      if (WebLinksNS && WebLinksNS.WebLinksAddon) {
        term.loadAddon(new WebLinksNS.WebLinksAddon(function (ev, uri) {
          try { if (api && api.action) api.action('openExternal', { url: uri }).catch(function () {}); } catch (e) {}
        }));
      }
    } catch (e) {}
    term.open(body);
    // RENDER POR GPU (WebGL): el renderer DOM de xterm reconstruye el DOM por frame → con claude (que
    // repinta full-screen en alt-screen) se siente lento/tosco. El addon WebGL dibuja las celdas en la GPU
    // → mucho más fluido. Carga DESPUÉS de term.open (necesita el canvas montado). Si la GPU no está / el
    // contexto se pierde → dispose → xterm vuelve solo al renderer DOM (sin regresión). 100% offline (HR3).
    if (gpuRender) {
      try {
        if (WebglNS && WebglNS.WebglAddon) {
          var wgl = new WebglNS.WebglAddon();
          try { wgl.onContextLoss(function () { try { wgl.dispose(); } catch (e) {} pane._wgl = null; }); } catch (e) {}   // contexto perdido → DOM
          term.loadAddon(wgl);
          pane._gpu = 1;
          pane._wgl = wgl;   // ref para invalidar el texture atlas (ver clearAtlas) cuando cambia la geometría de celda
        }
      } catch (e) { /* WebGL no disponible (GPU vieja/sandbox) → DOM built-in, igual que antes */ }
    }
    // rutas de archivo clickeables: además del addon web-links (URLs), un link provider propio detecta
    // rutas y las abre (click → panel, Ctrl/Cmd+click → editor). Resuelve contra el cwd del panel.
    try {
      if (term.registerLinkProvider) {
        term.registerLinkProvider({ provideLinks: function (y, cb) {
          try {
            var bl = term.buffer.active.getLine(y - 1);   // provideLinks y 1-based; getLine 0-based
            if (!bl) { cb(undefined); return; }
            var spans = findPathSpans(bl.translateToString(true));
            if (!spans.length) { cb(undefined); return; }
            cb(spans.map(function (sp) {
              return {
                range: { start: { x: sp.start + 1, y: y }, end: { x: sp.end, y: y } },   // ILink 1-based, end inclusive
                text: sp.text,
                activate: function (ev) { onPathActivate(ev, sp.text, pane); },
                decorations: { pointerCursor: true, underline: true }
              };
            }));
          } catch (e) { cb(undefined); }
        } });
      }
    } catch (e) {}
    // CTRL+ESPACIO → otra terminal · Ctrl+C/Ctrl+Shift+C copiar (preservando SIGINT) · Ctrl+V/Ctrl+Shift+V pegar
    try {
      term.attachCustomKeyEventHandler(function (ev) {
        // @ PICKER flotante (solo claude): si está abierto, las teclas van al picker (no a claude); el '@'
        // abre el picker y NO se le manda a claude (así su picker inline no corre la pantalla). Suprime en
        // TODOS los tipos de evento (keydown/keypress) para que xterm no cuele el caracter por keypress.
        if (pane.dataset.kind === 'claude') {
          if (pane._atp) {
            // cerrándose por tecla: tragá keypress/keyup de esa tecla (Enter NO debe enviar) → libera en el keyup
            if (pane._atp.ending) { if (ev.type === 'keyup') closeAtPicker(pane); return false; }
            if (ev.type === 'keydown') atKey(pane, ev);
            return false;
          }
          // El '@' SÓLO se intercepta en LÍMITE DE PALABRA (inicio del input o después de un espacio) y con el
          // toggle activo → no roba el '@' de mitad de token (emails/paths "user@host" van crudos a claude). Si
          // no es límite o el toggle está off, dejamos pasar el '@' (xterm lo tipea → claude maneja lo suyo).
          if (floatingPickers && ev.key === '@' && !ev.metaKey && (!pane._inputDirty || pane._lastWasSpace)) { if (ev.type === 'keydown') openAtPicker(pane); return false; }
          // '/' PICKER flotante (slash-commands): mismo motor, datos de comandos. Sólo dispara al INICIO del
          // input (heurística _inputDirty) para no robar el '/' de rutas/URLs/and-or en medio de un prompt.
          if (pane._slp) {
            if (pane._slp.ending) { if (ev.type === 'keyup') closeSlashPicker(pane); return false; }
            if (ev.type === 'keydown') slKey(pane, ev);
            return false;
          }
          if (floatingPickers && ev.key === '/' && !ev.metaKey && !ev.ctrlKey && !ev.altKey && !pane._inputDirty) { if (ev.type === 'keydown') openSlashPicker(pane); return false; }
        }
        // Shift+Enter en claude -> SALTO DE LINEA (no enviar el prompt). xterm.js no distingue Shift+Enter
        // de Enter, asi que se emula. DOS claves para que ande BIEN:
        //  1) suprimir el evento en TODOS sus tipos (keydown/keypress/keyup): si solo gateamos keydown,
        //     xterm igual manda '\r' por la via 'keypress' (charCode 13) -> claude SUBMITEA igual (era el bug).
        //  2) escribir '\n' (un byte) en vez de ESC+CR: claude lo toma como salto de linea SIN el 'escape
        //     timeout' que metia lag y a veces se leia como ESC (cancelar) + CR (enviar).
        // Scopeado a paneles claude: en un shell, Enter sigue ejecutando (mandar esto borraria lo tipeado).
        if ((ev.code === 'Enter' || ev.code === 'NumpadEnter') && ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.metaKey && !ev.isComposing && pane.dataset.kind === 'claude') {
          if (ev.type === 'keydown') {
            var ptid = pane.dataset.tid;
            if (ptid && api.term && api.term.write) api.term.write(ptid, '\n');
          }
          return false;   // keydown + keypress + keyup -> xterm NUNCA manda '\r' por Shift+Enter
        }
        // Alt+V en claude → PEGAR IMAGEN del portapapeles de forma CONFIABLE. claude bindea Alt+V a "pegar
        // imagen", pero su lector en Windows está roto (lee BMP y su sharp-WASM no lo decodifica → falla a la
        // 1ª; pasa igual en Warp). En vez de reenviar la tecla, Consomni lee la imagen, la guarda como PNG
        // temporal y le pasa la RUTA por bracketed paste → claude la convierte en [Image #N], a la 1ª, siempre.
        // Sin imagen en el portapapeles → reenvía ESC v (comportamiento de siempre). Suprime el ESC v de xterm
        // en TODOS los tipos de evento (como Shift+Enter); el trabajo sólo va en keydown.
        if (ev.altKey && !ev.ctrlKey && !ev.metaKey && ev.code === 'KeyV' && pane.dataset.kind === 'claude') {
          if (ev.type === 'keydown') {
            pane._pasteGuard = Date.now();   // por las dudas, que un paste nativo no se cuele
            pasteClipImage(term, pane).then(function (didImage) {
              if (!didImage) { try { var vtid = pane.dataset.tid; if (vtid) api.term.write(vtid, '\x1bv'); } catch (e) {} }
            });
          }
          return false;
        }
        if (ev.type !== 'keydown') return true;
        // heurística para el picker de '/': el input está "sucio" si tipeaste algo desde el último Enter/Ctrl+C/Ctrl+U.
        // (las teclas interceptadas arriba —pickers, Shift+Enter— ya hicieron return; acá sólo pasan las que van a claude)
        if (pane.dataset.kind === 'claude') {
          if (ev.code === 'Enter' && !ev.shiftKey) { pane._inputDirty = false; pane._lastWasSpace = false; }
          else if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && (ev.code === 'KeyC' || ev.code === 'KeyU')) { pane._inputDirty = false; pane._lastWasSpace = false; }
          else if (ev.key && ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) { pane._inputDirty = true; pane._lastWasSpace = (ev.key === ' '); }
        }
        // AUTOSUGGEST (ghost text, sólo SHELL): trackea el buffer sombra y, si aceptás la sugerencia, consume la tecla
        if (pane.dataset.kind === 'shell' && shellAutosuggestKey(pane, ev)) return false;
        if (ev.ctrlKey && ev.code === 'Space') { if (quickTermHook) quickTermHook(); return false; }
        // Ctrl+W: cierra ESTA terminal (la enfocada, donde está el cursor). Pisa el "borrar palabra" del
        // shell a propósito (pedido del usuario); si es una terminal VIVA, closePane pide confirmación.
        // Diferido un tick: closePane puede disponer el xterm, y estamos DENTRO de su propio keydown.
        if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && !ev.metaKey && ev.code === 'KeyW') { setTimeout(function () { closePane(pane); }, 0); return false; }
        // Ctrl+Z en claude → DESHACER: claude bindea su undo a ctrl+_ (manda \x1f); le mandamos eso. xterm/shell
        // por defecto mandaría \x1a (suspend, inútil en la PTY embebida). Scopeado a claude (en shell, dejar pasar).
        if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && !ev.metaKey && ev.code === 'KeyZ' && pane.dataset.kind === 'claude') {
          var ztid = pane.dataset.tid; if (ztid && api.term && api.term.write) api.term.write(ztid, '\x1f'); return false;
        }
        // Ctrl+A en claude → SELECCIONAR todo el input que escribiste (a nivel xterm; la TUI de claude NO tiene
        // selección de su input — verificado: su Ctrl+A es "inicio de línea", que queda en Home). Luego Ctrl+C copia.
        if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && !ev.metaKey && ev.code === 'KeyA' && pane.dataset.kind === 'claude') {
          if (selectClaudeInput(term)) return false;   // seleccionó el input → consumir
          return true;                                  // input vacío / sin prompt → dejar pasar (claude: inicio de línea)
        }
        if (ev.ctrlKey && ev.shiftKey && ev.code === 'KeyC') { termCopy(term); return false; }              // copiar siempre
        if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && ev.code === 'KeyC') {
          if (termCopy(term)) return false;   // había selección → copió + limpió → no mandar nada
          return true;                        // sin selección → la shell recibe SIGINT (\x03)
        }
        if (ev.ctrlKey && ev.code === 'KeyV') {                                  // pegar (Ctrl+V/Ctrl+Shift+V); guard + listener de captura matan el paste NATIVO de xterm → NUNCA se duplica (ver de-dup abajo)
          pane._pasteGuard = Date.now(); ev.preventDefault();
          // en claude: si hay IMAGEN en el portapapeles, pegala (ruta→[Image #N]); si no, pegá TEXTO. En shell: sólo texto.
          if (pane.dataset.kind === 'claude') { pasteClipImage(term, pane).then(function (didImage) { if (!didImage) termPaste(term); }); }
          else termPaste(term);
          return false;
        }
        return true;
      });
    } catch (e) {}
    // OSC 52 ("c to copy" / copy automático de la TUI): SACADO a propósito (pedido del usuario). Hacía que
    // seleccionar/copiar en la terminal PISARA el portapapeles del usuario sin que él lo pidiera. Ahora la
    // terminal NUNCA escribe el clipboard sola; se copia SOLO con Ctrl+C / Ctrl+Shift+C / menú contextual
    // "Copiar" (seleccionar texto + Ctrl+C sigue funcionando vía termCopy).
    // cwd EN VIVO (cd tracking): el shell puede emitir OSC 7 (file://host/path) u OSC 9;9 (path) en cada
    // prompt → actualizamos pane.dataset.cwd para que "clonar la terminal activa" (Ctrl+Espacio) y las
    // rutas clickeables tomen el directorio REAL. Si el shell no lo emite, queda el cwd de arranque (no rompe nada).
    try {
      term.parser.registerOscHandler(7, function (data) {
        try {
          var m = String(data || '').match(/^file:\/\/[^/]*(\/.*)$/);
          if (m) { var pth = decodeURIComponent(m[1]).replace(/^\/([A-Za-z]:)/, '$1'); if (/^[A-Za-z]:/.test(pth)) pth = pth.replace(/\//g, '\\'); if (pth) updatePaneCwd(pane, pth); }
        } catch (e) {}
        return true;
      });
      term.parser.registerOscHandler(9, function (data) {
        try { var s = String(data || ''); if (s.slice(0, 2) === '9;') { var pth = s.slice(2).trim(); if (pth) updatePaneCwd(pane, pth); } } catch (e) {}
        return true;
      });
    } catch (e) {}
    // DE-DUP de PEGADO (la terminal tiene que andar PERFECTO): xterm tiene su PROPIO handler de 'paste'
    // que TAMBIÉN escribe el bracketed-paste a la PTY (verificado por test). Nuestro Ctrl+V hace
    // preventDefault para matarlo, pero eso es frágil: si el paste nativo igual se cuela, claude recibe
    // el MISMO paste DOS veces → colapsa con el 1º y el 2º (idéntico) lo EXPANDE → se ve "[...] paste again
    // to expand" con el texto entero (= el bug reportado). Guard en CAPTURA: si nuestro paste
    // acaba de correr, tragamos el paste nativo → claude recibe UNO solo → colapsa y queda colapsado.
    // Sin guard reciente (pegar por menú del SO sobre el textarea) dejamos pasar el nativo (no rompe nada).
    try { body.addEventListener('paste', function (ev) {
      if (pane._pasteGuard && (Date.now() - pane._pasteGuard) < 400) { ev.preventDefault(); ev.stopImmediatePropagation(); }
    }, true); } catch (e) {}
    // menú contextual (click derecho): si está sobre una ruta → acciones de archivo; siempre copiar/pegar/seleccionar
    try { body.addEventListener('contextmenu', function (ev) { ev.preventDefault(); showTermCtx(ev.clientX, ev.clientY, term, ev, pane); }); } catch (e) {}

    // RESIZE ATÓMICO: el ResizeObserver y fonts.ready ahora empujan fit+sync al PTY (no sólo el fit del
    // xterm) → el PTY nunca queda más chico que las filas visibles (raíz del "input flotando").
    pane._ptySize = '';   // se siembra al crear el PTY; pushPty dedupea por dims para no spamear SIGWINCH
    var ro = null;
    if (g.ResizeObserver) { ro = new g.ResizeObserver(function () { syncTerm(term, fit, pane); }); ro.observe(body); }
    if (g.document && g.document.fonts && g.document.fonts.ready) g.document.fonts.ready.then(function () { syncTerm(term, fit, pane); });

    requestAnimationFrame(function () {
      // hidden mount: NO medir (proposeDimensions daría NaN) → el PTY nace en 80x24 y se corrige al mostrarse
      if (pane.offsetParent !== null) { try { fit.fit(); } catch (e) {} }
      var bootCols = term.cols || 80, bootRows = term.rows || 24;
      var fsOpt = (kind === 'claude') ? (pane.dataset.fullscreen === '1') : undefined;   // claude: modo elegido; shell: undefined → default global
      api.term.create({ cwd: cwd, kind: kind, cols: bootCols, rows: bootRows, resume: resume, skip: skip, pick: pick, fullscreen: fsOpt }).then(function (res) {
        if (!res || !res.ok) { term.write('\r\n  \x1b[31m' + ((res && res.error) || 'no se pudo abrir') + '\x1b[0m\r\n'); return; }
        pane.dataset.tid = res.id;
        pane.dataset.cwd = res.cwd || cwd || '';
        pane._ptySize = bootCols + 'x' + bootRows;   // el PTY nació con estas dims (último empuje conocido)
        terms.set(res.id, { term: term, fit: fit, pane: pane, ro: ro });
        setPaneMeta(pane, ic, res.title || (kind === 'claude' ? 'claude' : 'shell'), projLabel(pane));
        term.onData(function (d) { api.term.write(res.id, d); });
        term.onResize(function (sz) { pushPty(pane, res.id, sz.cols, sz.rows); });   // resize genuino (drag/ventana) → al PTY
        // AUTOSUGGEST (shell): reposicionar el ghost al cursor real tras cada render (el echo del shell llega
        // async). Si la fila del cursor SALTÓ (output) → ocultar (la línea se movió; el próximo keystroke recomputa).
        if (kind === 'shell') {
          try { term.onRender(function () {
            if (!pane._sgGhostVisible) return;
            var cy; try { cy = term.buffer.active.cursorY; } catch (e) { cy = pane._sgCursorY; }
            if (pane._sgCursorY != null && Math.abs(cy - pane._sgCursorY) > 1) { hideShellGhost(pane); return; }
            placeShellGhost(pane, term);
          }); } catch (e) {}
          try { if (term.textarea) term.textarea.addEventListener('blur', function () { hideShellGhost(pane); }); } catch (e) {}
        }
        if (rootEl.contains(pane)) { try { term.focus(); } catch (e) {} }
        syncTerm(term, fit, pane);                                   // EMPUJE ATÓMICO post-create: corrige el race de montaje (fit no-op igual empuja)
        requestAnimationFrame(function () { syncTerm(term, fit, pane); });   // captura el crecimiento por fuentes / asentamiento del layout
        persist();
      }).catch(function () { term.write('\r\n  \x1b[31mfalló el IPC\x1b[0m\r\n'); });
    });
  }

  /* ── helper "comando por lenguaje natural" (tipo Warp `#`) ──
     Barra inline sobre la terminal: escribís en castellano, claude LOCAL lo
     traduce a UN comando y se INSERTA en la PTY (sin \r) → el usuario revisa
     y aprieta Enter. NUNCA auto-ejecuta (toda la seguridad está en el insert). */
  function setNlEnabled() { /* el feature ahora es SIEMPRE visible (ver CSS .dk-ask-btn); no-op por compat */ }
  // insertar texto en la PTY SIN \r (insert-don't-exec): el usuario revisa y aprieta Enter
  function insertCmd(pane, text) {
    var tid = pane.dataset.tid;
    if (tid && api && api.term && api.term.write) api.term.write(tid, text);
    // el autosuggest tipea SOMBRA por keydown; un insert programático mete texto que la sombra NO conoce →
    // marcar la línea como NO confiable (sin sugerencia hasta el próximo Enter/Ctrl+C) para no aceptar un sufijo desfasado y corromper la línea
    pane._sgTrusted = false; if (pane._sgGhost) hideShellGhost(pane);
    var t = terms.get(tid); if (t) { try { t.term.focus(); } catch (e) {} }
  }
  // insertar texto (un prompt de la biblioteca) en la terminal/claude enfocada (o la 1ª viva),
  // SIN \r → el usuario revisa y aprieta Enter. Trae el dock a la vista. Devuelve false si no
  // hay ninguna terminal abierta (el caller avisa "abrí una terminal").
  function insertIntoFocused(text) {
    if (text == null) return false;
    var isTerm = function (p) { return p && (p.dataset.kind === 'shell' || p.dataset.kind === 'claude'); };
    var pane = (isTerm(focused) && rootEl && rootEl.contains(focused)) ? focused : (panesOf().filter(isTerm)[0] || null);
    if (!pane) return false;
    show();                 // el dock pudo quedar minimizado/oculto (vista biblioteca) → mostrarlo
    setFocus(pane);
    insertCmd(pane, String(text));
    return true;
  }
  // abre "comandos rápidos" en la terminal enfocada (o la 1ª, o spawnea una)
  function openQuickCommands() {
    ensureDock(); show();
    var isTerm = function (p) { return p && (p.dataset.kind === 'shell' || p.dataset.kind === 'claude'); };
    var pane = (isTerm(focused) && rootEl.contains(focused)) ? focused : panesOf().filter(isTerm)[0];
    if (pane) { setFocus(pane); var ex = pane.querySelector('.dk-ask'); if (ex) { var i = ex.querySelector('.dk-ask-inp'); if (i) i.focus(); } else toggleAsk(pane); return; }
    spawn('shell');
    setTimeout(function () { var np = panesOf().filter(isTerm)[0]; if (np) toggleAsk(np); }, 450);
  }
  function toggleAsk(pane) {
    var kind = pane.dataset.kind;
    if (kind !== 'shell' && kind !== 'claude') { notifier('los comandos rápidos son para terminales', 'warn'); return; }
    var existing = pane.querySelector('.dk-ask');
    if (existing) { existing.remove(); refitAll(); return; }
    var bar = document.createElement('div');
    bar.className = 'dk-ask';
    var chips = ASK_PRESETS.map(function (p, i) { return '<button class="dk-preset" data-pi="' + i + '">' + esc(p.label) + '</button>'; }).join('');
    bar.innerHTML =
      '<div class="dk-ask-row">' +
        '<span class="dk-ask-ic">' + svg('dispatch', 13, 1.8) + '</span>' +
        '<input class="dk-ask-inp" placeholder="describí lo que querés y lo traduce tu claude… (ej: borrar todos los .log)" spellcheck="false">' +
        '<button class="dk-ask-go" title="traducir con tu claude local (~5s, usa tu uso de claude)">' + svg('enter', 12, 2) + ' traducir</button>' +
        '<button class="dk-ask-x" title="cerrar (Esc)">' + svg('x', 12, 2) + '</button>' +
      '</div>' +
      '<div class="dk-ask-presets">' + chips +
        '<span class="dk-ask-msg">se INSERTA, no se ejecuta · revisás y Enter</span>' +
      '</div>';
    var head = pane.querySelector('.dk-pane-head');
    pane.insertBefore(bar, head.nextSibling);
    var inp = bar.querySelector('.dk-ask-inp'), go = bar.querySelector('.dk-ask-go'), msg = bar.querySelector('.dk-ask-msg');
    function close() { bar.remove(); refitAll(); var t = terms.get(pane.dataset.tid); if (t) { try { t.term.focus(); } catch (e) {} } }
    function run() {
      var q = (inp.value || '').trim();
      if (!q) { inp.focus(); return; }
      if (!api || !api.term || !api.term.nl) { msg.textContent = 'no disponible'; msg.className = 'dk-ask-msg err'; return; }
      bar.classList.add('busy'); go.disabled = true; inp.disabled = true; msg.className = 'dk-ask-msg'; msg.textContent = 'traduciendo con tu claude… (~5s)';
      api.term.nl(q, pane.dataset.cwd || undefined).then(function (r) {
        bar.classList.remove('busy'); go.disabled = false; inp.disabled = false;
        if (!r || !r.ok) { msg.textContent = (r && r.error) || 'no se pudo'; msg.className = 'dk-ask-msg err'; try { inp.focus(); } catch (e) {} return; }
        insertCmd(pane, r.command);   // SIN \r → insertar; revisás y Enter vos
        notifier('comando insertado · revisá y apretá Enter');
        close();
      }).catch(function () { bar.classList.remove('busy'); go.disabled = false; inp.disabled = false; msg.textContent = 'error'; msg.className = 'dk-ask-msg err'; });
    }
    // presets: cmd = determinista (inserta al toque, gratis) · q = prellena el input (IA)
    bar.querySelector('.dk-ask-presets').addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('.dk-preset'); if (!b) return;
      e.stopPropagation();
      var p = ASK_PRESETS[+b.getAttribute('data-pi')]; if (!p) return;
      if (p.cmd) { insertCmd(pane, p.cmd); notifier('comando insertado · revisá y apretá Enter'); close(); }
      else { inp.value = p.q || ''; inp.focus(); try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch (e2) {} }
    });
    go.addEventListener('click', function (e) { e.stopPropagation(); run(); });
    bar.querySelector('.dk-ask-x').addEventListener('click', function (e) { e.stopPropagation(); close(); });
    inp.addEventListener('keydown', function (e) { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); run(); } else if (e.key === 'Escape') { e.preventDefault(); close(); } });
    refitAll();
    setTimeout(function () { try { inp.focus(); } catch (e) {} }, 0);
  }

  /* ── panel de SESIÓN ── */
  function openSession(sid, name, proj, projName, cwd) {
    ensureDock(); bindSnap(); show();
    var ex = sessions.get(sid);
    if (ex) {
      if (cwd && !ex.dataset.cwd) ex.dataset.cwd = cwd;
      if (!rootEl.contains(ex)) { if (proj && !ex.dataset.proj) ex.dataset.proj = proj; if (projName && !ex.dataset.projname) ex.dataset.projname = projName; if (view === '__home__') ex.dataset.pinned = '1'; showView(view); }
      setFocus(ex); renderSession(ex); return;
    }
    var pane = makePaneShell('session');
    if (proj) pane.dataset.proj = proj;
    if (projName) pane.dataset.projname = projName;
    if (cwd) pane.dataset.cwd = cwd;
    if (view === '__home__') pane.dataset.pinned = '1';   // abierta desde inicio → aparece en inicio
    placeContent(pane, 'right');
    mountSession(pane, sid, name, proj, cwd);
    persist();
  }

  // "responder": convierte el panel de sesión ABIERTO (si existe) en una terminal claude --resume
  // interactiva, EN EL MISMO panel (no abre uno nuevo). Sin panel abierto → abre una terminal nueva.
  // opts.skip → claude --resume <id> --dangerously-skip-permissions (continúa ESA sesión sin permisos).
  function resumeSession(sid, cwd, opts) {
    if (!Terminal) { notifier('xterm no cargó', 'err'); return; }
    if (!api || !api.term) { notifier('terminales no disponibles', 'err'); return; }
    var rid = String(sid || '').replace(/[^A-Za-z0-9_-]/g, '');   // se tipea en el shell → sanitizar
    if (!rid) { notifier('id de sesión inválido', 'err'); return; }
    var skip = !!(opts && opts.skip);
    ensureDock(); bindIpc(); show();
    var pane = sessions.get(sid);
    if (pane) {
      sessions.delete(sid);
      pane.removeAttribute('data-sid'); pane.removeAttribute('data-sname');
      if (!rootEl.contains(pane)) showView(view);                 // por si estaba en el pool
      mountTerminal(pane, 'claude', cwd || pane.dataset.cwd || undefined, rid, skip);
      setFocus(pane); persist();
      return;
    }
    spawn('claude', cwd, null, { resume: rid, skip: skip });      // sin panel abierto → nueva terminal
  }

  // monta la conversación read-only dentro de un panel YA colocado
  function mountSession(pane, sid, name, proj, cwd) {
    pane.classList.remove('dk-pane--shell', 'dk-pane--claude');
    pane.classList.add('dk-pane--session');
    pane.dataset.kind = 'session';
    pane.dataset.sid = sid;
    pane.dataset.sname = name || 'sesión';
    if (proj) pane.dataset.proj = proj;
    if (cwd) pane.dataset.cwd = cwd;   // para resolver rutas clickeables en la conversación
    setPaneMeta(pane, svg('eye', 12, 1.8), name || 'sesión', projLabel(pane));
    updatePinUI(pane);
    var body = pane.querySelector('.dk-pane-body');
    body.innerHTML =
      '<div class="dk-shead">' +
        '<span class="dk-sactions">' +
          '<button class="btn btn--sm btn--green" data-dock-act="resume" data-sid="' + esc(sid) + '" title="continuar ESTA conversación de forma interactiva (claude --resume)">' + svg('reply', 11, 2) + ' responder</button>' +
          '<button class="btn btn--sm" data-dock-act="resume-skip" data-sid="' + esc(sid) + '" title="continuar ESTA conversación SIN permisos (claude --resume --dangerously-skip-permissions)">' + svg('dispatch', 11, 2) + ' claude ⚡</button>' +
          '<button class="btn btn--sm" data-dock-act="term" data-sid="' + esc(sid) + '">' + svg('term', 11, 2) + ' terminal</button>' +
          '<button class="btn btn--sm" data-dock-act="ext" data-sid="' + esc(sid) + '">' + svg('ext', 11, 2) + ' VSCode</button>' +
          '<button class="btn btn--sm" data-dock-act="detail" data-sid="' + esc(sid) + '">detalle</button>' +
        '</span>' +
      '</div>' +
      '<div class="dk-convo"><div class="dk-empty">cargando conversación…</div></div>';
    body.querySelector('.dk-sactions').addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-dock-act]');
      if (b) { e.stopPropagation(); actionHandler(b.getAttribute('data-dock-act'), b.getAttribute('data-sid')); }
    });
    // rutas clickeables dentro de la conversación: click → panel, Ctrl/Cmd → editor, click derecho → menú
    var convo = body.querySelector('.dk-convo');
    convo.addEventListener('click', function (e) {
      var f = e.target.closest && e.target.closest('.cv-file'); if (!f) return;
      e.preventDefault(); e.stopPropagation();
      var p = f.getAttribute('data-path'), cw = pane.dataset.cwd || '';
      if (e.ctrlKey || e.metaKey) openFileEditor(p, cw); else openFilePanel(p, cw);
    });
    convo.addEventListener('contextmenu', function (e) {
      var f = e.target.closest && e.target.closest('.cv-file'); if (!f) return;
      e.preventDefault(); e.stopPropagation();
      showFileCtx(e.clientX, e.clientY, f.getAttribute('data-path'), pane.dataset.cwd || '');
    });
    sessions.set(sid, pane);
    renderSession(pane);
  }

  function renderSession(pane) {
    var convoEl = pane.querySelector('.dk-convo'); var sid = pane.dataset.sid;
    if (!convoEl || !sid || !api || !api.getSessionDetail) return;
    api.getSessionDetail(sid).then(function (d) {
      if (!d || !convoEl.isConnected) return;
      var convo = d.convo || [];
      var atBottom = (convoEl.scrollHeight - convoEl.scrollTop - convoEl.clientHeight) < 40;
      if (!convo.length) {
        convoEl.innerHTML = '<div class="dk-empty">Esta sesión no tiene mensajes en el transcript todavía (o es solo-hook).<br>Tocá <b>responder</b> para continuar la conversación de forma interactiva (claude --resume).</div>';
        return;
      }
      var cwd = pane.dataset.cwd || '';
      convoEl.innerHTML = convo.map(function (turn) {
        var who = turn.role === 'user' ? 'tú' : 'claude';
        return '<div class="cv-turn cv-' + turn.role + '"><span class="cv-who">' + who + '</span>' +
          '<div class="cv-text">' + linkifyPaths(esc(turn.text), cwd) + '</div></div>';
      }).join('');
      if (atBottom) convoEl.scrollTop = convoEl.scrollHeight;
    }).catch(function () {});
  }

  /* ── drag de divisores (resize) ── */
  function wireSplitterDrag() {
    rootEl.addEventListener('mousedown', function (e) {
      var sp = e.target.closest && e.target.closest('.dk-splitter');
      if (!sp) return;
      e.preventDefault();
      var split = sp.parentNode, row = split.classList.contains('row');
      var prev = sp.previousElementSibling, next = sp.nextElementSibling;
      if (!prev || !next) return;
      // Normalizar TODOS los hermanos a su tamaño ACTUAL en px como flex-grow (basis 0). Si no,
      // los que no se tocan mantienen grow:1 y frente a un grow grande se colapsan a ~0.
      // OJO: medir TODO primero y recién después escribir (si no, cada set reflowea y el read se distorsiona).
      var sibs = elemChildren(split).filter(function (c) { return !c.classList.contains('dk-splitter'); });
      var sizes = sibs.map(function (c) { var r = c.getBoundingClientRect(); return row ? r.width : r.height; });
      sibs.forEach(function (c, i) { c.style.flex = sizes[i] + ' 1 0'; });
      var pr = prev.getBoundingClientRect(), nr = next.getBoundingClientRect();
      var start = row ? e.clientX : e.clientY;
      var ps = row ? pr.width : pr.height, ns = row ? nr.width : nr.height, total = ps + ns;
      function move(ev) {
        var d = (row ? ev.clientX : ev.clientY) - start;
        var np = Math.max(70, Math.min(total - 70, ps + d));
        prev.style.flex = np + ' 1 0'; next.style.flex = (total - np) + ' 1 0'; liveFit();
      }
      function up() { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); document.body.style.userSelect = ''; persist(); }
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
    });
  }

  /* ── drag de un PANEL (de su barra) a un borde de otro → reubicar ── */
  function clearInd() { if (dropInd) dropInd.style.display = 'none'; }
  function showInd(tgt, zone, r) {
    var hr = host.getBoundingClientRect();
    var x = r.left - hr.left, y = r.top - hr.top, w = r.width, h = r.height;
    if (zone === 'left') { w = r.width / 2; }
    else if (zone === 'right') { x += r.width / 2; w = r.width / 2; }
    else if (zone === 'top') { h = r.height / 2; }
    else if (zone === 'bottom') { y += r.height / 2; h = r.height / 2; }
    dropInd.style.display = 'block';
    dropInd.style.left = x + 'px'; dropInd.style.top = y + 'px';
    dropInd.style.width = w + 'px'; dropInd.style.height = h + 'px';
  }
  function wirePaneDrag() {
    rootEl.addEventListener('mousedown', function (e) {
      var head = e.target.closest && e.target.closest('.dk-pane-head');
      if (!head || (e.target.closest && e.target.closest('.dk-pbtn'))) return;
      var pane = head.closest('.dk-pane'); if (!pane) return;
      if (host.classList.contains('minimized')) return;
      e.preventDefault();   // evita que el drag seleccione texto
      var sx = e.clientX, sy = e.clientY, started = false, drag = null;
      function move(ev) {
        if (!started) { if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 6) return; started = true; document.body.classList.add('dk-dragging'); document.body.style.userSelect = 'none'; pane.classList.add('dragging'); }
        var el = document.elementFromPoint(ev.clientX, ev.clientY);
        var tgt = el && el.closest ? el.closest('.dk-pane') : null;
        clearInd(); drag = null;
        if (tgt && tgt !== pane && rootEl.contains(tgt)) {
          var r = tgt.getBoundingClientRect();
          var rx = (ev.clientX - r.left) / r.width, ry = (ev.clientY - r.top) / r.height;
          var zone = rx < 0.28 ? 'left' : rx > 0.72 ? 'right' : ry < 0.28 ? 'top' : ry > 0.72 ? 'bottom' : 'center';
          if (zone !== 'center') { showInd(tgt, zone, r); drag = { target: tgt, zone: zone }; }
        }
      }
      function up() {
        document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up);
        document.body.classList.remove('dk-dragging'); document.body.style.userSelect = ''; pane.classList.remove('dragging'); clearInd();
        if (started && drag && drag.target !== pane) { detachPane(pane); insertPaneAt(drag.target, pane, drag.zone); setFocus(pane); refitAll(); persist(); }
      }
      document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
    });
  }

  /* ── drag del borde superior (alto del dock) ── */
  function wireDockResize() {
    host.querySelector('.dk-resize').addEventListener('mousedown', function (e) {
      if (host.classList.contains('maximized') || host.classList.contains('minimized')) return;
      e.preventDefault();
      var startY = e.clientY, startH = host.getBoundingClientRect().height;
      function move(ev) {
        var h = Math.max(160, Math.min(window.innerHeight * 0.92, startH + (startY - ev.clientY)));
        document.documentElement.style.setProperty('--dock-h', h + 'px'); liveFit();
      }
      function up() { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); document.body.style.userSelect = ''; refitAll(); persist(); }
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
    });
  }

  /* ── fit · RESIZE ATÓMICO (single source of truth de dimensiones) ──
     El bug del "input flotando en el medio" era un DESYNC PTY↔xterm: el PTY se sincronizaba SÓLO como
     efecto de term.onResize, que dispara únicamente cuando CAMBIAN las dims de xterm. addon-fit.fit()
     es no-op cuando las dims propuestas == las actuales → un fit no-op NUNCA empujaba al PTY. Así el
     PTY podía quedar con MENOS filas que las visibles y, como ningún fit posterior cambiaba xterm,
     el desync quedaba pegado. Claude/Ink lee process.stdout.rows (= filas del PTY) para anclar su
     bloque inferior; con pty.rows < visibles ancla el "fondo" muy arriba → al reimprimir un frame más
     corto in-place el input queda en el medio con filas vacías debajo. syncTerm hace fit + LEE las
     dims REALES de xterm + las empuja al PTY SIEMPRE (idempotente), cerrando el desync en su raíz. */
  var fitTimer = null, liveRaf = null;
  function nearBottom(term) { try { var b = term.buffer.active; return (b.baseY - b.viewportY) <= 1; } catch (e) { return true; } }
  // empuje al PTY con dedupe por dims (evita SIGWINCH redundante: onResize + syncTerm + drags por frame)
  // + DEBOUNCE (80ms): durante un drag llegan decenas de dims por frame; ConPTY se corrompe con resizes
  // rápidos (truncado/overlap). El fit de xterm sigue EN VIVO (visual); al PTY le mandamos sólo la ÚLTIMA
  // dimensión cuando el drag se asienta. 80ms es imperceptible y deja a claude re-anclar el alt-screen rápido.
  function pushPty(pane, tid, cols, rows) {
    if (!tid || !api || !api.term || !api.term.resize || !(cols > 0) || !(rows > 0)) return;
    var key = cols + 'x' + rows;
    if (pane._ptySize === key) return;   // el PTY ya está en estas dims → no re-empujar
    pane._ptySize = key;
    if (pane._ptyResizeT) clearTimeout(pane._ptyResizeT);
    pane._ptyResizeT = setTimeout(function () {
      pane._ptyResizeT = null;
      try { api.term.resize(tid, cols, rows); } catch (e) {}
    }, 80);
  }
  // fit del xterm + empuje ATÓMICO al PTY de sus dims REALES (no de proposeDimensions, que es unclamped
  // y NaN si está oculto). Salta paneles ocultos (offsetParent null): ahí fit() es no-op por NaN y
  // term.cols/rows quedarían STALE → empujarlas desincronizaría. Re-ancla al fondo SÓLO si el usuario
  // ya estaba al fondo (respeta el scroll hacia arriba intencional → no lo saca de la historia).
  // invalida el TEXTURE ATLAS del renderer WebGL: el addon cachea los glifos por geometría de celda; si la
  // geometría cambia (resize, carga de fuente async, panel que vuelve del pool, cambio de tema) y el atlas NO
  // se purga, dibuja glifos viejos en posiciones nuevas → letras dobladas/mezcladas ("RReadback"/"EEditar").
  // No-op (try/catch) si el panel está en renderer DOM o el addon ya se disposó por context-loss.
  function clearAtlas(pane) {
    try { if (pane && pane._wgl && pane._wgl.clearTextureAtlas) pane._wgl.clearTextureAtlas(); } catch (e) {}
  }
  function syncTerm(term, fit, pane) {
    if (!term || !fit || !pane || pane.offsetParent === null) return;
    var wasBottom = nearBottom(term);
    try { fit.fit(); } catch (e) {}
    pushPty(pane, pane.dataset.tid, term.cols || 0, term.rows || 0);
    clearAtlas(pane);   // tras cualquier fit/reflow → purgá el atlas WebGL para que no queden glifos desfasados
    if (wasBottom) { try { term.scrollToBottom(); } catch (e) {} }
    if (pane._sgGhostVisible) placeShellGhost(pane, term);   // autosuggest: el cursor se movió con el resize → reubicar el ghost
  }
  function refitSoon() { if (fitTimer) cancelAnimationFrame(fitTimer); fitTimer = requestAnimationFrame(function () { fitTimer = requestAnimationFrame(refitAll); }); }
  // fit por frame durante un drag (reflow EN VIVO; el ResizeObserver llega tarde)
  function liveFit() { if (liveRaf) cancelAnimationFrame(liveRaf); liveRaf = requestAnimationFrame(function () { liveRaf = null; refitAll(); }); }
  // único choke point de refit → todos los paths (RO, ventana, drag, show/restore/maximize, showView,
  // minimize/restore, ask-bar) pasan por el empuje atómico. Los ocultos los saltea syncTerm.
  function refitAll() { terms.forEach(function (t) { try { syncTerm(t.term, t.fit, t.pane); } catch (e) {} }); }

  /* ── estados: show / minimize / restore / maximize / home / hide ── */
  function show() {
    ensureDock(); if (!host) return;
    host.hidden = false; host.classList.remove('minimized');
    document.body.classList.add('dock-open'); document.body.classList.remove('dock-min');
    notifyMax(); refitSoon();
  }
  function minimize() { ensureDock(); if (!host || host.hidden) return; host.classList.remove('maximized'); host.classList.add('minimized'); document.body.classList.add('dock-min'); notifyMax(); persist(); }
  function restore() { ensureDock(); host.classList.remove('minimized'); host.hidden = false; document.body.classList.add('dock-open'); document.body.classList.remove('dock-min'); notifyMax(); refitSoon(); persist(); }
  function toggleMin() { if (host.classList.contains('minimized')) restore(); else minimize(); }
  function toggleMax() { ensureDock(); host.classList.remove('minimized'); document.body.classList.remove('dock-min'); host.classList.toggle('maximized'); notifyMax(); refitSoon(); persist(); }
  function hide() { if (!host) return; host.hidden = true; host.classList.remove('maximized', 'minimized'); document.body.classList.remove('dock-open', 'dock-min'); notifyMax(); }
  function home() {
    ensureDock(); bindIpc();
    view = '__home__'; viewCwd = ''; viewName = '';
    showView('__home__');
    host.hidden = false; host.classList.remove('minimized'); host.classList.add('maximized');
    document.body.classList.add('dock-open'); document.body.classList.remove('dock-min');
    notifyMax(); refitSoon();
  }
  function toggle() {
    if (!isOpen()) { ensureDock(); show(); showView(view); }
    else if (host.classList.contains('minimized')) restore();
    else minimize();
  }
  function isOpen() { return !!host && !host.hidden; }
  function count() { return terms.size + sessions.size; }
  function refreshActive() { sessions.forEach(function (pane) { if (rootEl && rootEl.contains(pane)) renderSession(pane); }); }
  /* ── tour de novedades: demo efímera para que la barra de sesiones (F6) y el botón cd (F4) sean
     highlights REALES. Abre UNA shell sólo si no hay ninguna visible; tagueada y excluida de la persistencia. ── */
  function openTourDemo() {
    ensureDock(); bindIpc(); show();
    view = '__home__'; viewCwd = ''; viewName = '';
    showView('__home__');
    host.hidden = false; host.classList.remove('minimized'); host.classList.add('maximized');
    document.body.classList.add('dock-open'); document.body.classList.remove('dock-min');
    notifyMax();
    var hasShell = allPanes().some(function (p) { return p.dataset.kind === 'shell' && p.dataset.min !== '1' && matchesView(p, '__home__'); });
    if (hasShell) { refitSoon(); return false; }
    spawn('shell');                                   // shell en el HOME del usuario (cwd vacío → HOME)
    if (focused) focused.dataset.tourDemo = '1';
    refitSoon();
    return true;
  }
  function closeTourDemo() {
    allPanes().forEach(function (p) { if (p.dataset.tourDemo === '1') doClosePane(p); });   // cierre directo (sin modal de confirmación)
  }
  function setNotifier(fn) { if (typeof fn === 'function') notifier = fn; }
  function setActionHandler(fn) { if (typeof fn === 'function') actionHandler = fn; }
  function setMaxObserver(fn) { if (typeof fn === 'function') maxObserver = fn; }
  function setBoardChecker(fn) { if (typeof fn === 'function') boardChecker = fn; }
  function setEditorOpener(fn) { if (typeof fn === 'function') editorOpener = fn; }
  function setQuickTermHook(fn) { if (typeof fn === 'function') quickTermHook = fn; }
  function setHomeProjects(fn) { if (typeof fn === 'function') homeProjects = fn; }

  var rt = null;
  window.addEventListener('resize', function () { if (isOpen()) { if (rt) clearTimeout(rt); rt = setTimeout(refitAll, 120); } });

  g.ConsomniTerms = {
    spawn: spawn, open: function (o) { o = o || {}; spawn(o.kind === 'claude' ? 'claude' : 'shell', o.cwd, null, { resume: o.resume, skip: o.skip, pick: o.pick, proj: o.proj, projName: o.projName }); },
    openSession: openSession, show: show, hide: hide, minimize: minimize, restore: restore,
    toggle: toggle, home: home, setView: setView, openProject: openProject,
    isOpen: isOpen, count: count, refreshActive: refreshActive,
    setNotifier: setNotifier, setActionHandler: setActionHandler, setMaxObserver: setMaxObserver,
    restoreSession: restoreSession, isMaximized: isMaximized, getView: function () { return view; },
    resumeSession: resumeSession, setBoardChecker: setBoardChecker, setCloseConfirmer: setCloseConfirmer,
    setNlEnabled: setNlEnabled, insertIntoFocused: insertIntoFocused,
    setEditorOpener: setEditorOpener, setQuickTermHook: setQuickTermHook,
    setHomeProjects: setHomeProjects,
    setClaudeFullscreenDefault: setClaudeFullscreenDefault,
    setGpuRender: setGpuRender, setFloatingPickers: setFloatingPickers, hasActiveClaudeSessions: hasActiveClaudeSessions,
    setAutosuggest: setAutosuggest, setAutosuggestRebinder: setAutosuggestRebinder,
    openTourDemo: openTourDemo, closeTourDemo: closeTourDemo,
    openFilePanel: openFilePanel, activeTermCwd: activeTermCwd
  };
  loadTermHistoryStore();   // cargar el historial de comandos para el autosuggest (una vez, al iniciar)
})(window);
