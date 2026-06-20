/* ════════════════════════════════════════════════════════════════
   Consomni — app.js (renderer)
   Estado + transform Session[]→builders + interacciones completas:
   búsqueda, filtros de modo, orden, densidad, filtro por proyecto,
   panel de detalle (E2), command palette (E3), mapa de atajos, help,
   toast, multi-select, pin, onboarding con logo parpadeante.
   Markup byte-idéntico (sólo se reusan builders + clases del reference).
   ════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var C = window.Chrome;
  var api = window.consomni || null;
  var BREAKPOINT = 820;

  var SORTS = [
    { key: 'prioridad', label: 'prioridad', cmp: byPriority },
    { key: 'actividad', label: 'actividad', cmp: function (a, b) { return (b.lastActivity || 0) - (a.lastActivity || 0); } },
    { key: 'contexto', label: 'contexto', cmp: function (a, b) { return b.ctxPct - a.ctxPct; } },
    { key: 'tokens', label: 'tokens', cmp: function (a, b) { return b.tokensTotal - a.tokensTotal; } },
    { key: 'nombre', label: 'nombre', cmp: function (a, b) { return String(a.name).localeCompare(String(b.name)); } }
  ];

  var state = {
    snapshot: null,
    collapsed: false,
    activeProject: 'all',
    modeFilter: {},        // {ask:true,...} — vacío = sin filtro
    sort: 'prioridad',
    density: 'comodo',
    search: '',
    searchActive: false,
    selected: {},          // sid → true (multi-select)
    muted: false,
    focusSid: null,
    paletteOpen: false,
    paletteQuery: '',
    paletteSel: 0,
    paletteRows: [],
    detailId: null,
  };

  /* ── helpers ── */
  function formatTokens(n) {
    if (!n || n < 0) return '0';
    if (n < 1000) return String(n);
    if (n < 1000000) return Math.round(n / 1000) + 'k';
    return (n / 1000000).toFixed(1) + 'M';
  }
  function lvlFor(ctxPct, st) {
    if (st === 'standby') return 'dim';
    if (ctxPct > 90) return 'red';
    if (ctxPct >= 75) return 'amber';
    return 'green';
  }
  var PRIO = { attn: 0, working: 1, error: 2, idle: 3, standby: 4, closed: 5 };
  function byPriority(a, b) {
    var pa = PRIO[a.state] != null ? PRIO[a.state] : 9;
    var pb = PRIO[b.state] != null ? PRIO[b.state] : 9;
    if (pa !== pb) return pa - pb;
    return (b.lastActivity || 0) - (a.lastActivity || 0);
  }
  function relTime(ms) {
    var s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (s < 60) return 'hace ' + s + 's';
    var m = Math.floor(s / 60);
    if (m < 60) return 'hace ' + m + 'm';
    var h = Math.floor(m / 60);
    if (h < 24) return 'hace ' + h + 'h';
    return 'hace ' + Math.floor(h / 24) + 'd';
  }
  function esc(s) { return C.esc(s); }
  function activeModes() { return Object.keys(state.modeFilter).filter(function (k) { return state.modeFilter[k]; }); }
  function curSort() { for (var i = 0; i < SORTS.length; i++) if (SORTS[i].key === state.sort) return SORTS[i]; return SORTS[0]; }

  function matchesFilter(s) {
    var am = activeModes();
    if (am.length && am.indexOf(s.mode) === -1) return false;
    if (state.search) {
      var q = state.search.toLowerCase();
      var hay = (s.name + ' ' + s.project + ' ' + (s.branch || '')).toLowerCase();
      if (hay.indexOf(q) === -1) return false;
    }
    return true;
  }

  /* ── Session → card ── */
  function toCard(s) {
    var status;
    if (s.state === 'working') status = { kind: 'green', spinner: true, text: s.statusText, em: s.statusEm };
    else if (s.state === 'attn') status = { kind: 'attn', text: s.statusText, em: s.statusEm };
    else if (s.state === 'error') status = { kind: 'error', text: s.statusText, em: s.statusEm };
    else if (s.state === 'standby') status = { kind: 'standby', text: s.statusText, em: s.statusEm };
    else status = { kind: 'idle', text: s.statusText, em: s.statusEm };
    return {
      id: s.id, name: s.name, mode: s.mode, ctx: s.ctxPct,
      lvl: lvlFor(s.ctxPct, s.state), tokens: formatTokens(s.tokensTotal),
      model: s.model, state: s.state, sel: !!state.selected[s.id],
      qaBtns: s.state === 'error' ? ['ext', 'term', 'redo'] : ['ext', 'term', 'copy'],
      status: status,
    };
  }

  function colMeta(c) {
    var out = [];
    if (c.attn) out.push({ dot: 'var(--amber)', label: c.attn + ' atención', color: 'var(--amber)' });
    if (c.error) out.push({ dot: 'var(--error)', label: c.error + ' error', color: 'var(--error)' });
    if (c.working) out.push({ dot: 'var(--green)', label: c.working + ' active' });
    if (c.idle) out.push({ dot: 'var(--idle)', label: c.idle + ' idle' });
    if (c.standby) out.push({ dot: 'var(--standby)', label: c.standby + ' standby' });
    if (c.closed) out.push({ dot: 'var(--closed)', label: c.closed + ' cerradas', color: 'var(--text-4)' });
    return out.slice(0, 3);
  }
  function sbMinis(c) {
    var out = [];
    if (c.attn) out.push({ color: 'var(--amber)', n: c.attn });
    if (c.error) out.push({ color: 'var(--error)', n: c.error });
    if (c.working) out.push({ color: 'var(--green)', n: c.working });
    if (c.idle && out.length < 2) out.push({ color: 'var(--text-3)', n: c.idle });
    return out.slice(0, 3);
  }
  function dominantDot(c) {
    if (c.attn) return 'var(--amber)';
    if (c.error) return 'var(--error)';
    if (c.working) return 'var(--green)';
    if (c.idle) return 'var(--text-3)';
    return null;
  }
  function projKey(s) { return String(s.projectPath || s.project || s.id).toLowerCase().replace(/\\/g, '/').replace(/\/+$/, ''); }

  function groupByProject(sessions) {
    var map = {};
    sessions.forEach(function (s) {
      var key = projKey(s);
      if (!map[key]) map[key] = { id: key, name: s.project || key, fav: false, sessions: [] };
      map[key].sessions.push(s);
      if (s.fav) map[key].fav = true;
    });
    return Object.keys(map).map(function (k) {
      var g = map[k];
      g.counts = { working: 0, attn: 0, error: 0, idle: 0, standby: 0, closed: 0 };
      g.sessions.forEach(function (s) { if (g.counts[s.state] != null) g.counts[s.state]++; });
      g.active = g.counts.working + g.counts.attn + g.counts.error + g.counts.idle + g.counts.standby;
      g.lastActivity = g.sessions.reduce(function (m, s) { return Math.max(m, s.lastActivity || 0); }, 0);
      return g;
    });
  }

  function transform(snap) {
    var sessions = snap.sessions || [];
    var groups = groupByProject(sessions);
    var cmp = curSort().cmp;

    var counts = { total: sessions.length, attn: 0, working: 0, idle: 0, closed: 0 };
    var totalTokens = 0, activeCount = 0;
    sessions.forEach(function (s) {
      if (s.state === 'attn') counts.attn++;
      else if (s.state === 'working') counts.working++;
      else if (s.state === 'idle') counts.idle++;
      else if (s.state === 'closed') counts.closed++;
      totalTokens += s.tokensTotal || 0;
      if (s.state === 'working' || s.state === 'attn' || s.state === 'error') activeCount++;
    });
    counts.tokens = formatTokens(totalTokens);

    var liveGroups = groups.filter(function (g) { return g.active > 0 || g.fav; });
    var archivedGroups = groups.filter(function (g) { return g.active === 0 && !g.fav; });

    var boardGroups = (state.activeProject !== 'all')
      ? groups.filter(function (g) { return g.id === state.activeProject; })
      : liveGroups;
    boardGroups = boardGroups.slice().sort(function (a, b) {
      if (!!b.counts.attn !== !!a.counts.attn) return (b.counts.attn ? 1 : 0) - (a.counts.attn ? 1 : 0);
      return b.lastActivity - a.lastActivity;
    });

    var filtering = state.search || activeModes().length;
    var cols = boardGroups.map(function (g) {
      var sorted = g.sessions.slice().sort(cmp);
      var openS = sorted.filter(function (s) { return s.state !== 'closed' && matchesFilter(s); });
      var closedS = sorted.filter(function (s) { return s.state === 'closed' && matchesFilter(s); });
      return {
        id: g.id, name: g.name, fav: g.fav, count: g.sessions.length,
        meta: colMeta(g.counts), cards: openS.map(toCard),
        closedCount: closedS.length,
        closed: closedS.map(function (s) { return { id: s.id, name: s.name, tokens: formatTokens(s.tokensTotal) }; }),
        _empty: openS.length === 0 && closedS.length === 0,
      };
    });
    if (filtering) cols = cols.filter(function (c) { return !c._empty; });

    function projItem(g) {
      return {
        id: g.id, name: g.name, icon: g.fav ? 'star' : 'repo', fav: g.fav,
        dim: g.counts.working + g.counts.attn + g.counts.error === 0,
        minis: sbMinis(g.counts), active: state.activeProject === g.id,
      };
    }
    var favItems = liveGroups.filter(function (g) { return g.fav; }).map(projItem);
    var actItems = liveGroups.filter(function (g) { return !g.fav; }).map(projItem);
    var grp = [];
    if (favItems.length) grp.push({ label: 'favoritos', items: favItems });
    if (actItems.length) grp.push({ label: 'activos', items: actItems });
    if (archivedGroups.length) grp.push({ label: 'archivados', items: [{ isArchived: true, id: '__archived', name: 'archivados', count: archivedGroups.length }] });
    var ci = [{ icon: 'target', active: state.activeProject === 'all', dot: null, proj: 'all' }];
    liveGroups.forEach(function (g) { ci.push({ icon: g.fav ? 'star' : 'repo', active: state.activeProject === g.id, dot: dominantDot(g.counts), proj: g.id }); });

    var status = {
      hooksConnected: !!snap.hooksConnected,
      tokensToday: formatTokens(snap.tokensToday || 0),
      activeCount: activeCount, attnCount: counts.attn,
      refreshSecs: 2, lastUpdate: relTime(snap.generatedAt || Date.now()),
    };

    return { counts: counts, tree: { active: state.activeProject, groups: grp, ci: ci }, status: status, cols: cols, liveGroups: liveGroups };
  }

  /* ── render ── */
  var lastView = null;
  function buildShell() {
    var view = (state.snapshot && api) ? transform(state.snapshot) : null;
    lastView = view;
    if (state.split) return buildSplit(view);
    var mf = activeModes().length ? state.modeFilter : null;
    var ver = (state.snapshot && state.snapshot.appVersion) ? 'v' + state.snapshot.appVersion : undefined;
    var o = view
      ? { counts: view.counts, tree: view.tree, status: view.status, modeFilter: mf, density: state.density, sortLabel: curSort().label, searchValue: (state.searchActive || state.search) ? state.search : '', version: ver }
      : { alert: true };
    var sidebar = state.collapsed ? C.sidebar(Object.assign({}, o, { collapsed: true })) : C.sidebar(o);
    var cols = view ? view.cols : undefined;
    var banner = (view && view.counts.attn > 0) ? attnBanner(view.counts.attn) : '';
    return '<div class="app">' + C.topbar(o) + banner +
      '<div class="main-row">' + sidebar + C.board(cols) + '</div>' +
      C.statusbar(o) + C.crt() + '</div>';
  }
  var rafPending = false;
  function render() {
    var root = document.getElementById('root');
    if (!root) return;
    root.innerHTML = buildShell();
    document.body.classList.toggle('compacto', state.density === 'compacto');
    document.body.classList.toggle('sb-collapsed', !!state.collapsed);   // el dock arranca a la derecha del sidebar
    applyFocusRing();
    injectPerms();
    applyUpdBtn();   // re-aplicar estado del botón "Actualizar" (el topbar se reconstruyó)
  }
  function scheduleRender() { if (rafPending) return; rafPending = true; requestAnimationFrame(function () { rafPending = false; render(); }); }
  function setSnapshot(snap) { state.snapshot = snap; scheduleRender(); if (state.detailId) refreshDetail(); }

  function applyFocusRing() {
    if (!state.focusSid) return;
    var el = document.querySelector('.card[data-sid="' + cssEsc(state.focusSid) + '"]');
    if (el) { el.style.boxShadow = '0 0 0 1px var(--border-strong)'; el.style.borderColor = 'var(--border-strong)'; }
  }
  function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  /* ── toast ── */
  function ensureToastWrap() {
    var w = document.querySelector('.toastwrap');
    if (!w) { w = document.createElement('div'); w.className = 'toastwrap'; document.body.appendChild(w); }
    return w;
  }
  function toast(msg, kind) {
    var w = ensureToastWrap();
    var t = document.createElement('div');
    t.className = 'cns-toast' + (kind ? ' ' + kind : '');
    t.innerHTML = '<span class="tdot"></span><span>' + esc(msg) + '</span>';
    w.appendChild(t);
    setTimeout(function () { t.style.transition = 'opacity .3s'; t.style.opacity = '0'; setTimeout(function () { t.remove(); }, 320); }, 2600);
  }
  // toast persistente y clickeable (p.ej. "actualización disponible")
  function actionToast(msg, url) {
    var w = ensureToastWrap();
    var t = document.createElement('div');
    t.className = 'cns-toast update';
    t.style.cursor = 'pointer';
    t.innerHTML = '<span class="tdot"></span><span>' + esc(msg) + '</span><span class="tx-go">' + C.svg('ext', 12, 2) + '</span>';
    t.addEventListener('click', function () { if (url) openExternalUrl(url); t.remove(); });
    w.appendChild(t);
    setTimeout(function () { if (t.parentNode) { t.style.transition = 'opacity .3s'; t.style.opacity = '0'; setTimeout(function () { t.remove(); }, 320); } }, 12000);
  }

  /* ── auto-update: botón del topbar + flujo (electron-updater) ──
     El topbar se re-renderiza con throttle → el estado del botón vive en
     state.upd y se RE-APLICA al DOM tras cada render (applyUpdBtn). */
  function applyUpdBtn() {
    var b = document.querySelector('.upbtn[data-act="update"]');
    if (!b) return;
    var u = state.upd;
    b.classList.remove('downloading', 'installing');
    if (!u || u.mode === 'hidden') { b.hidden = true; return; }
    b.hidden = false;
    if (u.mode === 'downloading') { b.classList.add('downloading'); b.style.setProperty('--upb-pct', (u.pct || 0) + '%'); }
    else if (u.mode === 'installing') { b.classList.add('installing'); }
    var tx = b.querySelector('.upbtn-tx'); if (tx && u.label != null) tx.textContent = u.label;
  }
  // Toast PERSISTENTE y clickeable: garantiza que el update sea accionable AUNQUE el topbar
  // esté tapado (p.ej. terminales maximizadas en "inicio"). Vive en .toastwrap (z-index 60,
  // por encima del dock maximizado) y NO se borra solo: refleja el estado y al click (cuando
  // hay update disponible) arranca la descarga.
  function applyUpdToast() {
    var u = state.upd;
    var w = ensureToastWrap();
    var t = w.querySelector('.cns-toast.update[data-upd]');
    if (!u || u.mode === 'hidden') { if (t) t.remove(); return; }
    if (!t) {
      t = document.createElement('div');
      t.className = 'cns-toast update';
      t.setAttribute('data-upd', '1');
      t.addEventListener('click', function () { if (state.upd && state.upd.mode === 'show') startUpdateDownload(); });
      w.appendChild(t);
    }
    var ver = (state.update && state.update.latest) ? ('v' + state.update.latest + ' ') : '';
    var label, icon = 'download', clickable = false;
    if (u.mode === 'show') { label = '⬆ Consomni ' + ver + '— Actualizar'; clickable = true; }
    else if (u.mode === 'downloading') { label = 'Descargando actualización… ' + (u.pct != null ? u.pct + '%' : ''); }
    else { label = 'Actualización lista · reiniciando…'; icon = 'check'; }
    t.style.cursor = clickable ? 'pointer' : 'default';
    t.innerHTML = '<span class="tdot"></span><span>' + esc(label) + '</span><span class="tx-go">' + C.svg(icon, 12, 2) + '</span>';
  }
  // available → (click en botón o toast) → progress* → downloaded → relanza. error → vuelve a "Actualizar".
  function onUpdatePhase(phase, data) {
    if (phase === 'available') { state.update = data; state.upd = { mode: 'show', label: 'Actualizar' }; }
    else if (phase === 'progress') { state.upd = { mode: 'downloading', label: (data && data.percent != null ? data.percent + '%' : 'Descargando…'), pct: data && data.percent }; }
    else if (phase === 'downloaded') { state.upd = { mode: 'installing', label: 'Reiniciando…' }; }
    else if (phase === 'error') { state.upd = { mode: 'show', label: 'Actualizar' }; toast('update: ' + ((data && data.error) || 'error'), 'err'); }
    else if (phase === 'none') { return; }
    applyUpdBtn(); applyUpdToast();
  }
  function startUpdateDownload() {
    if (!api || !api.updateDownload) { if (state.update && state.update.url) openExternalUrl(state.update.url); return; }
    state.upd = { mode: 'downloading', label: '0%', pct: 0 };
    applyUpdBtn(); applyUpdToast();
    api.updateDownload();
  }

  /* ── sesiones helpers ── */
  function sessionById(id) {
    var list = (state.snapshot && state.snapshot.sessions) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function visibleCards() { return Array.prototype.slice.call(document.querySelectorAll('.card[data-sid]')); }

  /* ════════ ACCIONES ════════ */
  // 'term' y 'dispatch' ya NO lanzan un wt externo: abren una terminal EMBEBIDA
  // (xterm + node-pty) a pantalla completa dentro de Consomni.
  function openEmbeddedTerminal(cwd, kind, resume, opts) {
    opts = opts || {};
    var T = window.ConsomniTerms;
    if (!T) { toast('terminales no disponibles', 'err'); return; }
    var go = function () { T.spawn(kind, cwd || undefined, 'right', { resume: resume || undefined, skip: opts.skip, proj: opts.proj, projName: opts.projName }); };
    if (api && api.term && api.term.available) {
      api.term.available().then(function (ok) {
        if (!ok) { toast('node-pty no se cargó (módulo nativo) — reinstalá deps', 'err'); return; }
        go();
      }).catch(go);
    } else { go(); }
  }
  // datos de proyecto de una sesión para taguear el panel (id = projKey, igual que la vista; name = lindo)
  function sProj(s, skip) { var o = s ? { proj: projKey(s), projName: s.project } : {}; if (skip) o.skip = true; return o; }
  // cwd + nombre representativo de un proyecto (por su projKey) desde el snapshot
  function projInfo(p) {
    var list = (state.snapshot && state.snapshot.sessions) || [], name = '', cwd = '';
    for (var i = 0; i < list.length; i++) { if (projKey(list[i]) === p) { if (!name) name = list[i].project || ''; if (list[i].cwd) { cwd = list[i].cwd; break; } } }
    return { cwd: cwd, name: name };
  }

  var REAL = { ext: 1, folder: 1, diff: 1, pr: 1, copy: 1, branch: 1, copyId: 1, transcript: 1 };
  function dispatchAction(act, sid) {
    var s = sid ? sessionById(sid) : (state.detailId ? sessionById(state.detailId) : (state.focusSid ? sessionById(state.focusSid) : null));
    if (act === 'x') { if (!sid && s) sid = s.id; if (sid) toggleSelect(sid); return; }
    if (act === 'pin') { if (s) api.setLocalState(s.id, { pinned: !s.pinned }).then(function (sn) { setSnapshot(sn); toast((s.pinned ? 'unpin' : 'pin') + ' · ' + s.name); }); return; }
    if (act === 'archive') { if (s) api.setLocalState(s.id, { archived: !s.archived }).then(function (sn) { setSnapshot(sn); toast('archivada · ' + s.name); }); return; }
    // ── terminales embebidas (tagueadas con el proyecto de la sesión) ──
    if (act === 'term') { openEmbeddedTerminal(s ? s.cwd : null, 'shell', null, sProj(s)); if (s) closeDetail(); return; }
    if (act === 'dispatch') { openEmbeddedTerminal(s ? s.cwd : null, 'claude', null, sProj(s)); if (s) closeDetail(); return; }
    if (act === 'dispatch-skip') { openEmbeddedTerminal(s ? s.cwd : null, 'claude', null, sProj(s, true)); if (s) closeDetail(); return; }
    if (act === 'resume') { if (!s) { toast('elegí una sesión', 'warn'); return; } openEmbeddedTerminal(s.cwd, 'claude', s.id, sProj(s)); closeDetail(); return; }
    if (REAL[act]) {
      if (!s) { toast('elegí una sesión primero', 'warn'); return; }
      if (!api || !api.action) { toast('acción no disponible', 'err'); return; }
      api.action(act, { sid: s.id, cwd: s.cwd, branch: s.branch, id: s.id }).then(function (r) {
        toast((r && r.ok ? (r.message || ('✓ ' + act)) : ('✗ ' + ((r && r.error) || act))), (r && r.ok) ? '' : 'err');
      }).catch(function () { toast('✗ ' + act, 'err'); });
      return;
    }
    // ── stubs honestos (control surface real de Claude Code no lo permite) ──
    if (act === 'approve' || act === 'deny') { toast('aprobar/denegar requiere interceptación bloqueante de permisos (opt-in, no instalado) — abrí la terminal de la sesión (t)', 'warn'); return; }
    if (act === 'reply') { toast('quick-reply a una sesión EN CURSO no es posible vía hooks — usá la terminal (t)', 'warn'); return; }
    if (act === 'pause' || act === 'skull') { toast('pausar/matar no lo expone el control surface de Claude Code (TODO)', 'warn'); return; }
    if (act === 'redo') { toast('re-dispatch — TODO', 'warn'); return; }
    toast('acción "' + act + '"', 'warn');
  }

  /* ════════ ATENCIÓN: banner E4 + inline approve/deny (.perm) ════════ */
  function attnBanner(n) {
    return '<div class="attn-banner"><span class="bdot"></span>' +
      '<span class="txt"><b>' + n + ' ' + (n === 1 ? 'sesión' : 'sesiones') + '</b> ' + (n === 1 ? 'necesita' : 'necesitan') + ' tu atención</span>' +
      '<button class="btn btn--amber btn--sm" data-act="go-attn">' + C.svg('chevR', 12, 2.4) + ' ir a la primera</button></div>';
  }
  function injectPerms() {
    var cards = document.querySelectorAll('.card--attn[data-sid]');
    Array.prototype.forEach.call(cards, function (card) {
      if (card.querySelector('.perm')) return;
      var s = sessionById(card.getAttribute('data-sid'));
      if (!s || !s.attnReason) return;
      var st = card.querySelector('.card-status'); if (st) st.style.display = 'none';
      var perm = document.createElement('div');
      perm.className = 'perm';
      perm.innerHTML =
        '<div class="q">esperando permiso para ejecutar:</div>' +
        '<div class="cmd"><span class="pfx">$</span> ' + esc(s.attnReason) + '</div>' +
        '<div class="btns">' +
          '<button class="btn btn--green" data-act="approve" data-sid="' + esc(s.id) + '">' + C.svg('check', 13, 2.4) + ' aprobar <kbd class="kbd" style="background:rgba(74,222,128,.15);border-color:rgba(74,222,128,.3);color:#4ade80">a</kbd></button>' +
          '<button class="btn btn--red" data-act="deny" data-sid="' + esc(s.id) + '">' + C.svg('x', 13, 2.4) + ' denegar <kbd class="kbd" style="background:rgba(239,68,68,.12);border-color:rgba(239,68,68,.3);color:#f87171">d</kbd></button>' +
        '</div>';
      card.appendChild(perm);
    });
  }

  /* ════════ SPLIT / GRID (E5) ════════ */
  function splitSessions() {
    var list = (state.snapshot && state.snapshot.sessions) || [];
    var sel = Object.keys(state.selected);
    var chosen;
    if (sel.length >= 2) chosen = sel.map(sessionById).filter(Boolean).slice(0, 4);
    else chosen = list.filter(function (s) { return s.state === 'working' || s.state === 'attn' || s.state === 'error'; }).sort(byPriority).slice(0, 3);
    if (chosen.length < 2) chosen = list.slice().sort(byPriority).filter(function (s) { return s.state !== 'closed'; }).slice(0, 3);
    return chosen;
  }
  function paneHtml(s) {
    var cls = s.state === 'working' ? 'active' : (s.state === 'attn' ? 'attn' : '');
    var lvl = lvlFor(s.ctxPct, s.state);
    var lvlCls = lvl === 'red' ? 'ctx-pct--red' : (lvl === 'amber' ? 'ctx-pct--amber' : '');
    var dotCls = s.state === 'working' ? 'green pulse' : (s.state === 'attn' ? 'amber pulse' : 'idle');
    var feed = (s.lastToolCalls || []).slice().reverse();
    var lines = feed.length ? feed.map(function (f, i) {
      return '<div class="ln" style="animation-delay:' + (i * 0.04) + 's"><span class="ts">' + fmtClock(f.ts).slice(0, 5) + '</span><span class="bd"><span class="tool" style="color:' + (toolColor[f.tool] || 'var(--text-2)') + '">' + esc(f.tool) + '</span> <span class="dim">' + esc(f.arg || '') + '</span></span></div>';
    }).join('') : '<div class="ln"><span class="ts"></span><span class="bd dim">sin actividad reciente</span></div>';
    if (s.state === 'working') lines += '<div class="ln"><span class="ts"></span><span class="bd"><span class="pfx">claude&gt;</span> ' + esc(s.statusEm || 'trabajando…') + '<span class="cur" style="background:var(--green)"></span></span></div>';
    else if (s.state === 'attn') lines += '<div class="ln"><span class="ts"></span><span class="bd"><span class="warn">⚠ ' + esc(s.attnReason || 'esperando aprobación…') + '</span><span class="cur" style="background:var(--amber)"></span></span></div>';
    return '<div class="pane ' + cls + '">' +
      '<div class="pane-head"><span class="dot dot--' + dotCls + '"' + (s.state === 'working' ? ' style="box-shadow:0 0 6px rgba(74,222,128,.6)"' : '') + '></span>' +
        '<span class="nm">' + esc(s.name) + '</span><span class="badge badge--' + s.mode + '">' + esc(s.mode) + '</span></div>' +
      '<div class="pane-sub"><span style="color:var(--text-2)">' + esc(s.project) + '</span><span class="sep">·</span>' +
        '<span class="ctx"><span class="ctx-fill ctx-fill--' + lvl + '" style="width:' + s.ctxPct + '%"></span></span>' +
        '<span class="' + lvlCls + '">' + s.ctxPct + '%</span><span style="margin-left:auto"><span style="color:' + stColor(s.state) + '">● ' + s.state + '</span></span></div>' +
      '<div class="term">' + lines + '</div>' +
      '<div class="pane-foot">' + C.svg('reply', 13, 1.7) + '<input placeholder="responder a ' + esc(s.name) + '…" data-reply="' + esc(s.id) + '"></div>' +
    '</div>';
  }
  function buildSplit(view) {
    var o = view ? { counts: view.counts, status: view.status, density: state.density, sortLabel: curSort().label } : { alert: true };
    var sessions = splitSessions();
    var n = Math.max(2, Math.min(4, sessions.length || 2));
    var panes = sessions.length ? sessions.map(paneHtml).join('') : '<div style="grid-column:1/-1;display:flex;align-items:center;justify-content:center;color:var(--text-3);font-size:12px">no hay sesiones activas para comparar — seleccioná con x</div>';
    var seg = [2, 3, 4].map(function (k) { return '<span' + (k === n ? ' class="on"' : '') + '>' + k + '</span>'; }).join('');
    var toolbar = '<div style="flex:none;display:flex;align-items:center;gap:10px;padding:9px 16px;border-bottom:1px solid var(--border-soft);font-size:11px;color:var(--text-3);">' +
      '<span class="row" style="gap:6px;color:#cfcfd4;font-size:12px;font-weight:600">' + C.svg('grid', 14, 1.8) + ' split</span>' +
      '<span style="color:var(--text-3)">' + sessions.length + ' sesiones · feeds en vivo</span>' +
      '<span style="margin-left:auto" class="row gap6"><span class="seg">' + seg + '</span>' +
      '<button class="iconbtn" data-act="exit-split" title="salir (esc)">' + C.svg('x', 15, 1.7) + '</button></span></div>';
    return '<div class="app">' + C.topbar(o) + toolbar +
      '<div class="grid" style="grid-template-columns:repeat(' + n + ',1fr)">' + panes + '</div>' +
      C.statusbar(o) + C.crt() + '</div>';
  }
  function enterSplit() { state.split = true; render(); }
  function exitSplit() { state.split = false; render(); }
  function toggleSelect(sid) { if (state.selected[sid]) delete state.selected[sid]; else state.selected[sid] = true; render(); }

  /* ════════ FILTROS / ORDEN / DENSIDAD / PROYECTO ════════ */
  function setActiveProject(p) {
    state.activeProject = p; state.focusSid = null;
    var T = window.ConsomniTerms;
    if (p === 'all') {
      // "todos" → se muestra como antes (board). Si veníamos de pantalla completa, salimos.
      if (T) { if (T.isMaximized()) T.minimize(); T.setView('__home__'); }
      render(); return;
    }
    // proyecto puntual → abrir SUS terminales DE UNA (pantalla completa)
    var info = projInfo(p);
    render();
    if (T) T.openProject(p, info.cwd, info.name);
  }
  function toggleMode(m) { if (state.modeFilter[m]) delete state.modeFilter[m]; else state.modeFilter[m] = true; render(); }
  function cycleMode() {
    var order = ['', 'ask', 'plan', 'edit', 'auto'];
    var cur = activeModes()[0] || '';
    var next = order[(order.indexOf(cur) + 1) % order.length];
    state.modeFilter = next ? (function () { var o = {}; o[next] = true; return o; })() : {};
    render();
  }
  function setSort(k) { state.sort = k; render(); closeSortMenu(); }
  function cycleSort() { var i = SORTS.findIndex(function (s) { return s.key === state.sort; }); state.sort = SORTS[(i + 1) % SORTS.length].key; render(); toast('orden: ' + curSort().label); }
  function setDensity(d) { state.density = d; render(); }
  function toggleDensity() { state.density = state.density === 'comodo' ? 'compacto' : 'comodo'; render(); }

  /* ── sort dropdown (popover) ── */
  function closeSortMenu() { var m = document.getElementById('sortMenu'); if (m) m.remove(); }
  function openSortMenu(anchor) {
    closeSortMenu();
    var r = anchor.getBoundingClientRect();
    var m = document.createElement('div');
    m.id = 'sortMenu';
    m.style.cssText = 'position:fixed;z-index:55;top:' + (r.bottom + 5) + 'px;left:' + r.left + 'px;background:var(--surface-raised);border:1px solid var(--border-hover);border-radius:8px;padding:5px;box-shadow:0 18px 44px -16px rgba(0,0,0,.7);min-width:150px;';
    m.innerHTML = SORTS.map(function (s) {
      return '<div class="sort-opt" data-sort="' + s.key + '" style="padding:7px 10px;border-radius:6px;font-size:12px;cursor:pointer;color:' + (s.key === state.sort ? 'var(--text-1)' : 'var(--text-2)') + ';' + (s.key === state.sort ? 'background:rgba(255,255,255,.05);' : '') + '">orden: ' + s.label + '</div>';
    }).join('');
    document.body.appendChild(m);
  }

  /* ════════ BÚSQUEDA ════════ */
  function activateSearch() { state.searchActive = true; render(); }
  function deactivateSearch(clear) { state.searchActive = false; if (clear) state.search = ''; render(); }

  /* ════════ NAVEGACIÓN (j/k/h/l) ════════ */
  function moveFocus(delta) {
    var cards = visibleCards();
    if (!cards.length) return;
    var idx = cards.findIndex(function (c) { return c.getAttribute('data-sid') === state.focusSid; });
    idx = idx < 0 ? 0 : Math.max(0, Math.min(cards.length - 1, idx + delta));
    state.focusSid = cards[idx].getAttribute('data-sid');
    render();
    var el = document.querySelector('.card[data-sid="' + cssEsc(state.focusSid) + '"]');
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  function moveColumn(delta) {
    var cols = Array.prototype.slice.call(document.querySelectorAll('.col'));
    if (!cols.length) return;
    var curEl = state.focusSid ? document.querySelector('.card[data-sid="' + cssEsc(state.focusSid) + '"]') : null;
    var curCol = curEl ? curEl.closest('.col') : null;
    var ci = cols.indexOf(curCol);
    ci = ci < 0 ? 0 : Math.max(0, Math.min(cols.length - 1, ci + delta));
    var firstCard = cols[ci].querySelector('.card[data-sid]');
    if (firstCard) { state.focusSid = firstCard.getAttribute('data-sid'); render(); firstCard.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' }); }
  }
  function goToAttention() {
    var list = (state.snapshot && state.snapshot.sessions) || [];
    var a = list.filter(function (s) { return s.state === 'attn'; }).sort(byPriority)[0];
    if (!a) { toast('no hay sesiones esperando atención'); return; }
    state.activeProject = 'all'; state.focusSid = a.id; render();
    var el = document.querySelector('.card[data-sid="' + cssEsc(a.id) + '"]');
    if (el) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
  }

  /* ════════ PANEL DE DETALLE (E2) ════════ */
  var toolColor = { Read: 'var(--blue-2)', Glob: 'var(--blue-2)', Grep: 'var(--amber-2)', Edit: 'var(--violet)', MultiEdit: 'var(--violet)', Write: 'var(--green)', Bash: 'var(--green)' };
  function fmtClock(ts) { try { var d = new Date(ts); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2); } catch (e) { return ''; } }

  function openDetail(id) {
    if (!id) return;
    state.detailId = id;
    renderDetail(sessionById(id), null);
    if (api && api.getSessionDetail) api.getSessionDetail(id).then(function (d) { if (state.detailId === id) renderDetail(sessionById(id), d); }).catch(function () {});
  }
  function refreshDetail() { if (state.detailId) { var s = sessionById(state.detailId); if (s) renderDetail(s, state._lastDetail); } }
  function closeDetail() { state.detailId = null; state._lastDetail = null; setOverlay(''); }

  function renderDetail(s, detail) {
    if (!s) { closeDetail(); return; }
    state._lastDetail = detail || state._lastDetail;
    var d = state._lastDetail;
    var lvl = lvlFor(s.ctxPct, s.state);
    var dotCls = s.state === 'working' ? 'dot dot--green pulse' : (s.state === 'attn' ? 'dot dot--amber pulse' : (s.state === 'error' ? 'dot dot--error' : 'dot dot--idle'));
    var ctxTokens = s.tokensTotal || 0;
    var counts = d ? d.counts : { edits: 0, bash: 0, reads: 0 };
    var files = d ? d.files : [];
    var subs = d ? d.subagents : [];
    var feed = (d && d.feed && d.feed.length) ? d.feed : (s.lastToolCalls || []);
    var costEst = ((s.tokensIn || 0) / 1e6 * 15 + (s.tokensOut || 0) / 1e6 * 75);

    var header =
      '<div class="pn-sec" style="padding-bottom:16px;">' +
        '<div class="row" style="gap:9px;margin-bottom:13px;">' +
          '<span class="' + dotCls + '" style="box-shadow:0 0 6px rgba(74,222,128,.6)"></span>' +
          '<span style="flex:1;font-size:15px;font-weight:600;color:var(--text-1)">' + esc(s.name) + '</span>' +
          '<span class="badge badge--' + s.mode + '">' + esc(s.mode) + '</span>' +
          '<button class="iconbtn" style="width:26px;height:26px" data-act="close-detail">' + C.svg('x', 14, 2) + '</button>' +
        '</div>' +
        '<div class="row" style="gap:10px;font-size:11px;color:var(--text-2)">' +
          '<span class="ctx-lg" style="flex:1"><span class="ctx-fill ctx-fill--' + lvl + '" style="width:' + s.ctxPct + '%"></span></span>' +
          '<span class="' + (lvl !== 'green' ? 'ctx-pct--' + lvl : '') + '" style="font-weight:600">' + s.ctxPct + '%</span>' +
        '</div>' +
        '<div class="row" style="gap:8px;margin-top:9px;font-size:11px;color:var(--text-3)">' +
          '<span class="row" style="gap:5px;color:var(--green)">' + C.svg('branch', 12, 1.7) + ' ' + esc(s.branch || '—') + '</span>' +
          '<span class="sep">·</span>' +
          '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(s.cwd || '') + '</span>' +
        '</div>' +
      '</div>';

    var resumen =
      '<div class="pn-sec"><div class="pn-lbl">RESUMEN</div>' +
        '<div class="sum-row"><span class="sum-k">sesión</span><span class="sum-v">' + esc(s.name) + '</span></div>' +
        '<div class="sum-row"><span class="sum-k">acciones</span><span class="sum-v"><b style="color:#cfcfd4">' + counts.edits + '</b> edits · <b style="color:#cfcfd4">' + counts.bash + '</b> bash · <b style="color:#cfcfd4">' + counts.reads + '</b> reads</span></div>' +
        '<div class="sum-row"><span class="sum-k">archivos</span><span class="sum-v">' + files.length + ' tocados</span></div>' +
        '<div class="sum-row"><span class="sum-k">estado</span><span class="sum-v"><span style="color:' + stColor(s.state) + '">' + s.state + '</span>' + (s.statusEm ? ' — <span style="color:#cfcfd4">' + esc(s.statusEm) + '</span>' : '') + (s.state === 'working' ? '<span class="caret"></span>' : '') + '</span></div>' +
      '</div>';

    var ctxWarn = s.ctxPct >= 90 ? '<span style="color:var(--red)">⚠ límite cerca</span>' : (s.ctxPct >= 75 ? '<span style="color:var(--amber)">⚠ acercándose al límite</span>' : '<span style="color:var(--text-4)">ok</span>');
    var contexto =
      '<div class="pn-sec"><div class="pn-lbl">CONTEXTO</div>' +
        '<div class="row" style="gap:11px"><span class="ctx-lg" style="flex:1"><span class="ctx-fill ctx-fill--' + lvl + '" style="width:' + s.ctxPct + '%"></span></span>' +
        '<span style="font-size:13px;color:' + (lvl === 'green' ? 'var(--text-1)' : 'var(--' + (lvl === 'red' ? 'red' : 'amber-2') + ')') + ';font-weight:600">' + s.ctxPct + '%</span></div>' +
        '<div class="row" style="justify-content:space-between;margin-top:7px;font-size:10.5px;color:var(--text-3)">' +
          '<span>' + formatTokens(ctxTokens) + ' / ' + formatTokens(s.windowSize) + ' tokens</span>' + ctxWarn + '</div>' +
      '</div>';

    var sid = String(s.id);
    var meta =
      '<div class="pn-sec"><div class="pn-lbl">METADATOS</div><div class="meta-grid">' +
        metaCell('modelo', s.model || '—') + metaCell('esfuerzo', s.effort || '—') +
        metaCell('entrada', formatTokens(s.tokensIn)) + metaCell('salida (Σ)', formatTokens(s.tokensOut)) +
        metaCell('cache', formatTokens(s.cache) + ' hit') + metaCell('ventana', formatTokens(s.windowSize)) +
        metaCell('actividad', relTime(s.lastActivity)) + metaCell('session id', sid.slice(0, 4) + '…' + sid.slice(-3)) +
      '</div></div>';

    var tokensSec =
      '<div class="pn-sec"><div class="row" style="justify-content:space-between;margin-bottom:11px">' +
        '<span class="pn-lbl" style="margin:0">TOKENS EN EL TIEMPO</span>' +
        '<span style="font-size:11px;color:var(--text-2)">costo est. <b style="color:#cfcfd4">$' + costEst.toFixed(2) + '</b></span></div>' +
        sparkline(s.ctxPct) +
      '</div>';

    var filesSec =
      '<div class="pn-sec"><div class="pn-lbl">ARCHIVOS TOCADOS</div>' +
        (files.length ? files.map(function (f) {
          return '<div class="file-row"><span style="color:var(--text-3)">' + C.svg('diff', 12, 1.7) + '</span><span style="flex:1">' + esc(f.name) + '</span><span class="add">×' + f.edits + '</span></div>';
        }).join('') : '<div style="font-size:11px;color:var(--text-4)">sin ediciones registradas</div>') +
      '</div>';

    var subsSec =
      '<div class="pn-sec"><div class="pn-lbl">SUBAGENTES (' + subs.length + ')</div>' +
        (subs.length ? subs.map(function (sa, i) {
          var br = i === subs.length - 1 ? '└─' : '├─';
          var dot = sa.state === 'working' ? '<span class="dot dot--green pulse" style="width:6px;height:6px"></span>' : '<span class="dot" style="width:6px;height:6px;background:var(--idle-dot)"></span>';
          return '<div class="tree-row"><span class="br">' + br + '</span>' + dot + '<span style="flex:1">' + esc(sa.name) + '</span><span style="color:var(--text-3);font-size:10px">' + sa.state + '</span></div>';
        }).join('') : '<div style="font-size:11px;color:var(--text-4)">sin subagentes</div>') +
      '</div>';

    var feedSec =
      '<div class="pn-sec"><div class="row" style="justify-content:space-between;margin-bottom:11px">' +
        '<span class="pn-lbl" style="margin:0">ACTIVIDAD EN VIVO</span>' +
        '<span class="row" style="gap:5px;font-size:10px;color:var(--green)"><span class="dot dot--green pulse" style="width:5px;height:5px;box-shadow:none"></span>live</span></div>' +
        '<div class="feed">' + (feed.length ? feed.slice().reverse().map(function (f, i) {
          return '<div class="feed-row" style="animation-delay:' + (i * 0.04) + 's"><span class="t">' + fmtClock(f.ts) + '</span>' +
            '<span class="tool" style="color:' + (toolColor[f.tool] || 'var(--text-2)') + '">' + esc(f.tool) + '</span>' +
            '<span class="arg">' + esc(f.arg || '') + '</span></div>';
        }).join('') : '<div style="font-size:11px;color:var(--text-4)">sin actividad reciente</div>') + '</div>' +
      '</div>';

    var actions = [['term', 'terminal acá'], ['dispatch', 'claude acá'], ['ext', 'VSCode'], ['copy', 'copiar path'], ['branch', 'copiar branch'], ['transcript', 'transcript'], ['diff', 'ver diff'], ['pin', s.pinned ? 'unpin' : 'pin'], ['pause', 'pausar'], ['skull', 'matar'], ['redo', 're-dispatch'], ['archive', 'archivar'], ['pr', 'abrir PR']];
    var actionbar =
      '<div class="actionbar"><div class="qreply"><span style="color:var(--green)">' + C.svg('reply', 14, 1.7) + '</span>' +
        '<input placeholder="responder a esta sesión… (r)" data-reply="' + esc(s.id) + '"><kbd class="kbd">⌘↵</kbd></div>' +
        '<div class="act-grid">' + actions.map(function (a) { return '<button class="act" data-act="' + a[0] + '" data-sid="' + esc(s.id) + '">' + C.svg(a[0], 12, 1.8) + a[1] + '</button>'; }).join('') + '</div>' +
      '</div>';

    var html = '<div class="scrim" data-act="close-detail"></div><aside class="panel">' + header +
      '<div class="pn-scroll">' + resumen + contexto + meta + tokensSec + filesSec + subsSec + feedSec + '</div>' + actionbar + '</aside>';
    setOverlay(html);
  }
  function metaCell(k, v) { return '<div class="meta-cell"><span class="k">' + esc(k) + '</span><span class="v">' + esc(v) + '</span></div>'; }
  function stColor(st) { return st === 'working' ? 'var(--green)' : (st === 'attn' ? 'var(--amber)' : (st === 'error' ? 'var(--error)' : 'var(--idle)')); }
  function sparkline(pct) {
    var pts = [], n = 14;
    for (var i = 0; i <= n; i++) { var x = (i / n) * 400; var y = 44 - (pct / 100) * 40 * (i / n) - (Math.sin(i) * 2); pts.push(x.toFixed(0) + ',' + Math.max(4, y).toFixed(0)); }
    var poly = pts.join(' ');
    return '<svg width="100%" height="46" viewBox="0 0 400 46" preserveAspectRatio="none" style="display:block">' +
      '<defs><linearGradient id="sg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgba(74,222,128,.25)"/><stop offset="1" stop-color="rgba(74,222,128,0)"/></linearGradient></defs>' +
      '<path d="M0,46 L' + poly.replace(/ /g, ' L') + ' L400,46 Z" fill="url(#sg)"/>' +
      '<polyline points="' + poly + '" fill="none" stroke="#4ade80" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  }

  /* ════════ COMMAND PALETTE (E3) ════════ */
  function openPalette() { state.paletteOpen = true; state.paletteQuery = ''; state.paletteSel = 0; renderPalette(); }
  function closePalette() { state.paletteOpen = false; setOverlay(''); }
  function paletteData() {
    var rows = [];
    rows.push({ group: 'DISPATCH', ic: 'plus', tx: 'Dispatch nueva sesión…', sub: 'lanzar con prompt + modo + modelo', keys: ['⌘', '↵'], act: 'dispatch' });
    rows.push({ group: 'DISPATCH', ic: 'grid', tx: 'Dispatch en paralelo (x3)', sub: 'mismo prompt, 3 worktrees', keys: [], act: 'dispatch' });
    var list = (state.snapshot && state.snapshot.sessions) || [];
    list.slice().sort(byPriority).slice(0, 40).forEach(function (s) {
      rows.push({ group: 'SESIONES', ic: s.state === 'attn' ? 'clock' : (s.state === 'error' ? 'warn' : 'target'), tx: s.name, sub: s.project + ' · ' + s.state + ' · ' + s.ctxPct + '%', keys: [], act: 'open', sid: s.id });
    });
    (lastView ? lastView.liveGroups : []).forEach(function (g) {
      rows.push({ group: 'PROYECTOS', ic: g.fav ? 'star' : 'repo', tx: 'Saltar a ' + g.name, sub: g.sessions.length + ' sesiones', keys: [], act: 'proj', proj: g.id });
    });
    rows.push({ group: 'ACCIONES', ic: 'ext', tx: 'Abrir sesión en VSCode', sub: '', keys: ['o'], act: 'a:ext' });
    rows.push({ group: 'ACCIONES', ic: 'term', tx: 'Abrir terminal', sub: '', keys: ['t'], act: 'a:term' });
    rows.push({ group: 'ACCIONES', ic: 'sliders', tx: 'Cambiar orden', sub: 'actual: ' + curSort().label, keys: ['s'], act: 'sort' });
    rows.push({ group: 'ACCIONES', ic: 'grid', tx: 'Ver en split / grid', sub: 'sesiones activas o seleccionadas', keys: [], act: 'split' });
    rows.push({ group: 'ACCIONES', ic: 'bell', tx: state.muted ? 'Desmutear notificaciones' : 'Mutear notificaciones', sub: '', keys: ['m'], act: 'mute' });
    rows.push({ group: 'ACCIONES', ic: 'gear', tx: 'Abrir settings', sub: '', keys: [], act: 'settings' });
    return rows;
  }
  function fuzzy(rows, q) {
    if (!q) return rows;
    var ql = q.toLowerCase();
    return rows.filter(function (r) { return (r.tx + ' ' + (r.sub || '')).toLowerCase().indexOf(ql) > -1; });
  }
  function renderPalette() {
    var all = fuzzy(paletteData(), state.paletteQuery);
    state.paletteRows = all;
    if (state.paletteSel >= all.length) state.paletteSel = Math.max(0, all.length - 1);
    var lastGroup = '';
    var body = all.map(function (r, i) {
      var head = (r.group !== lastGroup) ? '<div class="pal-group">' + r.group + '</div>' : '';
      lastGroup = r.group;
      var tx = hlQuery(r.tx, state.paletteQuery);
      return head + '<div class="pal-row' + (i === state.paletteSel ? ' sel' : '') + '" data-pi="' + i + '">' +
        '<span class="ic">' + C.svg(r.ic, 15, 1.8) + '</span>' +
        '<span class="tx">' + tx + (r.sub ? ' <span class="sub">' + esc(r.sub) + '</span>' : '') + '</span>' +
        '<span class="sc">' + (r.keys || []).map(function (k) { return '<kbd class="kbd">' + k + '</kbd>'; }).join('') + '</span></div>';
    }).join('');
    var q = state.paletteQuery ? '<span class="typed">' + esc(state.paletteQuery) + '</span><span class="cur"></span>' : '<span class="ph">buscar sesión / proyecto / acción…</span><span class="cur"></span>';
    var html = '<div class="cmd-scrim" data-act="close-palette"><div class="palette">' +
      '<div class="pal-input"><span style="color:var(--text-2)">' + C.svg('search', 17, 2) + '</span>' +
        '<span class="q">' + q + '</span><kbd class="kbd" style="font-size:10px">esc</kbd></div>' +
      '<div class="pal-body" id="palBody">' + (body || '<div class="pal-group">sin resultados</div>') + '</div>' +
      '<div class="pal-foot"><span class="it"><kbd class="kbd">↑</kbd><kbd class="kbd">↓</kbd> navegar</span>' +
        '<span class="it"><kbd class="kbd">↵</kbd> ejecutar</span><span class="it"><kbd class="kbd">⌘↵</kbd> dispatch</span>' +
        '<span style="margin-left:auto;color:var(--text-4)">consomni · fuzzy search</span></div></div></div>';
    setOverlay(html);
    var sel = document.querySelector('.pal-row.sel'); if (sel) sel.scrollIntoView({ block: 'nearest' });
  }
  function hlQuery(text, q) {
    if (!q) return esc(text);
    var idx = text.toLowerCase().indexOf(q.toLowerCase());
    if (idx < 0) return esc(text);
    return esc(text.slice(0, idx)) + '<span class="hl">' + esc(text.slice(idx, idx + q.length)) + '</span>' + esc(text.slice(idx + q.length));
  }
  function paletteExec(row, dispatch) {
    if (!row) return;
    if (row.act === 'open') { closePalette(); openDetail(row.sid); }
    else if (row.act === 'proj') { closePalette(); setActiveProject(row.proj); }
    else if (row.act === 'sort') { closePalette(); cycleSort(); }
    else if (row.act === 'split') { closePalette(); enterSplit(); }
    else if (row.act === 'mute') { closePalette(); toggleMute(); }
    else if (row.act === 'dispatch') { closePalette(); dispatchAction('dispatch', state.focusSid); }
    else if (row.act === 'settings') { closePalette(); openSettings(); }
    else if (row.act && row.act.indexOf('a:') === 0) { closePalette(); dispatchAction(row.act.slice(2), state.focusSid); }
    else closePalette();
  }

  function toggleMute() { state.muted = !state.muted; if (api && api.setMuted) api.setMuted(state.muted); toast(state.muted ? 'notificaciones muteadas' : 'notificaciones activas'); }

  /* ════════ HELP (?) ════════ */
  var HELP = [
    ['⌘K', 'command palette'], ['/', 'buscar'], ['j / k', 'navegar cards'], ['h / l', 'cambiar columna'],
    ['↵', 'expandir detalle'], ['space', 'peek'], ['esc', 'cerrar'], ['o', 'abrir VSCode'],
    ['t', 'terminal embebida'], ['⇧T', 'workspace terminales'], ['y / Y', 'copiar path / branch'], ['r', 'responder'],
    ['a / d', 'aprobar / denegar'], ['p', 'pin'], ['x', 'multi-select'], ['X', 'cerrar sesión'], ['⌘↵', 'dispatch claude'],
    ['⌘1..9', 'saltar a proyecto'], ['f', 'filtro de modo'], ['s', 'orden'], ['c', 'densidad'],
    ['m', 'mute'], ['g a', 'ir a atención'], ['?', 'esta ayuda']
  ];
  function openHelp() {
    var rows = HELP.map(function (h) { return '<div class="help-row"><kbd class="kbd">' + h[0] + '</kbd><span class="lbl">' + h[1] + '</span></div>'; }).join('');
    setOverlay('<div class="help-scrim" data-act="close-help"><div class="help-card"><h3>ATAJOS DE TECLADO</h3><div class="help-grid">' + rows + '</div></div></div>');
    state.helpOpen = true;
  }

  /* ════════ SETTINGS ════════ */
  function openSettings() {
    if (!api || !api.getConfig) { toast('settings no disponible', 'warn'); return; }
    Promise.all([api.getConfig(), api.getHooksStatus ? api.getHooksStatus() : Promise.resolve({})])
      .then(function (a) { renderSettings(a[0], a[1] || {}); });
  }
  function closeSettings() { state.settingsOpen = false; setOverlay(''); }
  function seg2(key, val, opts) {
    return '<span class="seg">' + opts.map(function (o) { return '<span' + (o[0] === val ? ' class="on"' : '') + ' data-set="' + key + '" data-val="' + o[0] + '">' + o[1] + '</span>'; }).join('') + '</span>';
  }
  function renderSettings(cfg, hooks) {
    state.settingsOpen = true;
    var dirs = (cfg.watchedDirs || []).map(function (d) {
      return '<div class="set-dir"><span class="p">' + esc(d) + '</span><span class="rm" data-rmdir="' + esc(d) + '" title="quitar">' + C.svg('x', 12, 2) + '</span></div>';
    }).join('');
    var hk = !!(hooks && hooks.installed);
    var html = '<div class="set-scrim" data-act="close-settings"><div class="set-card">' +
      '<div class="set-head"><span class="ttl">SETTINGS</span><button class="iconbtn" style="width:26px;height:26px" data-act="close-settings">' + C.svg('x', 14, 2) + '</button></div>' +
      '<div class="set-sec"><div class="lbl">EDITOR & TERMINAL</div>' +
        '<div class="set-row"><span class="k">editor preferido</span>' + seg2('editor', cfg.editor, [['code', 'VS Code'], ['cursor', 'Cursor']]) + '</div>' +
        '<div class="set-row"><span class="k">terminal preferida</span>' + seg2('terminal', cfg.terminal, [['wt', 'Win Terminal'], ['powershell', 'PowerShell']]) + '</div>' +
      '</div>' +
      '<div class="set-sec"><div class="lbl">DIRECTORIOS VIGILADOS (read-only)</div>' + dirs +
        '<div class="set-row" style="margin-top:8px"><input class="set-inp" id="setDirAdd" style="flex:1;width:auto" placeholder="C:\\ruta\\.claude\\projects"><button class="btn btn--sm" id="setDirAddBtn">' + C.svg('plus', 12, 2) + ' agregar</button></div>' +
      '</div>' +
      '<div class="set-sec"><div class="lbl">MONITOREO</div>' +
        '<div class="set-row"><span class="k">umbral de aviso de contexto (%)</span><input class="set-inp" id="setCtx" type="number" min="50" max="100" value="' + cfg.ctxWarnThreshold + '"></div>' +
        '<div class="set-row"><span class="k">refresh del statusbar (s)</span><input class="set-inp" id="setRefresh" type="number" min="1" max="60" value="' + Math.round((cfg.refreshMs || 2000) / 1000) + '"></div>' +
        '<div class="set-row"><span class="k">sonidos / notificaciones</span>' + seg2('sounds', cfg.sounds ? 'on' : 'off', [['on', 'on'], ['off', 'off']]) + '</div>' +
      '</div>' +
      '<div class="set-sec"><div class="lbl">HOOKS</div>' +
        '<div class="set-row"><span class="k">puerto del server</span><input class="set-inp" id="setPort" type="number" min="1024" max="65535" value="' + cfg.port + '"></div>' +
        '<div class="set-row"><span class="k">estado</span><span class="set-hooks"><span class="dot ' + (hk ? 'dot--green pulse' : 'dot--idle') + '" style="box-shadow:none"></span>' + (hk ? 'conectado' : 'desconectado') + '</span>' +
          '<button class="btn btn--sm ' + (hk ? 'btn--red' : 'btn--green') + '" id="setHooksBtn" data-hk="' + (hk ? '1' : '0') + '">' + (hk ? 'desinstalar' : 'instalar') + ' hooks</button></div>' +
        '<div style="font-size:10px;color:var(--text-4);margin-top:4px">backup automático en ~/.consomni/backups · merge no-destructivo · cero API de Anthropic</div>' +
      '</div>' +
      '<div class="set-sec"><div class="lbl">ACTUALIZACIONES</div>' +
        '<div class="set-row"><span class="k">buscar al iniciar</span>' + seg2('checkUpdates', cfg.checkUpdates !== false ? 'on' : 'off', [['on', 'on'], ['off', 'off']]) + '</div>' +
        '<div class="set-row"><span class="k" id="setUpdMsg">comprobar versión más reciente</span>' +
          '<button class="btn btn--sm" id="setUpdBtn">' + C.svg('redo', 12, 2) + ' buscar</button></div>' +
        '<div style="font-size:10px;color:var(--text-4);margin-top:4px">chequeo de sólo-lectura al repo del proyecto en GitHub · sin telemetría · es la única salida de red fuera de 127.0.0.1</div>' +
      '</div>' +
      '</div></div>';
    setOverlay(html);
    wireSettings(cfg);
  }
  function saveSetting(patch) {
    return api.saveConfig(patch).then(function (cfg) {
      if (api.getHooksStatus) return api.getHooksStatus().then(function (h) { renderSettings(cfg, h); });
      renderSettings(cfg, {});
    });
  }
  function wireSettings(cfg) {
    var card = document.querySelector('.set-card');
    if (!card) return;
    Array.prototype.forEach.call(card.querySelectorAll('[data-set]'), function (el) {
      el.addEventListener('click', function () {
        var key = el.getAttribute('data-set'), val = el.getAttribute('data-val');
        var patch = {};
        if (key === 'sounds' || key === 'checkUpdates') patch[key] = (val === 'on'); else patch[key] = val;
        saveSetting(patch);
      });
    });
    var ctx = card.querySelector('#setCtx'); if (ctx) ctx.addEventListener('change', function () { saveSetting({ ctxWarnThreshold: Math.max(50, Math.min(100, +ctx.value || 90)) }); });
    var rf = card.querySelector('#setRefresh'); if (rf) rf.addEventListener('change', function () { saveSetting({ refreshMs: Math.max(1, Math.min(60, +rf.value || 2)) * 1000 }); });
    var port = card.querySelector('#setPort'); if (port) port.addEventListener('change', function () { saveSetting({ port: Math.max(1024, Math.min(65535, +port.value || 4517)) }).then(function () { toast('puerto guardado — reinstalá hooks + reiniciá para aplicar', 'warn'); }); });
    var addBtn = card.querySelector('#setDirAddBtn'); if (addBtn) addBtn.addEventListener('click', function () {
      var inp = card.querySelector('#setDirAdd'); var v = (inp.value || '').trim(); if (!v) return;
      var d = (cfg.watchedDirs || []).slice(); if (d.indexOf(v) < 0) d.push(v); saveSetting({ watchedDirs: d });
    });
    Array.prototype.forEach.call(card.querySelectorAll('[data-rmdir]'), function (el) {
      el.addEventListener('click', function () {
        var d = (cfg.watchedDirs || []).filter(function (x) { return x !== el.getAttribute('data-rmdir'); });
        if (!d.length) { toast('tiene que quedar al menos un directorio', 'warn'); return; }
        saveSetting({ watchedDirs: d });
      });
    });
    var ub = card.querySelector('#setUpdBtn'); if (ub && api.checkUpdate) ub.addEventListener('click', function () {
      var msg = card.querySelector('#setUpdMsg'); ub.disabled = true; if (msg) msg.textContent = 'buscando…';
      api.checkUpdate().then(function (u) {
        ub.disabled = false;
        if (!msg) return;
        if (!u) { msg.textContent = 'no se pudo comprobar'; return; }
        if (u.error) { msg.textContent = 'sin conexión / sin releases (v' + u.current + ')'; }
        else if (u.hasUpdate) { msg.innerHTML = 'v' + esc(u.latest) + ' disponible · <a data-href="' + esc(u.url) + '" style="color:var(--green);cursor:pointer">abrir releases</a>'; }
        else if (u.latest) { msg.textContent = 'estás al día (v' + u.current + ')'; }
        else { msg.textContent = 'sin releases publicadas aún (v' + u.current + ')'; }
      }).catch(function () { ub.disabled = false; if (msg) msg.textContent = 'error al comprobar'; });
    });
    var hb = card.querySelector('#setHooksBtn'); if (hb) hb.addEventListener('click', function () {
      var wasInstalled = hb.getAttribute('data-hk') === '1';
      hb.textContent = '…';
      (wasInstalled ? api.uninstallHooks() : api.installHooks()).then(function (r) {
        toast(r && r.ok ? (wasInstalled ? 'hooks desinstalados · settings restaurado' : 'hooks instalados · backup hecho') : 'error', r && r.ok ? '' : 'err');
        openSettings();
      });
    });
  }

  /* ── overlay host ── */
  function setOverlay(html) { var o = document.getElementById('overlays'); if (o) o.innerHTML = html; if (!html) { state.helpOpen = false; state.settingsOpen = false; } }
  function anyOverlayOpen() { return state.paletteOpen || !!state.detailId || state.helpOpen || state.settingsOpen; }
  function closeOverlays() {
    if (state.paletteOpen) { closePalette(); return; }
    if (state.detailId) { closeDetail(); return; }
    if (state.settingsOpen) { closeSettings(); return; }
    if (state.helpOpen) { setOverlay(''); return; }
    if (state.searchActive || state.search) { deactivateSearch(true); return; }
    closeSortMenu();
  }

  /* ════════ EVENT DELEGATION (click) ════════ */
  function openExternalUrl(url) { if (api && api.action && url) api.action('openExternal', { url: url }).catch(function () {}); }

  document.addEventListener('click', function (e) {
    var t = e.target;
    closeSortMenu();

    // links externos (autor / github / releases) → navegador del SO
    var href = t.closest && t.closest('[data-href]');
    if (href) { e.preventDefault(); e.stopPropagation(); openExternalUrl(href.getAttribute('data-href')); return; }

    // sort menu options
    var opt = t.closest && t.closest('.sort-opt'); if (opt) { setSort(opt.getAttribute('data-sort')); return; }
    // palette row
    var prow = t.closest && t.closest('.pal-row'); if (prow && state.paletteOpen) { state.paletteSel = +prow.getAttribute('data-pi'); paletteExec(state.paletteRows[state.paletteSel], false); return; }
    // close overlays via scrim / buttons
    var actEl = t.closest && t.closest('[data-act]');
    if (actEl) {
      var act = actEl.getAttribute('data-act');
      if (act === 'close-detail') { closeDetail(); return; }
      if (act === 'close-palette') { if (t.classList.contains('cmd-scrim')) closePalette(); return; }
      if (act === 'close-help') { if (t.classList.contains('help-scrim')) setOverlay(''); return; }
      if (act === 'close-settings') { if (t.classList.contains('set-scrim') || actEl.tagName === 'BUTTON') closeSettings(); return; }
      if (act === 'settings') { openSettings(); return; }
      if (act === 'terminals') { if (window.ConsomniTerms) window.ConsomniTerms.toggle(); return; }
      if (act === 'theme') { toast('tema oscuro (único por ahora)', 'warn'); return; }
      if (act === 'go-attn') { goToAttention(); return; }
      if (act === 'exit-split') { exitSplit(); return; }
      if (act === 'update') { if (!actEl.classList.contains('downloading') && !actEl.classList.contains('installing')) startUpdateDownload(); return; }
      var ACTS = ['ext', 'term', 'folder', 'copy', 'x', 'redo', 'branch', 'transcript', 'diff', 'pin', 'pause', 'skull', 'archive', 'pr', 'approve', 'deny', 'reply', 'dispatch', 'copyId'];
      if (ACTS.indexOf(act) > -1) {
        var sidA = actEl.getAttribute('data-sid');
        // los qa-btn de la card no llevan data-sid: lo tomamos de la card contenedora
        if (!sidA && actEl.closest) { var pc = actEl.closest('.card[data-sid]'); if (pc) sidA = pc.getAttribute('data-sid'); }
        e.stopPropagation();
        dispatchAction(act, sidA);
        return;
      }
    }
    // topbar controls
    if (t.closest && t.closest('.board-add')) { openEmbeddedTerminal(null, 'shell'); return; }
    if (t.closest && t.closest('.cmdk')) { openPalette(); return; }
    if (t.closest && t.closest('.search')) { activateSearch(); return; }
    var seg = t.closest && t.closest('.seg span[data-density]'); if (seg) { setDensity(seg.getAttribute('data-density')); return; }
    var pill = t.closest && t.closest('.fpill[data-mode]'); if (pill) { toggleMode(pill.getAttribute('data-mode')); return; }
    var sortBtn = t.closest && t.closest('.tbtn'); if (sortBtn) { openSortMenu(sortBtn); return; }
    if (t.closest && t.closest('[data-act="sbtoggle"]')) { setSidebarCollapsed(!state.collapsed); return; }
    if (t.closest && t.closest('[data-act="home"]')) { state.activeProject = 'all'; render(); if (window.ConsomniTerms) window.ConsomniTerms.home(); return; }

    // ── CARDS PRIMERO (van adentro de la columna, que tiene data-proj) ──
    // closed row → detalle
    var crow = t.closest && t.closest('.closed-row[data-sid]'); if (crow) { openDetail(crow.getAttribute('data-sid')); return; }
    // card → abre/foco la conversación de esa sesión en el DOCK (abajo, no tapa todo)
    var card = t.closest && t.closest('.card[data-sid]');
    if (card) {
      var sid = card.getAttribute('data-sid');
      state.focusSid = sid;
      var sObj = sessionById(sid);
      if (window.ConsomniTerms) window.ConsomniTerms.openSession(sid, sObj ? sObj.name : 'sesión', sObj ? projKey(sObj) : '', sObj ? sObj.project : '');
      else openDetail(sid);
      return;
    }
    // sidebar / header de columna → filtrar por proyecto (DESPUÉS de las cards)
    var sb = t.closest && t.closest('[data-proj]'); if (sb) { setActiveProject(sb.getAttribute('data-proj')); return; }
  });

  /* ════════ KEYBOARD ════════ */
  var gPending = false;
  document.addEventListener('keydown', function (e) {
    var meta = e.metaKey || e.ctrlKey;
    var T = window.ConsomniTerms;

    // Si el foco está DENTRO del dock (xterm), las teclas van a la terminal; sólo Esc reacciona.
    var inDock = document.activeElement && document.activeElement.closest && document.activeElement.closest('#terminals');
    if (inDock) {
      if (e.key === 'Escape') { e.preventDefault(); if (T && T.isMaximized()) T.toggle(); else if (document.activeElement.blur) document.activeElement.blur(); }
      return;
    }
    // Abrir/cerrar el dock de terminales (Shift+T para no chocar con 't' = terminal de la card)
    if (!meta && (e.key === 'T')) { e.preventDefault(); T && T.toggle(); return; }

    // ⌘K abre palette desde cualquier lado
    if (meta && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); state.paletteOpen ? closePalette() : openPalette(); return; }

    // dentro de la palette
    if (state.paletteOpen) {
      if (e.key === 'Escape') { e.preventDefault(); closePalette(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); state.paletteSel = Math.min(state.paletteRows.length - 1, state.paletteSel + 1); renderPalette(); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); state.paletteSel = Math.max(0, state.paletteSel - 1); renderPalette(); return; }
      if (e.key === 'Enter') { e.preventDefault(); paletteExec(state.paletteRows[state.paletteSel], meta); return; }
      if (e.key === 'Backspace') { e.preventDefault(); state.paletteQuery = state.paletteQuery.slice(0, -1); state.paletteSel = 0; renderPalette(); return; }
      if (e.key.length === 1 && !meta) { e.preventDefault(); state.paletteQuery += e.key; state.paletteSel = 0; renderPalette(); return; }
      return;
    }

    // modo búsqueda activo
    if (state.searchActive) {
      if (e.key === 'Escape') { e.preventDefault(); deactivateSearch(true); return; }
      if (e.key === 'Enter') { e.preventDefault(); state.searchActive = false; render(); return; }
      if (e.key === 'Backspace') { e.preventDefault(); state.search = state.search.slice(0, -1); render(); return; }
      if (e.key.length === 1 && !meta) { e.preventDefault(); state.search += e.key; render(); return; }
      return;
    }

    // escape global
    if (e.key === 'Escape') {
      if (anyOverlayOpen() || state.search) { e.preventDefault(); closeOverlays(); return; }
      if (state.split) { e.preventDefault(); exitSplit(); return; }
      return;
    }

    // si un input tiene foco (qreply), no capturar
    if (document.activeElement && document.activeElement.tagName === 'INPUT') return;

    // chord "g a"
    if (gPending) { gPending = false; if (e.key === 'a') { e.preventDefault(); goToAttention(); return; } }
    if (e.key === 'g') { gPending = true; setTimeout(function () { gPending = false; }, 600); return; }

    // ⌘1..9 saltar a proyecto
    if (meta && e.key >= '1' && e.key <= '9') { e.preventDefault(); var gi = +e.key - 1; var lg = lastView ? lastView.liveGroups : []; if (lg[gi]) setActiveProject(lg[gi].id); return; }

    switch (e.key) {
      case '/': e.preventDefault(); activateSearch(); break;
      case 'k': moveFocus(-1); break;
      case 'j': moveFocus(1); break;
      case 'h': moveColumn(-1); break;
      case 'l': moveColumn(1); break;
      case 'Enter': if (state.focusSid) openDetail(state.focusSid); break;
      case ' ': if (state.focusSid) { e.preventDefault(); openDetail(state.focusSid); } break;
      case 'o': dispatchAction('ext', state.focusSid); break;
      case 't': dispatchAction('term', state.focusSid); break;
      case 'y': dispatchAction('copy', state.focusSid); break;
      case 'Y': dispatchAction('branch', state.focusSid); break;
      case 'r': dispatchAction('reply', state.focusSid); break;
      case 'a': dispatchAction('approve', state.focusSid); break;
      case 'd': dispatchAction('deny', state.focusSid); break;
      case 'p': dispatchAction('pin', state.focusSid); break;
      case 'x': if (state.focusSid) toggleSelect(state.focusSid); break;
      case 'X': dispatchAction('archive', state.focusSid); break;
      case 'f': cycleMode(); break;
      case 's': cycleSort(); break;
      case 'c': toggleDensity(); break;
      case 'm': toggleMute(); break;
      case '?': openHelp(); break;
      default: break;
    }
  });

  // cerrar sort menu al click afuera ya se maneja en el delegate (closeSortMenu al inicio)
  window.addEventListener('blur', function () { logoBlink.focused = false; });
  window.addEventListener('focus', function () { logoBlink.focused = true; });

  /* ════════ ONBOARDING + LOGO PARPADEANTE ════════ */
  var logoBlink = { timer: null, on: true, focused: true };
  function startLogoBlink() {
    stopLogoBlink();
    logoBlink.timer = setInterval(function () {
      if (!logoBlink.focused) return; // pausa al perder foco
      var img = document.getElementById('onbLogoImg');
      if (!img) { stopLogoBlink(); return; }
      logoBlink.on = !logoBlink.on;
      img.src = logoBlink.on ? 'assets/logo/cursor-on.png' : 'assets/logo/cursor-off.png';
    }, 500);
  }
  function stopLogoBlink() { if (logoBlink.timer) { clearInterval(logoBlink.timer); logoBlink.timer = null; } }

  function closeOnboarding() { setOverlay(''); stopLogoBlink(); }
  function showOnboarding() {
    setOverlay(
      '<div class="onb-scrim"><div class="onb-card">' +
        '<div class="onb-logo"><img id="onbLogoImg" src="assets/logo/cursor-on.png" alt="Consomni" width="138"></div>' +
        '<div class="onb-title">conectá Consomni a tus hooks</div>' +
        '<div class="onb-desc">Para ver el estado en vivo (working · atención · idle) Consomni instala hooks locales en <b>~/.claude/settings.json</b>. Se hace <b>backup</b> antes de tocar nada. Read-only sobre tus transcripts · sólo 127.0.0.1.</div>' +
        '<div class="onb-btns">' +
          '<button class="btn btn--green" id="onbInstall">' + C.svg('check', 13, 2.4) + ' instalar hooks</button>' +
          '<button class="btn btn--ghost" id="onbSkip">ahora no</button>' +
        '</div>' +
        '<div class="onb-foot">backup automático · merge no-destructivo · cero API de Anthropic</div>' +
        '<a class="onb-author" data-href="https://github.com/JoaquimColacilli" title="github.com/JoaquimColacilli">' + C.gh(12) + '<span>by <b>Joaquim Colacilli</b></span></a>' +
      '</div></div>');
    startLogoBlink();
    document.getElementById('onbSkip').addEventListener('click', function () { setOnboarded(); closeOnboarding(); });
    document.getElementById('onbInstall').addEventListener('click', function () {
      var btn = document.getElementById('onbInstall'); btn.textContent = 'instalando…';
      api.installHooks().then(function (r) {
        setOnboarded();
        var card = document.querySelector('.onb-card');
        if (r && r.ok) {
          stopLogoBlink();
          card.querySelector('.onb-btns').style.display = 'none';
          var ok = document.createElement('div'); ok.className = 'onb-ok';
          ok.innerHTML = C.svg('check', 13, 2.4) + ' hooks instalados · backup en ~/.consomni/backups';
          card.appendChild(ok);
          setTimeout(closeOnboarding, 1900);
        } else { btn.textContent = 'reintentar'; }
      }).catch(function () { btn.textContent = 'reintentar'; });
    });
  }
  function setOnboarded() { try { localStorage.setItem('consomni.onboarded', '1'); } catch (e) {} }
  function maybeOnboard() {
    if (!api || !api.getHooksStatus) return;
    var dismissed = false; try { dismissed = localStorage.getItem('consomni.onboarded') === '1'; } catch (e) {}
    api.getHooksStatus().then(function (st) { if (st && !st.installed && !dismissed) showOnboarding(); }).catch(function () {});
  }

  /* ── responsive + colapso manual del sidebar ──
     userCollapsed: null = automático (por ancho); true/false = forzado por el usuario. */
  function syncResponsive() {
    var should = (state.userCollapsed != null) ? state.userCollapsed : (window.innerWidth < BREAKPOINT);
    if (should !== state.collapsed) { state.collapsed = should; render(); }
  }
  function setSidebarCollapsed(v) { state.userCollapsed = !!v; if (state.collapsed !== !!v) { state.collapsed = !!v; render(); } }
  window.addEventListener('resize', syncResponsive);

  /* ── ticker: refresca "última actualización" sin re-render ── */
  setInterval(function () {
    if (!state.snapshot) return;
    var right = document.querySelector('.statusbar .right');
    if (right) right.textContent = 'auto-refresh 2s · última actualización ' + relTime(state.snapshot.generatedAt || Date.now());
  }, 1000);

  /* ── init ── */
  if (window.ConsomniTerms) {
    window.ConsomniTerms.setNotifier(toast);
    // botones del tab de sesión: claude acá / terminal / VSCode / detalle
    window.ConsomniTerms.setActionHandler(function (act, sid) {
      if (act === 'detail') { openDetail(sid); return; }
      dispatchAction(act, sid);
    });
    // pantalla completa de terminales → comprime el sidebar, pero NO de forma pegajosa:
    // al salir de pantalla completa, restaura el estado previo del sidebar.
    var preMaxCollapse; // undefined = no guardado
    window.ConsomniTerms.setMaxObserver(function (isMax) {
      if (isMax) {
        if (preMaxCollapse === undefined) preMaxCollapse = state.userCollapsed;
        setSidebarCollapsed(true);
      } else if (preMaxCollapse !== undefined) {
        state.userCollapsed = preMaxCollapse; preMaxCollapse = undefined;
        var should = (state.userCollapsed != null) ? state.userCollapsed : (window.innerWidth < BREAKPOINT);
        state.collapsed = should; render();
      }
    });
    // SIEMPRE arrancar en "inicio" con las terminales que quedaron de la sesión anterior
    try { window.ConsomniTerms.restoreSession(); } catch (e) {}
  }
  state.userCollapsed = null;
  state.collapsed = window.innerWidth < BREAKPOINT;
  if (api) {
    api.getSnapshot().then(setSnapshot).catch(function () { render(); });
    api.onSnapshot(setSnapshot);
    if (api.onJump) api.onJump(function (sid) { state.split = false; state.activeProject = 'all'; state.focusSid = sid; render(); openDetail(sid); });
    if (api.onUpdateEvent) api.onUpdateEvent(onUpdatePhase);
    maybeOnboard();
  } else {
    render();
  }

  window.__consomni = {
    state: state, render: render, transform: transform,
    openPalette: openPalette, openDetail: openDetail, openHelp: openHelp, openSettings: openSettings,
    setActiveProject: setActiveProject, activateSearch: activateSearch,
    toggleDensity: toggleDensity, showOnboarding: showOnboarding,
    enterSplit: enterSplit, exitSplit: exitSplit, dispatchAction: dispatchAction,
    firstSid: function () { var l = (state.snapshot && state.snapshot.sessions) || []; return l.length ? l[0].id : null; },
    simulateUpdate: onUpdatePhase,   // QA: __consomni.simulateUpdate('available'|'progress'|'downloaded', {…})
  };
})();
