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
    theme: 'dark',
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
    keptProjects: [],            // proyectos fijados al sidebar (projKey) — persistido en config
    hiddenProjects: [],          // proyectos marcados "esto no es un proyecto" (projKey) — fuera de board/sidebar/archivados; reversible
    confirmCloseTerminal: true,  // avisar antes de cerrar una terminal viva
    plansOpen: false,            // vista "Planes" (frentes: planes/specs/tareas detectados)
    planTodosOpen: {},           // estado abierto/cerrado de los checklists (sid → bool; sobrevive re-renders)
    frentes: {},                 // estado MANUAL por frente (projKey → {status,note}) — privado, persistido
    planDocs: {},                // cwd → [{path,name,mtime}] (docs plan/spec, cargados on-demand)
    libraryOpen: false,          // vista "Biblioteca" (prompts/skills/rules reutilizables)
    library: [],                 // entries de la biblioteca (cargadas de ~/.consomni/library.json)
    librarySeeded: true,         // ya se sembraron los ejemplos (idempotente; se setea al cargar)
    libFilter: { kind: '', tag: '', q: '' },   // filtros de la vista biblioteca
    libEditOpen: false,          // editor (modal) abierto
    libEditId: null,             // id en edición (null = item nuevo)
    nlHelper: false,             // helper "comando IA" en las terminales (opt-in)
    notifs: [],                  // centro de notificaciones (nuevas versiones, …) — persiste en notifications.json
    notifOpen: false,
    notifHistoryOpen: false,     // overlay "ver todas"
    changelogOpen: false,
    changelogAllOpen: false,     // pantalla full de Changelog (timeline de versiones)
  };

  /* ── estados manuales del frente (privados, on-brand con tokens) ── */
  var FRENTE_STATUS = [
    { key: '', label: 'sin estado', color: 'var(--text-4)' },
    { key: 'backlog', label: 'backlog', color: 'var(--text-3)' },
    { key: 'dev', label: 'en desarrollo', color: 'var(--green)' },
    { key: 'idea', label: 'idea', color: 'var(--violet)' },
    { key: 'pausado', label: 'pausado', color: 'var(--amber)' },
    { key: 'listo', label: 'listo', color: 'var(--blue-2)' }
  ];

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

    // un proyecto "kept" (fijado) sigue en el sidebar aunque no tenga sesiones activas (no cae a archivados)
    // los marcados "no es un proyecto" (hidden) salen de TODO (board, sidebar y archivados)
    var liveGroups = groups.filter(function (g) { return !isHidden(g.id) && (g.active > 0 || g.fav || isKept(g.id)); });
    var archivedGroups = groups.filter(function (g) { return !isHidden(g.id) && g.active === 0 && !g.fav && !isKept(g.id); });

    var boardGroups = (state.activeProject === '__archived') ? archivedGroups
      : (state.activeProject !== 'all') ? groups.filter(function (g) { return g.id === state.activeProject; })
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
      var gcwd = (g.sessions[0] && g.sessions[0].cwd) || '';
      return {
        id: g.id, name: g.name, fav: g.fav, count: g.sessions.length,
        meta: colMeta(g.counts), cards: openS.map(toCard),
        cwd: gcwd, diff: (snap.diffStats && snap.diffStats[g.id]) || null,
        closedCount: closedS.length,
        closed: closedS.map(function (s) { return { id: s.id, name: s.name, tokens: formatTokens(s.tokensTotal) }; }),
        // en la vista de UN proyecto, mostramos sus sesiones finalizadas abiertas (abajo, opacas); en "todos" quedan colapsadas
        openClosed: (state.activeProject !== 'all' && state.activeProject !== '__archived'),
        _empty: openS.length === 0 && closedS.length === 0,
      };
    });
    if (filtering) cols = cols.filter(function (c) { return !c._empty; });

    function projItem(g) {
      return {
        id: g.id, name: g.name, icon: g.fav ? 'star' : 'repo', fav: g.fav,
        dim: g.counts.working + g.counts.attn + g.counts.error === 0,
        minis: sbMinis(g.counts), active: state.activeProject === g.id,
        finished: g.active === 0,   // sin sesiones activas (vive por estar "kept") → mostrar 'x' para sacarlo
      };
    }
    var favItems = liveGroups.filter(function (g) { return g.fav; }).map(projItem);
    var actItems = liveGroups.filter(function (g) { return !g.fav; }).map(projItem);
    var grp = [];
    if (favItems.length) grp.push({ label: 'favoritos', items: favItems });
    if (actItems.length) grp.push({ label: 'activos', items: actItems });
    if (archivedGroups.length) grp.push({ label: 'archivados', items: [{ isArchived: true, id: '__archived', name: 'archivados', count: archivedGroups.length, active: state.activeProject === '__archived' }] });
    // "inicio" (vista activa) = dock maximizado mostrando '__home__'. Si es así, el marcador
    // activo va en INICIO, no en "todos" (aunque activeProject siga siendo 'all').
    var _T = window.ConsomniTerms;
    var homeView = !state.plansOpen && !state.libraryOpen && !!(_T && _T.isMaximized && _T.isMaximized() && _T.getView && _T.getView() === '__home__');
    var ci = [{ icon: 'target', active: !homeView && !state.plansOpen && !state.libraryOpen && state.activeProject === 'all', dot: null, proj: 'all' }];
    liveGroups.forEach(function (g) { ci.push({ icon: g.fav ? 'star' : 'repo', active: state.activeProject === g.id, dot: dominantDot(g.counts), proj: g.id }); });
    if (archivedGroups.length) ci.push({ icon: 'archive', active: state.activeProject === '__archived', dot: null, proj: '__archived' });

    var status = {
      hooksConnected: !!snap.hooksConnected,
      tokensToday: formatTokens(snap.tokensToday || 0),
      activeCount: activeCount, attnCount: counts.attn,
      refreshSecs: 2, lastUpdate: relTime(snap.generatedAt || Date.now()),
    };

    return { counts: counts, tree: { active: state.activeProject, home: homeView, plans: state.plansOpen, library: state.libraryOpen, groups: grp, ci: ci }, status: status, cols: cols, liveGroups: liveGroups };
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
      ? { counts: view.counts, tree: view.tree, status: view.status, modeFilter: mf, density: state.density, sortLabel: curSort().label, searchActive: !!state.searchActive, searchQuery: state.search || '', version: ver, light: state.theme === 'light' }
      : { alert: true, light: state.theme === 'light' };
    if (state.libraryOpen) return buildLibrary(o);
    if (state.plansOpen) return buildPlans(o);
    var sidebar = state.collapsed ? C.sidebar(Object.assign({}, o, { collapsed: true })) : C.sidebar(o);
    var cols = view ? view.cols : undefined;
    var banner = (view && view.counts.attn > 0) ? attnBanner(view.counts.attn) : '';
    return '<div class="app">' + C.topbar(o) + banner +
      '<div class="main-row">' + sidebar + C.board(cols) + '</div>' +
      C.statusbar(o) + C.crt() + '</div>';
  }
  var rafPending = false;
  var lastScrollView = '';   // vista del último render (el scroll sólo se restaura dentro de la MISMA vista)
  function render() {
    var root = document.getElementById('root');
    if (!root) return;
    // preservar el foco/caret de la nota de frente y del buscador de biblioteca entre re-renders (snapshots vivos)
    var ae = document.activeElement, noteKey = null, notePos = 0, libQ = false, libPos = 0;
    if (ae && ae.classList && ae.classList.contains('frente-note')) { noteKey = ae.getAttribute('data-frente'); try { notePos = ae.selectionStart; } catch (e0) {} }
    if (ae && ae.classList && ae.classList.contains('lib-search')) { libQ = true; try { libPos = ae.selectionStart; } catch (e0b) {} }
    // preservar scroll del board (los snapshots vivos re-renderizan: sin esto el scroll salta al inicio)
    // — sólo si la VISTA no cambió (el scroll de planes no debe aplicarse al board, etc.)
    var viewKey = (state.plansOpen ? 'plans' : state.libraryOpen ? 'lib' : 'board:' + (state.activeProject || ''));
    var sb = document.querySelector('main.board'), sbTop = sb ? sb.scrollTop : 0, sbLeft = sb ? sb.scrollLeft : 0;
    if (viewKey !== lastScrollView) { sbTop = 0; sbLeft = 0; }
    lastScrollView = viewKey;
    // preservar el estado abierto/cerrado de los checklists de Planes (interacción del usuario > default)
    document.querySelectorAll('.plan-card[data-sid] .plan-todos').forEach(function (dt) {
      var pcard = dt.closest('.plan-card'); if (pcard) state.planTodosOpen[pcard.getAttribute('data-sid')] = dt.open;
    });
    // preservar la altura custom (resize manual) de las notas de frente
    var noteHeights = {};
    document.querySelectorAll('.frente-note').forEach(function (na) { if (na.style.height) noteHeights[na.getAttribute('data-frente')] = na.style.height; });
    root.innerHTML = buildShell();
    var sb2 = document.querySelector('main.board');
    if (sb2 && (sbTop || sbLeft)) { sb2.scrollTop = sbTop; sb2.scrollLeft = sbLeft; }
    for (var nhKey in noteHeights) { var nh = document.querySelector('.frente-note[data-frente="' + cssEsc(nhKey) + '"]'); if (nh) nh.style.height = noteHeights[nhKey]; }
    document.body.classList.toggle('compacto', state.density === 'compacto');
    document.body.classList.toggle('sb-collapsed', !!state.collapsed);   // el dock arranca a la derecha del sidebar
    document.body.classList.toggle('view-archived', state.activeProject === '__archived');   // archivados: columnas en grilla (wrap), no scroll infinito a la derecha
    document.body.classList.toggle('plans-view', !!state.plansOpen);
    document.body.classList.toggle('library-view', !!state.libraryOpen);
    applyFocusRing();
    injectPerms();
    applyUpdBtn();   // re-aplicar estado del botón "Actualizar" (el topbar se reconstruyó)
    applyNotifBadge();   // badge del bell (el topbar se reconstruyó)
    if (TOUR.active) requestAnimationFrame(positionTour);   // el tutorial sigue pegado a su target
    if (noteKey) { var nn = document.querySelector('.frente-note[data-frente="' + cssEsc(noteKey) + '"]'); if (nn) { try { nn.focus(); nn.setSelectionRange(notePos, notePos); } catch (e1) {} } }
    if (libQ) { var ls = document.querySelector('.lib-search'); if (ls) { try { ls.focus(); ls.setSelectionRange(libPos, libPos); } catch (e2) {} } }
  }
  function scheduleRender() { if (rafPending) return; rafPending = true; requestAnimationFrame(function () { rafPending = false; render(); }); }
  // firma barata del snapshot: SÓLO los campos que afectan el board. Si no cambian, no reconstruimos el
  // DOM (causa #3 del lag en el renderer: cada push hacía root.innerHTML = buildShell() entero, lo que
  // además dispara los ResizeObserver de las terminales → refit + clear de atlas GPU de TODOS los paneles).
  // Las interacciones (filtros, modo, densidad, overlays) llaman render() DIRECTO → no pasan por este gate.
  function snapSig(snap) {
    if (!snap) return '';
    var parts = [];
    var ss = snap.sessions || [];
    for (var i = 0; i < ss.length; i++) {
      var s = ss[i];
      // lastActivity cuantizado a 5s y tokens a 1k: la escritura continua del transcript activo cambiaba
      // la firma en CADA push → innerHTML del board entero hasta 4×/s (la card muestra "hace Xs" y "45k"
      // igual de bien con granularidad gruesa; el push del main ya viene capado a 1/s además)
      parts.push(s.id + '|' + s.state + '|' + (s.ctxPct | 0) + '|' + ((s.tokensTotal / 1000) | 0) + '|' + s.mode + '|' + s.model +
        '|' + (s.statusText || '') + '|' + (s.statusEm || '') + '|' + (s.attnReason || '') + '|' + (((s.lastActivity || 0) / 5000) | 0) +
        '|' + (s.pinned ? 1 : 0) + '|' + (s.fav ? 1 : 0) + '|' + (s.branch || '') + '|' + (s.name || '') +
        '|' + (s.subagents ? s.subagents.length : 0) + '|' + (s.plan ? ((s.plan.todoAt || 0) + '.' + (s.plan.todos ? s.plan.todos.length : 0) + '.' + (s.plan.completed || 0) + '.' + (s.plan.inProgress || 0)) : 0));
    }
    parts.push('H' + (snap.hooksConnected ? 1 : 0) + 'T' + (snap.tokensToday || 0) + 'V' + (snap.appVersion || ''));
    var d = snap.diffStats || {}, dk = Object.keys(d).sort();
    for (var j = 0; j < dk.length; j++) { var dv = d[dk[j]]; parts.push(dk[j] + ':' + dv.added + '/' + dv.removed + '/' + dv.files); }
    return parts.join(';');
  }
  var lastSnapSig = null;
  function setSnapshot(snap) {
    state.snapshot = snap;
    var sig = snapSig(snap);
    if (sig !== lastSnapSig) { lastSnapSig = sig; scheduleRender(); maybeReloadPlanDocs(); }
    if (state.detailId) refreshDetail();
  }

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
      t.addEventListener('click', function () {
        if (!state.upd) return;
        // tras un error de descarga: el click abre la release de GitHub (instalador oficial) → nunca trabado.
        if (state.upd.err) { openExternalUrl((state.update && state.update.url) || 'https://github.com/JoaquimColacilli/consomni/releases'); return; }
        if (state.upd.mode === 'show') startUpdateDownload();
      });
      w.appendChild(t);
    }
    var ver = (state.update && state.update.latest) ? ('v' + state.update.latest + ' ') : '';
    var label, icon = 'download', clickable = false;
    if (u.err) { label = '⬆ Consomni ' + ver + '— no se pudo descargar · bajar instalador'; clickable = true; }
    else if (u.mode === 'show') { label = '⬆ Consomni ' + ver + '— Actualizar'; clickable = true; }
    else if (u.mode === 'downloading') { label = 'Descargando actualización… ' + (u.pct != null ? u.pct + '%' : ''); }
    else { label = 'Actualización lista · reiniciando…'; icon = 'check'; }
    t.style.cursor = clickable ? 'pointer' : 'default';
    t.innerHTML = '<span class="tdot"></span><span>' + esc(label) + '</span><span class="tx-go">' + C.svg(icon, 12, 2) + '</span>';
  }
  // semver compare local (espeja parseVer/isNewer del main; '1.9.10' > '1.9.9' lexicográfico daría false).
  function isNewerVer(latest, current) {
    function pv(v) { return String(v || '').replace(/^v/i, '').split(/[.\-+]/).map(function (n) { return parseInt(n, 10); }).filter(function (n) { return !isNaN(n); }); }
    var a = pv(latest), b = pv(current), len = Math.max(a.length, b.length);
    for (var i = 0; i < len; i++) { var x = a[i] || 0, y = b[i] || 0; if (x > y) return true; if (x < y) return false; }
    return false;
  }
  // ÚNICO punto que prende el botón "Actualizar": setea state.upd (lo que gobierna applyUpdBtn) + guarda
  // el update + notifica. Idempotente (addNotif dedupea por id). Lo usan TODOS los caminos (auto, "buscar"
  // de Settings, click en la notificación, re-pull al boot) → ninguno queda como callejón sin salida.
  function markUpdateAvailable(data, skipNotif) {
    if (!data || !data.latest) return;
    state.update = data;
    state.upd = { mode: 'show', label: 'Actualizar' };
    // skipNotif lo pasan SÓLO los hooks de QA → nunca escriben el store persistido de notificaciones
    // (los caminos reales —auto, "buscar", notif, boot— sí notifican).
    if (!skipNotif) addUpdateNotif(data);
    applyUpdBtn(); applyUpdToast();
  }
  // available → (click en botón o toast) → progress* → downloaded → relanza. error → "Actualizar" + fallback.
  function onUpdatePhase(phase, data, opts) {
    if (phase === 'available') {
      // ignorar el available redundante mientras ya bajamos/instalamos (el check interno de downloadUpdate
      // re-dispara update-available → sin esto el estado "downloading" se resetearía a "Actualizar").
      if (state.upd && (state.upd.mode === 'downloading' || state.upd.mode === 'installing')) return;
      markUpdateAvailable(data, opts && opts.qa); return;   // opts.qa (sólo QA) → no persiste notif
    }
    else if (phase === 'progress') { state.upd = { mode: 'downloading', label: (data && data.percent != null ? data.percent + '%' : 'Descargando…'), pct: data && data.percent }; }
    else if (phase === 'downloaded') { state.upd = { mode: 'installing', label: 'Reiniciando…' }; }
    // error: queda accionable → reintentar la descarga in-app O bajar el instalador (red de seguridad).
    else if (phase === 'error') { state.upd = { mode: 'show', label: 'Actualizar', err: true }; toast('No se pudo descargar · podés bajar el instalador', 'err'); }
    else if (phase === 'none') { return; }
    applyUpdBtn(); applyUpdToast();
  }
  function startUpdateDownload() {
    // Si hay una sesión de claude VIVA, avisar: actualizar baja + cierra la app y CORTA la sesión en vivo.
    // (reusa el modal .cfm-* vía pendingClose; sin el checkbox cccDont → no toca confirmCloseTerminal)
    try {
      var T = window.ConsomniTerms;
      if (T && T.hasActiveClaudeSessions && T.hasActiveClaudeSessions()) { confirmUpdateThenDownload(); return; }
    } catch (e) {}
    doUpdateDownload();
  }
  function confirmUpdateThenDownload() {
    pendingClose = doUpdateDownload;
    var html = '<div class="cfm-scrim" data-act="cfm-cancel"><div class="cfm-card" role="dialog" aria-modal="true">' +
      '<div class="cfm-ttl">' + C.svg('warn', 16, 1.9) + ' ¿Actualizar ahora?</div>' +
      '<div class="cfm-body">Tenés una <b>sesión de Claude activa</b>. Actualizar <b>cierra la app</b> y se <b>corta la sesión en vivo</b>. El transcript queda en disco — la reanudás después con <b>responder</b> (<code>claude --resume</code>).</div>' +
      '<div class="cfm-btns">' +
        '<button class="btn btn--sm" data-act="cfm-cancel">seguir trabajando</button>' +
        '<button class="btn btn--sm btn--green" data-act="cfm-ok">actualizar ahora</button>' +
      '</div></div></div>';
    setOverlay(html);
  }
  function doUpdateDownload() {
    if (!api || !api.updateDownload) { if (state.update && state.update.url) openExternalUrl(state.update.url); return; }
    state.upd = { mode: 'downloading', label: '0%', pct: 0 };
    applyUpdBtn(); applyUpdToast();
    api.updateDownload();
  }

  /* ════════ NOTIFICACIONES (centro + changelog de la versión) ════════
     Módulo simple: avisa nuevas versiones; al click → modal con el changelog
     (release notes del repo, render markdown SEGURO). Extensible a futuro. */
  // Persistencia: la LISTA vive en ~/.consomni/notifications.json (localStorage no es confiable bajo file://).
  // Cada notif tiene `read`; el badge cuenta las NO leídas. Sobreviven reinicios/updates → solo se van al "limpiar".
  var notifPersistTimer = null;
  function persistNotifs() {
    if (notifPersistTimer) clearTimeout(notifPersistTimer);
    notifPersistTimer = setTimeout(function () {
      try { if (api && api.saveNotifications) api.saveNotifications({ notifs: state.notifs.slice(0, 60) }); } catch (e) {}
    }, 300);
  }
  function addNotif(n) {
    if (!n || !n.id) return;
    for (var i = 0; i < state.notifs.length; i++) if (state.notifs[i].id === n.id) {
      var wasRead = state.notifs[i].read;
      state.notifs[i] = Object.assign(state.notifs[i], n);
      state.notifs[i].read = wasRead;                 // dedupe NO la resucita como no-leída
      applyNotifBadge(); persistNotifs(); return;
    }
    n.ts = n.ts || Date.now();
    if (n.read == null) n.read = false;
    state.notifs.unshift(n);
    if (state.notifs.length > 60) state.notifs.length = 60;
    applyNotifBadge(); persistNotifs();
  }
  function addUpdateNotif(data) {
    if (!data || !data.latest) return;
    addNotif({ id: 'update-' + data.latest, kind: 'update', title: 'Nueva versión ' + (data.name ? data.name : 'v' + data.latest), body: 'Tocá para ver las novedades de esta versión.', data: data });
  }
  function unreadCount() { return state.notifs.filter(function (n) { return n.read !== true; }).length; }
  function applyNotifBadge() {
    var b = document.querySelector('.notif-badge'); if (!b) return;
    var c = unreadCount();
    if (c > 0) { b.hidden = false; b.textContent = c > 9 ? '9+' : String(c); } else { b.hidden = true; }
  }
  // abrir el panel / historial = "leídas" → limpia el badge, pero NO las saca del historial (solo el "limpiar" lo hace)
  function markAllSeen() { state.notifs.forEach(function (n) { n.read = true; }); applyNotifBadge(); persistNotifs(); }
  function closeNotifPanel() { state.notifOpen = false; var p = document.getElementById('notifPanel'); if (p) p.remove(); }
  function notifById(id) { for (var i = 0; i < state.notifs.length; i++) if (state.notifs[i].id === id) return state.notifs[i]; return null; }
  function notifRowHtml(n) {
    var unseen = n.read !== true;
    var ic = n.kind === 'update' ? 'download' : 'bell';
    return '<div class="ntf-row' + (unseen ? ' unseen' : '') + (n.kind === 'update' ? ' clickable' : '') + '" data-notif="' + esc(n.id) + '">' +
      '<span class="ntf-ic">' + C.svg(ic, 15, 1.8) + '</span>' +
      '<span class="ntf-bd"><span class="ntf-ttl">' + esc(n.title) + '</span><span class="ntf-tx">' + esc(n.body || '') + '</span><span class="ntf-ts">' + relTime(n.ts) + '</span></span>' +
      (n.kind === 'update' ? '<span class="ntf-go">' + C.svg('chevR', 13, 2.2) + '</span>' : '') +
    '</div>';
  }
  function openNotifPanel() {
    closeNotifPanel(); closeSortMenu();
    state.notifOpen = true;
    var anchor = document.querySelector('.notif-bell');
    var r = anchor ? anchor.getBoundingClientRect() : { bottom: 52 };
    var p = document.createElement('div');
    p.id = 'notifPanel'; p.className = 'notif-panel';
    p.style.top = (r.bottom + 7) + 'px';
    var recent = state.notifs.slice(0, 6);
    var rows = recent.length ? recent.map(notifRowHtml).join('') : '<div class="ntf-empty">' + C.svg('check', 16, 2) + ' estás al día · sin novedades</div>';
    p.innerHTML = '<div class="ntf-head"><span class="ntf-h-ttl">NOTIFICACIONES</span>' +
      (state.notifs.length ? '<button class="ntf-clear" data-act="notif-clear">limpiar</button>' : '') + '</div>' +
      '<div class="ntf-list">' + rows + '</div>' +
      (state.notifs.length ? '<div class="ntf-foot"><button class="ntf-all" data-act="notif-all">ver todas (' + state.notifs.length + ')</button></div>' : '');
    document.body.appendChild(p);
    markAllSeen();
  }
  // historial completo (apartado de notificaciones): overlay on-brand reusando las clases del changelog
  function openNotifHistory() {
    closeNotifPanel();
    state.notifHistoryOpen = true;
    var rows = state.notifs.length ? state.notifs.map(notifRowHtml).join('') : '<div class="ntf-empty">' + C.svg('check', 16, 2) + ' sin notificaciones todavía</div>';
    var html = '<div class="cl-scrim" data-act="close-notif-history"><div class="cl-card" role="dialog" aria-modal="true">' +
      '<div class="cl-head"><span class="cl-eye">' + C.svg('bell', 18, 1.8) + '</span>' +
        '<div class="cl-hh"><span class="cl-ttl">Notificaciones</span><span class="cl-sub">todas tus novedades</span></div>' +
        '<button class="iconbtn" style="width:28px;height:28px" data-act="close-notif-history">' + C.svg('x', 14, 2) + '</button></div>' +
      '<div class="cl-body">' + rows + '</div>' +
      '<div class="cl-foot">' +
        (state.notifs.length ? '<button class="btn btn--ghost btn--sm" data-act="notif-clear">' + C.svg('x', 12, 2) + ' limpiar</button>' : '') +
        '<span style="flex:1"></span>' +
        '<button class="btn btn--sm" data-act="close-notif-history">cerrar</button>' +
      '</div></div></div>';
    setOverlay(html);
    markAllSeen();
  }
  function closeNotifHistory() { state.notifHistoryOpen = false; setOverlay(''); }

  function openChangelog(data) {
    if (!data) return;
    state.changelogOpen = true;
    var ver = data.latest ? ('v' + data.latest) : '';
    var notes = data.notes ? notesToHtml(data.notes) : '<p class="cl-p cl-empty">Sin notas de versión publicadas todavía. Mirá el detalle en GitHub.</p>';
    var canDownload = !!(api && api.updateDownload) && state.upd && (state.upd.mode === 'show' || state.upd.mode === 'downloading');
    var hasErr = !!(state.upd && state.upd.err);   // última descarga in-app falló → ofrecer el instalador
    var dlUrl = esc(data.url || 'https://github.com/JoaquimColacilli/consomni/releases');
    // Red de seguridad: si falló la descarga, el link de la izquierda pasa a "descargar instalador"
    // (release oficial de GitHub) — bajada segura desde adentro, sin tener que buscar el bundle a mano.
    var leftBtn = hasErr
      ? '<a class="btn btn--ghost btn--sm" data-href="' + dlUrl + '">' + C.svg('download', 12, 2) + ' descargar instalador</a>'
      : '<a class="btn btn--ghost btn--sm" data-href="' + dlUrl + '">' + C.svg('ext', 12, 2) + ' ver en GitHub</a>';
    var html = '<div class="cl-scrim" data-act="close-changelog"><div class="cl-card" role="dialog" aria-modal="true">' +
      '<div class="cl-head"><span class="cl-eye">' + C.eye(22, false) + '</span>' +
        '<div class="cl-hh"><span class="cl-ttl">Novedades ' + esc(ver) + '</span>' +
          '<span class="cl-sub">' + esc(data.name ? data.name : 'Consomni') + '</span></div>' +
        '<button class="iconbtn" style="width:28px;height:28px" data-act="close-changelog">' + C.svg('x', 14, 2) + '</button></div>' +
      '<div class="cl-body">' + notes + '</div>' +
      '<div class="cl-foot">' + leftBtn +
        '<span style="flex:1"></span>' +
        (canDownload ? '<button class="btn btn--green btn--sm" data-act="changelog-update">' + C.svg('download', 13, 2) + (hasErr ? ' Reintentar' : ' Actualizar ahora') + '</button>' : '<button class="btn btn--sm" data-act="close-changelog">listo</button>') +
      '</div></div></div>';
    setOverlay(html);
  }
  function closeChangelog() { state.changelogOpen = false; setOverlay(''); }

  /* ════════ CHANGELOG COMPLETO (pantalla full, timeline de versiones) ════════
     Registro local (offline, sin red, sin emojis) de TODO lo que se fue haciendo.
     Al sacar una versión nueva: agregar su entrada acá arriba (newest-first). */
  var CHANGELOG = [
    { v: '1.9.23', date: '04 jul 2026', title: 'Modo eco: la app gasta MUCHO menos CPU, GPU, disco y batería', items: [
      'Con la ventana minimizada u oculta, Consomni deja de trabajar: no parsea transcripts, no corre git, no actualiza la UI (al volver, se pone al día al instante). Tus terminales y claude siguen corriendo exactamente igual — sólo se pausa el monitoreo.',
      'El badge de cambios (+N/−N) ya no relee el contenido de tus archivos nuevos en cada recálculo (hasta 50MB de disco cada 3 segundos): ahora cachea por archivo y sólo relee lo que cambió. Con batería, además, se recalcula cada ~30s.',
      'Con claude activo, el tablero se reconstruía hasta 4 veces por segundo; ahora máximo 1 (imperceptible, y el primer cambio tras quietud sigue siendo inmediato).',
      'Las terminales tienen control de flujo real (el mecanismo de VS Code): si un proceso escupe output más rápido de lo que se puede dibujar, se pausa la lectura unos milisegundos en vez de acumular hasta 50MB en memoria. El output además se agrupa (~8ms) → muchos menos mensajes internos.',
      'El historial por terminal (scrollback) ahora es configurable en Ajustes (3k/5k/12k líneas; default 5k ≈ 12MB menos de RAM por terminal llena que antes) y el cursor sólo parpadea en la terminal enfocada.',
      'El visor de archivos en vivo ya no relee y remanda hasta 1MB por segundo si el archivo no cambió (chequea la fecha de modificación primero).',
      'Menos I/O de fondo: el listado de sesiones se cachea (antes se recorrían todos tus proyectos en disco hasta 4 veces por segundo), el detalle de una sesión no se re-parsea si el transcript no cambió, y los git de fondo usan --no-optional-locks para no interferir con tu git.',
    ] },
    { v: '1.9.22', date: '04 jul 2026', title: 'Planes detecta tus tareas siempre + muchas terminales sin bugs visuales', items: [
      'El tablero de Planes ahora lee las tareas del store que Claude Code guarda en disco (tasks/<sesión>/*.json) en vez de pescarlas del final del transcript. En sesiones largas (transcripts de varios MB) las tareas quedaban fuera del tramo leído y el frente no aparecía: ahora aparece con el estado SIEMPRE actual, y con su título real.',
      'Con muchas terminales abiertas, el texto ya no se corrompe al cambiar de foco: el render por GPU ahora vive sólo en los paneles VISIBLES (los minimizados o de otras vistas liberan su contexto gráfico y lo recuperan al mostrarse).',
      'Los paneles del mosaico ya no se aplastan hasta ser ilegibles: cada terminal mantiene un ancho mínimo usable y el mosaico scrollea. En paneles angostos, la cabecera muestra sólo los controles vitales (minimizar/fijar/cerrar).',
      'En la barra de terminales, el chip de la terminal enfocada se trae solo a la vista (con muchas pestañas quedaba fuera del carrusel).',
      'La vista Planes ya no pierde el scroll, ni el estado de los checklists, ni la altura de tu nota cuando llega actividad nueva; los frentes 100% terminados se atenúan para que el ojo vaya a lo pendiente; y los docs de plan/spec del repo se descubren más profundo (hasta 5 niveles) y se refrescan solos.',
    ] },
    { v: '1.9.21', date: '04 jul 2026', title: 'Un worktree ya no es "otro proyecto" + renombrar terminales + visor sin scroll horizontal', items: [
      'Las sesiones que trabajan en un worktree git (una branch aislada, tipo pb-124-reconcile) ahora se agrupan en su repo REAL en vez de fabricar un proyecto por branch. La branch se sigue viendo en la card; las acciones (terminal, editor, diff) siguen yendo al worktree donde está el laburo.',
      'Renombrá cualquier terminal o sesión del dock con click derecho en su chip de la barra de sesiones o en la cabecera del panel (las shells abiertas a mano quedaban "sin nombre"). Enter guarda, vacío vuelve al nombre automático, y el nombre sobrevive al reiniciar.',
      'El visor de archivos ya no scrollea horizontal: las líneas largas envuelven (los bloques de código de la vista .md conservan su scroll propio).',
      'Una sesión corrida en la raíz de un disco (C:\\) ya no aparece como proyecto sin nombre.',
    ] },
    { v: '1.9.20', date: '03 jul 2026', title: 'Los archivos que claude nombra se abren aunque vivan en otro proyecto', items: [
      'Al clickear un archivo mencionado por su nombre pelado (sin ruta) en el chat o la terminal, el visor a veces decía "no se pudo leer": el archivo existía, pero en OTRO proyecto. Ahora Consomni lo busca en tus proyectos conocidos y lo abre igual (el panel se redirige al archivo real y el sync en vivo sigue ese archivo).',
      'Si de verdad no existe, el error ahora dice QUÉ archivo no encontró (antes era un "no se pudo leer" genérico).',
    ] },
    { v: '1.9.19', date: '03 jul 2026', title: 'Ctrl+C copia en la terminal de claude (con texto seleccionado)', items: [
      'En la terminal de claude, Ctrl+C con texto seleccionado ahora COPIA (como en cualquier consola de Windows); sin selección sigue interrumpiendo a claude, como siempre.',
      'Sin conflictos: copiar consume la selección, así que un segundo Ctrl+C siempre interrumpe. Y si un redibujo de claude te borra el resaltado justo antes de copiar, Consomni igual copia lo que habías seleccionado (solo por unos segundos — un Ctrl+C tardío para interrumpir nunca copia algo viejo).',
      'Ctrl+Shift+C sigue copiando siempre, por si preferís el gesto explícito.',
    ] },
    { v: '1.9.18', date: '01 jul 2026', title: 'El selector de "/" ya no se queda tildado al volver a la app', items: [
      'Si volvías a Consomni después de tenerla de fondo un rato, a veces el "/" no abría el selector de comandos en la terminal de claude hasta escribir y borrar una letra a mano. Ahora se destraba solo apenas la ventana vuelve a tener foco.',
    ] },
    { v: '1.9.17', date: '29 jun 2026', title: 'Ctrl+C que no se traba + barra de terminales arrastrable + arreglo del texto distorsionado', items: [
      'En la terminal de claude, Ctrl+C ahora SIEMPRE interrumpe (como en cualquier consola) — antes a veces copiaba y a veces intentaba cerrar claude. Para copiar usá Ctrl+Shift+C (y si apretás Ctrl+C con texto seleccionado, te lo recuerda).',
      'Arreglado: la terminal activa a veces se veía con el texto distorsionado o desaparecía, y había que clickear para arreglarla (rompiendo la otra). Ahora se repinta sola al enfocar o cambiar de vista.',
      'La barra de terminales de arriba ahora se arrastra (o girás la rueda) para llegar a todas cuando tenés muchas abiertas.',
      'Pegar ahora avisa si el portapapeles falla (antes no pegaba nada y no decía por qué).',
      'Topbar más limpio: se sacó el botón ⌘K (el atajo sigue funcionando) y el selector cómodo/compacto; la info de sesiones activas / atención ya no se duplica entre la barra de arriba y la de abajo.',
      'La app va más fluida: menos tirones al refrescar con muchas sesiones abiertas.',
    ] },
    { v: '1.9.16', date: '26 jun 2026', title: 'Copiar (Ctrl+C) más confiable en la terminal de claude', items: [
      'Si seleccionabas texto en la terminal de claude y al copiar con Ctrl+C "a veces copiaba y a veces no" (y encima te saltaba el aviso de cerrar claude): ahora, si claude redibujó y se borró el resaltado, Ctrl+C igual copia lo último que habías seleccionado. Ctrl+C sin nada seleccionado sigue interrumpiendo claude como siempre.',
      'Tip: para seleccionar en la terminal de claude, arrastrá con Shift apretado, o usá el botón de "modo selección" (el del cursor de texto) en la barra del panel. Ctrl+Shift+C copia siempre.',
    ] },
    { v: '1.9.15', date: '26 jun 2026', title: 'Pegar que no envía + Ctrl+Inicio/Fin en el input + scroll más estable', items: [
      'Arreglado: a veces al pegar (Ctrl+V o clic derecho → Pegar) en la terminal de claude se ENVIABA el mensaje en vez de pegar el texto — pasaba sobre todo cuando lo copiado tenía un salto de línea al final, y después de minimizar/restaurar. Ahora pega siempre, sin enviar.',
      'Ctrl+Inicio / Ctrl+Fin sobre el input de claude ahora van al principio / al final de lo que estás escribiendo (antes scrolleaban la conversación y quedaba raro).',
      'Scroll de la terminal más estable: si se trababa, ahora con clickear la terminal se recupera (sin tener que maximizar y achicar). Además se quitó el scroll "suave" que podía dejar la rueda pegada.',
    ] },
    { v: '1.9.14', date: '26 jun 2026', title: 'Seleccionar el texto del input de claude con Shift+flechas + Ctrl+X corta', items: [
      'En la terminal de claude ahora podés SELECCIONAR con el teclado lo que estás escribiendo: Shift+flechas (carácter por carácter), Ctrl+Shift+flecha (de a palabras) y Shift+Inicio/Fin (hasta el principio o el fin de lo tipeado). Después Ctrl+C lo copia.',
      'Ctrl+X CORTA: copia la selección y la borra del input de una.',
      'Sólo aplica a la terminal de claude; en la consola normal (PowerShell) Shift+flechas sigue funcionando como siempre.',
    ] },
    { v: '1.9.13', date: '26 jun 2026', title: 'Barra de scroll visible en la conversación', items: [
      'La conversación de una sesión (el panel read-only del dock) ahora muestra una barra de scroll vertical clara para moverte por los mensajes largos. Antes la barra estaba casi invisible, aunque ya podías scrollear con la rueda del mouse.',
    ] },
    { v: '1.9.12', date: '26 jun 2026', title: 'Limpieza de notificaciones de "nueva versión" inválidas', items: [
      'Se quita sola cualquier notificación de "nueva versión" que no correspondía (por ejemplo una versión que en realidad no existe, o una que ya tenías instalada).',
      'Refuerzo interno para que esas notificaciones inválidas no se vuelvan a guardar.',
    ] },
    { v: '1.9.11', date: '26 jun 2026', title: 'El botón "Actualizar" vuelve a funcionar (y nunca quedás trabado)', items: [
      'Se arregló el bug en el que la app avisaba que había una versión nueva pero no te dejaba actualizar. Ahora, detectar una versión nueva SIEMPRE te da el botón para descargar e instalar.',
      'El botón aparece en los tres lugares: en la barra de arriba, en "Novedades", y al tocar la notificación de "nueva versión". Antes desde Settings → "buscar" sólo te mostraba el changelog, sin opción de bajar.',
      'Aunque recargues la ventana, el botón "Actualizar" se vuelve a mostrar solo (antes se perdía al recargar).',
      'Red de seguridad: si la descarga falla por algún motivo, la app te ofrece bajar el instalador oficial desde GitHub con un clic — sin tener que buscarlo a mano.',
    ] },
    { v: '1.9.10', date: '25 jun 2026', title: 'Terminal más estable + se puede tipear @ siempre + menos tooltips + la selección ya no pisa el portapapeles', items: [
      'Texto de la terminal más estable: se arregló el texto que se rompía o se duplicaba (letras dobladas) al scrollear o redimensionar la consola de claude. Si igual lo notaras, podés cambiar a renderer clásico en Settings → Editor & Terminal ("render por GPU").',
      'Se puede tipear @ siempre: el selector flotante de @ ya no te deja trabado si no puede listar los archivos — si falla, el @ va directo a claude y seguís escribiendo normal. El @ además sólo abre la cajita al empezar una palabra (no en medio de un "user@host"). Si preferís, lo podés apagar del todo en Settings ("selector flotante de @ y /").',
      'Menos tooltips molestos: se sacó el cartelito que flotaba en el medio de la terminal al pasar el mouse (repetía el nombre que ya se ve arriba).',
      'La selección ya no pisa el portapapeles: seleccionar texto en la terminal dejó de copiarlo solo. Ahora copiás cuando vos querés, con Ctrl+C (o Ctrl+Shift+C / clic derecho → Copiar).',
      'Arreglos de tamaño chico: la barra de arriba se acomoda mejor cuando achicás la ventana.',
      'Scroll un poco más suave en la conversación y en las terminales.',
    ] },
    { v: '1.9.9', date: '25 jun 2026', title: 'Terminales mucho más fluidas + aviso al actualizar + abrir .md + "esto no es un proyecto"', items: [
      'Terminales más fluidas: ahora se dibujan por GPU (WebGL), así que la consola de claude va mucho más suave —sobre todo cuando claude escribe mucho o redibuja la pantalla—. Si tu GPU llegara a renderizar raro, lo podés apagar en Settings → Editor & Terminal ("render por GPU").',
      'Aviso al actualizar con claude abierto: si tenés una sesión de Claude activa y le das a Actualizar, ahora te pregunta antes (actualizar cierra la app y corta la sesión en vivo). Podés seguir trabajando o actualizar igual.',
      'Abrir un .md: clickear un archivo .md para verlo en el panel ya no falla con "no se pudo leer" cuando lo abrís desde una terminal cuyo proyecto no estaba siendo seguido.',
      'Marcar "esto no es un proyecto": pasá el mouse por un proyecto en el sidebar y tocá el ojo tachado para ocultarlo del board y del sidebar (útil para cosas que no son proyectos de verdad, o branches sueltos). Es reversible: lo volvés a mostrar desde Settings → "proyectos ocultos".',
    ] },
    { v: '1.9.8', date: '25 jun 2026', title: 'Copiar con Ctrl+C ya no cambia la densidad sin querer', items: [
      'A veces al copiar (Ctrl+C) se cambiaba solo entre vista cómoda y compacta, y el copiar fallaba. Pasaba porque la tecla "c" era un atajo para alternar la densidad y se disparaba también con Ctrl+C. Se sacó ese atajo de teclado (la densidad se sigue cambiando con los botones cómodo/compacto de arriba), y además ningún atajo de una letra se dispara más cuando tenés Ctrl o Cmd apretado — así Ctrl+C, Ctrl+A, etc. hacen lo de siempre.',
    ] },
    { v: '1.9.7', date: '25 jun 2026', title: 'Actualizar salta directo a la última versión', items: [
      'Al actualizar, la app avanzaba de a una versión por vez (si estabas varias atrás, tenías que actualizar varias veces seguidas). Ahora salta directo a la última versión disponible de una sola vez. Si por algún motivo no se puede averiguar cuál es la última (sin internet, etc.), sigue funcionando como antes — nunca te quedás sin poder actualizar.',
    ] },
    { v: '1.9.6', date: '25 jun 2026', title: 'El ícono del escritorio no desaparece al actualizar + terminal de claude que ya no se duplica', items: [
      'Al actualizar la app, el acceso directo de Consomni en el escritorio desaparecía y no volvía. El instalador lo borraba en cada actualización en vez de mantenerlo. Ahora el acceso directo se conserva al actualizar (y si por alguna razón faltaba, se vuelve a crear solo y aparece al instante, sin tener que refrescar el escritorio).',
      'Terminal de claude duplicada: al minimizar una terminal y volver a abrirla/maximizarla, se duplicaba el principio de la conversación. Era un repintado de más que disparaba el cambio de tamaño aunque el tamaño no cambiara; ahora se evita ese repintado innecesario, así que no se duplica (y de paso el scroll queda más estable, sin saltar al fondo solo).',
      'Leer el historial completo de claude: cuando el input queda anclado abajo, la forma confiable de leer (y buscar) toda la conversación es Ctrl+O (modo transcripción de claude). Ahora te lo avisamos al retomar un chat y está explicado en el botón de scroll de la cabecera de la terminal.',
    ] },
    { v: '1.9.5', date: '25 jun 2026', title: 'La terminal de claude deja de "romperse" al scrollear/redimensionar + abrir claude es más rápido', items: [
      'Scroll del historial arreglado: en las terminales de claude el historial se "rompía" —texto viejo superpuesto, partes cortadas, y no se podía scrollear hacia arriba para leer el principio—, sobre todo en sesiones largas y al minimizar/agrandar/achicar. Eran dos cosas: (1) claude corría en modo "pantalla completa", que NO tiene scroll de terminal (por eso no llegabas al principio), y la rueda del mouse scrolleaba lentísimo (1 línea por vez); ahora la rueda anda fluida y, si preferís el scroll de toda la vida, hay un botón nuevo en la cabecera de la terminal para pasar a "scroll nativo" (scrolleás hacia arriba como cualquier terminal). (2) El reflow de las líneas al cambiar el tamaño se corrompía sobre Windows; ahora la terminal sabe que está sobre ConPTY y reacomoda el texto bien al redimensionar.',
      'Botón claude más inteligente: el botón "claude" de arriba ya no abre una terminal nueva cada vez (no más juntar 5 pestañas). Si ya hay un claude abierto en la vista, lo enfoca; para abrir uno nuevo a propósito, hacé Shift+click (o usá "claude ⚡").',
      'Abrir claude en un proyecto, de un toque: al entrar a un proyecto que no tiene terminales abiertas, ahora aparece un botón "abrir claude" (y "terminal") destacado para arrancar claude directo en su carpeta, sin tener que ir a buscarlo.',
    ] },
    { v: '1.9.4', date: '24 jun 2026', title: 'Pegar imágenes, seleccionar lo que escribís, y ver los archivos que genera claude en vivo', items: [
      'Pegar imágenes: pegar una imagen en una terminal de claude antes fallaba seguido en el primer intento ("no hay nada en el portapapeles") y había que pegarla de nuevo. Es un problema del propio claude en Windows (pasa igual en Warp): lee la imagen en un formato que su decodificador no soporta. Ahora Consomni la lee él mismo, la guarda como archivo temporal y se la pasa a claude por su ruta → la toma a la primera, siempre, y la ves al instante como "[Image #N]". Funciona con Alt+V y con Ctrl+V (si hay imagen la pega como imagen; si hay texto, pega el texto).',
      'Seleccionar tu input: en las terminales de claude podés seleccionar el texto que estás escribiendo y copiarlo con Ctrl+C. Como la interfaz de claude no permite seleccionar su propio input, lo resuelve Consomni: activá el botón "selección" en la cabecera de la terminal y arrastrá con el mouse para seleccionar (al desactivarlo, el mouse vuelve a ser de claude). Y Ctrl+A selecciona TODO tu prompt de una; para ir al inicio de la línea quedó Home.',
      'Archivos en vivo: cuando claude genera un archivo, hacé click en su ruta para abrirlo en un panel a la derecha (pantalla dividida) y Ctrl+click para abrirlo en el editor. Ahora el panel se actualiza EN VIVO mientras el agente sigue editando el archivo —no hace falta cerrarlo y reabrirlo— y además detecta rutas con espacios (como C:\\Users\\Usuario 7\\…).',
    ] },
    { v: '1.9.3', date: '24 jun 2026', title: 'El buscador del topbar ahora se ve y se usa como un buscador de verdad', items: [
      'Al activar el buscador (con un click o con la tecla "/") ahora se ve que estás adentro: el cuadro se resalta y aparece un cursor titilando.',
      'Mientras escribís, el texto se ve en el cuadro (antes filtraba pero no se veía qué tipeabas) y hay una "×" para borrar el filtro al instante.',
      'Si hacés click fuera del cuadro, el buscador se desactiva (así escribir en la app no filtra sin querer); el filtro aplicado queda a la vista con su "×" para sacarlo.',
    ] },
    { v: '1.9.2', date: '24 jun 2026', title: 'La etiqueta "actual" del changelog centrada + buscador clickeable', items: [
      'En la pantalla de Changelog, la etiqueta "actual" quedó centrada (vertical y horizontalmente) dentro de su recuadro.',
      'El buscador del topbar ahora se activa también con un click (antes era sólo con la tecla "/"). Filtra el tablero por nombre, proyecto o branch.',
    ] },
    { v: '1.9.1', date: '24 jun 2026', title: 'Fixes visuales: la campanita, el botón Actualizar y el changelog', items: [
      'Volvió a verse el ícono de notificaciones (la campanita) y el botón de la paleta (⌘K) arriba a la derecha: quedaban tapados por los botones de la ventana (minimizar / maximizar / cerrar).',
      'El botón "Actualizar" ya no se choca con el borde de la ventana cuando hay una versión nueva.',
      'En la pantalla de Changelog, la etiqueta "actual" quedó centrada dentro de su recuadro.',
    ] },
    { v: '1.9.0', date: '24 jun 2026', title: 'Autocompletar con Tab, pegar largo que se resume y el contador de cambios sin commitear', items: [
      'Autocompletar con Tab en las terminales: mientras escribís, Consomni te sugiere en gris (pegado al cursor) el comando más reciente de tu historial que empieza igual. Apretás Tab y lo completa. La tecla es reconfigurable: clickeás el cartelito "Tab" al lado de la sugerencia y elegís otra (→, End, Ctrl+algo). Lo prendés y apagás desde Settings → Editor & Terminal. Por ahora funciona en terminales shell.',
      'Pegar textos largos en claude ahora se resume solo a "[Texto pegado]" en vez de volcar las 50 líneas en pantalla, y si lo pegás de nuevo se expande. Antes, en algunos casos, el pegado se duplicaba y eso hacía que se viera expandido; quedó resuelto para que siempre se pegue una sola vez.',
      'El indicador de cambios sin commitear (+N / −N) ahora se ve siempre, también cuando estás con las terminales en pantalla completa: sigue a la terminal activa. Además cuenta los archivos nuevos sin trackear, así el número coincide con lo que ves en Warp o tu editor.',
    ] },
    { v: '1.8.2', date: '23 jun 2026', title: 'El input de claude queda SIEMPRE abajo + terminales que se reajustan perfecto', items: [
      'El cuadro de texto de claude ahora queda anclado abajo de todo en la terminal, como en WezTerm/Ghostty. Antes, en una sesión recién abierta (o al escribir y borrar), el input quedaba flotando en el medio con espacio vacío debajo. Se resuelve activando el modo "fullscreen" de claude en las terminales embebidas.',
      'Lo podés desactivar en Settings → Editor & Terminal ("claude: input box anclado abajo") si preferís el modo inline con el historial en el buffer de la terminal.',
      'Las terminales se reajustan exacto al redimensionar la ventana, cambiar de pestaña/sesión o achicar paneles: el tamaño real que ve claude ahora siempre coincide con el visible, así no se desacomoda el dibujo.',
    ] },
    { v: '1.8.1', date: '23 jun 2026', title: 'Fix: pegar duplicaba · picker flotante de "/"', items: [
      'Arreglado: al pegar en una terminal el texto se duplicaba (se pegaba dos veces, sobre todo cuando era una sola línea). Ahora pega una sola vez.',
      'Picker flotante de "/": al tipear "/" al inicio del input en una terminal con claude se abre un selector flotante de comandos —built-in + los custom de tu .claude/commands— pegado al cursor, sin que se te corra la pantalla. Filtrás escribiendo, Enter o click elige, Esc cierra y conserva lo que escribiste. Igual que el de "@".',
    ] },
    { v: '1.8.0', date: '23 jun 2026', title: 'Varias terminales en paralelo, cambiar de carpeta sin cd, arranque con la PC y más', items: [
      'Barra de sesiones: todas tus terminales/sesiones vivas aparecen como chips arriba del dock. Cambiás entre ellas con un click y podés minimizar una para ocultarla SIN matar su proceso (sigue corriendo en background) y traerla de vuelta cuando quieras.',
      'Atajos en el inicio: abrís una terminal directo en un proyecto (o desde el botón "proyecto" del dock), sin ir a buscarlo, abrirla y favearla a mano cada vez.',
      'Cambiar de directorio sin tipear cd: el botón de carpeta de una terminal te deja elegir el directorio de una lista de tus proyectos (o el selector nativo) y Consomni manda el cd por vos.',
      'Arranque con la PC: Consomni puede abrirse sola al prender la computadora. Lo activás en Settings → Sistema.',
      'Menciones con @: ahora se ve lo que escribís en gris pegado al cursor mientras se abre el panel, y si cerrás con Esc el @texto queda en el input (antes se perdía).',
      'Title bar más amena: la barra de la ventana (minimizar/maximizar/cerrar) combina con la estética de la app y sigue el tema claro/oscuro.',
      'Tour de novedades: la primera vez tras actualizar te mostramos lo nuevo con un recorrido guiado. Lo podés volver a ver desde la paleta (Ctrl/Cmd+K) o el panel de ayuda (?).',
    ] },
    { v: '1.7.4', date: '22 jun 2026', title: 'Ctrl+Z deshace en claude · el selector de @ ya no envía al elegir', items: [
      'Ctrl+Z en una terminal con claude ahora DESHACE (undo) — escribís, borrás y con Ctrl+Z vuelve a aparecer. Se mapea al undo nativo de claude.',
      'Al elegir un archivo del selector de @ con Enter, ahora SOLO se inserta la referencia y se cierra el selector; ya no se enviaba el mensaje de una. Recién el segundo Enter lo envía.',
    ] },
    { v: '1.7.3', date: '22 jun 2026', title: 'Picker flotante de @, Shift+Enter arreglado, Ctrl+Espacio clona el directorio, Ctrl+W cierra', items: [
      'Al escribir @ en una terminal con claude ahora aparece un selector de archivos FLOTANTE (estilo Warp), pegado al input, en vez del listado inline de claude que te corría toda la pantalla. Escribís para filtrar, Enter o click para elegir, y se inserta la referencia al archivo. Esc cancela.',
      'Shift+Enter en claude ahora hace el salto de línea bien: antes (1.7.2) a veces enviaba el mensaje igual y andaba con lag. Quedó instantáneo y confiable.',
      'Ctrl+Espacio abre la terminal nueva parada en el MISMO directorio de la terminal que venías usando (como Warp), en vez de arrancar en tu carpeta de usuario.',
      'Ctrl+W cierra la terminal donde está el cursor (la que estás usando). Si es una terminal viva, te pide confirmación antes de cortar el proceso. Nota: dentro de un shell, Ctrl+W deja de borrar la palabra anterior.',
    ] },
    { v: '1.7.2', date: '22 jun 2026', title: 'Shift+Enter para saltar de línea en claude', items: [
      'En las terminales con claude, Shift+Enter ahora inserta un salto de línea en vez de enviar el prompt — podés escribir prompts de varias líneas sin que se mande de una. Es lo mismo que hace el "/terminal-setup" de Claude Code en otros terminales.',
      'Aplica solo a las sesiones de claude embebidas; en un shell normal, Enter sigue ejecutando el comando como siempre.',
    ] },
    { v: '1.7.1', date: '22 jun 2026', title: 'Cambios sin commitear (+N/−N) y abrir archivos desde el chat', items: [
      'Indicador de cambios sin commitear (+N / −N) por proyecto, estilo Warp: aparece en el encabezado de cada columna del tablero y en la cabecera del dock cuando entrás a un proyecto. Se actualiza solo a medida que el agente edita, y al hacerle click abre el git diff.',
      'Rutas de archivo clickeables en la terminal y en la conversación de las sesiones (además de los links): click abre el archivo en un panel al costado, Ctrl/Cmd+click lo abre en tu editor, y el click derecho ofrece "Abrir en panel / Abrir en editor / Revelar ubicación".',
      'Visor de archivo embebido: muestra el contenido crudo (monospace, seleccionable) con botones para copiar todo, abrir en el editor o revelar la ubicación. Para archivos .md hay un toggle entre vista renderizada y crudo. Ideal para abrir un .md, copiar el prompt y pegarlo en otro lado.',
      'Todo 100% local: el indicador usa el git de tu máquina y el visor lee solo archivos dentro de las carpetas que ya monitoreás (sin red, sin subir nada).',
    ] },
    { v: '1.7.0', date: '22 jun 2026', title: 'Multi-perfil de Claude', items: [
      'Consomni ya no asume ~/.claude fijo: en Settings, sección "Perfil de Claude", podés elegir el config dir que querés monitorear (ej ~/.claude-max). Auto-detecta tus perfiles .claude* y también acepta una ruta a mano.',
      'Al cambiar de perfil, el tablero pasa a mostrar las sesiones de ESE perfil, y los hooks se instalan en su propio settings.json (reinstalalos desde Settings tras cambiar).',
      'Las terminales que Consomni abre usan el perfil elegido (cualquier `claude` adentro escribe en ese config dir).',
      'Sin tocar nada queda exactamente como antes (usa ~/.claude o la variable CLAUDE_CONFIG_DIR de tu entorno).',
      'Tutorial guiado: la primera vez se abre Settings solo y te muestra dónde elegir el perfil. Lo podés repetir desde el botón "tutorial" de la sección o la paleta.',
    ] },
    { v: '1.6.2', date: '22 jun 2026', title: 'Fix del cartel de atención', items: [
      'Arreglado: el cartel "una sesión necesita tu atención" se quedaba pegado después de loguearte (o ante avisos que no eran un pedido de permiso). Ahora solo se prende ante un pedido de permiso real, y se limpia solo cuando la sesión sigue trabajando.',
    ] },
    { v: '1.6.1', date: '21 jun 2026', title: 'Pulido del Changelog', items: [
      'La marca de cada versión en la línea de tiempo del Changelog quedó perfectamente centrada sobre el riel.',
    ] },
    { v: '1.6.0', date: '21 jun 2026', title: 'Modo claro', items: [
      'Nuevo modo claro para toda la app (el modo oscuro sigue siendo el de fábrica). Cambialo con el botón de sol/luna, abajo a la izquierda.',
      'Las terminales se mantienen en oscuro incluso en modo claro, para que la interfaz de Claude se siga leyendo cómoda.',
      'La versión quedó centrada sobre el botón "Changelog".',
      'El modal de novedades ahora muestra el formato correcto (antes podían aparecer etiquetas sueltas).',
    ] },
    { v: '1.5.2', date: '21 jun 2026', title: 'Historial de novedades', items: [
      'Nueva pantalla de Changelog: un registro completo de todo lo que cambió en Consomni, versión por versión, accesible desde el número de versión.',
    ] },
    { v: '1.5.1', date: '21 jun 2026', title: 'Terminal y notificaciones', items: [
      'Links clickeables en la terminal: las URLs se abren completas en el navegador, incluso las largas que ocupan varias líneas (como la del login de Claude).',
      'Copiar y pegar con Ctrl+C y Ctrl+V (y sus variantes con Shift), más un menú de click derecho.',
      'Soporte para el atajo "c to copy" de Claude.',
      'Las notificaciones ahora persisten y se pueden revisar todas desde un historial.',
    ] },
    { v: '1.5.0', date: '21 jun 2026', title: 'Dock de terminales', items: [
      'Entrar a un proyecto abre un selector de conversaciones de Claude acotado a ese proyecto.',
      'La cabecera del dock muestra el nombre del proyecto en el que estás.',
      'Botones por panel para continuar una sesión de Claude, con o sin permisos.',
      'Ctrl+Espacio abre una terminal nueva, configurable desde Settings.',
      'El sidebar ya no se colapsa solo al entrar a un proyecto.',
    ] },
    { v: '1.4.0', date: '20 jun 2026', title: 'Biblioteca', items: [
      'Guardá, editá y reutilizá tus prompts, skills y reglas favoritas en una biblioteca local.',
    ] },
    { v: '1.3.0', date: '20 jun 2026', title: 'Planes, comandos y tutorial', items: [
      'Tablero de planes y frentes: qué está pendiente y qué ya se hizo, por proyecto.',
      'Comandos rápidos en la terminal: atajos y traducción de lenguaje natural a comandos.',
      'Centro de notificaciones con el changelog de cada versión.',
      'Tutorial guiado para las funciones nuevas.',
    ] },
    { v: '1.2.0', date: '19 jun 2026', title: 'Instalación y actualizaciones', items: [
      'Instalador con acceso directo opcional en el escritorio.',
      'Actualizaciones automáticas: aviso de versión nueva y botón para actualizar desde la app.',
      'Dock contextual por proyecto, terminales fijables y Claude sin permisos.',
    ] },
    { v: '1.0.0', date: '19 jun 2026', title: 'Primera versión estable', items: [
      'Consomni llega a producción: monitoreo y orquestación de tus sesiones de Claude Code, 100% local.',
    ] },
    { v: '0.6.0', date: '19 jun 2026', title: 'Terminales embebidas', items: [
      'Consomni dejó de ser solo un observador: ahora hospeda terminales reales adentro, shell o Claude, con paneles divisibles.',
    ] },
    { v: '0.5.0', date: '19 jun 2026', title: 'Pulido y empaquetado', items: [
      'Chequeo de actualizaciones, icono propio y la app empaquetada para Windows.',
    ] },
    { v: '0.1.0', date: '19 jun 2026', title: 'El monitor', items: [
      'La base de todo: monitoreo en tiempo real de tus sesiones de Claude Code, leyendo los transcripts en disco.',
    ] },
  ];
  function openChangelogAll() {
    state.changelogAllOpen = true;
    var rows = CHANGELOG.map(function (e, i) {
      var latest = i === 0;
      var items = (e.items || []).map(function (it) { return '<li>' + esc(it) + '</li>'; }).join('');
      return '<div class="chl-entry' + (latest ? ' latest' : '') + '" style="animation-delay:' + Math.min(i * 45, 360) + 'ms">' +
        '<div class="chl-vrow"><span class="chl-v">v' + esc(e.v) + '</span>' +
          (latest ? '<span class="chl-pill">actual</span>' : '') +
          '<span class="chl-date">' + esc(e.date || '') + '</span></div>' +
        (e.title ? '<div class="chl-etitle">' + esc(e.title) + '</div>' : '') +
        '<ul class="chl-items">' + items + '</ul>' +
      '</div>';
    }).join('');
    var html = '<div class="chl-screen" role="dialog" aria-modal="true">' +
      '<div class="chl-top"><span class="chl-brand">' + C.eye(22, false) + '<span class="chl-wm">CONSOMNI</span></span>' +
        '<span class="chl-tdiv"></span><span class="chl-toplabel">Changelog</span>' +
        '<button class="chl-close" data-act="close-changelog-all" title="cerrar (Esc)">' + C.svg('x', 15, 2) + '</button></div>' +
      '<div class="chl-scroll"><div class="chl-wrap">' +
        '<div class="chl-hero"><span class="chl-eyebrow">' + C.svg('sparkles', 13, 1.8) + ' Novedades</span>' +
          '<h1>Todo lo que fue cambiando</h1>' +
          '<p>El registro completo de Consomni, versión por versión. Cien por ciento local, sin telemetría — como toda la app.</p></div>' +
        '<div class="chl-timeline">' + rows + '</div>' +
        '<div class="chl-foot2"><span>¿Querés el detalle técnico de cada release?</span>' +
          '<a data-href="https://github.com/JoaquimColacilli/consomni/releases">' + C.svg('ext', 12, 2) + ' Verlo en GitHub</a></div>' +
      '</div></div></div>';
    setOverlay(html);
  }
  function closeChangelogAll() { state.changelogAllOpen = false; setOverlay(''); }
  // mini-render markdown SEGURO (escapa TODO primero, después aplica un puñado de reglas)
  function renderNotes(md) {
    var lines = String(md).replace(/\r/g, '').split('\n');
    var out = [], inList = false, inCode = false;
    function closeList() { if (inList) { out.push('</ul>'); inList = false; } }
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i], t = ln.trim();
      if (/^```/.test(t)) { if (inCode) { out.push('</pre>'); inCode = false; } else { closeList(); out.push('<pre class="cl-pre">'); inCode = true; } continue; }
      if (inCode) { out.push(esc(ln)); continue; }
      if (!t) { closeList(); continue; }
      var h = t.match(/^(#{1,4})\s+(.*)$/);
      if (h) { closeList(); out.push('<h4 class="cl-h">' + inlineMd(h[2]) + '</h4>'); continue; }
      var li = t.match(/^[-*]\s+(.*)$/);
      if (li) { if (!inList) { out.push('<ul class="cl-ul">'); inList = true; } out.push('<li>' + inlineMd(li[1]) + '</li>'); continue; }
      closeList();
      out.push('<p class="cl-p">' + inlineMd(t) + '</p>');
    }
    if (inCode) out.push('</pre>'); closeList();
    return out.join('');
  }
  function inlineMd(s) {
    var e = esc(s);
    e = e.replace(/`([^`]+)`/g, '<code>$1</code>');
    e = e.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    e = e.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<span class="cl-link" data-href="$2">$1</span>');
    return e;
  }
  // Las release notes pueden llegar en MARKDOWN (chequeo manual → json.body) o en HTML (electron-updater
  // suele entregar `releaseNotes` ya renderizado como HTML). Si es HTML lo convertimos a markdown-ish ANTES
  // de renderNotes (que escapa todo) → así no se ven las etiquetas literales `<p>`/`<br>`/`<li>`. Seguro:
  // se quitan TODOS los tags antes de renderNotes, que re-escapa el texto restante (sin XSS).
  function notesToHtml(raw) {
    var s = String(raw == null ? '' : raw);
    if (/<(p|br|ul|ol|li|h[1-6]|strong|em|code|pre|blockquote|div|span|a)[\s>\/]/i.test(s)) {
      s = s
        .replace(/<\s*br\s*\/?\s*>/gi, '\n')
        .replace(/<\s*h([1-6])[^>]*>/gi, function (_m, n) { return '\n' + new Array(Math.min(+n, 4) + 1).join('#') + ' '; })
        .replace(/<\s*li[^>]*>/gi, '\n- ')
        .replace(/<\s*\/\s*(p|h[1-6]|ul|ol|div|blockquote|tr)\s*>/gi, '\n')   // OJO: sin 'li' (el <li> ya abrió línea)
        .replace(/<\s*(strong|b)\s*>/gi, '**').replace(/<\s*\/\s*(strong|b)\s*>/gi, '**')
        .replace(/<\s*(em|i)\s*>/gi, '*').replace(/<\s*\/\s*(em|i)\s*>/gi, '*')
        .replace(/<\s*code\s*>/gi, '`').replace(/<\s*\/\s*code\s*>/gi, '`')
        .replace(/<[^>]+>/g, '')                                  // sacar cualquier tag restante
        .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#0?39;/gi, "'").replace(/&#x?2f;/gi, '/')
        .replace(/[ \t]+\n/g, '\n')                               // sin espacios colgando por línea
        .replace(/\n\s*\n(?=\s*-\s)/g, '\n')                      // sin línea en blanco antes de un bullet → un solo <ul>
        .replace(/\n{3,}/g, '\n\n').replace(/^\s+|\s+$/g, '');
    }
    return renderNotes(s);
  }

  /* ════════ TUTORIAL (coachmark spotlight) ════════
     Resalta UN elemento con un recorte EXACTO (box-shadow gigante que opaca el
     resto) y una tarjeta al lado, paso a paso, con "saltar". Responsive: reencuadra
     en resize y en cada re-render. Explica el tablero de Planes. */
  var TOUR = { active: false, steps: [], idx: 0, doneKey: 'consomni.tour.plans', onDone: null, onEnd: null };
  var tourEls = { host: null, spot: null, pop: null };

  function openPlansForTour() {
    if (!state.plansOpen) { state.plansOpen = true; var T = window.ConsomniTerms; if (T && T.isMaximized && T.isMaximized()) T.minimize(); loadPlanDocs(); render(); }
  }
  function planTourSteps() {
    var hasData = planView().length > 0;
    var steps = [
      { center: true, icon: 'tasks', title: 'Planes · tus frentes', before: openPlansForTour,
        body: 'Esto detecta los <b>planes de implementación</b>, <b>specs</b> y <b>tareas</b> de tus sesiones de Claude Code — qué quedó <b>pendiente</b> y qué ya se <b>hizo</b>. Ideal para dejar un plan armado y seguir al otro día sin perder el hilo.' },
      { target: '.sb-plans', alt: '.ci-plans', place: 'right', icon: 'tasks', title: 'Entrá a “planes”', before: openPlansForTour,
        body: 'Desde acá abrís el tablero de <b>frentes</b>. Cada frente es un proyecto con sus planes y tareas, agrupados solos.' }
    ];
    if (!hasData) {
      // sin planes detectados todavía → no apuntamos a elementos inexistentes
      steps.push({ center: true, icon: 'eye', title: 'Todavía no hay frentes', before: openPlansForTour,
        body: 'Cuando una sesión de Claude presente un <b>plan</b> (plan mode) o arme una lista de <b>tareas</b> (TodoWrite), su progreso aparece acá agrupado por proyecto — con su checklist, su estado y una nota privada. Volvé cuando tengas alguno y te muestro el resto.' });
      return steps;
    }
    steps.push(
      { target: '.plan-col .frente-prog', place: 'bottom', title: 'Pendiente vs hecho', before: openPlansForTour,
        body: 'La barra resume el progreso del frente: <b>X/Y hechas</b>, en curso y pendientes — sumando todas las tareas que Claude fue marcando (TodoWrite).' },
      { target: '.plan-col .plan-todos', alt: '.plan-col .plan-roll', place: 'bottom', title: 'Las tareas, una por una', before: openPlansForTour, open: '.plan-col .plan-todos',
        body: 'Cada sesión muestra su checklist: <span style="color:var(--green)">✓ hecho</span> · <span style="color:var(--amber)">◐ en curso</span> · ○ pendiente. Es lo que Claude planificó y fue ejecutando.' },
      { target: '.plan-col .frente-pill', place: 'bottom', title: 'Estado del frente (privado)', before: openPlansForTour,
        body: 'Marcá en qué anda: <b>backlog · en desarrollo · idea · pausado · listo</b>. Click para ciclar. Es <b>tuyo y local</b> — no sale de tu máquina.' },
      { target: '.plan-col .frente-note', place: 'top', title: 'Tu nota / idea privada', before: openPlansForTour,
        body: 'Anotá lo que estás flageando para mejorar o implementar y <b>no querés contarle a nadie</b>. 100% local · sin telemetría · sin red.' },
      { target: '.plan-col .plan-card-acts', alt: '.plan-col .plan-card', place: 'bottom', title: 'Retomá donde dejaste', before: openPlansForTour,
        body: '<b>Continuar</b> reanuda esa sesión (<code>claude --resume</code>) · <b>detalle</b> la abre completa. Y los <b>plan.md</b> / <b>spec.md</b> de tu repo aparecen a un click.' }
    );
    return steps;
  }
  function startPlanTour() { startTour(planTourSteps(), 'consomni.tour.plans'); }
  function maybeStartPlanTour() {
    var done = false; try { done = localStorage.getItem('consomni.tour.plans') === '1'; } catch (e) {}
    if (done || TOUR.active) return;
    startPlanTour();
  }
  function startTour(steps, doneKey, onDone, onEnd) {
    if (!steps || !steps.length) return;
    TOUR.steps = steps; TOUR.idx = 0; TOUR.active = true; TOUR.doneKey = doneKey || 'consomni.tour.plans';
    TOUR.onDone = (typeof onDone === 'function') ? onDone : null;
    TOUR.onEnd = (typeof onEnd === 'function') ? onEnd : null;   // se llama SIEMPRE al cerrar (terminar/saltar/Esc) → cleanup
    window.addEventListener('resize', positionTour);
    showTourStep();
  }
  function tourNext() { if (!TOUR.active) return; if (TOUR.idx >= TOUR.steps.length - 1) { endTour(true); return; } TOUR.idx++; showTourStep(); }
  function tourPrev() { if (!TOUR.active || TOUR.idx === 0) return; TOUR.idx--; showTourStep(); }
  function endTour(markDone) {
    TOUR.active = false; removeTourDOM();
    window.removeEventListener('resize', positionTour);
    if (markDone) {
      try { localStorage.setItem(TOUR.doneKey || 'consomni.tour.plans', '1'); } catch (e) {}
      if (TOUR.onDone) { try { TOUR.onDone(); } catch (e2) {} }   // persistencia confiable adicional (ej config.json)
    }
    if (TOUR.onEnd) { try { TOUR.onEnd(); } catch (e3) {} }       // cleanup SIEMPRE (terminar/saltar/Esc): ej cerrar la demo del tour
    TOUR.onDone = null; TOUR.onEnd = null;
  }
  function removeTourDOM() { var h = document.getElementById('tour'); if (h) h.remove(); tourEls = { host: null, spot: null, pop: null }; }
  function tourTarget(step) {
    if (!step.target) return null;
    var el = document.querySelector(step.target) || (step.alt ? document.querySelector(step.alt) : null);
    if (!el) return null;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;   // montado pero invisible (ej barra vacía con [hidden]) → tarjeta centrada
    return el;
  }
  function showTourStep() {
    var step = TOUR.steps[TOUR.idx]; if (!step) { endTour(true); return; }
    if (step.before) { try { step.before(); } catch (e) {} }
    if (step.open) { var det = document.querySelector(step.open); if (det && det.tagName === 'DETAILS') det.open = true; }
    requestAnimationFrame(function () { requestAnimationFrame(function () { paintTourStep(step); }); });
  }
  function paintTourStep(step) {
    removeTourDOM();
    var host = document.createElement('div'); host.id = 'tour'; host.className = 'tour';
    var block = document.createElement('div'); block.className = 'tour-block'; host.appendChild(block);
    var target = step.center ? null : tourTarget(step);
    // traer el target a la vista ANTES de recortarlo (si está abajo del fold no se vería)
    if (target) { try { target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' }); } catch (e0) {} }
    if (target) { var spot = document.createElement('div'); spot.className = 'tour-spot'; host.appendChild(spot); tourEls.spot = spot; }
    else { host.classList.add('tour-centered'); tourEls.spot = null; }
    var pop = buildTourPop(step); host.appendChild(pop); tourEls.pop = pop;
    tourEls.host = host; document.body.appendChild(host);
    positionTour();
    setTimeout(positionTour, 360);   // reencuadre si reflowa (docs async / fuentes)
  }
  function buildTourPop(step) {
    var n = TOUR.steps.length, i = TOUR.idx, dots = '';
    for (var k = 0; k < n; k++) dots += '<span class="tour-dot' + (k === i ? ' on' : (k < i ? ' done' : '')) + '"></span>';
    var prev = i > 0 ? '<button class="tour-btn tour-ghost" data-tour="prev">anterior</button>' : '';
    var nextLabel = i >= n - 1 ? 'listo' : 'siguiente';
    var pop = document.createElement('div'); pop.className = 'tour-pop';
    pop.innerHTML =
      '<div class="tour-pop-head">' + (step.icon ? '<span class="tour-ic">' + C.svg(step.icon, 15, 1.8) + '</span>' : '') +
        '<span class="tour-ttl">' + esc(step.title || '') + '</span><span class="tour-step">' + (i + 1) + '/' + n + '</span></div>' +
      '<div class="tour-body">' + (step.body || '') + '</div>' +
      '<div class="tour-foot"><div class="tour-dots">' + dots + '</div>' +
        '<div class="tour-actrow"><button class="tour-btn tour-skip" data-tour="skip">saltar</button>' + prev +
          '<button class="tour-btn tour-next" data-tour="next">' + nextLabel + ' ' + C.svg('chevR', 12, 2.4) + '</button></div></div>' +
      '<span class="tour-arrow"></span>';
    return pop;
  }
  function positionTour() {
    if (!TOUR.active || !tourEls.host) return;
    var step = TOUR.steps[TOUR.idx]; if (!step) return;
    var pop = tourEls.pop, vw = window.innerWidth, vh = window.innerHeight;
    var target = step.center ? null : tourTarget(step);
    var arrow = pop.querySelector('.tour-arrow');
    if (!target || !tourEls.spot) { tourEls.host.classList.add('tour-centered'); pop.style.left = ''; pop.style.top = ''; if (arrow) arrow.style.display = 'none'; return; }
    tourEls.host.classList.remove('tour-centered');
    var pad = step.pad != null ? step.pad : 8, gap = 14;
    var r = target.getBoundingClientRect(), spot = tourEls.spot;
    spot.style.left = (r.left - pad) + 'px'; spot.style.top = (r.top - pad) + 'px';
    spot.style.width = (r.width + pad * 2) + 'px'; spot.style.height = (r.height + pad * 2) + 'px';
    var pw = pop.offsetWidth || 320, ph = pop.offsetHeight || 170;
    var place = step.place || 'bottom';
    var fb = r.bottom + pad + gap + ph <= vh - 8, fa = r.top - pad - gap - ph >= 8;
    var frt = r.right + pad + gap + pw <= vw - 8, fl = r.left - pad - gap - pw >= 8;
    if (place === 'bottom' && !fb) place = fa ? 'top' : (frt ? 'right' : 'left');
    else if (place === 'top' && !fa) place = fb ? 'bottom' : (frt ? 'right' : 'left');
    else if (place === 'right' && !frt) place = fb ? 'bottom' : (fa ? 'top' : 'left');
    else if (place === 'left' && !fl) place = fb ? 'bottom' : (fa ? 'top' : 'right');
    var cx = r.left + r.width / 2, cy = r.top + r.height / 2, left, top;
    if (place === 'bottom') { top = r.bottom + pad + gap; left = cx - pw / 2; }
    else if (place === 'top') { top = r.top - pad - gap - ph; left = cx - pw / 2; }
    else if (place === 'right') { left = r.right + pad + gap; top = cy - ph / 2; }
    else { left = r.left - pad - gap - pw; top = cy - ph / 2; }
    left = Math.max(8, Math.min(vw - pw - 8, left)); top = Math.max(8, Math.min(vh - ph - 8, top));
    pop.style.left = left + 'px'; pop.style.top = top + 'px';
    if (arrow) {
      arrow.style.display = 'block'; arrow.className = 'tour-arrow tour-arrow--' + place;
      if (place === 'bottom' || place === 'top') { arrow.style.left = Math.max(16, Math.min(pw - 16, cx - left)) + 'px'; arrow.style.top = ''; }
      else { arrow.style.top = Math.max(16, Math.min(ph - 16, cy - top)) + 'px'; arrow.style.left = ''; }
    }
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
  // CTRL+ESPACIO: abre una terminal nueva según config (shell / claude / claude --dangerously-skip-permissions),
  // CLONANDO el directorio de la terminal activa (estilo Warp): la nueva arranca en el cwd de la que venías
  // usando, no en el home. Si no hay terminal abierta, cae al cwd del proyecto/vista (lo resuelve spawn()).
  function openQuickTerm() {
    var k = state.quickTermKind || 'claude-skip';
    var kind = (k === 'shell') ? 'shell' : 'claude';
    var T = window.ConsomniTerms;
    var cwd = (T && T.activeTermCwd) ? T.activeTermCwd() : '';
    openEmbeddedTerminal(cwd || null, kind, null, { skip: (k === 'claude-skip') });
  }
  // datos de proyecto de una sesión para taguear el panel (id = projKey, igual que la vista; name = lindo)
  function sProj(s, skip) { var o = s ? { proj: projKey(s), projName: s.project } : {}; if (skip) o.skip = true; return o; }
  // cwd + nombre representativo de un proyecto (por su projKey) desde el snapshot
  function projInfo(p) {
    var list = (state.snapshot && state.snapshot.sessions) || [], name = '', cwd = '';
    for (var i = 0; i < list.length; i++) { if (projKey(list[i]) === p) { if (!name) name = list[i].project || ''; if (list[i].cwd) { cwd = list[i].cwd; break; } } }
    return { cwd: cwd, name: name };
  }
  // sesiones de un proyecto para auto-abrir como paneles al entrar a su vista: las ACTIVAS siempre,
  // + las cerradas más recientes hasta un tope (se continúan con "responder" → claude --resume).
  var AUTO_OPEN_MAX = 8;
  function projSessions(p) {
    var list = ((state.snapshot && state.snapshot.sessions) || []).filter(function (s) { return projKey(s) === p; });
    var activeN = 0;
    list.forEach(function (s) { if (s.state !== 'closed') activeN++; });
    list.sort(function (a, b) {
      var ac = a.state === 'closed' ? 1 : 0, bc = b.state === 'closed' ? 1 : 0;
      if (ac !== bc) return ac - bc;                            // activas primero
      return (b.lastActivity || 0) - (a.lastActivity || 0);    // luego, más recientes
    });
    return list.slice(0, Math.max(activeN, AUTO_OPEN_MAX)).map(function (s) { return { sid: s.id, name: s.name, projName: s.project }; });
  }
  // lista de proyectos para los shortcuts del inicio (F5): nombre + cwd, con fav/kept/activos primero.
  function homeProjectsList() {
    var list = (state.snapshot && state.snapshot.sessions) || [], byKey = {};
    for (var i = 0; i < list.length; i++) {
      var s = list[i], k = projKey(s);
      if (!byKey[k]) byKey[k] = { id: k, name: s.project || '', cwd: s.cwd || '', fav: false, active: false, last: 0 };
      var e = byKey[k];
      if (!e.cwd && s.cwd) e.cwd = s.cwd;
      if (!e.name && s.project) e.name = s.project;
      if (s.fav) e.fav = true;
      if (s.state !== 'closed') e.active = true;
      if ((s.lastActivity || 0) > e.last) e.last = s.lastActivity || 0;
    }
    var arr = [];
    for (var key in byKey) { if (byKey[key].cwd) { byKey[key].kept = isKept(key); arr.push(byKey[key]); } }
    arr.sort(function (a, b) {
      var ar = (a.fav || a.kept) ? 0 : 1, br = (b.fav || b.kept) ? 0 : 1; if (ar !== br) return ar - br;
      var aa = a.active ? 0 : 1, ba = b.active ? 0 : 1; if (aa !== ba) return aa - ba;
      return b.last - a.last;
    });
    return arr.slice(0, 12).map(function (p) { return { id: p.id, name: p.name || baseName(p.cwd), cwd: p.cwd, fav: p.fav }; });
  }
  // ¿el proyecto tiene cards (sesiones) en el board? (para mostrar el board en vez del placeholder al cerrar terminales)
  function projHasCards(projId) {
    var list = (state.snapshot && state.snapshot.sessions) || [];
    for (var i = 0; i < list.length; i++) { if (projKey(list[i]) === projId) return true; }
    return false;
  }
  function normPath(p) { return String(p || '').toLowerCase().replace(/\\/g, '/').replace(/\/+$/, ''); }
  function baseName(p) { return String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(p || ''); }
  // "+ agregar": selector de carpeta nativo → abre esa raíz como proyecto (sus terminales/sesiones; arranca en su cwd)
  function addProjectViaPicker() {
    if (!api || !api.pickFolder) { toast('selector no disponible', 'warn'); return; }
    api.pickFolder().then(function (path) {
      if (!path) return;
      var projId = normPath(path), name = baseName(path);
      keepProject(projId);
      state.activeProject = projId; state.focusSid = null;
      render();
      var T = window.ConsomniTerms;
      if (T) T.openProject(projId, path, name, projSessions(projId));
    }).catch(function () { toast('no se pudo abrir el selector', 'err'); });
  }
  // ── proyectos "kept" (fijados al sidebar; persistidos en config.keptProjects) ──
  // un proyecto donde trabajaste (lo abriste) queda fijo en el sidebar aunque se cierren sus terminales/sesiones.
  function isKept(id) { return state.keptProjects.indexOf(id) > -1; }
  function keepProject(id) {
    if (!id || id === 'all' || id === '__archived' || isKept(id)) return;
    state.keptProjects.push(id);
    if (api && api.saveConfig) api.saveConfig({ keptProjects: state.keptProjects });
  }
  function unkeepProject(id) {
    var i = state.keptProjects.indexOf(id);
    if (i < 0) return;
    state.keptProjects.splice(i, 1);
    if (api && api.saveConfig) api.saveConfig({ keptProjects: state.keptProjects });
    if (state.activeProject === id) state.activeProject = 'all';
    render();
  }
  // ── "esto NO es un proyecto" (ocultos; persistidos en config.hiddenProjects) ──
  // sacan el proyecto del board, del sidebar y de archivados. Reversible desde Settings → "proyectos ocultos".
  function isHidden(id) { return state.hiddenProjects.indexOf(id) > -1; }
  function hideProject(id) {
    if (!id || id === 'all' || id === '__archived' || isHidden(id)) return;
    state.hiddenProjects.push(id);
    if (api && api.saveConfig) api.saveConfig({ hiddenProjects: state.hiddenProjects });
    if (state.activeProject === id) state.activeProject = 'all';
    var nm = ((lastView && lastView.liveGroups) || []).filter(function (g) { return g.id === id; })[0];
    toast('ocultado' + (nm ? ' · ' + nm.name : '') + ' · lo mostrás de nuevo en Settings → proyectos ocultos');
    render();
  }
  function unhideProject(id) {
    var i = state.hiddenProjects.indexOf(id);
    if (i < 0) return;
    state.hiddenProjects.splice(i, 1);
    if (api && api.saveConfig) api.saveConfig({ hiddenProjects: state.hiddenProjects });
    render();
    if (state.settingsOpen) openSettings();   // refrescar la lista en Settings → proyectos ocultos
  }

  // ── confirmación al cerrar una terminal VIVA (corta el proceso de claude/shell) ──
  // El dock la invoca vía setCloseConfirmer; si el usuario tildó "no volver a mostrar", cierra directo.
  var pendingClose = null;
  function confirmCloseTerminal(info, onConfirm) {
    info = info || {};
    if (!state.confirmCloseTerminal) { onConfirm(); return; }
    pendingClose = onConfirm;
    var isClaude = info.kind === 'claude';
    var warn = isClaude
      ? 'Estás cerrando una <b>sesión de Claude activa</b>. Se va a <b>cortar el proceso</b> y perdés el contexto en vivo. El transcript en disco queda — podés reanudarla después con <b>responder</b> (<code>claude --resume</code>).'
      : 'Estás cerrando una <b>terminal activa</b>. Se va a <b>cortar el proceso</b> que tenga corriendo adentro.';
    var html = '<div class="cfm-scrim" data-act="cfm-cancel"><div class="cfm-card" role="dialog" aria-modal="true">' +
      '<div class="cfm-ttl">' + C.svg('warn', 16, 1.9) + ' ¿Cerrar ' + (isClaude ? 'esta sesión' : 'esta terminal') + '?</div>' +
      '<div class="cfm-body">' + warn + '</div>' +
      '<label class="cfm-dont"><input type="checkbox" id="cccDont"> No volver a mostrar este aviso</label>' +
      '<div class="cfm-btns">' +
        '<button class="btn btn--sm" data-act="cfm-cancel">cancelar</button>' +
        '<button class="btn btn--sm btn--red" data-act="cfm-ok">' + C.svg('x', 12, 2) + ' cerrar</button>' +
      '</div></div></div>';
    setOverlay(html);
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
    if (act === 'resume') { if (!s) { toast('elegí una sesión', 'warn'); return; } var T2 = window.ConsomniTerms; if (T2 && T2.resumeSession) T2.resumeSession(s.id, s.cwd); else openEmbeddedTerminal(s.cwd, 'claude', s.id, sProj(s)); closeDetail(); return; }
    if (act === 'resume-skip') { if (!s) { toast('elegí una sesión', 'warn'); return; } var T3 = window.ConsomniTerms; if (T3 && T3.resumeSession) T3.resumeSession(s.id, s.cwd, { skip: true }); else openEmbeddedTerminal(s.cwd, 'claude', s.id, sProj(s, true)); closeDetail(); return; }
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

  /* ════════ TABLERO DE PLANES / SPECS (frentes) ════════
     Detecta planes (ExitPlanMode) + tareas (TodoWrite/Task) por proyecto desde
     los transcripts que YA leemos, + los docs plan.md/spec.md del repo. Suma
     estado MANUAL + nota privada por frente (local, nunca sale de la máquina).
     "lo que dejaste abierto / en desarrollo / flageaste sin contarle a nadie." */
  function openPlans() {
    state.plansOpen = true; state.libraryOpen = false;
    var T = window.ConsomniTerms;
    if (T && T.isMaximized && T.isMaximized()) T.minimize();   // el dock no tapa el tablero
    loadPlanDocs();
    render();
  }
  function closePlans() { state.plansOpen = false; render(); }

  function frenteStatusObj(k) { for (var i = 0; i < FRENTE_STATUS.length; i++) if (FRENTE_STATUS[i].key === (k || '')) return FRENTE_STATUS[i]; return FRENTE_STATUS[0]; }
  var frenteSaveTimer = null;
  function saveFrentes() { if (!api || !api.saveConfig) return; if (frenteSaveTimer) clearTimeout(frenteSaveTimer); frenteSaveTimer = setTimeout(function () { api.saveConfig({ frentes: state.frentes }); }, 400); }
  function cycleFrenteStatus(key) {
    if (!key) return;
    var cur = (state.frentes[key] && state.frentes[key].status) || '';
    var keys = FRENTE_STATUS.map(function (s) { return s.key; });
    var nx = keys[(keys.indexOf(cur) + 1) % keys.length];
    state.frentes[key] = Object.assign({}, state.frentes[key], { status: nx, updated: Date.now() });
    saveFrentes(); render();
  }
  function setFrenteNote(key, val) { if (!key) return; state.frentes[key] = Object.assign({}, state.frentes[key], { note: val, updated: Date.now() }); saveFrentes(); }

  function hasPlanData(s) { return !!(s.plan && (s.plan.hasPlan || (s.plan.todos && s.plan.todos.length))); }
  function planView() {
    var sessions = (state.snapshot && state.snapshot.sessions) || [];
    var map = {};
    sessions.forEach(function (s) {
      if (!hasPlanData(s)) return;
      var k = projKey(s);
      if (!map[k]) map[k] = { id: k, name: s.project || k, fav: false, cwd: s.cwd || '', sessions: [], pending: 0, inProgress: 0, completed: 0 };
      var g = map[k];
      g.sessions.push(s);
      if (s.fav) g.fav = true;
      if (!g.cwd && s.cwd) g.cwd = s.cwd;
      g.pending += s.plan.pending || 0; g.inProgress += s.plan.inProgress || 0; g.completed += s.plan.completed || 0;
    });
    var arr = Object.keys(map).map(function (k) { return map[k]; });
    arr.forEach(function (g) {
      g.total = g.pending + g.inProgress + g.completed;
      g.lastActivity = g.sessions.reduce(function (m, s) { return Math.max(m, s.lastActivity || 0); }, 0);
      g.sessions.sort(function (a, b) {
        var ai = (a.plan.inProgress || 0) > 0 ? 0 : 1, bi = (b.plan.inProgress || 0) > 0 ? 0 : 1;
        if (ai !== bi) return ai - bi;
        return (b.lastActivity || 0) - (a.lastActivity || 0);
      });
    });
    arr.sort(function (a, b) {
      if ((b.inProgress > 0) !== (a.inProgress > 0)) return (b.inProgress > 0 ? 1 : 0) - (a.inProgress > 0 ? 1 : 0);
      if (b.pending !== a.pending) return b.pending - a.pending;
      return b.lastActivity - a.lastActivity;
    });
    return arr;
  }

  var planDocsSig = null;   // firma de los cwds ya pedidos (para re-pedir sólo si cambió el set de frentes)
  function loadPlanDocs() {
    if (!api || !api.getPlanDocs) return;
    var groups = planView(), cwds = [];
    groups.forEach(function (g) { if (g.cwd && cwds.indexOf(g.cwd) < 0) cwds.push(g.cwd); });
    planDocsSig = cwds.slice().sort().join('|');
    if (!cwds.length) { state.planDocs = {}; return; }
    api.getPlanDocs(cwds).then(function (m) { state.planDocs = m || {}; if (state.plansOpen) render(); }).catch(function () {});
  }
  /** Con Planes abierto, si un snapshot trae frentes nuevos (cwds que no pedimos), recargar docs solos. */
  function maybeReloadPlanDocs() {
    if (!state.plansOpen || !api || !api.getPlanDocs) return;
    var cwds = [];
    planView().forEach(function (g) { if (g.cwd && cwds.indexOf(g.cwd) < 0) cwds.push(g.cwd); });
    if (cwds.slice().sort().join('|') !== planDocsSig) loadPlanDocs();
  }
  function openDocFile(p) {
    if (!p || !api || !api.action) return;
    api.action('openDoc', { file: p }).then(function (r) { toast(r && r.ok ? (r.message || 'doc abierto') : ((r && r.error) || 'no se pudo abrir'), r && r.ok ? '' : 'err'); }).catch(function () { toast('no se pudo abrir', 'err'); });
  }

  var TODO_ORDER = { in_progress: 0, pending: 1, completed: 2 };
  function todoLine(t) {
    var st = t.status || 'pending', ic, cls;
    if (st === 'completed') { ic = C.svg('check', 12, 2.6); cls = 'done'; }
    else if (st === 'in_progress') { ic = '<span class="tw-spin"></span>'; cls = 'prog'; }
    else { ic = '<span class="tw-o"></span>'; cls = 'pend'; }
    var txt = (st === 'in_progress' && t.activeForm) ? t.activeForm : t.content;
    return '<div class="tw-item tw-' + cls + '"><span class="tw-ic">' + ic + '</span><span class="tw-tx">' + esc(txt) + '</span></div>';
  }
  function rollHtml(p) {
    var total = (p.pending || 0) + (p.inProgress || 0) + (p.completed || 0);
    var pct = total ? Math.round((p.completed / total) * 100) : 0;
    return '<span class="rl rl-done" title="hechas">' + C.svg('check', 11, 2.6) + (p.completed || 0) + '</span>' +
      ((p.inProgress || 0) ? '<span class="rl rl-prog" title="en curso"><span class="tw-spin"></span>' + p.inProgress + '</span>' : '') +
      '<span class="rl rl-pend" title="pendientes"><span class="tw-o"></span>' + (p.pending || 0) + '</span>' +
      '<span class="rl-bar"><span class="rl-fill" style="width:' + pct + '%"></span></span>';
  }
  function planCardHtml(s) {
    var p = s.plan;
    var todos = (p.todos || []).slice().sort(function (a, b) {
      var ao = TODO_ORDER[a.status] != null ? TODO_ORDER[a.status] : 1, bo = TODO_ORDER[b.status] != null ? TODO_ORDER[b.status] : 1;
      return ao - bo;
    });
    var dotMap = { working: 'green', attn: 'amber', idle: 'idle', standby: 'standby', error: 'error', closed: 'idle' };
    var dk = dotMap[s.state] || 'idle';
    var planChip = p.hasPlan ? '<span class="pl-chip">' + C.svg('check', 10, 2.6) + ' plan' + (p.planAt ? ' · ' + relTime(p.planAt) : '') + '</span>' : '';
    return '<div class="plan-card" data-sid="' + esc(s.id) + '">' +
      '<div class="plan-card-head"><span class="dot dot--' + dk + '"></span>' +
        '<span class="pc-nm">' + esc(s.name) + '</span><span class="badge badge--' + s.mode + '">' + esc(s.mode) + '</span></div>' +
      '<div class="plan-card-sub"><span style="color:' + stColor(s.state) + '">' + esc(s.state) + '</span>' +
        '<span class="sep">·</span><span>' + relTime(s.lastActivity) + '</span>' + planChip + '</div>' +
      '<div class="plan-roll">' + rollHtml(p) + '</div>' +
      (todos.length ? '<details class="plan-todos"' + ((state.planTodosOpen[s.id] != null ? state.planTodosOpen[s.id] : p.inProgress) ? ' open' : '') + '><summary>' + C.svg('chevR', 10, 2.4) + ' ' + todos.length + (todos.length === 1 ? ' tarea' : ' tareas') + '</summary><div class="tw-list">' + todos.map(todoLine).join('') + '</div></details>' : '') +
      '<div class="plan-card-acts">' +
        '<button class="pc-act" data-act="plan-resume" data-sid="' + esc(s.id) + '" title="continuar esta sesión (claude --resume)">' + C.svg('reply', 11, 1.8) + ' continuar</button>' +
        '<button class="pc-act" data-act="plan-detail" data-sid="' + esc(s.id) + '">detalle</button>' +
      '</div>' +
    '</div>';
  }
  function planColHtml(g) {
    var fr = state.frentes[g.id] || {};
    var st = frenteStatusObj(fr.status);
    var pct = g.total ? Math.round((g.completed / g.total) * 100) : 0;
    var docs = (state.planDocs && state.planDocs[g.cwd]) || [];
    var head = '<div class="col-head">' +
      '<div class="col-title"><span style="color:' + (g.fav ? 'var(--amber)' : '#7a7a82') + '">' + C.svg(g.fav ? 'star' : 'repo', g.fav ? 13 : 14, 1.7) + '</span>' +
        '<span class="nm">' + esc(g.name) + '</span><span class="ct">' + g.sessions.length + '</span></div>' +
      '<button class="frente-pill" data-act="frente-status" data-frente="' + esc(g.id) + '" title="cambiar estado del frente (privado, click para ciclar)" style="color:' + st.color + '"><span class="d" style="background:' + st.color + '"></span>' + esc(st.label) + '</button>' +
    '</div>';
    var prog = '<div class="frente-prog"><span class="fp-bar"><span class="fp-fill" style="width:' + pct + '%"></span></span>' +
      '<span class="fp-tx"><b>' + g.completed + '</b>/' + g.total + ' hechas' + (g.inProgress ? ' · ' + g.inProgress + ' en curso' : '') + (g.pending ? ' · ' + g.pending + ' pend' : '') + '</span></div>';
    var cards = g.sessions.map(planCardHtml).join('');
    var docsHtml = docs.length ? '<div class="plan-docs"><div class="pd-lbl">DOCS · PLAN / SPEC</div>' + docs.map(function (dc) {
      return '<button class="pd-row" data-act="open-doc" data-doc="' + esc(dc.path) + '" title="' + esc(dc.path) + '">' + C.svg('file', 12, 1.7) + '<span class="pd-nm">' + esc(dc.name) + '</span><span class="pd-go">' + C.svg('ext', 11, 2) + '</span></button>';
    }).join('') + '</div>' : '';
    var note = '<div class="frente-note-wrap"><div class="pd-lbl">NOTA PRIVADA / IDEA</div>' +
      '<textarea class="frente-note" data-frente="' + esc(g.id) + '" rows="2" placeholder="lo que estás flageando para implementar/mejorar… (sólo local, nunca sale de tu máquina)">' + esc(fr.note || '') + '</textarea></div>';
    var allDone = g.total > 0 && !g.pending && !g.inProgress;   // frente terminado → atenuado (menos ruido)
    return '<section class="col plan-col' + (allDone ? ' plan-col--done' : '') + '" data-frente="' + esc(g.id) + '">' + head + prog +
      '<div class="col-cards">' + cards + docsHtml + note + '</div></section>';
  }
  function plansIntro() {
    return '<div class="plans-intro"><span class="pi-eye">' + C.eye(18, false) + '</span>' +
      '<span class="pi-tx"><b>FRENTES</b> · planes, specs y tareas que dejaste abiertos — <span class="pi-dim">detectados de tus sesiones (plan mode · TodoWrite) + docs del repo · 100% local</span></span>' +
      '<button class="pi-refresh pi-tour" data-act="plan-tour" title="ver el tutorial">' + C.svg('eye', 13, 1.8) + ' tutorial</button>' +
      '<button class="pi-refresh" data-act="plans-refresh" title="re-escanear docs del repo">' + C.svg('redo', 12, 2) + '</button></div>';
  }
  function renderPlansBoard() {
    var groups = planView();
    if (!groups.length) {
      return '<main class="board plans-board"><div class="plans-empty">' + C.eye(48, false) +
        '<div class="pe-title">Todavía no detecté planes ni tareas</div>' +
        '<div class="pe-text">Cuando una sesión presente un <b>plan</b> (plan mode → ExitPlanMode) o arme una lista de <b>tareas</b> (TodoWrite), su progreso —qué está <b>pendiente</b> y qué ya se <b>hizo</b>— aparece acá, agrupado por proyecto. También levanto los <b>plan.md</b> / <b>spec.md</b> de tus repos.</div>' +
      '</div></main>';
    }
    return '<main class="board plans-board">' + groups.map(planColHtml).join('') + '</main>';
  }
  function buildPlans(o) {
    var sidebar = state.collapsed ? C.sidebar(Object.assign({}, o, { collapsed: true })) : C.sidebar(o);
    return '<div class="app">' + C.topbar(o) +
      '<div class="main-row">' + sidebar + '<div class="plans-wrap">' + plansIntro() + renderPlansBoard() + '</div></div>' +
      C.statusbar(o) + C.crt() + '</div>';
  }

  /* ════════ BIBLIOTECA (prompts / skills / rules — 100% local) ════════
     Guardás y reutilizás los prompts que usás seguido. Vive en
     ~/.consomni/library.json (store dedicado). Misma mecánica de vista que Planes. */
  var LIB_KINDS = [
    { key: 'prompt', label: 'prompt', color: 'var(--green)' },
    { key: 'skill', label: 'skill', color: 'var(--violet)' },
    { key: 'rule', label: 'rule', color: 'var(--amber)' }
  ];
  function libKindObj(k) { for (var i = 0; i < LIB_KINDS.length; i++) if (LIB_KINDS[i].key === k) return LIB_KINDS[i]; return LIB_KINDS[0]; }
  function genLibId() { return 'lib_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function libById(id) { for (var i = 0; i < state.library.length; i++) if (state.library[i].id === id) return state.library[i]; return null; }
  function normTags(arr) {
    var seen = {}, out = [];
    (arr || []).forEach(function (t) { t = String(t || '').trim().toLowerCase(); if (t && !seen[t]) { seen[t] = 1; out.push(t); } });
    return out.slice(0, 12);
  }
  function persistLibrary() { if (api && api.saveLibrary) api.saveLibrary({ entries: state.library, seeded: state.librarySeeded !== false }); }

  function openLibrary() {
    state.libraryOpen = true; state.plansOpen = false;
    var T = window.ConsomniTerms;
    if (T && T.isMaximized && T.isMaximized()) T.minimize();   // el dock no tapa la biblioteca
    render();
  }
  function closeLibrary() { state.libraryOpen = false; render(); }

  /* ── filtros / vista ── */
  function libAllTags() {
    var counts = {};
    state.library.forEach(function (e) { (e.tags || []).forEach(function (t) { counts[t] = (counts[t] || 0) + 1; }); });
    return Object.keys(counts).sort().map(function (t) { return { tag: t, n: counts[t] }; });
  }
  function libMatches(e) {
    var f = state.libFilter;
    if (f.kind && e.kind !== f.kind) return false;
    if (f.tag && (e.tags || []).indexOf(f.tag) < 0) return false;
    if (f.q) {
      var hay = (e.title + ' ' + e.content + ' ' + (e.tags || []).join(' ')).toLowerCase();
      if (hay.indexOf(f.q.toLowerCase()) < 0) return false;
    }
    return true;
  }
  function libView() { return state.library.filter(libMatches).slice().sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); }); }
  function libCount(kind) { return state.library.filter(function (e) { return !kind || e.kind === kind; }).length; }

  /* ── render de la vista ── */
  function libIntro() {
    return '<div class="lib-intro"><span class="pi-eye">' + C.eye(18, false) + '</span>' +
      '<span class="pi-tx"><b>BIBLIOTECA</b> · tus <b>prompts</b>, <b>skills</b> y <b>rules</b> reutilizables — <span class="pi-dim">guardalos una vez, copialos o insertalos al instante · 100% local</span></span>' +
      '<button class="lib-newbtn lib-new" data-act="lib-new" title="crear un nuevo item">' + C.svg('plus', 13, 2.2) + ' nuevo</button>' +
      '<button class="pi-refresh pi-tour" data-act="lib-tour" title="ver el tutorial">' + C.svg('eye', 13, 1.8) + ' tutorial</button>' +
      '<button class="pi-refresh" data-act="lib-import" title="importar desde un .json">' + C.svg('download', 13, 2) + '</button>' +
      '<button class="pi-refresh" data-act="lib-export" title="exportar a un .json">' + C.svg('ext', 12, 2) + '</button></div>';
  }
  function libToolbar() {
    var f = state.libFilter;
    var kinds = '<button class="lib-chip' + (!f.kind ? ' on' : '') + '" data-act="lib-filter" data-kind="">todos <span class="lc-n">' + libCount('') + '</span></button>' +
      LIB_KINDS.map(function (k) { return '<button class="lib-chip lib-chip--' + k.key + (f.kind === k.key ? ' on' : '') + '" data-act="lib-filter" data-kind="' + k.key + '">' + k.label + ' <span class="lc-n">' + libCount(k.key) + '</span></button>'; }).join('');
    var tags = libAllTags();
    var tagHtml = tags.length ? '<div class="lib-tagbar">' + tags.map(function (t) {
      return '<button class="lib-tag' + (f.tag === t.tag ? ' on' : '') + '" data-act="lib-tag" data-tag="' + esc(t.tag) + '">#' + esc(t.tag) + '<span class="lc-n">' + t.n + '</span></button>';
    }).join('') + '</div>' : '';
    var clearable = f.kind || f.tag || f.q;
    return '<div class="lib-toolbar">' +
      '<div class="lib-search-wrap">' + C.svg('search', 15, 2) + '<input class="lib-search" placeholder="buscar por título, contenido o tag…" value="' + esc(f.q || '') + '" spellcheck="false">' +
        (clearable ? '<button class="lib-clear" data-act="lib-clear" title="limpiar filtros">' + C.svg('x', 13, 2) + '</button>' : '') + '</div>' +
      '<div class="lib-chips">' + kinds + '</div>' + tagHtml + '</div>';
  }
  function libCardHtml(e) {
    var k = libKindObj(e.kind);
    var prev = (e.content || '').length > 240 ? e.content.slice(0, 240) + '…' : (e.content || '');
    var tags = (e.tags || []).length ? '<div class="lib-tags">' + e.tags.map(function (t) { return '<span class="lib-tg" data-act="lib-tag" data-tag="' + esc(t) + '">#' + esc(t) + '</span>'; }).join('') + '</div>' : '';
    return '<article class="lib-card" data-id="' + esc(e.id) + '">' +
      '<div class="lib-card-head"><span class="lib-badge lib-badge--' + k.key + '">' + esc(k.label) + '</span>' +
        '<span class="lib-title">' + esc(e.title || 'sin título') + '</span></div>' +
      '<div class="lib-prev">' + esc(prev) + '</div>' + tags +
      '<div class="lib-card-acts">' +
        '<button class="lib-act lib-act--go lib-copy" data-act="lib-copy" data-id="' + esc(e.id) + '" title="copiar al portapapeles">' + C.svg('copy', 12, 1.8) + ' copiar</button>' +
        '<button class="lib-act lib-insert" data-act="lib-insert" data-id="' + esc(e.id) + '" title="insertar en la terminal/claude activa (sin ejecutar)">' + C.svg('dispatch', 12, 1.8) + ' insertar</button>' +
        '<span class="lib-act-sp"></span>' +
        '<button class="lib-ic" data-act="lib-edit" data-id="' + esc(e.id) + '" title="editar">' + C.svg('edit', 12, 1.8) + '</button>' +
        '<button class="lib-ic" data-act="lib-dup" data-id="' + esc(e.id) + '" title="duplicar">' + C.svg('copy', 12, 1.8) + '</button>' +
        '<button class="lib-ic lib-ic--del" data-act="lib-del" data-id="' + esc(e.id) + '" title="eliminar">' + C.svg('trash', 12, 1.8) + '</button>' +
      '</div></article>';
  }
  function renderLibBoard() {
    if (!state.library.length) {
      return '<main class="board lib-board lib-board--empty"><div class="lib-empty">' + C.eye(48, false) +
        '<div class="le-title">Tu biblioteca está vacía</div>' +
        '<div class="le-text">Guardá los prompts que usás seguido — una <b>revisión de PR</b>, un <b>crear app desde cero</b>, una <b>regla</b> de estilo — y recuperalos al instante: copiar en un click o insertarlos en una terminal/claude.</div>' +
        '<button class="lib-newbtn lib-new" data-act="lib-new">' + C.svg('plus', 13, 2.2) + ' crear el primero</button>' +
      '</div></main>';
    }
    var items = libView();
    if (!items.length) {
      return '<main class="board lib-board"><div class="lib-empty lib-empty--filtered">' + C.svg('search', 30, 1.8) +
        '<div class="le-title">Sin resultados</div><div class="le-text">Ningún item matchea el filtro. <button class="lib-link" data-act="lib-clear">limpiar filtros</button></div></div></main>';
    }
    return '<main class="board lib-board">' + items.map(libCardHtml).join('') + '</main>';
  }
  function buildLibrary(o) {
    var sidebar = state.collapsed ? C.sidebar(Object.assign({}, o, { collapsed: true })) : C.sidebar(o);
    return '<div class="app">' + C.topbar(o) +
      '<div class="main-row">' + sidebar + '<div class="lib-wrap">' + libIntro() + libToolbar() + renderLibBoard() + '</div></div>' +
      C.statusbar(o) + C.crt() + '</div>';
  }

  /* ── editor (modal en #overlays, reusa el lenguaje de Settings) ── */
  function openLibEdit(id) {
    var e = id ? libById(id) : null, editing = !!e, kind = e ? e.kind : 'prompt';
    state.libEditOpen = true; state.libEditId = e ? e.id : null;
    var kseg = LIB_KINDS.map(function (k) { return '<button type="button" class="lib-kopt lib-kopt--' + k.key + (k.key === kind ? ' on' : '') + '" data-libkind="' + k.key + '">' + esc(k.label) + '</button>'; }).join('');
    var html = '<div class="lib-edit-scrim"><div class="lib-edit-card" role="dialog" aria-modal="true">' +
      '<div class="set-head"><span class="ttl">' + (editing ? 'EDITAR ITEM' : 'NUEVO ITEM') + '</span><button class="iconbtn" style="width:26px;height:26px" data-libedit="cancel">' + C.svg('x', 14, 2) + '</button></div>' +
      '<div class="lib-edit-body">' +
        '<div class="le-row"><span class="le-lbl">TIPO</span><div class="lib-kseg">' + kseg + '</div></div>' +
        '<div class="le-row"><span class="le-lbl">TÍTULO</span><input class="set-inp le-inp" id="libTitle" placeholder="ej: Revisión de PR" value="' + esc(e ? e.title : '') + '" spellcheck="false"></div>' +
        '<div class="le-row le-row--ta"><span class="le-lbl">CONTENIDO</span><textarea class="lib-ta" id="libContent" placeholder="el prompt / la skill / la regla…" spellcheck="false">' + esc(e ? e.content : '') + '</textarea></div>' +
        '<div class="le-row"><span class="le-lbl">TAGS</span><input class="set-inp le-inp" id="libTags" placeholder="separados por coma · ej: review, git" value="' + esc(e ? (e.tags || []).join(', ') : '') + '" spellcheck="false"></div>' +
      '</div>' +
      '<div class="lib-edit-foot">' +
        (editing ? '<button class="btn btn--sm btn--red" data-libedit="del">' + C.svg('trash', 12, 1.8) + ' eliminar</button>' : '') +
        '<span style="flex:1"></span>' +
        '<button class="btn btn--sm" data-libedit="cancel">cancelar</button>' +
        '<button class="btn btn--green btn--sm" data-libedit="save">' + C.svg('check', 13, 2.2) + ' guardar</button>' +
      '</div></div></div>';
    setOverlay(html);
    wireLibEdit();
    setTimeout(function () { var ti = document.getElementById('libTitle'); if (ti) ti.focus(); }, 0);
  }
  function wireLibEdit() {
    var card = document.querySelector('.lib-edit-card'), scrim = document.querySelector('.lib-edit-scrim');
    if (!card) return;
    Array.prototype.forEach.call(card.querySelectorAll('.lib-kopt'), function (b) {
      b.addEventListener('click', function (ev) { ev.stopPropagation();
        Array.prototype.forEach.call(card.querySelectorAll('.lib-kopt'), function (o) { o.classList.remove('on'); });
        b.classList.add('on');
      });
    });
    Array.prototype.forEach.call(card.querySelectorAll('[data-libedit]'), function (b) {
      b.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var a = b.getAttribute('data-libedit');
        if (a === 'cancel') closeLibEdit();
        else if (a === 'save') saveLibEntryFromForm();
        else if (a === 'del') { var id = state.libEditId; closeLibEdit(); if (id) requestDeleteLib(id); }
      });
    });
    if (scrim) scrim.addEventListener('click', function (ev) { if (ev.target === scrim) closeLibEdit(); });
  }
  function closeLibEdit() { state.libEditOpen = false; state.libEditId = null; setOverlay(''); }
  function saveLibEntryFromForm() {
    var card = document.querySelector('.lib-edit-card'); if (!card) return;
    var kindEl = card.querySelector('.lib-kopt.on');
    var kind = kindEl ? kindEl.getAttribute('data-libkind') : 'prompt';
    var title = (card.querySelector('#libTitle').value || '').trim();
    var content = card.querySelector('#libContent').value || '';
    var tags = normTags((card.querySelector('#libTags').value || '').split(','));
    if (!title && !content.trim()) { toast('escribí al menos un título o contenido', 'warn'); return; }
    if (!title) title = content.trim().slice(0, 40);
    var now = Date.now();
    if (state.libEditId) {
      var e = libById(state.libEditId);
      if (e) { e.kind = kind; e.title = title; e.content = content; e.tags = tags; e.updatedAt = now; }
    } else {
      state.library.unshift({ id: genLibId(), kind: kind, title: title, content: content, tags: tags, createdAt: now, updatedAt: now });
    }
    persistLibrary(); closeLibEdit(); render(); toast('guardado en la biblioteca');
  }

  /* ── acciones de card ── */
  function dupLibEntry(id) {
    var e = libById(id); if (!e) return;
    var now = Date.now();
    state.library.unshift({ id: genLibId(), kind: e.kind, title: e.title + ' (copia)', content: e.content, tags: (e.tags || []).slice(), createdAt: now, updatedAt: now });
    persistLibrary(); render(); toast('duplicado');
  }
  function requestDeleteLib(id) {
    var e = libById(id); if (!e) return;
    pendingClose = function () { deleteLibConfirmed(id); };
    var html = '<div class="cfm-scrim" data-act="cfm-cancel"><div class="cfm-card" role="dialog" aria-modal="true">' +
      '<div class="cfm-ttl">' + C.svg('trash', 16, 1.9) + ' ¿Eliminar de la biblioteca?</div>' +
      '<div class="cfm-body">Vas a borrar <b>' + esc(e.title || 'este item') + '</b>. Es local y no se puede deshacer.</div>' +
      '<div class="cfm-btns"><button class="btn btn--sm" data-act="cfm-cancel">cancelar</button>' +
        '<button class="btn btn--sm btn--red" data-act="cfm-ok">' + C.svg('trash', 12, 2) + ' eliminar</button></div></div></div>';
    setOverlay(html);
  }
  function deleteLibConfirmed(id) {
    state.library = state.library.filter(function (e) { return e.id !== id; });
    persistLibrary(); render(); toast('eliminado');
  }
  function copyLibEntry(id) {
    var e = libById(id); if (!e) return;
    if (api && api.action) api.action('copyText', { text: e.content, branch: e.kind }).then(function () { toast('copiado al portapapeles'); }).catch(function () { toast('no se pudo copiar', 'err'); });
    else toast('copiar no disponible', 'warn');
  }
  function insertLibEntry(id) {
    var e = libById(id); if (!e) return;
    var T = window.ConsomniTerms;
    var ok = T && T.insertIntoFocused ? T.insertIntoFocused(e.content) : false;
    if (ok) toast('insertado en la terminal · revisá y apretá Enter'); else toast('abrí una terminal o sesión para insertarlo', 'warn');
  }

  /* ── import / export (.json, respaldo / compartir) ── */
  function doExportLibrary() {
    if (!api || !api.exportLibrary) { toast('exportar no disponible', 'warn'); return; }
    api.exportLibrary(state.library).then(function (r) {
      if (r && r.ok) toast('exportado · ' + (r.count || 0) + ' items'); else if (r && r.error) toast('export: ' + r.error, 'err');
    }).catch(function () { toast('no se pudo exportar', 'err'); });
  }
  function doImportLibrary() {
    if (!api || !api.importLibrary) { toast('importar no disponible', 'warn'); return; }
    api.importLibrary().then(function (r) {
      if (!r || !r.ok) { if (r && r.error) toast('import: ' + r.error, 'err'); return; }
      var added = 0, now = Date.now();
      (r.entries || []).forEach(function (raw) {
        if (!raw || (!raw.title && !raw.content)) return;
        var kind = (raw.kind === 'skill' || raw.kind === 'rule') ? raw.kind : 'prompt';
        state.library.unshift({ id: genLibId(), kind: kind, title: String(raw.title || '').slice(0, 200) || 'sin título', content: String(raw.content || ''), tags: normTags(raw.tags || []), createdAt: now, updatedAt: now });
        added++;
      });
      if (added) { persistLibrary(); render(); toast('importados ' + added + ' items'); } else toast('no había items válidos en el archivo', 'warn');
    }).catch(function () { toast('no se pudo importar', 'err'); });
  }

  /* ── seeds (1ª ejecución; cubren los 3 tipos) ── */
  function seedLibrary() {
    var now = Date.now();
    function mk(kind, title, tags, content) { return { id: genLibId(), kind: kind, title: title, content: content, tags: normTags(tags), createdAt: now, updatedAt: now, seed: true }; }
    return [
      mk('prompt', 'Revisión de PR', ['review', 'git', 'calidad'],
        'Revisá este pull request como un senior exigente pero constructivo.\n\n1. Resumí en 2 líneas QUÉ hace el cambio.\n2. Bugs y casos borde: enumerá problemas reales con archivo:línea y por qué fallan.\n3. Seguridad: inputs sin validar, secrets, inyección, permisos.\n4. Diseño y simplicidad: ¿se puede reusar algo que ya existe? ¿hay duplicación?\n5. Tests: ¿qué falta cubrir?\n\nSé concreto, priorizá por severidad (alta/media/baja) y proponé el fix, no sólo el problema.'),
      mk('prompt', 'Crear app desde cero', ['scaffold', 'inicio'],
        'Quiero crear una nueva app: <describí la idea, el stack y la plataforma>.\n\nAntes de escribir código:\n1. Hacé 3-5 preguntas que de verdad cambien el diseño (no triviales).\n2. Proponé un stack mínimo y justificá cada dependencia.\n3. Dame la estructura de carpetas y los archivos clave.\n4. Un plan por fases, con un "done" verificable por fase.\n\nReglas: local-first si se puede, sin libs innecesarias, y dejá el primer run funcionando antes de sumar features.'),
      mk('prompt', 'Investigar bug (root cause)', ['debug', 'investigación'],
        'Tengo este bug: <síntoma + cómo se reproduce>.\n\nNo parchees a ciegas. Seguí este método:\n1. Reproducí y confirmá el síntoma exacto.\n2. Formulá 2-3 hipótesis de causa raíz, ordenadas por probabilidad.\n3. Verificá cada una con evidencia del código/logs (archivo:línea).\n4. Recién ahí proponé el fix mínimo + cómo lo testeo para confirmar que no vuelve.\n\nMostrame el razonamiento, no sólo la conclusión.'),
      mk('skill', 'QA visual responsive', ['qa', 'ui', 'responsive'],
        'Hacé QA visual de la pantalla actual a 1320px y 720px de ancho.\n\nChequeá: overflow/clipping, scroll horizontal no deseado, jerarquía y espaciado, contraste, estados (hover / activo / vacío), y que nada se rompa al colapsar el layout. Reportá cada hallazgo con su severidad y la regla CSS responsable, y proponé el fix usando los tokens existentes (cero drift visual).'),
      mk('rule', 'Convenciones de commit', ['git', 'proceso'],
        'Reglas de commit para este repo:\n- Mensajes en español, en imperativo y concisos ("agrega…", "corrige…").\n- Un commit = un cambio lógico; no mezclar refactor con feature.\n- NUNCA hacer git commit ni git push sin aprobación explícita del usuario.\n- No incluir secrets ni tokens; revisar el diff antes de commitear.')
    ];
  }

  /* ── tutorial de biblioteca (reusa el motor de coachmark) ── */
  function openLibraryForTour() { if (!state.libraryOpen) openLibrary(); }
  function libraryTourSteps() {
    var hasData = state.library.length > 0;
    var steps = [
      { center: true, icon: 'book', title: 'Biblioteca · tus prompts', before: openLibraryForTour,
        body: 'Acá guardás los <b>prompts</b>, <b>skills</b> y <b>rules</b> que usás seguido — una <b>revisión de PR</b>, un <b>crear app desde cero</b>, tus reglas — para reutilizarlos sin reescribirlos. <b>100% local</b>: no sale de tu máquina.' },
      { target: '.sb-lib', alt: '.ci-lib', place: 'right', icon: 'book', title: 'Entrá a "biblioteca"', before: openLibraryForTour,
        body: 'Desde acá abrís el panel. Está siempre a mano, al lado de inicio y planes.' }
    ];
    if (!hasData) {
      steps.push({ center: true, icon: 'plus', title: 'Creá el primero', before: openLibraryForTour,
        body: 'Tocá <b>+ nuevo</b>, elegí el tipo (prompt / skill / rule), pegá tu texto y los tags, y listo. Después lo copiás o insertás en una terminal en un click. Volvé cuando tengas alguno y te muestro el resto.' });
      return steps;
    }
    steps.push(
      { target: '.lib-toolbar', place: 'bottom', title: 'Filtrá y buscá', before: openLibraryForTour,
        body: 'Filtrá por <b>tipo</b> (prompt / skill / rule) o por <b>#tag</b>, o buscá por texto. Encontrás lo que querés al toque aunque tengas decenas.' },
      { target: '.lib-card .lib-card-acts', alt: '.lib-card', place: 'top', title: 'Copiar o insertar', before: openLibraryForTour,
        body: '<b>Copiar</b> lo manda al portapapeles. <b>Insertar</b> lo escribe en tu terminal/claude activa <i>sin ejecutarlo</i> — revisás y apretás Enter. También editás, duplicás y eliminás.' },
      { target: '.lib-new', alt: '.lib-intro', place: 'bottom', title: 'Guardá los tuyos', before: openLibraryForTour,
        body: 'Con <b>+ nuevo</b> agregás los tuyos. Y con <b>importar / exportar</b> respaldás o compartís tu biblioteca como un <code>.json</code>.' }
    );
    return steps;
  }
  function startLibraryTour() { startTour(libraryTourSteps(), 'consomni.tour.library'); }
  function maybeStartLibraryTour() {
    var done = false; try { done = localStorage.getItem('consomni.tour.library') === '1'; } catch (e) {}
    if (done || TOUR.active) return;
    startLibraryTour();
  }

  /* ── tutorial de CONFIGURACIÓN / multi-perfil (reusa el motor de coachmark, dentro del modal de Settings) ──
     Apunta a la sección PERFIL DE CLAUDE. Se auto-abre Settings y se ilumina paso a paso. */
  function openSettingsForTour() { if (!state.settingsOpen) openSettings(); }
  function markProfileTourSeen() {
    state.seenProfileTour = true;
    if (api && api.saveConfig) api.saveConfig({ seenProfileTour: true });
  }
  function profileTourSteps() {
    return [
      { center: true, icon: 'sparkles', title: 'Novedad: multi-perfil de Claude', before: openSettingsForTour,
        body: 'Ahora Consomni puede monitorear <b>cualquier perfil</b> de Claude Code, no solo <code>~/.claude</code>. Si usás un alias como <code>claude-max</code> (que apunta a <code>~/.claude-max</code>), podés decirle a Consomni que mire <b>ese</b> perfil. Te muestro dónde, son 10 segundos.' },
      { target: '#setProfSec', place: 'bottom', icon: 'folder', title: 'Elegí tu perfil', before: openSettingsForTour, pad: 10,
        body: 'Consomni <b>auto-detecta</b> tus carpetas <code>.claude*</code> y las lista acá. Click en una para que el tablero pase a mostrar las sesiones de <b>ese</b> config dir. La que está activa lleva el punto verde.' },
      { target: '#setProfPath', alt: '#setProfSec', place: 'bottom', icon: 'folder', title: 'Ruta a mano o volver a auto', before: openSettingsForTour,
        body: 'Si tu perfil está en otra ruta, pegala o tocá <b>elegir</b> para buscarla. <b>Usar default (auto)</b> vuelve al comportamiento de siempre (la variable <code>CLAUDE_CONFIG_DIR</code> de tu entorno, o <code>~/.claude</code>).' },
      { target: '#setHooksBtn', alt: '#setHooksSec', place: 'top', icon: 'check', title: 'Reinstalá los hooks al cambiar', before: openSettingsForTour,
        body: 'Cada perfil tiene su propio <code>settings.json</code>. Cuando cambiás de perfil, <b>reinstalá los hooks acá</b> para que el estado en vivo siga funcionando en el perfil nuevo (con backup automático, como siempre).' }
    ];
  }
  function startProfileTour() {
    openSettingsForTour();
    // esperar a que el modal de Settings esté en el DOM antes de pintar el primer recorte
    var tries = 0;
    (function wait() {
      if (document.querySelector('#setProfSec') || tries > 40) {
        startTour(profileTourSteps(), 'consomni.tour.profile', markProfileTourSeen);
        return;
      }
      tries++; requestAnimationFrame(wait);
    })();
  }
  // Auto-arranque 1 vez tras actualizar: solo si no lo vio, no hay onboarding ni otro overlay abierto.
  function maybeAutostartProfileTour() {
    if (TOUR.active || anyOverlayOpen()) return;
    if (document.querySelector('.onb-scrim')) return;   // onboarding visible → lo dejamos para otro arranque
    if (!api || !api.getConfig) return;
    api.getConfig().then(function (cfg) {
      if (!cfg || cfg.seenProfileTour) { if (cfg) state.seenProfileTour = true; return; }
      if (TOUR.active || anyOverlayOpen() || document.querySelector('.onb-scrim')) return;
      startProfileTour();
    }).catch(function () {});
  }

  /* ════════ TOUR DE NOVEDADES v1.8.0 (reusa el motor de spotlight) ════════
     Headline F6 (barra de sesiones) + F5/F4/F1 + cierre liviano F3. Abre una terminal DEMO efímera
     para que F6/F4 sean highlights reales; se limpia en cualquier cierre (onEnd). */
  function openWhatsNewStage() { var T = window.ConsomniTerms; if (T && T.openTourDemo) { try { T.openTourDemo(); } catch (e) {} } }
  function whatsNewTourSteps() {
    return [
      { center: true, icon: 'sparkles', title: 'Novedades de la v1.8.0', before: openWhatsNewStage,
        body: 'Salieron varias cosas nuevas para laburar con tus terminales. Te las muestro en 30 segundos — podés <b>saltar</b> cuando quieras.' },
      { target: '.dk-sessions', place: 'bottom', icon: 'term', title: 'Varias sesiones a la vez', before: openWhatsNewStage,
        body: 'Cada terminal/sesión viva aparece acá como un <b>chip</b>. Tené <b>varias en paralelo</b>, cambiá entre ellas con un click, y <b>minimizá</b> una (botón del panel) para ocultarla <b>sin matar su proceso</b> — sigue corriendo en background (el puntito ámbar lo confirma) y la traés de vuelta cuando quieras.' },
      { target: '.dk-new-proj', place: 'bottom', icon: 'folder', title: 'Abrí una terminal en un proyecto', before: openWhatsNewStage,
        body: 'Desde acá (y desde los atajos del <b>inicio</b>) abrís una terminal <b>directo en un proyecto</b> — sin ir a buscarlo, abrirla y favearla a mano cada vez.' },
      { target: '.dk-pane-cd', place: 'bottom', icon: 'folder', title: 'Cambiá de carpeta sin tipear cd', before: openWhatsNewStage,
        body: 'El botón de carpeta de una terminal te deja <b>cambiar el directorio</b> eligiendo de una lista de tus proyectos (o el selector nativo). Consomni le manda el <code>cd</code> por vos.' },
      { target: '.dk-new-claude', place: 'bottom', icon: 'dispatch', title: 'Menciones con @', before: openWhatsNewStage,
        body: 'En una terminal de <b>Claude</b>, al tipear <b>@</b> se abre el panel de archivos y tu texto se ve en <b>ghost</b> a la vez. <b>ESC</b> cierra el panel <b>conservando</b> lo que escribiste.' },
      { center: true, icon: 'eye', title: 'Y arranca con la PC', before: openWhatsNewStage,
        body: 'Si querés, Consomni puede <b>abrirse sola al prender la compu</b>. Lo activás en <b>Settings → Sistema</b>. ¡Eso es todo!' }
    ];
  }
  function markWhatsNewSeen() { state.seenWhatsNew18 = true; if (api && api.saveConfig) api.saveConfig({ seenWhatsNew18: true }); }
  function cleanupWhatsNewTour() { var T = window.ConsomniTerms; if (T && T.closeTourDemo) { try { T.closeTourDemo(); } catch (e) {} } }
  function startWhatsNewTour() { startTour(whatsNewTourSteps(), 'consomni.tour.whatsnew18', markWhatsNewSeen, cleanupWhatsNewTour); }
  // Auto-arranque tras actualizar: novedades v1.8.0 primero; si ya las vio, cae al tour de multi-perfil.
  function maybeAutostartTours() {
    if (TOUR.active || anyOverlayOpen() || document.querySelector('.onb-scrim')) return;
    if (!api || !api.getConfig) return;
    api.getConfig().then(function (cfg) {
      if (!cfg || TOUR.active || anyOverlayOpen() || document.querySelector('.onb-scrim')) return;
      if (!cfg.seenWhatsNew18) { startWhatsNewTour(); return; }
      state.seenProfileTour = cfg.seenProfileTour;
      if (!cfg.seenProfileTour) startProfileTour();
    }).catch(function () {});
  }

  /* ════════ FILTROS / ORDEN / DENSIDAD / PROYECTO ════════ */
  function setActiveProject(p) {
    state.activeProject = p; state.focusSid = null; state.plansOpen = false; state.libraryOpen = false;
    var T = window.ConsomniTerms;
    if (p === 'all' || p === '__archived') {
      // "todos" / "archivados" → board (no dock maximizado). Si veníamos de pantalla completa, salimos.
      if (T) { if (T.isMaximized()) T.minimize(); T.setView('__home__'); }
      render(); return;
    }
    // proyecto puntual → abrir SUS terminales DE UNA (pantalla completa) + auto-abrir sus sesiones
    keepProject(p);   // trabajaste en él → queda fijo en el sidebar aunque después cierres todo
    var info = projInfo(p);
    render();
    if (T) T.openProject(p, info.cwd, info.name, projSessions(p));
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
  // modo claro / oscuro (default oscuro). Sólo togglea la clase body.light (el CSS hace el resto) + persiste.
  function applyTheme() {
    document.body.classList.toggle('light', state.theme === 'light');
    if (api && api.setTitleBarOverlay) api.setTitleBarOverlay(state.theme);   // recolorea los botones nativos de la title bar
  }
  function toggleTheme() {
    state.theme = state.theme === 'light' ? 'dark' : 'light';
    applyTheme();
    if (api && api.saveConfig) api.saveConfig({ theme: state.theme });
    render();   // refresca el ícono del botón (sol/luna)
    toast(state.theme === 'light' ? 'modo claro' : 'modo oscuro');
  }

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
    rows.push({ group: 'ACCIONES', ic: 'tasks', tx: 'Abrir Planes (frentes)', sub: 'pendiente vs hecho', keys: [], act: 'plans' });
    rows.push({ group: 'ACCIONES', ic: 'eye', tx: 'Tutorial de Planes', sub: 'tour paso a paso', keys: [], act: 'tour' });
    rows.push({ group: 'ACCIONES', ic: 'book', tx: 'Abrir Biblioteca', sub: 'prompts / skills / rules', keys: [], act: 'library' });
    rows.push({ group: 'ACCIONES', ic: 'plus', tx: 'Nuevo item en la biblioteca', sub: 'prompt / skill / rule', keys: [], act: 'libnew' });
    rows.push({ group: 'ACCIONES', ic: 'eye', tx: 'Tutorial de Biblioteca', sub: 'tour paso a paso', keys: [], act: 'libtour' });
    rows.push({ group: 'ACCIONES', ic: 'gear', tx: 'Abrir settings', sub: '', keys: [], act: 'settings' });
    rows.push({ group: 'ACCIONES', ic: 'sparkles', tx: 'Novedades v1.8.0', sub: 'tour de lo nuevo', keys: [], act: 'whatsnew' });
    rows.push({ group: 'ACCIONES', ic: 'eye', tx: 'Tutorial de perfiles', sub: 'multi-perfil de Claude · tour', keys: [], act: 'proftour' });
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
    else if (row.act === 'plans') { closePalette(); openPlans(); maybeStartPlanTour(); }
    else if (row.act === 'tour') { closePalette(); openPlans(); startPlanTour(); }
    else if (row.act === 'library') { closePalette(); openLibrary(); maybeStartLibraryTour(); }
    else if (row.act === 'libnew') { closePalette(); openLibrary(); openLibEdit(null); }
    else if (row.act === 'libtour') { closePalette(); openLibrary(); startLibraryTour(); }
    else if (row.act === 'proftour') { closePalette(); startProfileTour(); }
    else if (row.act === 'whatsnew') { closePalette(); startWhatsNewTour(); }
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
    ['⌘1..9', 'saltar a proyecto'], ['f', 'filtro de modo'], ['s', 'orden'],
    ['m', 'mute'], ['g a', 'ir a atención'], ['?', 'esta ayuda']
  ];
  function openHelp() {
    var rows = HELP.map(function (h) { return '<div class="help-row"><kbd class="kbd">' + h[0] + '</kbd><span class="lbl">' + h[1] + '</span></div>'; }).join('');
    var foot = '<div style="display:flex;justify-content:center;margin-top:14px;padding-top:13px;border-top:1px solid var(--border)">' +
      '<button class="btn btn--sm" data-act="help-whatsnew">' + C.svg('sparkles', 12, 1.8) + ' Novedades v1.8.0</button></div>';
    setOverlay('<div class="help-scrim" data-act="close-help"><div class="help-card"><h3>ATAJOS DE TECLADO</h3><div class="help-grid">' + rows + '</div>' + foot + '</div></div>');
    state.helpOpen = true;
  }

  /* ════════ SETTINGS ════════ */
  var settingsProfiles = [];   // perfiles de Claude detectados (para la sección "PERFIL DE CLAUDE")
  function openSettings() {
    if (!api || !api.getConfig) { toast('settings no disponible', 'warn'); return; }
    Promise.all([
      api.getConfig(),
      api.getHooksStatus ? api.getHooksStatus() : Promise.resolve({}),
      api.getClaudeProfiles ? api.getClaudeProfiles().catch(function () { return []; }) : Promise.resolve([])
    ]).then(function (a) { settingsProfiles = Array.isArray(a[2]) ? a[2] : []; renderSettings(a[0], a[1] || {}); });
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
    // PROYECTOS OCULTOS (marcados "esto no es un proyecto") → fila con nombre + "mostrar" para revertir
    var hiddenRows = (state.hiddenProjects || []).map(function (id) {
      var name = String(id).split('/').filter(Boolean).pop() || id;
      return '<div class="set-dir"><span class="p">' + esc(name) + ' <span style="color:var(--text-4);font-size:10px">· ' + esc(id) + '</span></span><button class="btn btn--sm" data-show="' + esc(id) + '">' + C.svg('eye', 12, 1.9) + ' mostrar</button></div>';
    }).join('');
    var hiddenSec = (state.hiddenProjects && state.hiddenProjects.length)
      ? '<div class="set-sec"><div class="lbl">PROYECTOS OCULTOS (no son proyectos)</div>' + hiddenRows +
        '<div style="font-size:10px;color:var(--text-4);margin-top:4px">los marcaste con el ojo tachado en el sidebar · "mostrar" los devuelve al board y al sidebar</div></div>'
      : '';
    var hk = !!(hooks && hooks.installed);
    // PERFIL DE CLAUDE (config dir) — filas seleccionables + ruta personalizada
    var curCfgDir = (cfg.claudeConfigDir || '').trim();
    var profRows = (settingsProfiles || []).map(function (pr) {
      var on = !!pr.active;
      return '<div class="set-prof' + (on ? ' on' : '') + '" data-prof="' + esc(pr.dir) + '" title="' + esc(pr.dir) + '">' +
        '<span class="dot ' + (on ? 'dot--green pulse' : 'dot--idle') + '" style="box-shadow:none"></span>' +
        '<span class="nm">' + esc(pr.name) + '</span>' +
        '<span class="p">' + esc(pr.dir) + '</span>' +
        '<span class="cnt">' + (pr.projectCount || 0) + ' proy' + (pr.hasSettings ? '' : ' · sin settings') + '</span>' +
        (on && !curCfgDir ? '<span class="set-prof-auto">auto</span>' : '') +
        '</div>';
    }).join('');
    var profHint = curCfgDir ? ('perfil fijado: ' + curCfgDir) : 'auto: env CLAUDE_CONFIG_DIR → ~/.claude';
    var html = '<div class="set-scrim" data-act="close-settings"><div class="set-card">' +
      '<div class="set-head"><span class="ttl">SETTINGS</span><button class="iconbtn" style="width:26px;height:26px" data-act="close-settings">' + C.svg('x', 14, 2) + '</button></div>' +
      '<div class="set-sec"><div class="lbl">EDITOR & TERMINAL</div>' +
        '<div class="set-row"><span class="k">editor preferido</span>' + seg2('editor', cfg.editor, [['code', 'VS Code'], ['cursor', 'Cursor']]) + '</div>' +
        '<div class="set-row"><span class="k">terminal preferida</span>' + seg2('terminal', cfg.terminal, [['wt', 'Win Terminal'], ['powershell', 'PowerShell']]) + '</div>' +
        '<div class="set-row"><span class="k">Ctrl+Espacio abre</span>' + seg2('quickTermKind', cfg.quickTermKind || 'claude-skip', [['shell', 'terminal'], ['claude', 'claude'], ['claude-skip', 'claude ⚡']]) + '</div>' +
        '<div class="set-row"><span class="k">claude: input anclado abajo <span style="color:var(--text-3)">· off = scroll nativo del historial</span></span>' + seg2('claudeFullscreen', cfg.claudeFullscreen !== false ? 'on' : 'off', [['on', 'on'], ['off', 'off']]) + '</div>' +
        '<div style="font-size:10px;color:var(--text-4);margin-top:4px">modo fullscreen de claude (alt-screen) → el input queda abajo de todo, como WezTerm · off = inline (input sigue al contenido, scrollback en el buffer) · aplica a terminales nuevas</div>' +
        '<div class="set-row"><span class="k">render por GPU (terminal más fluida) <span style="color:var(--text-3)">· WebGL</span></span>' + seg2('gpuRender', cfg.gpuRender !== false ? 'on' : 'off', [['on', 'on'], ['off', 'off']]) + '</div>' +
        '<div style="font-size:10px;color:var(--text-4);margin-top:4px">dibuja las terminales en la GPU (WebGL) → mucho más fluido, sobre todo en claude · off = renderer DOM (apagalo sólo si ves la terminal rara en tu GPU) · aplica a terminales nuevas</div>' +
        '<div class="set-row"><span class="k">historial por terminal (scrollback)</span>' + seg2('scrollback', String(cfg.scrollback || 5000), [['3000', '3k'], ['5000', '5k'], ['12000', '12k']]) + '</div>' +
        '<div style="font-size:10px;color:var(--text-4);margin-top:4px">líneas que guarda cada terminal para scrollear hacia arriba · más historial = más RAM (12k ≈ 29MB por terminal llena) · aplica en vivo</div>' +
        '<div class="set-row"><span class="k">selector flotante de @ y / <span style="color:var(--text-3)">· estilo Warp</span></span>' + seg2('floatingPickers', cfg.floatingPickers !== false ? 'on' : 'off', [['on', 'on'], ['off', 'off']]) + '</div>' +
        '<div style="font-size:10px;color:var(--text-4);margin-top:4px">al tipear @ (archivos) o / (comandos) en una terminal de claude, abre una cajita flotante para elegir (no corre la pantalla) · off = @ y / van directo a claude (su selector inline) · aplica en vivo</div>' +
        '<div class="set-row"><span class="k">autocompletar con Tab (terminal)</span>' + seg2('autosuggest', cfg.autosuggest !== false ? 'on' : 'off', [['on', 'on'], ['off', 'off']]) + '</div>' +
        '<div class="set-row"><span class="k">tecla para aceptar la sugerencia</span><span style="display:inline-flex;align-items:center;gap:8px"><code id="setSgKey" style="padding:2px 7px;border-radius:5px;background:var(--surface-input);border:1px solid var(--border);font-family:\'Geist Mono\',monospace;font-size:11px;color:var(--text-2)">' + esc(prettyAcceptKey(cfg.autosuggestAcceptKey || 'Tab')) + '</code><button class="btn btn--sm" id="setSgRebind">cambiar</button></span></div>' +
        '<div style="font-size:10px;color:var(--text-4);margin-top:4px">sugiere en gris (pegado al cursor) el comando más reciente de tu historial que empieza con lo que escribís · la tecla acepta SÓLO cuando hay sugerencia visible (si no, pasa al completado nativo) · sólo en terminales shell</div>' +
      '</div>' +
      '<div class="set-sec" id="setProfSec"><div class="lbl">PERFIL DE CLAUDE (config dir)<button class="set-tour-link" data-act="profile-tour" title="ver el tutorial">' + C.svg('eye', 11, 1.8) + ' tutorial</button></div>' + profRows +
        '<div class="set-row" style="margin-top:8px"><input class="set-inp" id="setProfPath" style="flex:1;width:auto" placeholder="ruta personalizada (ej C:\\Users\\vos\\.claude-max)"><button class="btn btn--sm" id="setProfPick">' + C.svg('folder', 12, 2) + ' elegir</button></div>' +
        '<div class="set-row"><span class="k" id="setProfMsg">' + esc(profHint) + '</span><button class="btn btn--sm" id="setProfAuto">usar default (auto)</button></div>' +
        '<div style="font-size:10px;color:var(--text-4);margin-top:4px">el projects del perfil activo se vigila solo · los hooks van a SU settings.json (reinstalá si cambiás) · cero API de Anthropic</div>' +
      '</div>' +
      '<div class="set-sec"><div class="lbl">DIRECTORIOS VIGILADOS EXTRA (read-only)</div>' + dirs +
        '<div class="set-row" style="margin-top:8px"><input class="set-inp" id="setDirAdd" style="flex:1;width:auto" placeholder="C:\\ruta\\.claude\\projects"><button class="btn btn--sm" id="setDirAddBtn">' + C.svg('plus', 12, 2) + ' agregar</button></div>' +
      '</div>' +
      hiddenSec +
      '<div class="set-sec"><div class="lbl">MONITOREO</div>' +
        '<div class="set-row"><span class="k">umbral de aviso de contexto (%)</span><input class="set-inp" id="setCtx" type="number" min="50" max="100" value="' + cfg.ctxWarnThreshold + '"></div>' +
        '<div class="set-row"><span class="k">refresh del statusbar (s)</span><input class="set-inp" id="setRefresh" type="number" min="1" max="60" value="' + Math.round((cfg.refreshMs || 2000) / 1000) + '"></div>' +
        '<div class="set-row"><span class="k">sonidos / notificaciones</span>' + seg2('sounds', cfg.sounds ? 'on' : 'off', [['on', 'on'], ['off', 'off']]) + '</div>' +
      '</div>' +
      '<div class="set-sec" id="setHooksSec"><div class="lbl">HOOKS</div>' +
        '<div class="set-row"><span class="k">puerto del server</span><input class="set-inp" id="setPort" type="number" min="1024" max="65535" value="' + cfg.port + '"></div>' +
        '<div class="set-row"><span class="k">estado</span><span class="set-hooks"><span class="dot ' + (hk ? 'dot--green pulse' : 'dot--idle') + '" style="box-shadow:none"></span>' + (hk ? 'conectado' : 'desconectado') + '</span>' +
          '<button class="btn btn--sm ' + (hk ? 'btn--red' : 'btn--green') + '" id="setHooksBtn" data-hk="' + (hk ? '1' : '0') + '">' + (hk ? 'desinstalar' : 'instalar') + ' hooks</button></div>' +
        '<div style="font-size:10px;color:var(--text-4);margin-top:4px">backup automático en ~/.consomni/backups · merge no-destructivo · cero API de Anthropic</div>' +
      '</div>' +
      '<div class="set-sec"><div class="lbl">SISTEMA</div>' +
        '<div class="set-row"><span class="k">abrir Consomni al iniciar la PC</span>' + seg2('autoStart', cfg.autoStart ? 'on' : 'off', [['on', 'on'], ['off', 'off']]) + '</div>' +
        '<div style="font-size:10px;color:var(--text-4);margin-top:4px">auto-inicio nativo de Windows (registro Run) · sin servicios ni tareas programadas</div>' +
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

  /* ── AUTOSUGGEST (Feature: autocompletar con Tab) — bridge a las terminales + reasignar la tecla ── */
  function prettyAcceptKey(k) { var m = { ArrowRight: '→', ArrowLeft: '←', ArrowUp: '↑', ArrowDown: '↓' }; return m[k] || k; }
  // serializa una tecla EXACTAMENTE igual que terminals-ui (sgSerializeKey) → lo guardado matchea en runtime
  function serializeAcceptKey(ev) {
    var mods = ''; if (ev.ctrlKey) mods += 'Ctrl+'; if (ev.altKey) mods += 'Alt+'; if (ev.shiftKey) mods += 'Shift+';
    var c = ev.code || '', base;
    if (c.indexOf('Key') === 0) base = c.slice(3); else if (c.indexOf('Digit') === 0) base = c.slice(5); else base = c || ev.key;
    return mods + base;
  }
  // válida como tecla de aceptar: navegación/función sola (Tab/→/End/F-keys…) o cualquier cosa con Ctrl/Alt;
  // NO imprimibles sin modificador (se tipearían), ni Enter/Escape/Backspace.
  function isValidAcceptKey(ev) {
    if (ev.key === 'Escape' || ev.key === 'Enter' || ev.key === 'Backspace') return false;
    // Ctrl mapea a chars de control del terminal (Ctrl+C=SIGINT, Ctrl+W=cerrar pane, Ctrl+V=pegar, Ctrl+U=borrar…)
    // → NO se permite como tecla de aceptar (robaría esos shortcuts cuando hay una sugerencia). Alt sí (no choca).
    if (ev.ctrlKey) return false;
    if (ev.altKey) return !(ev.key === 'Control' || ev.key === 'Alt' || ev.key === 'Shift' || ev.key === 'Meta');
    if (ev.shiftKey) return false;   // sin Ctrl/Alt, con Shift, el descriptor llevaría 'Shift+' pero la tecla pelada nunca matchearía en runtime → rechazar
    var ok = { Tab: 1, ArrowRight: 1, ArrowLeft: 1, ArrowUp: 1, ArrowDown: 1, End: 1, Home: 1, Insert: 1, Delete: 1, PageUp: 1, PageDown: 1, F1: 1, F2: 1, F3: 1, F4: 1, F5: 1, F6: 1, F7: 1, F8: 1, F9: 1, F10: 1, F11: 1, F12: 1 };
    return !!(ok[ev.key] || ok[ev.code]);
  }
  function pushAutosuggest() { try { if (window.ConsomniTerms && window.ConsomniTerms.setAutosuggest) window.ConsomniTerms.setAutosuggest(state.autosuggest !== false, state.autosuggestAcceptKey || 'Tab'); } catch (e) {} }
  function closeAcceptKeyRebind() { var o = document.getElementById('sgRebind'); if (o && o._cleanup) o._cleanup(); else if (o && o.parentNode) o.parentNode.removeChild(o); }
  function openAcceptKeyRebind() {
    closeAcceptKeyRebind();
    var ov = document.createElement('div'); ov.id = 'sgRebind'; ov.className = 'cfm-scrim';
    ov.innerHTML = '<div class="cfm-card" role="dialog" aria-modal="true">' +
      '<div class="cfm-ttl">' + C.svg('term', 15, 2) + 'tecla para aceptar la sugerencia</div>' +
      '<div class="cfm-body">Apretá la tecla que querés usar para aceptar el ghost text.<br>Sirven <code>Tab</code>, <code>→</code>, <code>End</code>, una tecla de función, o una combinación con <code>Alt</code>. <code>Esc</code> cancela.</div>' +
      '<div class="sg-rebind-key" id="sgRebindKey">esperando una tecla…</div>' +
    '</div>';
    document.body.appendChild(ov);
    var keyEl = ov.querySelector('#sgRebindKey');
    function onKey(ev) {
      ev.preventDefault(); ev.stopPropagation();
      if (ev.key === 'Escape') { cleanup(); return; }
      if (ev.key === 'Control' || ev.key === 'Alt' || ev.key === 'Shift' || ev.key === 'Meta' || ev.key === 'CapsLock') { keyEl.textContent = '…'; return; }
      if (!isValidAcceptKey(ev)) { keyEl.textContent = 'esa no sirve — probá Tab, →, End o Ctrl+algo'; return; }
      var k = serializeAcceptKey(ev);
      state.autosuggestAcceptKey = k; pushAutosuggest(); saveSetting({ autosuggestAcceptKey: k });
      var disp = document.getElementById('setSgKey'); if (disp) disp.textContent = prettyAcceptKey(k);
      cleanup();
    }
    function onClick(e) { if (e.target === ov) cleanup(); }
    function cleanup() { document.removeEventListener('keydown', onKey, true); ov.removeEventListener('click', onClick); if (ov.parentNode) ov.parentNode.removeChild(ov); }
    ov._cleanup = cleanup;
    document.addEventListener('keydown', onKey, true);
    ov.addEventListener('click', onClick);
  }
  function wireSettings(cfg) {
    var card = document.querySelector('.set-card');
    if (!card) return;
    Array.prototype.forEach.call(card.querySelectorAll('[data-set]'), function (el) {
      el.addEventListener('click', function () {
        var key = el.getAttribute('data-set'), val = el.getAttribute('data-val');
        // auto-inicio: además de persistir, hay que aplicarlo al SO → IPC dedicado (setAutoStart guarda config también)
        if (key === 'autoStart' && api.setAutoStart) {
          api.setAutoStart(val === 'on').then(function () {
            return api.getConfig().then(function (c) {
              if (api.getHooksStatus) return api.getHooksStatus().then(function (h) { renderSettings(c, h); });
              renderSettings(c, {});
            });
          });
          return;
        }
        var patch = {};
        if (key === 'sounds' || key === 'checkUpdates' || key === 'claudeFullscreen' || key === 'autosuggest' || key === 'gpuRender' || key === 'floatingPickers') patch[key] = (val === 'on'); else if (key === 'scrollback') patch[key] = parseInt(val, 10) || 5000; else patch[key] = val;
        if (key === 'scrollback') { if (window.ConsomniTerms && window.ConsomniTerms.setScrollback) window.ConsomniTerms.setScrollback(parseInt(val, 10) || 5000); }   // aplica EN VIVO a todas las terminales
        if (key === 'quickTermKind') state.quickTermKind = val;   // aplica sin reiniciar
        if (key === 'autosuggest') { state.autosuggest = (val === 'on'); pushAutosuggest(); }   // aplica en vivo a las terminales
        if (key === 'claudeFullscreen') { state.claudeFullscreen = (val === 'on'); if (window.ConsomniTerms && window.ConsomniTerms.setClaudeFullscreenDefault) window.ConsomniTerms.setClaudeFullscreenDefault(state.claudeFullscreen); }   // default para terminales claude NUEVAS
        if (key === 'gpuRender') { state.gpuRender = (val === 'on'); if (window.ConsomniTerms && window.ConsomniTerms.setGpuRender) window.ConsomniTerms.setGpuRender(state.gpuRender); }   // aplica a terminales NUEVAS
        if (key === 'floatingPickers') { state.floatingPickers = (val === 'on'); if (window.ConsomniTerms && window.ConsomniTerms.setFloatingPickers) window.ConsomniTerms.setFloatingPickers(state.floatingPickers); }   // aplica EN VIVO (gatea la intercepción de @ y /)
        saveSetting(patch);
      });
    });
    var sgReb = card.querySelector('#setSgRebind'); if (sgReb) sgReb.addEventListener('click', function () { openAcceptKeyRebind(); });
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
    // "mostrar" un proyecto oculto → lo des-oculta y refresca el board + esta lista (listener directo: el
    // scrim de Settings tiene data-act=close-settings, así que la delegación global devuelve antes de llegar acá)
    Array.prototype.forEach.call(card.querySelectorAll('[data-show]'), function (el) {
      el.addEventListener('click', function () { unhideProject(el.getAttribute('data-show')); });
    });
    // ── perfil de Claude (config dir) ──
    function applyProfile(dir) {
      if (!api.setClaudeProfile) { toast('no disponible', 'warn'); return; }
      var msg = card.querySelector('#setProfMsg'); if (msg) msg.textContent = 'cambiando…';
      api.setClaudeProfile(dir || '').then(function (res) {
        if (!res || !res.ok) { toast((res && res.error) || 'no se pudo cambiar el perfil', 'err'); if (msg) msg.textContent = (res && res.error) || 'error'; return; }
        var nm = (res.active || '').split(/[\\/]/).filter(Boolean).pop() || 'default';
        toast('perfil: ' + nm + ' · revisá los hooks', '');
        (api.getClaudeProfiles ? api.getClaudeProfiles().catch(function () { return settingsProfiles; }) : Promise.resolve(settingsProfiles))
          .then(function (ps) { settingsProfiles = Array.isArray(ps) ? ps : settingsProfiles; renderSettings(res.config, (res.hooks || {})); });
      }).catch(function () { toast('error al cambiar el perfil', 'err'); });
    }
    Array.prototype.forEach.call(card.querySelectorAll('.set-prof'), function (el) {
      el.addEventListener('click', function () { applyProfile(el.getAttribute('data-prof')); });
    });
    var profPick = card.querySelector('#setProfPick'); if (profPick) profPick.addEventListener('click', function () {
      var inp = card.querySelector('#setProfPath'); var typed = (inp && inp.value || '').trim();
      if (typed) { applyProfile(typed); return; }
      if (api.pickFolder) api.pickFolder().then(function (p) { if (p) applyProfile(p); }); else toast('selector no disponible', 'warn');
    });
    var profInp = card.querySelector('#setProfPath'); if (profInp) profInp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { var v = (profInp.value || '').trim(); if (v) applyProfile(v); }
    });
    var profAuto = card.querySelector('#setProfAuto'); if (profAuto) profAuto.addEventListener('click', function () { applyProfile(''); });
    var ub = card.querySelector('#setUpdBtn'); if (ub && api.checkUpdate) ub.addEventListener('click', function () {
      var msg = card.querySelector('#setUpdMsg'); ub.disabled = true; if (msg) msg.textContent = 'buscando…';
      api.checkUpdate().then(function (u) {
        ub.disabled = false;
        if (!msg) return;
        if (!u) { msg.textContent = 'no se pudo comprobar'; return; }
        if (u.error) { msg.textContent = 'sin conexión / sin releases (v' + u.current + ')'; }
        else if (u.hasUpdate) { markUpdateAvailable(u); msg.innerHTML = 'v' + esc(u.latest) + ' disponible · <a data-act="show-changelog" style="color:var(--green);cursor:pointer">ver novedades</a>'; }
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
  function setOverlay(html) { var o = document.getElementById('overlays'); if (o) o.innerHTML = html; if (!html) { state.helpOpen = false; state.settingsOpen = false; state.changelogOpen = false; state.changelogAllOpen = false; state.libEditOpen = false; state.notifHistoryOpen = false; } }
  function anyOverlayOpen() { return state.paletteOpen || !!state.detailId || state.helpOpen || state.settingsOpen || state.changelogOpen || state.changelogAllOpen || state.libEditOpen || state.notifHistoryOpen; }
  function closeOverlays() {
    if (state.libEditOpen) { closeLibEdit(); return; }
    if (state.paletteOpen) { closePalette(); return; }
    if (state.changelogAllOpen) { closeChangelogAll(); return; }
    if (state.notifHistoryOpen) { closeNotifHistory(); return; }
    if (state.changelogOpen) { closeChangelog(); return; }
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
    // cerrar el panel de notificaciones si clickeás afuera (no en el bell ni en el panel)
    if (state.notifOpen && t.closest && !t.closest('#notifPanel') && !t.closest('.notif-bell')) closeNotifPanel();
    // desactivar el buscador al clickear AFUERA de la caja (mantiene el filtro aplicado; así, fuera del modo
    // búsqueda, tipear NO filtra "invisible" — la causa de la confusión que reportó el usuario)
    if (state.searchActive && t.closest && !t.closest('.search')) deactivateSearch(false);

    // el dock (#terminals) maneja sus propios clicks (toolbar, panes, acciones). El board NO debe
    // procesarlos: si lo hace, un click adentro de una terminal matchea el [data-proj] del panel y
    // dispara setActiveProject → openProject → abre OTRA terminal y le roba el foco al xterm.
    if (t.closest && t.closest('#terminals')) return;

    // ── tutorial (coachmark): botones siguiente / anterior / saltar ──
    var tourBtn = t.closest && t.closest('[data-tour]');
    if (tourBtn) { e.preventDefault(); e.stopPropagation(); var ta = tourBtn.getAttribute('data-tour'); if (ta === 'next') tourNext(); else if (ta === 'prev') tourPrev(); else endTour(true); return; }
    // ── fila de notificación → changelog (desde el panel o el historial) ──
    var nrow = t.closest && t.closest('.ntf-row[data-notif]');
    if (nrow) { e.stopPropagation(); var nn = notifById(nrow.getAttribute('data-notif')); closeNotifPanel(); state.notifHistoryOpen = false; if (nn && nn.kind === 'update') {
      // notif vigente (versión > la instalada) → habilita "Actualizar ahora"; notif vieja → cae a "listo".
      var cur = state.snapshot && state.snapshot.appVersion;
      if (nn.data && nn.data.latest && (!cur || isNewerVer(nn.data.latest, cur))) markUpdateAvailable(nn.data);
      openChangelog(nn.data);
    } return; }

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
      if (act === 'help-whatsnew') { e.stopPropagation(); setOverlay(''); state.helpOpen = false; startWhatsNewTour(); return; }
      if (act === 'close-settings') { if (t.classList.contains('set-scrim') || actEl.tagName === 'BUTTON') closeSettings(); return; }
      if (act === 'profile-tour') { e.stopPropagation(); startProfileTour(); return; }
      if (act === 'cfm-cancel') { if (t.classList.contains('cfm-scrim') || actEl.tagName === 'BUTTON') { pendingClose = null; setOverlay(''); } return; }
      if (act === 'cfm-ok') { var ccd = document.getElementById('cccDont'); if (ccd && ccd.checked) { state.confirmCloseTerminal = false; if (api && api.saveConfig) api.saveConfig({ confirmCloseTerminal: false }); } var fn = pendingClose; pendingClose = null; setOverlay(''); if (fn) fn(); return; }
      // ── tablero de Planes (frentes) ──
      if (act === 'plans') { e.stopPropagation(); openPlans(); maybeStartPlanTour(); return; }
      if (act === 'plans-refresh') { e.stopPropagation(); loadPlanDocs(); toast('re-escaneando docs…'); return; }
      if (act === 'plan-tour') { e.stopPropagation(); startPlanTour(); return; }
      if (act === 'show-changelog') { e.stopPropagation(); openChangelog(state.update); return; }
      if (act === 'plan-detail') { e.stopPropagation(); var pdsid = actEl.getAttribute('data-sid'); if (pdsid) openDetail(pdsid); return; }
      if (act === 'plan-resume') { e.stopPropagation(); var prsid = actEl.getAttribute('data-sid'); state.plansOpen = false; render(); dispatchAction('resume', prsid); return; }
      if (act === 'open-doc') { e.stopPropagation(); openDocFile(actEl.getAttribute('data-doc')); return; }
      if (act === 'frente-status') { e.stopPropagation(); cycleFrenteStatus(actEl.getAttribute('data-frente')); return; }
      // ── biblioteca (prompts/skills/rules) ──
      if (act === 'library') { e.stopPropagation(); openLibrary(); maybeStartLibraryTour(); return; }
      if (act === 'lib-new') { e.stopPropagation(); openLibEdit(null); return; }
      if (act === 'lib-edit') { e.stopPropagation(); openLibEdit(actEl.getAttribute('data-id')); return; }
      if (act === 'lib-dup') { e.stopPropagation(); dupLibEntry(actEl.getAttribute('data-id')); return; }
      if (act === 'lib-del') { e.stopPropagation(); requestDeleteLib(actEl.getAttribute('data-id')); return; }
      if (act === 'lib-copy') { e.stopPropagation(); copyLibEntry(actEl.getAttribute('data-id')); return; }
      if (act === 'lib-insert') { e.stopPropagation(); insertLibEntry(actEl.getAttribute('data-id')); return; }
      if (act === 'lib-filter') { e.stopPropagation(); state.libFilter.kind = actEl.getAttribute('data-kind') || ''; render(); return; }
      if (act === 'lib-tag') { e.stopPropagation(); var ltg = actEl.getAttribute('data-tag') || ''; state.libFilter.tag = (state.libFilter.tag === ltg) ? '' : ltg; render(); return; }
      if (act === 'lib-clear') { e.stopPropagation(); state.libFilter = { kind: '', tag: '', q: '' }; render(); return; }
      if (act === 'lib-tour') { e.stopPropagation(); startLibraryTour(); return; }
      if (act === 'lib-import') { e.stopPropagation(); doImportLibrary(); return; }
      if (act === 'lib-export') { e.stopPropagation(); doExportLibrary(); return; }
      // ── buscador del topbar: el click activa lo mismo que la tecla "/" (antes era sólo visual al click) ──
      if (act === 'search') { e.stopPropagation(); activateSearch(); return; }
      if (act === 'search-clear') { e.stopPropagation(); deactivateSearch(true); return; }   // × borra el filtro y sale
      // ── notificaciones + changelog ──
      if (act === 'notifs') { e.stopPropagation(); state.notifOpen ? closeNotifPanel() : openNotifPanel(); return; }
      if (act === 'notif-all') { e.stopPropagation(); closeNotifPanel(); openNotifHistory(); return; }
      if (act === 'close-notif-history') { if (t.classList.contains('cl-scrim') || actEl.tagName === 'BUTTON') closeNotifHistory(); return; }
      if (act === 'notif-clear') { e.stopPropagation(); state.notifs = []; applyNotifBadge(); persistNotifs(); closeNotifPanel(); if (state.notifHistoryOpen) closeNotifHistory(); return; }
      if (act === 'close-changelog') { if (t.classList.contains('cl-scrim') || actEl.tagName === 'BUTTON') closeChangelog(); return; }
      if (act === 'changelog-all') { e.stopPropagation(); closeNotifPanel(); openChangelogAll(); return; }
      if (act === 'close-changelog-all') { e.stopPropagation(); closeChangelogAll(); return; }
      if (act === 'changelog-update') { e.stopPropagation(); closeChangelog(); startUpdateDownload(); return; }
      if (act === 'settings') { openSettings(); return; }
      if (act === 'terminals') { if (window.ConsomniTerms) window.ConsomniTerms.toggle(); return; }
      if (act === 'theme') { toggleTheme(); return; }
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
    if (t.closest && t.closest('.sb-add')) { addProjectViaPicker(); return; }
    var rmEl = t.closest && t.closest('[data-unkeep]');
    if (rmEl) { e.stopPropagation(); unkeepProject(rmEl.getAttribute('data-unkeep')); return; }
    var hideEl = t.closest && t.closest('[data-hide]');
    if (hideEl) { e.stopPropagation(); hideProject(hideEl.getAttribute('data-hide')); return; }
    // (data-show = "mostrar" en Settings → listener directo en wireSettings; acá el scrim ya devolvió en close-settings)
    if (t.closest && t.closest('[data-act="home"]')) { state.activeProject = 'all'; state.plansOpen = false; state.libraryOpen = false; render(); if (window.ConsomniTerms) window.ConsomniTerms.home(); return; }

    // ── CARDS PRIMERO (van adentro de la columna, que tiene data-proj) ──
    // closed row → detalle
    var crow = t.closest && t.closest('.closed-row[data-sid]'); if (crow) { openDetail(crow.getAttribute('data-sid')); return; }
    // card → abre/foco la conversación de esa sesión en el DOCK (abajo, no tapa todo)
    var card = t.closest && t.closest('.card[data-sid]');
    if (card) {
      var sid = card.getAttribute('data-sid');
      state.focusSid = sid;
      var sObj = sessionById(sid);
      if (window.ConsomniTerms) window.ConsomniTerms.openSession(sid, sObj ? sObj.name : 'sesión', sObj ? projKey(sObj) : '', sObj ? sObj.project : '', sObj ? sObj.cwd : '');
      else openDetail(sid);
      return;
    }
    // badge de diff del header de columna → abrir git diff (ANTES del fallback [data-proj], que filtraría el proyecto)
    var dbtn = t.closest && t.closest('[data-act="diff-cwd"]');
    if (dbtn) {
      e.stopPropagation();
      var dcwd = dbtn.getAttribute('data-cwd');
      if (dcwd && api && api.action) api.action('diff', { cwd: dcwd })
        .then(function (r) { toast(r && r.ok ? (r.message || 'diff abierto') : ((r && r.error) || 'no se pudo'), r && r.ok ? '' : 'err'); })
        .catch(function () { toast('no se pudo abrir el diff', 'err'); });
      return;
    }
    // sidebar / header de columna → filtrar por proyecto (DESPUÉS de las cards)
    var sb = t.closest && t.closest('[data-proj]'); if (sb) { setActiveProject(sb.getAttribute('data-proj')); return; }
  });

  /* ── input vivo: nota privada del frente (no re-renderiza → no pierde foco) ── */
  document.addEventListener('input', function (e) {
    var n = e.target && e.target.closest && e.target.closest('.frente-note');
    if (n) { setFrenteNote(n.getAttribute('data-frente'), n.value); return; }
    // buscador de la biblioteca: filtro vivo (el foco/caret se restaura en render())
    var ls = e.target && e.target.closest && e.target.closest('.lib-search');
    if (ls) { state.libFilter.q = ls.value; scheduleRender(); }
  });

  /* ════════ KEYBOARD ════════ */
  var gPending = false;
  document.addEventListener('keydown', function (e) {
    var meta = e.metaKey || e.ctrlKey;
    var T = window.ConsomniTerms;

    // tutorial activo: la navegación del tour (←/→/Enter/Esc) GANA aunque el foco esté en una terminal
    // (el tour de novedades abre una terminal demo enfocada). Va ANTES del guard de #terminals. Bloquea el resto.
    if (TOUR.active) {
      if (e.key === 'Escape') { e.preventDefault(); endTour(true); return; }
      if (e.key === 'Enter' || e.key === 'ArrowRight') { e.preventDefault(); tourNext(); return; }
      if (e.key === 'ArrowLeft') { e.preventDefault(); tourPrev(); return; }
      return;
    }
    // Si el foco está DENTRO del dock (xterm), las teclas van a la terminal; sólo Esc reacciona.
    var inDock = document.activeElement && document.activeElement.closest && document.activeElement.closest('#terminals');
    if (inDock) {
      if (e.key === 'Escape') { e.preventDefault(); if (T && T.isMaximized()) T.toggle(); else if (document.activeElement.blur) document.activeElement.blur(); }
      return;
    }

    // Si hay un input/textarea REAL con foco (nota de frente, settings, qreply), dejá escribir:
    // sólo Escape sigue (para cerrar overlays / blur). Evita que 'T', 's', 'j'… disparen atajos.
    var aeTag = document.activeElement && document.activeElement.tagName;
    if ((aeTag === 'INPUT' || aeTag === 'TEXTAREA') && e.key !== 'Escape') return;

    // CTRL+ESPACIO: abre una terminal nueva (configurable en Settings: shell / claude / claude ⚡).
    // Dentro de un xterm enfocado lo intercepta terminals-ui (attachCustomKeyEventHandler); acá es el caso board.
    if (e.ctrlKey && e.code === 'Space') { e.preventDefault(); openQuickTerm(); return; }

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

    // Ctrl/Cmd + tecla NO dispara los atajos de UNA letra: Ctrl+C (copiar), Ctrl+A, Ctrl+F, etc. deben
    // hacer lo del sistema, no acciones del board. Los atajos meta legítimos (⌘K, ⌘1-9, Ctrl+Espacio) ya
    // se manejaron arriba y retornaron. (Era el bug: Ctrl+C cambiaba la densidad y rompía el copiar.)
    if (meta) return;

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
      case 'm': toggleMute(); break;
      case '?': openHelp(); break;
      default: break;
    }
  });

  // cerrar sort menu al click afuera ya se maneja en el delegate (closeSortMenu al inicio)
  window.addEventListener('blur', function () { logoBlink.focused = false; });
  window.addEventListener('focus', function () {
    logoBlink.focused = true;
    if (window.ConsomniTerms && window.ConsomniTerms.resetInputTrackingOnFocus) window.ConsomniTerms.resetInputTrackingOnFocus();
  });

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
        '<div class="onb-desc">Para ver el estado en vivo (working · atención · idle) Consomni instala hooks locales en el <b>settings.json</b> de tu perfil de Claude activo (por defecto <b>~/.claude</b>). Se hace <b>backup</b> antes de tocar nada. Read-only sobre tus transcripts · sólo 127.0.0.1.</div>' +
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
    if (!api || !api.getHooksStatus) { maybeAutostartTours(); return; }
    var dismissed = false; try { dismissed = localStorage.getItem('consomni.onboarded') === '1'; } catch (e) {}
    api.getHooksStatus().then(function (st) {
      if (st && !st.installed && !dismissed) { showOnboarding(); return; }   // onboarding tiene prioridad este arranque
      maybeAutostartTours();   // sin onboarding → novedades v1.8.0 (1 vez) → si ya las vio, multi-perfil
    }).catch(function () { maybeAutostartTours(); });
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
    if (document.hidden || !state.snapshot) return;   // ventana oculta → cero trabajo (Chromium degrada el timer, el laburo lo evitamos nosotros)
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
    // CTRL+ESPACIO dentro de un xterm enfocado → abre una terminal nueva (el dock lo intercepta)
    if (window.ConsomniTerms.setQuickTermHook) window.ConsomniTerms.setQuickTermHook(openQuickTerm);
    // botón VSCode de una terminal: abre su cwd en el editor (acción 'ext', basada en cwd, sin sid)
    if (window.ConsomniTerms.setEditorOpener) window.ConsomniTerms.setEditorOpener(function (cwd) {
      if (!cwd) { toast('sin carpeta', 'warn'); return; }
      if (!api || !api.action) { toast('acción no disponible', 'err'); return; }
      api.action('ext', { cwd: cwd }).then(function (r) {
        toast((r && r.ok ? (r.message || 'abriendo editor') : ('✗ ' + ((r && r.error) || 'editor'))), (r && r.ok) ? '' : 'err');
      }).catch(function () { toast('✗ editor', 'err'); });
    });
    // pantalla completa de terminales: NO toca el sidebar. Entrar a un proyecto / maximizar el dock
    // ya NO colapsa el sidebar — solo el chevron manual (setSidebarCollapsed) o el responsive lo hacen.
    window.ConsomniTerms.setMaxObserver(function (isMax) {
      render();   // el sidebar refleja inicio vs todos/proyecto según el estado vivo del dock
    });
    // el dock consulta esto: proyecto sin terminales pero CON cards → muestra el board, no el placeholder
    if (window.ConsomniTerms.setBoardChecker) window.ConsomniTerms.setBoardChecker(function (projId) { return projHasCards(projId); });
    // shortcuts del inicio (F5): proyectos con su cwd para abrir terminal/claude directo
    if (window.ConsomniTerms.setHomeProjects) window.ConsomniTerms.setHomeProjects(homeProjectsList);
    // el dock pregunta antes de cerrar una terminal viva (corta el proceso) → modal con "no volver a mostrar"
    if (window.ConsomniTerms.setCloseConfirmer) window.ConsomniTerms.setCloseConfirmer(confirmCloseTerminal);
    // autosuggest: el hint "Tab" clickeable de la terminal abre el popover de reasignar tecla (la config vive acá)
    if (window.ConsomniTerms.setAutosuggestRebinder) window.ConsomniTerms.setAutosuggestRebinder(openAcceptKeyRebind);
    // SIEMPRE arrancar en "inicio" con las terminales que quedaron de la sesión anterior
    try { window.ConsomniTerms.restoreSession(); } catch (e) {}
  }
  state.userCollapsed = null;
  state.collapsed = window.innerWidth < BREAKPOINT;
  if (api) {
    api.getSnapshot().then(setSnapshot).catch(function () { render(); });
    api.onSnapshot(setSnapshot);
    // prefs persistidas: proyectos fijados al sidebar + aviso al cerrar terminal
    if (api.getConfig) api.getConfig().then(function (cfg) {
      if (cfg) {
        state.keptProjects = Array.isArray(cfg.keptProjects) ? cfg.keptProjects.slice() : [];
        state.hiddenProjects = Array.isArray(cfg.hiddenProjects) ? cfg.hiddenProjects.slice() : [];
        state.confirmCloseTerminal = cfg.confirmCloseTerminal !== false;
        state.frentes = (cfg.frentes && typeof cfg.frentes === 'object') ? cfg.frentes : {};
        state.quickTermKind = cfg.quickTermKind || 'claude-skip';
        state.theme = (cfg.theme === 'light') ? 'light' : 'dark';
        state.autosuggest = cfg.autosuggest !== false;
        state.autosuggestAcceptKey = cfg.autosuggestAcceptKey || 'Tab';
        state.claudeFullscreen = cfg.claudeFullscreen !== false;
        state.gpuRender = cfg.gpuRender !== false;
        state.floatingPickers = cfg.floatingPickers !== false;
        pushAutosuggest();   // empujar la config del autosuggest a las terminales
        if (window.ConsomniTerms && window.ConsomniTerms.setClaudeFullscreenDefault) window.ConsomniTerms.setClaudeFullscreenDefault(state.claudeFullscreen);   // default de modo render para terminales claude nuevas
        if (window.ConsomniTerms && window.ConsomniTerms.setGpuRender) window.ConsomniTerms.setGpuRender(state.gpuRender);   // default de render GPU/WebGL para terminales nuevas
        if (window.ConsomniTerms && window.ConsomniTerms.setFloatingPickers) window.ConsomniTerms.setFloatingPickers(state.floatingPickers);   // selector flotante de @ y / en paneles claude
        if (window.ConsomniTerms && window.ConsomniTerms.setScrollback) window.ConsomniTerms.setScrollback(cfg.scrollback || 5000);   // historial por terminal (config)
        applyTheme();
      }
      render();
    }).catch(function () {});
    // centro de notificaciones (store dedicado): cargar las persistidas → sobreviven reinicios/updates
    if (api.getNotifications) api.getNotifications().then(function (d) {
      var list = (d && Array.isArray(d.notifs)) ? d.notifs : [];
      list.forEach(function (n) { if (n && n.id && !notifById(n.id)) state.notifs.push(n); });
      // SELF-HEAL: sacar notificaciones de "nueva versión" espurias →
      //  (a) versiones de PRUEBA conocidas que pudieron quedar persistidas y nunca debieron entrar, y
      //  (b) updates ya instalados (versión <= la actual) → no tiene sentido avisar de algo que ya tenés.
      // Se persiste el resultado para que no reaparezcan al próximo boot.
      var BOGUS_UPDATE_VERSIONS = { '1.9.99': 1 };
      var curV = state.snapshot && state.snapshot.appVersion;
      var before = state.notifs.length;
      state.notifs = state.notifs.filter(function (n) {
        if (!n || n.kind !== 'update') return true;
        var v = (n.data && n.data.latest) || (typeof n.id === 'string' ? n.id.replace(/^update-/, '') : '');
        if (BOGUS_UPDATE_VERSIONS[v]) return false;
        if (curV && v && !isNewerVer(v, curV)) return false;
        return true;
      });
      state.notifs.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
      if (state.notifs.length > 60) state.notifs.length = 60;
      if (state.notifs.length !== before) persistNotifs();   // graba la limpieza
      applyNotifBadge();
    }).catch(function () {});
    // biblioteca (store dedicado): cargar + sembrar ejemplos la 1ª vez
    if (api.getLibrary) api.getLibrary().then(function (lib) {
      var entries = (lib && Array.isArray(lib.entries)) ? lib.entries : [];
      var seeded = !!(lib && lib.seeded);
      if (!seeded) entries = seedLibrary().concat(entries);
      state.library = entries; state.librarySeeded = true;
      if (!seeded) persistLibrary();   // graba los seeds + marca seeded (idempotente)
      if (state.libraryOpen) render();
    }).catch(function () {});
    if (api.onJump) api.onJump(function (sid) { state.split = false; state.activeProject = 'all'; state.focusSid = sid; render(); openDetail(sid); });
    if (api.onUpdateEvent) api.onUpdateEvent(onUpdatePhase);
    // Re-pull del estado de update al boot: si el main ya detectó una versión nueva pero el renderer se
    // recargó (perdiendo el evento update-available), re-mostramos el botón. El main sólo expone una
    // versión genuinamente mayor (sale del evento de electron-updater con allowDowngrade=false).
    if (api.getUpdateStatus) api.getUpdateStatus().then(function (it) { if (it && it.latest) markUpdateAvailable(it); }).catch(function () {});
    maybeOnboard();
  } else {
    render();
  }

  window.__consomni = {
    state: state, render: render, transform: transform,
    openPalette: openPalette, openDetail: openDetail, openHelp: openHelp, openSettings: openSettings,
    openPlans: openPlans, closePlans: closePlans,
    openLibrary: openLibrary, closeLibrary: closeLibrary, openLibEdit: openLibEdit, startLibraryTour: startLibraryTour,
    startTutorial: startPlanTour, startProfileTour: startProfileTour, startWhatsNewTour: startWhatsNewTour, openNotifs: openNotifPanel, openNotifHistory: openNotifHistory, openChangelog: openChangelog, openChangelogAll: openChangelogAll,
    setActiveProject: setActiveProject, activateSearch: activateSearch,
    toggleDensity: toggleDensity, showOnboarding: showOnboarding,
    enterSplit: enterSplit, exitSplit: exitSplit, dispatchAction: dispatchAction,
    firstSid: function () { var l = (state.snapshot && state.snapshot.sessions) || []; return l.length ? l[0].id : null; },
    // QA (NO persisten notificaciones — el flag qa/skipNotif evita escribir el store real):
    simulateUpdate: function (phase, data) { return onUpdatePhase(phase, data, { qa: true }); },
    markUpdate: function (data) { return markUpdateAvailable(data, true); },
  };
})();
