/* ════════════════════════════════════════════════════════════════
   Consomni — terminals-ui.js
   Workspace de TERMINALES EMBEBIDAS: grid de xterm.js conectados a PTYs
   reales del main (node-pty). Vive en #terminals, una capa persistente que
   el re-render del board NO toca (las instancias de xterm son pesadas y los
   procesos siguen vivos en background mientras la ocultás).

   API global: window.ConsomniTerms = {
     open({cwd,kind}), spawn(kind,cwd), show(), hide(), toggle(),
     isOpen(), count(), setNotifier(fn)
   }
   ════════════════════════════════════════════════════════════════ */
(function (g) {
  'use strict';
  var C = g.Chrome;
  var api = g.consomni;
  var Terminal = g.Terminal;            // UMD global de xterm.js
  var FitAddonNS = g.FitAddon;          // { FitAddon }

  var host = null;                       // #terminals
  var grid = null;                       // .tw-grid
  var countEl = null;
  var panes = new Map();                 // id -> { term, fit, el, body, dead }
  var bound = false;
  var notifier = function () {};

  var THEME = {
    background: '#0a0a0b', foreground: '#e6e6e6',
    cursor: '#4ade80', cursorAccent: '#0a0a0b',
    selectionBackground: 'rgba(74,222,128,.28)',
    black: '#16161a', red: '#f87171', green: '#4ade80', yellow: '#fbbf24',
    blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#d4d4d8',
    brightBlack: '#52525b', brightRed: '#fca5a5', brightGreen: '#86efac', brightYellow: '#fde68a',
    brightBlue: '#93c5fd', brightMagenta: '#d8b4fe', brightCyan: '#67e8f9', brightWhite: '#fafafa'
  };

  function esc(s) { return C ? C.esc(s) : String(s == null ? '' : s); }
  function svg(n, sz, sw) { return C ? C.svg(n, sz, sw) : ''; }
  // ícono de maximizar/restaurar (no está en chrome.js)
  function maxIcon() { return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5"/><path d="M20 9V4h-5"/><path d="M4 15v5h5"/><path d="M20 15v5h-5"/></svg>'; }

  function ensureHost() {
    if (host) return host;
    host = document.getElementById('terminals');
    if (!host) return null;
    host.innerHTML =
      '<div class="tw-bar">' +
        '<div class="tw-title">' + (C ? C.eye(22, false) : '') + '<span class="tw-h">TERMINALES</span><span class="tw-ct" id="twCount">0</span></div>' +
        '<div class="tw-actions">' +
          '<button class="btn btn--sm tw-new-term">' + svg('term', 12, 2) + ' terminal</button>' +
          '<button class="btn btn--sm btn--green tw-new-claude">' + svg('plus', 12, 2.4) + ' claude</button>' +
          '<span class="tw-div"></span>' +
          '<button class="iconbtn tw-killall" title="cerrar todas">' + svg('archive', 14, 1.7) + '</button>' +
          '<button class="iconbtn tw-close" title="volver al board (Esc)">' + svg('x', 15, 2) + '</button>' +
        '</div>' +
      '</div>' +
      '<div class="tw-grid" id="twGrid"></div>';
    grid = host.querySelector('#twGrid');
    countEl = host.querySelector('#twCount');
    host.querySelector('.tw-new-term').addEventListener('click', function () { spawn('shell'); });
    host.querySelector('.tw-new-claude').addEventListener('click', function () { spawn('claude'); });
    host.querySelector('.tw-killall').addEventListener('click', killAll);
    host.querySelector('.tw-close').addEventListener('click', hide);
    return host;
  }

  function bindIpc() {
    if (bound || !api || !api.term) return;
    bound = true;
    api.term.onData(function (p) { var t = panes.get(p.id); if (t) t.term.write(p.data); });
    api.term.onExit(function (p) {
      var t = panes.get(p.id); if (!t) return;
      t.dead = true;
      try { t.term.write('\r\n\x1b[90m[proceso finalizado · code ' + p.exitCode + ' · cerrá el panel]\x1b[0m\r\n'); } catch (e) {}
      if (t.el) t.el.classList.add('dead');
    });
  }

  function updateCount() { if (countEl) countEl.textContent = String(panes.size); }

  function columnsFor(n) { return n <= 1 ? 1 : (n <= 4 ? 2 : (n <= 9 ? 3 : 4)); }

  function layout() {
    if (!grid) return;
    var max = null;
    panes.forEach(function (t) { if (t.el.classList.contains('maximized')) max = t; });
    if (max) {
      grid.style.gridTemplateColumns = '1fr';
      panes.forEach(function (t) { t.el.style.display = (t === max) ? '' : 'none'; });
    } else {
      var cols = columnsFor(panes.size);
      grid.style.gridTemplateColumns = 'repeat(' + cols + ', minmax(0,1fr))';
      panes.forEach(function (t) { t.el.style.display = ''; });
    }
    fitAllSoon();
  }

  var fitTimer = null;
  function fitAllSoon() {
    if (fitTimer) cancelAnimationFrame(fitTimer);
    fitTimer = requestAnimationFrame(function () {
      fitTimer = requestAnimationFrame(function () {
        panes.forEach(function (t) {
          if (t.el.style.display === 'none' || t.dead) return;
          try { t.fit.fit(); } catch (e) {}
        });
      });
    });
  }

  function buildPane(kind) {
    var el = document.createElement('section');
    el.className = 'tw-pane tw-pane--' + (kind === 'claude' ? 'claude' : 'shell');
    var dotColor = kind === 'claude' ? 'var(--green)' : 'var(--text-3)';
    el.innerHTML =
      '<div class="tw-pane-head">' +
        '<span class="tw-dot" style="background:' + dotColor + '"></span>' +
        '<span class="tw-pane-title">' + (kind === 'claude' ? 'claude' : 'shell') + '…</span>' +
        '<span class="tw-pane-btns">' +
          '<button class="tw-pb tw-max" title="maximizar">' + maxIcon() + '</button>' +
          '<button class="tw-pb tw-x" title="cerrar (kill)">' + svg('x', 13, 2) + '</button>' +
        '</span>' +
      '</div>' +
      '<div class="tw-pane-body"></div>';
    return el;
  }

  function spawn(kind, cwd) {
    if (!Terminal) { notifier('xterm no cargó', 'err'); return; }
    if (!api || !api.term) { notifier('terminales no disponibles', 'err'); return; }
    ensureHost(); bindIpc(); show();

    var el = buildPane(kind);
    grid.appendChild(el);
    var body = el.querySelector('.tw-pane-body');
    var titleEl = el.querySelector('.tw-pane-title');

    var term = new Terminal({
      fontFamily: "'Geist Mono', ui-monospace, 'Cascadia Mono', monospace",
      fontSize: 12.5, lineHeight: 1.15, cursorBlink: true, cursorStyle: 'bar',
      allowProposedApi: true, scrollback: 5000, theme: THEME
    });
    var fit = new FitAddonNS.FitAddon();
    term.loadAddon(fit);
    term.open(body);

    el.querySelector('.tw-max').addEventListener('click', function (e) {
      e.stopPropagation(); el.classList.toggle('maximized'); layout();
    });
    el.querySelector('.tw-x').addEventListener('click', function (e) {
      e.stopPropagation(); closePane(el);
    });
    el.addEventListener('mousedown', function () { try { term.focus(); } catch (er) {} });

    // medir el tamaño real ya montado → crear la PTY con esos cols/rows
    requestAnimationFrame(function () {
      try { fit.fit(); } catch (e) {}
      var cols = term.cols || 80, rows = term.rows || 24;
      api.term.create({ cwd: cwd, kind: kind, cols: cols, rows: rows }).then(function (res) {
        if (!res || !res.ok) {
          term.write('\r\n  \x1b[31m' + ((res && res.error) || 'no se pudo abrir la terminal') + '\x1b[0m\r\n');
          titleEl.textContent = 'error';
          el._noKill = true;
          return;
        }
        var id = res.id;
        el.dataset.tid = id;
        titleEl.textContent = res.title || (kind === 'claude' ? 'claude' : 'shell');
        el.title = res.cwd || '';
        panes.set(id, { term: term, fit: fit, el: el, body: body, dead: false });
        term.onData(function (d) { api.term.write(id, d); });
        term.onResize(function (sz) { api.term.resize(id, sz.cols, sz.rows); });
        updateCount(); layout();
        try { term.focus(); } catch (e2) {}
      }).catch(function () {
        term.write('\r\n  \x1b[31mfalló el IPC de la terminal\x1b[0m\r\n'); el._noKill = true;
      });
    });
  }

  function closePane(el) {
    var id = el.dataset.tid;
    if (id) { var t = panes.get(id); if (t) { try { t.term.dispose(); } catch (e) {} } panes.delete(id); if (api && api.term) api.term.kill(id); }
    if (el.parentNode) el.parentNode.removeChild(el);
    updateCount();
    if (panes.size === 0) { hide(); } else { layout(); }
  }

  function killAll() {
    var els = grid ? Array.prototype.slice.call(grid.children) : [];
    els.forEach(function (el) { closePane(el); });
  }

  function open(opts) { opts = opts || {}; spawn(opts.kind === 'claude' ? 'claude' : 'shell', opts.cwd); }

  function show() {
    ensureHost(); if (!host) return;
    host.hidden = false;
    document.body.classList.add('terminals-open');
    fitAllSoon();
  }
  function hide() {
    if (!host) return;
    host.hidden = true;
    document.body.classList.remove('terminals-open');
  }
  function toggle() { if (isOpen()) hide(); else { ensureHost(); show(); if (panes.size === 0) spawn('shell'); } }
  function isOpen() { return !!host && !host.hidden; }
  function count() { return panes.size; }
  function setNotifier(fn) { if (typeof fn === 'function') notifier = fn; }

  var rt = null;
  window.addEventListener('resize', function () {
    if (!isOpen()) return;
    if (rt) clearTimeout(rt);
    rt = setTimeout(fitAllSoon, 120);
  });

  g.ConsomniTerms = {
    open: open, spawn: spawn, show: show, hide: hide, toggle: toggle,
    isOpen: isOpen, count: count, setNotifier: setNotifier
  };
})(window);
