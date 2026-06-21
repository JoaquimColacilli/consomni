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
  var C = g.Chrome, api = g.consomni, Terminal = g.Terminal, FitNS = g.FitAddon, WebLinksNS = g.WebLinksAddon;

  var host = null, rootEl = null, poolEl = null, dropInd = null, countEl = null;
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
        var list = allPanes().filter(inInicio).map(serializePane);
        var rs = document.documentElement.style;
        if (api && api.term && api.term.saveDock) api.term.saveDock({ v: 2, max: isMaximized(), dh: rs.getPropertyValue('--dock-h') || '', panes: list });
      } catch (e) { /* noop */ }
    }, 350);
  }
  function serializePane(el) {
    var d = el.dataset, o = { kind: d.kind || 'shell' };
    if (d.kind === 'session') { o.sid = d.sid; o.name = d.sname || ''; }
    else { o.cwd = d.cwd || ''; if (d.resume) o.resume = d.resume; if (d.skip === '1') o.skip = 1; }
    if (d.proj) o.proj = d.proj;
    if (d.projname) o.projname = d.projname;
    if (d.pinned === '1') o.pinned = 1;
    return o;
  }
  function buildPane(o) {
    var kind = o.kind === 'session' ? 'session' : (o.kind === 'claude' ? 'claude' : 'shell');
    var pane = makePaneShell(kind);
    pane.dataset.kind = kind;
    if (o.proj) pane.dataset.proj = o.proj;
    if (o.projname) pane.dataset.projname = o.projname;
    if (o.pinned) pane.dataset.pinned = '1';
    if (kind === 'session') { pane.dataset.sid = o.sid || ''; pane.dataset.sname = o.name || ''; }
    else { if (o.cwd) pane.dataset.cwd = o.cwd; if (o.resume) pane.dataset.resume = o.resume; if (o.skip) pane.dataset.skip = '1'; }
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
          '<button class="dk-newbtn dk-new-claude" title="nueva sesión claude">' + svg('dispatch', 12, 2) + ' claude</button>' +
          '<button class="dk-newbtn dk-new-claude-skip" title="claude SIN permisos (--dangerously-skip-permissions)">' + svg('dispatch', 12, 2) + ' claude ⚡</button>' +
          '<span class="dk-div"></span>' +
          '<button class="dk-newbtn dk-new-cmd" title="comandos rápidos: atajos (crear carpeta, git status…) + describilo en castellano y lo traduce tu claude">' + svg('dispatch', 12, 2) + ' comandos</button>' +
          '<span class="dk-div"></span>' +
          '<button class="dk-newbtn dk-exit" title="salir de pantalla completa (volver al board)">' + svg('chevD', 13, 2.4) + ' salir</button>' +
          '<button class="dk-pb dk-max" title="pantalla completa / restaurar">' + maxIcon() + '</button>' +
          '<button class="dk-pb dk-min" title="minimizar / ocultar">' + svg('chevD', 15, 2.4) + '</button>' +
        '</span>' +
      '</div>' +
      '<div class="dk-root"></div>' +
      '<div class="dk-pool" style="display:none"></div>' +
      '<div class="dk-dropind"></div>';
    rootEl = host.querySelector('.dk-root');
    poolEl = host.querySelector('.dk-pool');
    dropInd = host.querySelector('.dk-dropind');
    countEl = host.querySelector('.dk-count');
    host.querySelector('.dk-new-term').addEventListener('click', function () { spawn('shell'); });
    host.querySelector('.dk-new-claude').addEventListener('click', function () { spawn('claude'); });
    host.querySelector('.dk-new-claude-skip').addEventListener('click', function () { spawn('claude', null, null, { skip: true }); });
    host.querySelector('.dk-new-cmd').addEventListener('click', openQuickCommands);
    host.querySelector('.dk-exit').addEventListener('click', function () { host.classList.remove('maximized'); notifyMax(); refitSoon(); persist(); });
    host.querySelector('.dk-max').addEventListener('click', toggleMax);
    host.querySelector('.dk-min').addEventListener('click', toggleMin);
    host.querySelector('.dk-tb-title').addEventListener('click', function () { if (host.classList.contains('minimized')) restore(); });
    wireDockResize();
    wireSplitterDrag();
    wirePaneDrag();
    return host;
  }

  function bindIpc() {
    if (bound || !api || !api.term) return;
    bound = true;
    api.term.onData(function (p) { var t = terms.get(p.id); if (t) t.term.write(p.data); });
    api.term.onExit(function (p) {
      var t = terms.get(p.id); if (!t) return;
      try { t.term.write('\r\n\x1b[90m[proceso finalizado · code ' + p.exitCode + ']\x1b[0m\r\n'); } catch (e) {}
      if (t.pane) t.pane.classList.add('dead');
    });
  }
  function bindSnap() {
    if (snapBound || !api || !api.onSnapshot) return;
    snapBound = true;
    api.onSnapshot(function () { sessions.forEach(function (pane) { if (host && !host.hidden && !host.classList.contains('minimized') && rootEl.contains(pane)) renderSession(pane); }); });
  }

  function updateCount() { if (countEl) { var n = panesOf().length; countEl.textContent = n ? ('· ' + n) : ''; } }
  function setFocus(pane) {
    if (focused === pane) return;
    focused = pane;
    panesOf().forEach(function (p) { p.classList.toggle('focused', p === pane); });
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
      return '<div class="dk-placeholder">' + (C ? C.eye(40, false) : '') +
        '<div class="dk-ph-title">Inicio sin terminales fijadas</div>' +
        '<div class="dk-ph-text">Fijá una terminal con la ★ (en cualquier proyecto) y va a aparecer acá, lista para vos.<br>O abrí una nueva con <b>terminal</b> / <b>claude</b> de arriba.</div>' +
        '</div>';
    }
    return '<div class="dk-placeholder">' + svg('term', 38, 1.5) +
      '<div class="dk-ph-title">Sin terminales en este proyecto</div>' +
      '<div class="dk-ph-text">Abrí una con <b>terminal</b> / <b>claude</b> de arriba — arranca en la carpeta del proyecto. Fijala con ★ para tenerla también en inicio.</div>' +
      '</div>';
  }
  // re-arma rootEl en FILA simple con los paneles que matchean la vista (el resto al pool)
  function showView(v) {
    ensureDock();
    view = v;
    updateTitle();   // cabecera del dock: nombre del proyecto / "TERMINALES" en inicio
    // 1) todo lo visible al pool
    panesOf().forEach(function (p) { poolEl.appendChild(p); });
    rootEl.innerHTML = '';
    // 2) los que matchean, a una fila
    var match = allPanes().filter(function (p) { return matchesView(p, v); });
    if (!match.length) {
      // vista de proyecto sin terminales pero CON cards (sesiones) → mostrar su board en vez del placeholder
      if (v !== '__home__' && boardChecker && boardChecker(v)) { rootEl.innerHTML = ''; updateCount(); minimize(); return; }
      rootEl.innerHTML = placeholderHTML(v); updateCount(); return;
    }
    if (match.length === 1) { match[0].style.flex = '1 1 0'; rootEl.appendChild(match[0]); }
    else {
      var split = document.createElement('div'); split.className = 'dk-split row';
      match.forEach(function (p, i) { if (i) split.appendChild(makeSplitter()); p.style.flex = '1 1 0'; split.appendChild(p); });
      rootEl.appendChild(split);
    }
    if (!focused || !rootEl.contains(focused)) setFocus(match[0]);
    updateCount(); refitSoon();
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
          '<button class="dk-pbtn dk-pane-x" title="cerrar panel">' + svg('x', 12, 2) + '</button>' +
        '</span>' +
      '</div>' +
      '<div class="dk-pane-body"></div>';
    pane.addEventListener('mousedown', function () { setFocus(pane); });
    pane.querySelector('.dk-ask-btn').addEventListener('click', function (e) { e.stopPropagation(); setFocus(pane); toggleAsk(pane); });
    pane.querySelector('.dk-pin').addEventListener('click', function (e) { e.stopPropagation(); pinToggle(pane); });
    pane.querySelector('.dk-split-r').addEventListener('click', function (e) { e.stopPropagation(); setFocus(pane); spawn('shell', null, 'right'); });
    pane.querySelector('.dk-split-d').addEventListener('click', function (e) { e.stopPropagation(); setFocus(pane); spawn('shell', null, 'down'); });
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
  function setPaneMeta(pane, icon, title, proj) {
    pane.querySelector('.dk-pane-ic').innerHTML = icon;
    pane.querySelector('.dk-pane-title').innerHTML = esc(title) + (proj ? ' <span class="dk-pt-proj">· ' + esc(proj) + '</span>' : '');
    pane.title = title + (proj ? ' · ' + proj : '');
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

  // menú contextual (copiar/pegar/seleccionar todo) sobre la terminal. Vive en document.body (fuera de
  // #terminals) → no lo traga el handler global de clicks de app.js.
  function closeTermCtx() {
    var m = g.document.getElementById('dkCtx'); if (m) m.remove();
    g.document.removeEventListener('mousedown', onCtxOutside, true);
    g.document.removeEventListener('keydown', onCtxKey, true);
  }
  function onCtxOutside(e) { if (!e.target.closest || !e.target.closest('#dkCtx')) closeTermCtx(); }
  function onCtxKey(e) { if (e.key === 'Escape') { e.preventDefault(); closeTermCtx(); } }
  function showTermCtx(x, y, term) {
    closeTermCtx();
    var hasSel = false; try { hasSel = !!(term.hasSelection && term.hasSelection()); } catch (e) {}
    var m = g.document.createElement('div');
    m.id = 'dkCtx'; m.className = 'dk-ctx';
    m.innerHTML =
      '<button class="dk-ctx-i" data-ctx="copy"' + (hasSel ? '' : ' disabled') + '>Copiar</button>' +
      '<button class="dk-ctx-i" data-ctx="paste">Pegar</button>' +
      '<button class="dk-ctx-i" data-ctx="all">Seleccionar todo</button>';
    g.document.body.appendChild(m);
    var mw = m.offsetWidth || 168, mh = m.offsetHeight || 96;
    m.style.left = Math.max(4, Math.min(x, g.innerWidth - mw - 4)) + 'px';
    m.style.top = Math.max(4, Math.min(y, g.innerHeight - mh - 4)) + 'px';
    m.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-ctx]'); if (!b || b.disabled) return;
      var act = b.getAttribute('data-ctx');
      if (act === 'copy') termCopy(term); else if (act === 'paste') termPaste(term); else if (act === 'all') termSelectAll(term);
      closeTermCtx(); try { term.focus(); } catch (e2) {}
    });
    setTimeout(function () {
      g.document.addEventListener('mousedown', onCtxOutside, true);
      g.document.addEventListener('keydown', onCtxKey, true);
    }, 0);
  }

  // monta xterm + PTY dentro de un panel YA colocado (lo usa spawn y la restauración)
  // pick (sin resume): `claude --resume` abre el SELECTOR interactivo scopeado al cwd del proyecto.
  function mountTerminal(pane, kind, cwd, resume, skip, pick) {
    kind = (kind === 'claude') ? 'claude' : 'shell';
    pane.dataset.kind = kind;
    if (cwd) pane.dataset.cwd = cwd;
    if (resume) pane.dataset.resume = resume; else pane.removeAttribute('data-resume');
    if (skip) pane.dataset.skip = '1'; else pane.removeAttribute('data-skip');
    pane.classList.remove('dk-pane--session', 'dk-pane--shell', 'dk-pane--claude');
    pane.classList.add('dk-pane--' + kind);
    var ic = kind === 'claude' ? '<span class="dk-tdot"></span>' : svg('term', 11, 2);
    var lbl = kind === 'claude' ? ((resume || pick) ? 'claude ↻…' : (skip ? 'claude ⚡…' : 'claude…')) : 'shell…';
    setPaneMeta(pane, ic, lbl, projLabel(pane));
    updatePinUI(pane);
    ensureVscodeBtn(pane);   // botón VSCode en la cabecera de la terminal (abre su cwd en el editor)
    var body = pane.querySelector('.dk-pane-body');
    body.innerHTML = '';

    var term = new Terminal({
      fontFamily: "'Geist Mono', ui-monospace, 'Cascadia Mono', monospace",
      fontSize: 12.5, lineHeight: 1.15, cursorBlink: true, cursorStyle: 'bar',
      allowProposedApi: true, scrollback: 6000, theme: THEME
    });
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
    // CTRL+ESPACIO → otra terminal · Ctrl+C/Ctrl+Shift+C copiar (preservando SIGINT) · Ctrl+V/Ctrl+Shift+V pegar
    try {
      term.attachCustomKeyEventHandler(function (ev) {
        if (ev.type !== 'keydown') return true;
        if (ev.ctrlKey && ev.code === 'Space') { if (quickTermHook) quickTermHook(); return false; }
        if (ev.ctrlKey && ev.shiftKey && ev.code === 'KeyC') { termCopy(term); return false; }              // copiar siempre
        if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && ev.code === 'KeyC') {
          if (termCopy(term)) return false;   // había selección → copió + limpió → no mandar nada
          return true;                        // sin selección → la shell recibe SIGINT (\x03)
        }
        if (ev.ctrlKey && ev.code === 'KeyV') { termPaste(term); return false; }                            // pegar (Ctrl+V / Ctrl+Shift+V)
        return true;
      });
    } catch (e) {}
    // "c to copy" de claude (OSC 52): decodificá base64 UTF-8 y copiá al portapapeles (sin addon extra)
    try {
      term.parser.registerOscHandler(52, function (data) {
        try {
          var semi = String(data || '').indexOf(';'); if (semi < 0) return true;
          var b64 = data.slice(semi + 1);
          if (!b64 || b64 === '?') return true;                       // query de lectura → ignorar
          var bin = atob(b64), bytes = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) & 0xff;
          var text = new TextDecoder('utf-8').decode(bytes);
          if (text && api && api.action) api.action('copyText', { text: text }).catch(function () {});
        } catch (e) {}
        return true;
      });
    } catch (e) {}
    // menú contextual (click derecho): copiar / pegar / seleccionar todo
    try { body.addEventListener('contextmenu', function (ev) { ev.preventDefault(); showTermCtx(ev.clientX, ev.clientY, term); }); } catch (e) {}

    var ro = null;
    if (g.ResizeObserver) { ro = new g.ResizeObserver(function () { try { fit.fit(); } catch (e) {} }); ro.observe(body); }
    if (g.document && g.document.fonts && g.document.fonts.ready) g.document.fonts.ready.then(function () { try { fit.fit(); } catch (e) {} });

    requestAnimationFrame(function () {
      try { fit.fit(); } catch (e) {}
      api.term.create({ cwd: cwd, kind: kind, cols: term.cols || 80, rows: term.rows || 24, resume: resume, skip: skip, pick: pick }).then(function (res) {
        if (!res || !res.ok) { term.write('\r\n  \x1b[31m' + ((res && res.error) || 'no se pudo abrir') + '\x1b[0m\r\n'); return; }
        pane.dataset.tid = res.id;
        pane.dataset.cwd = res.cwd || cwd || '';
        terms.set(res.id, { term: term, fit: fit, pane: pane, ro: ro });
        setPaneMeta(pane, ic, res.title || (kind === 'claude' ? 'claude' : 'shell'), projLabel(pane));
        term.onData(function (d) { api.term.write(res.id, d); });
        term.onResize(function (sz) { api.term.resize(res.id, sz.cols, sz.rows); });
        try { fit.fit(); if (rootEl.contains(pane)) term.focus(); } catch (e) {}
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
  function openSession(sid, name, proj, projName) {
    ensureDock(); bindSnap(); show();
    var ex = sessions.get(sid);
    if (ex) {
      if (!rootEl.contains(ex)) { if (proj && !ex.dataset.proj) ex.dataset.proj = proj; if (projName && !ex.dataset.projname) ex.dataset.projname = projName; if (view === '__home__') ex.dataset.pinned = '1'; showView(view); }
      setFocus(ex); renderSession(ex); return;
    }
    var pane = makePaneShell('session');
    if (proj) pane.dataset.proj = proj;
    if (projName) pane.dataset.projname = projName;
    if (view === '__home__') pane.dataset.pinned = '1';   // abierta desde inicio → aparece en inicio
    placeContent(pane, 'right');
    mountSession(pane, sid, name, proj);
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
  function mountSession(pane, sid, name, proj) {
    pane.classList.remove('dk-pane--shell', 'dk-pane--claude');
    pane.classList.add('dk-pane--session');
    pane.dataset.kind = 'session';
    pane.dataset.sid = sid;
    pane.dataset.sname = name || 'sesión';
    if (proj) pane.dataset.proj = proj;
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
      convoEl.innerHTML = convo.map(function (turn) {
        var who = turn.role === 'user' ? 'tú' : 'claude';
        return '<div class="cv-turn cv-' + turn.role + '"><span class="cv-who">' + who + '</span>' +
          '<div class="cv-text">' + esc(turn.text) + '</div></div>';
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

  /* ── fit ── */
  var fitTimer = null, liveRaf = null;
  function refitSoon() { if (fitTimer) cancelAnimationFrame(fitTimer); fitTimer = requestAnimationFrame(function () { fitTimer = requestAnimationFrame(refitAll); }); }
  // fit por frame durante un drag (reflow EN VIVO; el ResizeObserver llega tarde)
  function liveFit() { if (liveRaf) cancelAnimationFrame(liveRaf); liveRaf = requestAnimationFrame(function () { liveRaf = null; refitAll(); }); }
  function refitAll() { terms.forEach(function (t) { try { if (t.pane.offsetParent !== null) t.fit.fit(); } catch (e) {} }); }

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
  function setNotifier(fn) { if (typeof fn === 'function') notifier = fn; }
  function setActionHandler(fn) { if (typeof fn === 'function') actionHandler = fn; }
  function setMaxObserver(fn) { if (typeof fn === 'function') maxObserver = fn; }
  function setBoardChecker(fn) { if (typeof fn === 'function') boardChecker = fn; }
  function setEditorOpener(fn) { if (typeof fn === 'function') editorOpener = fn; }
  function setQuickTermHook(fn) { if (typeof fn === 'function') quickTermHook = fn; }

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
    setEditorOpener: setEditorOpener, setQuickTermHook: setQuickTermHook
  };
})(window);
