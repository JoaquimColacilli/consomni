/* ════════════════════════════════════════════════════════════════
   Consomni — terminals-ui.js
   DOCK de terminales/conversaciones MALEABLE (tipo IDE / tiling):
   - Vive abajo a la DERECHA del sidebar (no lo tapa salvo zoom/home).
   - Mosaico de paneles: dividir a derecha/abajo, ARRASTRAR divisores para
     redimensionar, y ARRASTRAR un panel (de su barra) a un borde de otro para
     reubicarlo (drop-zones izq/der/arriba/abajo).
   - Borde superior arrastrable (alto del dock). Minimizar a barra. Zoom full.
   - Cada panel: PTY real (xterm: shell o `claude`) o conversación read-only.
   Vive en #terminals: capa PERSISTENTE que el re-render del board NO toca.

   API: window.ConsomniTerms = { spawn, open, openSession, show, hide,
     minimize, restore, toggle, home, isOpen, count, refreshActive,
     setNotifier, setActionHandler, isMaximized }
   ════════════════════════════════════════════════════════════════ */
(function (g) {
  'use strict';
  var C = g.Chrome, api = g.consomni, Terminal = g.Terminal, FitNS = g.FitAddon;

  var host = null, rootEl = null, dropInd = null, countEl = null;
  var terms = new Map();       // ptyId -> { term, fit, pane, ro }
  var sessions = new Map();    // sid   -> pane
  var paneSeq = 0;
  var focused = null;
  var bound = false, snapBound = false;
  var notifier = function () {}, actionHandler = function () {};

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

  /* ── DOM base ── */
  function ensureDock() {
    if (host) return host;
    host = document.getElementById('terminals');
    if (!host) return null;
    host.classList.add('dock');
    host.innerHTML =
      '<div class="dk-resize" title="arrastrá para cambiar el alto"></div>' +
      '<div class="dk-toolbar">' +
        '<span class="dk-tb-title">' + (C ? C.eye(20, false) : '') + '<span>TERMINALES</span><span class="dk-count"></span></span>' +
        '<span class="dk-tb-actions">' +
          '<button class="dk-newbtn dk-new-term" title="nueva terminal">' + svg('term', 12, 2) + ' terminal</button>' +
          '<button class="dk-newbtn dk-new-claude" title="nueva sesión claude">' + svg('dispatch', 12, 2) + ' claude</button>' +
          '<span class="dk-div"></span>' +
          '<button class="dk-pb dk-max" title="pantalla completa / restaurar">' + maxIcon() + '</button>' +
          '<button class="dk-pb dk-min" title="minimizar / restaurar">' + svg('chevD', 15, 2.4) + '</button>' +
        '</span>' +
      '</div>' +
      '<div class="dk-root"></div>' +
      '<div class="dk-dropind"></div>';
    rootEl = host.querySelector('.dk-root');
    dropInd = host.querySelector('.dk-dropind');
    countEl = host.querySelector('.dk-count');
    host.querySelector('.dk-new-term').addEventListener('click', function () { spawn('shell'); });
    host.querySelector('.dk-new-claude').addEventListener('click', function () { spawn('claude'); });
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
    api.onSnapshot(function () { sessions.forEach(function (pane) { if (host && !host.hidden && !host.classList.contains('minimized')) renderSession(pane); }); });
  }

  function updateCount() { if (countEl) { var n = panesOf().length; countEl.textContent = n ? ('· ' + n) : ''; } }
  function setFocus(pane) {
    if (focused === pane) return;
    focused = pane;
    panesOf().forEach(function (p) { p.classList.toggle('focused', p === pane); });
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
          '<button class="dk-pbtn dk-split-r" title="dividir a la derecha">' + splitRIcon() + '</button>' +
          '<button class="dk-pbtn dk-split-d" title="dividir abajo">' + splitDIcon() + '</button>' +
          '<button class="dk-pbtn dk-pane-x" title="cerrar panel">' + svg('x', 12, 2) + '</button>' +
        '</span>' +
      '</div>' +
      '<div class="dk-pane-body"></div>';
    pane.addEventListener('mousedown', function () { setFocus(pane); });
    pane.querySelector('.dk-split-r').addEventListener('click', function (e) { e.stopPropagation(); setFocus(pane); spawn('shell', null, 'right'); });
    pane.querySelector('.dk-split-d').addEventListener('click', function (e) { e.stopPropagation(); setFocus(pane); spawn('shell', null, 'down'); });
    pane.querySelector('.dk-pane-x').addEventListener('click', function (e) { e.stopPropagation(); closePane(pane); });
    return pane;
  }
  function setPaneMeta(pane, icon, title) {
    pane.querySelector('.dk-pane-ic').innerHTML = icon;
    pane.querySelector('.dk-pane-title').textContent = title;
    pane.title = title;
  }

  /* ── tiling: insertar / dividir / detach ── */
  function makeSplitter() { var s = document.createElement('div'); s.className = 'dk-splitter'; return s; }

  function placeContent(pane, dir) {
    ensureDock();
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
    killPaneContent(pane);
    detachPane(pane);
    updateCount();
    if (!rootEl.querySelector('.dk-pane')) { focused = null; hide(); return; }
    setFocus(rootEl.querySelector('.dk-pane'));
    refitAll();
  }

  /* ── panel de TERMINAL ── */
  function spawn(kind, cwd, dir, opts) {
    if (!Terminal) { notifier('xterm no cargó', 'err'); return; }
    if (!api || !api.term) { notifier('terminales no disponibles', 'err'); return; }
    ensureDock(); bindIpc(); show();
    opts = opts || {};
    var resume = opts.resume || null;

    var pane = makePaneShell(kind === 'claude' ? 'claude' : 'shell');
    var body = pane.querySelector('.dk-pane-body');
    setPaneMeta(pane, kind === 'claude' ? '<span class="dk-tdot"></span>' : svg('term', 11, 2), kind === 'claude' ? (resume ? 'claude ↻…' : 'claude…') : 'shell…');
    placeContent(pane, dir || 'right');

    var term = new Terminal({
      fontFamily: "'Geist Mono', ui-monospace, 'Cascadia Mono', monospace",
      fontSize: 12.5, lineHeight: 1.15, cursorBlink: true, cursorStyle: 'bar',
      allowProposedApi: true, scrollback: 6000, theme: THEME
    });
    var fit = new FitNS.FitAddon();
    term.loadAddon(fit);
    term.open(body);

    // re-fit automático ante CUALQUIER cambio de tamaño del panel (split, drag, dock-resize…)
    var ro = null;
    if (g.ResizeObserver) { ro = new g.ResizeObserver(function () { try { fit.fit(); } catch (e) {} }); ro.observe(body); }

    requestAnimationFrame(function () {
      try { fit.fit(); } catch (e) {}
      api.term.create({ cwd: cwd, kind: kind, cols: term.cols || 80, rows: term.rows || 24, resume: resume }).then(function (res) {
        if (!res || !res.ok) { term.write('\r\n  \x1b[31m' + ((res && res.error) || 'no se pudo abrir') + '\x1b[0m\r\n'); return; }
        pane.dataset.tid = res.id;
        terms.set(res.id, { term: term, fit: fit, pane: pane, ro: ro });
        setPaneMeta(pane, kind === 'claude' ? '<span class="dk-tdot"></span>' : svg('term', 11, 2), res.title || (kind === 'claude' ? 'claude' : 'shell'));
        term.onData(function (d) { api.term.write(res.id, d); });
        term.onResize(function (sz) { api.term.resize(res.id, sz.cols, sz.rows); });
        try { fit.fit(); term.focus(); } catch (e) {}
      }).catch(function () { term.write('\r\n  \x1b[31mfalló el IPC\x1b[0m\r\n'); });
    });
  }

  /* ── panel de SESIÓN ── */
  function openSession(sid, name) {
    ensureDock(); bindSnap(); show();
    var ex = sessions.get(sid);
    if (ex && rootEl.contains(ex)) { setFocus(ex); renderSession(ex); return; }
    var pane = makePaneShell('session');
    pane.dataset.sid = sid;
    setPaneMeta(pane, svg('eye', 12, 1.8), name || 'sesión');
    var body = pane.querySelector('.dk-pane-body');
    body.innerHTML =
      '<div class="dk-shead">' +
        '<span class="dk-sactions">' +
          '<button class="btn btn--sm btn--green" data-dock-act="resume" data-sid="' + esc(sid) + '" title="continuar ESTA conversación de forma interactiva (claude --resume)">' + svg('reply', 11, 2) + ' responder</button>' +
          '<button class="btn btn--sm" data-dock-act="dispatch" data-sid="' + esc(sid) + '" title="nueva sesión claude en esta carpeta">' + svg('dispatch', 11, 2) + ' claude nuevo</button>' +
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
    placeContent(pane, 'right');
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
      var pr = prev.getBoundingClientRect(), nr = next.getBoundingClientRect();
      var start = row ? e.clientX : e.clientY;
      var ps = row ? pr.width : pr.height, ns = row ? nr.width : nr.height, total = ps + ns;
      function move(ev) {
        var d = (row ? ev.clientX : ev.clientY) - start;
        var np = Math.max(70, Math.min(total - 70, ps + d));
        prev.style.flex = np + ' 1 0'; next.style.flex = (total - np) + ' 1 0';
      }
      function up() { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); document.body.style.userSelect = ''; }
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
        if (started && drag && drag.target !== pane) { detachPane(pane); insertPaneAt(drag.target, pane, drag.zone); setFocus(pane); refitAll(); }
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
        document.documentElement.style.setProperty('--dock-h', h + 'px');
      }
      function up() { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); document.body.style.userSelect = ''; refitAll(); }
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
    });
  }

  /* ── fit ── */
  var fitTimer = null;
  function refitSoon() { if (fitTimer) cancelAnimationFrame(fitTimer); fitTimer = requestAnimationFrame(function () { fitTimer = requestAnimationFrame(refitAll); }); }
  function refitAll() { terms.forEach(function (t) { try { if (t.pane.offsetParent !== null) t.fit.fit(); } catch (e) {} }); }

  /* ── estados: show / minimize / restore / maximize / home / hide ── */
  function show() {
    ensureDock(); if (!host) return;
    host.hidden = false; host.classList.remove('minimized');
    document.body.classList.add('dock-open'); document.body.classList.remove('dock-min');
    refitSoon();
  }
  function minimize() { ensureDock(); if (!host || host.hidden) return; host.classList.remove('maximized'); host.classList.add('minimized'); document.body.classList.add('dock-min'); }
  function restore() { ensureDock(); host.classList.remove('minimized'); host.hidden = false; document.body.classList.add('dock-open'); document.body.classList.remove('dock-min'); refitSoon(); }
  function toggleMin() { if (host.classList.contains('minimized')) restore(); else minimize(); }
  function toggleMax() { ensureDock(); host.classList.remove('minimized'); document.body.classList.remove('dock-min'); host.classList.toggle('maximized'); refitSoon(); }
  function hide() { if (!host) return; host.hidden = true; host.classList.remove('maximized', 'minimized'); document.body.classList.remove('dock-open', 'dock-min'); }
  function home() {
    ensureDock(); bindIpc();
    if (!rootEl.querySelector('.dk-pane')) spawn('shell');
    host.hidden = false; host.classList.remove('minimized'); host.classList.add('maximized');
    document.body.classList.add('dock-open'); document.body.classList.remove('dock-min');
    refitSoon();
  }
  function toggle() {
    if (!isOpen()) { ensureDock(); if (rootEl.querySelector('.dk-pane')) show(); else spawn('shell'); }
    else if (host.classList.contains('minimized')) restore();
    else minimize();
  }
  function isOpen() { return !!host && !host.hidden; }
  function count() { return terms.size + sessions.size; }
  function refreshActive() { sessions.forEach(function (pane) { renderSession(pane); }); }
  function setNotifier(fn) { if (typeof fn === 'function') notifier = fn; }
  function setActionHandler(fn) { if (typeof fn === 'function') actionHandler = fn; }

  var rt = null;
  window.addEventListener('resize', function () { if (isOpen()) { if (rt) clearTimeout(rt); rt = setTimeout(refitAll, 120); } });

  g.ConsomniTerms = {
    spawn: spawn, open: function (o) { o = o || {}; spawn(o.kind === 'claude' ? 'claude' : 'shell', o.cwd); },
    openSession: openSession, show: show, hide: hide, minimize: minimize, restore: restore,
    toggle: toggle, home: home, isOpen: isOpen, count: count, refreshActive: refreshActive,
    setNotifier: setNotifier, setActionHandler: setActionHandler,
    isMaximized: function () { return !!host && host.classList.contains('maximized'); }
  };
})(window);
