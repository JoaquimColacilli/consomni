/* ════════════════════════════════════════════════════════════════
   CONSOMNI — chrome.js
   Componentes compartidos (no duplicados): top bar, sidebar,
   status bar, ojo, overlays CRT, builder de cards y columnas.
   Cada pantalla llama a estos builders → markup pixel-idéntico.
   ════════════════════════════════════════════════════════════════ */
(function (g) {
  'use strict';

  /* ── biblioteca de iconos (SVG strings, stroke=currentColor) ── */
  const I = {
    repo:   '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/>',
    star:   '<path d="M12 2.5l2.9 6 6.6.6-5 4.3 1.5 6.4L12 16.6 5.5 19.8 7 13.4l-5-4.3 6.6-.6z"/>',
    chevR:  '<polyline points="9 6 15 12 9 18"/>',
    chevD:  '<polyline points="6 9 12 15 18 9"/>',
    plus:   '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    search: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/>',
    bell:   '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
    gear:   '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.3l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2.2-1.3L14 2h-4l-.4 2.5a7 7 0 0 0-2.2 1.3l-2.3-1-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .4 0 .9.1 1.3l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 2.2 1.3L10 22h4l.4-2.5a7 7 0 0 0 2.2-1.3l2.3 1 2-3.4-2-1.5c.1-.4.1-.9.1-1.3z"/>',
    moon:   '<path d="M21 12.8A8 8 0 1 1 11.2 3 6 6 0 0 0 21 12.8z"/>',
    sliders:'<line x1="4" y1="8" x2="20" y2="8"/><circle cx="9" cy="8" r="2.3" fill="var(--surface-sidebar)"/><line x1="4" y1="16" x2="20" y2="16"/><circle cx="15" cy="16" r="2.3" fill="var(--surface-sidebar)"/>',
    archive:'<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><line x1="10" y1="12" x2="14" y2="12"/>',
    ext:    '<path d="M14 4h6v6"/><path d="M20 4l-8 8"/><path d="M19 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5"/>',
    term:   '<polyline points="5 8 9 12 5 16"/><line x1="11" y1="16" x2="17" y2="16"/>',
    copy:   '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>',
    x:      '<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>',
    clock:  '<circle cx="12" cy="12" r="9"/><line x1="12" y1="7" x2="12" y2="12"/><line x1="12" y1="12" x2="15.5" y2="14"/>',
    warn:   '<path d="M12 3l9 16H3z"/><line x1="12" y1="10" x2="12" y2="14"/><circle cx="12" cy="16.6" r="0.5" fill="currentColor"/>',
    redo:   '<polyline points="23 4 23 10 17 10"/><path d="M20.5 15a9 9 0 1 1-2.1-9.4L23 10"/>',
    branch: '<circle cx="6" cy="6" r="2.4"/><circle cx="6" cy="18" r="2.4"/><circle cx="18" cy="8" r="2.4"/><path d="M6 8.4v7.2"/><path d="M18 10.4c0 4-4 3.6-6 5.6"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    file:   '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><polyline points="14 3 14 8 19 8"/>',
    check:  '<polyline points="5 12 10 17 19 7"/>',
    pause:  '<rect x="7" y="5" width="3.5" height="14" rx="1"/><rect x="13.5" y="5" width="3.5" height="14" rx="1"/>',
    skull:  '<circle cx="12" cy="12" r="9"/><circle cx="9" cy="11" r="1.4" fill="currentColor"/><circle cx="15" cy="11" r="1.4" fill="currentColor"/><path d="M9 16h6"/>',
    pin:    '<path d="M9 4h6l-1 6 3 3H7l3-3z"/><line x1="12" y1="16" x2="12" y2="21"/>',
    reply:  '<polyline points="9 7 4 12 9 17"/><path d="M4 12h11a5 5 0 0 1 5 5v1"/>',
    pr:     '<circle cx="6" cy="6" r="2.4"/><circle cx="6" cy="18" r="2.4"/><circle cx="18" cy="18" r="2.4"/><path d="M6 8.4v7.2"/><path d="M11 6h4a3 3 0 0 1 3 3v6.6"/><polyline points="13 4 11 6 13 8"/>',
    transcript:'<line x1="6" y1="8" x2="18" y2="8"/><line x1="6" y1="12" x2="18" y2="12"/><line x1="6" y1="16" x2="13" y2="16"/>',
    diff:   '<line x1="12" y1="5" x2="12" y2="11"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="9" y1="17" x2="15" y2="17"/>',
    enter:  '<polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/>',
    grid:   '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    eye:    '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'
  };
  function svg(name, sz, sw) {
    sz = sz || 14; sw = sw || 1.7;
    return '<svg width="' + sz + '" height="' + sz + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + sw + '" stroke-linecap="round" stroke-linejoin="round">' + I[name] + '</svg>';
  }
  function icon(name, sz, sw) { return svg(name, sz, sw); }

  /* ── ojo (símbolo "todo lo ve") ── */
  function eye(w, alert) {
    w = w || 27; const h = Math.round(w * 19 / 27);
    return '<svg class="eye' + (alert ? ' alert' : '') + '" width="' + w + '" height="' + h + '" viewBox="0 0 80 56">' +
      '<ellipse cx="40" cy="28" rx="33" ry="11" fill="none" stroke="rgba(239,68,68,.18)" stroke-width="6"/>' +
      '<ellipse cx="40" cy="28" rx="31" ry="15" fill="none" stroke="rgba(230,230,230,.55)" stroke-width="2.5"/>' +
      '<circle cx="40" cy="28" r="11" fill="#ef4444"/>' +
      '<circle cx="40" cy="28" r="3.6" fill="#0a0a0b"/></svg>';
  }

  /* ── quick-actions block (hover) ── */
  function qa(buttons) {
    buttons = buttons || ['ext', 'term', 'copy', 'x'];
    return '<div class="card-qa">' + buttons.map(function (b) {
      return '<button class="qa-btn" title="' + b + '">' + svg(b, 12, 2) + '</button>';
    }).join('') + '</div>';
  }

  /* ── builder de CARD de sesión ──
     d = {name, mode, ctx, lvl('green'|'amber'|'red'|'dim'), tokens, model,
          state('working'|'attn'|'idle'|'standby'|'error'),
          status:{kind,text,em,spinner}, sel, qaBtns}                         */
  function card(d) {
    const cls = ['card'];
    if (d.state === 'working') cls.push('card--working');
    else if (d.state === 'attn') cls.push('card--attn');
    else if (d.state === 'error') cls.push('card--error');
    else if (d.state === 'standby') cls.push('card--standby');
    else cls.push('card--idle');
    if (d.sel) cls.push('card--sel');

    const dotMap = { working: 'green', attn: 'amber', idle: 'idle', standby: 'standby', error: 'error' };
    const dk = dotMap[d.state] || 'idle';
    const pulse = (d.state === 'working' || d.state === 'attn') ? ' pulse' : '';
    let lead;
    if (d.state === 'error') lead = '<span class="row" style="flex:none;color:var(--error)">' + svg('warn', 13, 1.9) + '</span>';
    else lead = '<span class="dot dot--' + dk + pulse + '"></span>';

    const s = d.status || {};
    let statusLead;
    if (s.spinner) statusLead = '<span class="spinner"></span>';
    else if (s.kind === 'attn') statusLead = svg('clock', 13, 1.8);
    else statusLead = '<span class="dot dot--' + dk + '"></span>';
    const em = s.em ? ' <span class="em">' + s.em + '</span>' : '';

    return '<div class="' + cls.join(' ') + '">' +
      (d.state === 'attn' ? '<span class="card-pip"></span>' : '') +
      '<div class="card-sel' + (d.sel ? ' checked' : '') + '">' + (d.sel ? svg('check', 11, 2.6) : '') + '</div>' +
      qa(d.qaBtns) +
      '<div class="card-head">' + lead +
        '<span class="card-title">' + d.name + '</span>' +
        '<span class="badge badge--' + d.mode + '">' + d.mode + '</span></div>' +
      '<div class="card-metrics">' +
        '<span class="ctx"><span class="ctx-fill ctx-fill--' + (d.lvl || 'green') + '" style="width:' + d.ctx + '%"></span></span>' +
        '<span class="ctx-pct' + (d.lvl && d.lvl !== 'green' ? ' ctx-pct--' + d.lvl : '') + '">' + d.ctx + '%</span>' +
        '<span class="sep">·</span><span>' + d.tokens + '</span>' +
        '<span class="sep">·</span><span class="model">' + d.model + '</span></div>' +
      '<div class="card-status st--' + (s.kind || 'idle') + '">' + statusLead + ' ' + (s.text || '') + em + '</div>' +
    '</div>';
  }

  /* ── builder de columna ── */
  function column(c) {
    const meta = (c.meta || []).map(function (m) {
      return '<span style="' + (m.color ? 'color:' + m.color : '') + '"><span class="d" style="background:' + m.dot + '"></span>' + m.label + '</span>';
    }).join('');
    const cards = (c.cards || []).map(card).join('');
    let closed = '';
    if (c.closed && c.closed.length) {
      const rows = c.closed.map(function (r) {
        return '<div class="closed-row"><span class="d"></span><span class="nm">' + r.name + '</span><span class="tk">' + r.tokens + '</span></div>';
      }).join('');
      closed = '<details><summary class="closed-toggle">' + svg('chevD', 11, 2.4) +
        ' cerradas <span class="n">(' + c.closedCount + ')</span></summary>' +
        '<div class="closed-list">' + rows + '</div></details>';
    }
    return '<section class="col">' +
      '<div class="col-head"><div class="col-title">' +
        '<span style="color:' + (c.fav ? 'var(--amber)' : '#7a7a82') + '">' + svg(c.fav ? 'star' : 'repo', c.fav ? 13 : 14, 1.7) + '</span>' +
        '<span class="nm">' + c.name + '</span><span class="ct">' + c.count + '</span></div>' +
        '<div class="col-meta">' + meta + '</div></div>' +
      '<div class="col-cards">' + cards + closed + '</div></section>';
  }

  /* ════════ TOP BAR ════════ */
  function topbar(o) {
    o = o || {};
    return '<header class="topbar">' +
      '<div class="brand">' + eye(27, o.alert) + '<span class="wordmark">CONSOMNI</span></div>' +
      '<div class="divider-v"></div>' +
      '<div class="counters">' +
        '<span><b>24</b> sesiones</span><span class="sep">·</span>' +
        '<span style="color:var(--amber)' + (o.alert ? ';animation:amberBlink 1.6s ease-in-out infinite;font-weight:500' : '') + '">' + (o.alert ? 2 : 0) + ' atención</span><span class="sep">·</span>' +
        '<span style="color:var(--green)">3 working</span><span class="sep">·</span>' +
        '<span style="color:#7a7a82">2 idle</span><span class="sep">·</span>' +
        '<span style="color:var(--text-3)">19 cerradas</span><span class="sep">·</span>' +
        '<span class="muted">Σ <b>9.0M</b> tok</span></div>' +
      '<div class="spacer"></div>' +
      '<div class="search">' + svg('search', 13, 2) + '<span>buscar nombre / proyecto / branch…</span><kbd class="kbd">/</kbd></div>' +
      '<div class="mode-pills">' +
        '<span class="fpill"><span class="d" style="background:var(--ask)"></span>ask</span>' +
        '<span class="fpill"><span class="d" style="background:var(--blue)"></span>plan</span>' +
        '<span class="fpill"><span class="d" style="background:var(--violet)"></span>edit</span>' +
        '<span class="fpill on"><span class="d" style="background:var(--red)"></span>auto</span></div>' +
      '<button class="tbtn">orden: <b>prioridad</b>' + svg('chevD', 10, 2.4) + '</button>' +
      '<div class="seg"><span class="on">cómodo</span><span>compacto</span></div>' +
      '<button class="iconbtn" title="notificaciones">' + svg('bell', 15, 1.7) + '</button>' +
      '<button class="cmdk"><kbd class="kbd">⌘</kbd><kbd class="kbd">K</kbd></button>' +
    '</header>';
  }

  /* ════════ SIDEBAR ════════ */
  function sidebar(o) {
    o = o || {};
    if (o.collapsed) {
      const ci = function (name, active, dot) {
        return '<div class="ci' + (active ? ' active' : '') + '" title="' + (o._t || '') + '">' + svg(name, 17, 1.7) +
          (dot ? '<span class="ci-dot" style="background:' + dot + '"></span>' : '') + '</div>';
      };
      return '<aside class="sidebar collapsed">' +
        '<div class="sb-head" style="justify-content:center;padding:15px 0 11px;"><button class="sb-add" style="padding:5px;">' + svg('plus', 13, 2.4) + '</button></div>' +
        '<div class="sb-scroll" style="gap:6px;">' +
          ci('target', true, null) +
          ci('star', false, 'var(--amber)') +
          ci('star', false, 'var(--green)') +
          ci('repo', false, 'var(--amber)') +
          ci('folder', false, 'var(--text-3)') +
          ci('repo', false, null) +
        '</div>' +
        '<div class="sb-foot" style="flex-direction:column;gap:7px;padding:10px 0;">' +
          '<button class="sbtn">' + svg('gear', 15, 1.7) + '</button>' +
          '<button class="sbtn">' + svg('moon', 14, 1.7) + '</button></div>' +
      '</aside>';
    }
    const mini = function (color, n) { return '<span class="sb-mini" style="color:' + color + '"><span class="d" style="background:' + color + (color.indexOf('green') > -1 ? ';box-shadow:0 0 6px rgba(74,222,128,.6)' : '') + '"></span>' + n + '</span>'; };
    return '<aside class="sidebar">' +
      '<div class="sb-head"><span class="lbl">proyectos</span>' +
        '<button class="sb-add">' + svg('plus', 11, 2.4) + ' agregar</button></div>' +
      '<div class="sb-scroll">' +
        '<div class="sb-item active">' + svg('target', 14, 1.7) + '<span class="nm">todos</span><span style="font-size:10px;color:var(--text-3)">vista global</span></div>' +
        '<div class="sb-group">favoritos</div>' +
        '<div class="sb-item"><span style="color:var(--amber)">' + svg('star', 13, 1.7) + '</span><span class="nm">Sar4</span>' + mini('var(--amber)', 1) + mini('var(--green)', 1) + '</div>' +
        '<div class="sb-item"><span style="color:var(--amber)">' + svg('star', 13, 1.7) + '</span><span class="nm">Consomni</span>' + mini('var(--green)', 2) + '</div>' +
        '<div class="sb-group">activos</div>' +
        '<div class="sb-item">' + svg('repo', 14, 1.7) + '<span class="nm">NI</span>' + mini('var(--amber)', 1) + mini('var(--error)', 1) + '</div>' +
        '<div class="sb-item"><span style="color:var(--text-3);margin-right:-2px">' + svg('chevR', 11, 2.4) + '</span>' + svg('folder', 14, 1.7) + '<span class="nm" style="color:#a8a8ae">api-gateway</span>' + mini('var(--text-3)', 3) + '</div>' +
        '<div class="sb-item sub"><span style="width:14px;display:flex;justify-content:center;color:var(--text-faint)">└</span><span class="nm">web</span>' + mini('var(--green)', 1) + '</div>' +
        '<div class="sb-item sub"><span style="width:14px;display:flex;justify-content:center;color:var(--text-faint)">└</span><span class="nm">api</span>' + mini('var(--text-3)', 2) + '</div>' +
        '<div class="sb-item">' + svg('repo', 14, 1.7) + '<span class="nm" style="color:#a8a8ae">marketing-site</span><span class="sb-mini" style="color:var(--text-3)"><span class="d" style="background:var(--text-3)"></span></span></div>' +
        '<div class="sb-group">archivados</div>' +
        '<div class="sb-item" style="color:var(--text-4)">' + svg('archive', 13, 1.7) + '<span class="nm" style="color:var(--text-4)">archivados</span><span style="font-size:10px">7</span></div>' +
      '</div>' +
      '<div class="sb-foot">' +
        '<button class="sbtn">' + svg('gear', 15, 1.7) + '</button>' +
        '<button class="sbtn">' + svg('moon', 14, 1.7) + '</button>' +
        '<span class="ver">v0.4.2</span></div>' +
    '</aside>';
  }

  /* ════════ STATUS BAR ════════ */
  function statusbar(o) {
    o = o || {};
    return '<footer class="statusbar">' +
      '<span class="row" style="gap:6px;color:var(--green)"><span class="dot dot--green pulse" style="box-shadow:none"></span>hooks: conectado</span><span class="sep">·</span>' +
      '<span>Σ <b>9.0M</b> tok hoy</span><span class="sep">·</span>' +
      '<span><b>3</b> sesiones activas</span><span class="sep">·</span>' +
      '<span style="color:var(--amber)">' + (o.alert ? 2 : 0) + ' esperan atención</span>' +
      '<span class="right">auto-refresh 2s · última actualización hace 3s</span>' +
    '</footer>';
  }

  function crt() { return '<div class="crt-vignette"></div><div class="crt-scan"></div>'; }

  /* ════════ datos de muestra (board compartido) ════════ */
  const DATA = {
    sar4: {
      name: 'Sar4', fav: true, count: 15,
      meta: [
        { dot: 'var(--green)', label: '2 active' },
        { dot: 'var(--idle)', label: '2 idle' },
        { dot: 'var(--closed)', label: '11 cerradas', color: 'var(--text-4)' }
      ],
      cards: [
        { name: 'Tickets', mode: 'auto', ctx: 41, lvl: 'green', tokens: '45k', model: 'opus 4.8', state: 'attn', status: { kind: 'attn', text: 'esperando permiso ·', em: 'Bash(rm -rf)' } },
        { name: 'Revisión 4 pantallas', mode: 'plan', ctx: 62, lvl: 'green', tokens: '128k', model: 'opus 4.8', state: 'working', status: { kind: 'green', spinner: true, text: 'coordinando subagentes', em: '(3)' } },
        { name: 'Fix auth flow', mode: 'edit', ctx: 28, lvl: 'green', tokens: '31k', model: 'sonnet 4.6', state: 'idle', status: { kind: 'idle', text: 'idle · 12m' } }
      ],
      closedCount: 11,
      closed: [{ name: 'Refactor store', tokens: '88k' }, { name: 'Setup CI pipeline', tokens: '203k' }, { name: 'Migrar a Tailwind v4', tokens: '66k' }]
    },
    consomni: {
      name: 'Consomni', fav: true, count: 6,
      meta: [
        { dot: 'var(--green)', label: '2 active' },
        { dot: 'var(--standby)', label: '1 standby' },
        { dot: 'var(--closed)', label: '3 cerradas', color: 'var(--text-4)' }
      ],
      cards: [
        { name: 'Build dashboard UI', mode: 'auto', ctx: 78, lvl: 'amber', tokens: '256k', model: 'opus 4.8', state: 'working', status: { kind: 'green', spinner: true, text: 'trabajando…', em: 'Edit Card.dc.html' } },
        { name: 'Design tokens', mode: 'edit', ctx: 19, lvl: 'green', tokens: '22k', model: 'sonnet 4.6', state: 'working', status: { kind: 'green', spinner: true, text: 'editando archivos', em: '(4)' } },
        { name: 'Eye logo / branding', mode: 'ask', ctx: 8, lvl: 'dim', tokens: '9k', model: 'sonnet 4.6', state: 'standby', status: { kind: 'standby', text: 'standby · esperando dispatch' } }
      ],
      closedCount: 3,
      closed: [{ name: 'Scaffold proyecto', tokens: '47k' }, { name: 'Spec del brief', tokens: '112k' }]
    },
    ni: {
      name: 'NI', fav: false, count: 4,
      meta: [
        { dot: 'var(--amber)', label: '1 atención', color: 'var(--amber)' },
        { dot: 'var(--error)', label: '1 error', color: 'var(--error)' },
        { dot: 'var(--closed)', label: '5 cerradas', color: 'var(--text-4)' }
      ],
      cards: [
        { name: 'Migración DB', mode: 'plan', ctx: 91, lvl: 'red', tokens: '198k', model: 'opus 4.8', state: 'attn', status: { kind: 'attn', text: 'esperando permiso ·', em: 'aplicar migración' } },
        { name: 'Endpoint /users', mode: 'auto', ctx: 54, lvl: 'green', tokens: '88k', model: 'opus 4.8', state: 'error', status: { kind: 'error', text: 'error: build failed', em: 'exit 1' }, qaBtns: ['ext', 'term', 'redo', 'x'] },
        { name: 'Audit deps', mode: 'ask', ctx: 12, lvl: 'green', tokens: '14k', model: 'sonnet 4.6', state: 'idle', status: { kind: 'idle', text: 'idle · 1h' } }
      ],
      closedCount: 5,
      closed: [{ name: 'Seed data', tokens: '34k' }, { name: 'Rate limiter', tokens: '71k' }]
    }
  };

  function board(cols) {
    cols = cols || [DATA.sar4, DATA.consomni, DATA.ni];
    return '<main class="board">' + cols.map(column).join('') +
      '<button class="iconbtn" style="width:54px;align-self:stretch;border-radius:10px;border:1px dashed var(--border);background:transparent;color:var(--text-4);align-items:flex-start;padding-top:13px;">' + svg('plus', 16, 2) + '</button>' +
    '</main>';
  }

  /* ════════ auto-mount: rellena placeholders por data-attr ════════ */
  function mount(o) {
    o = o || {};
    document.querySelectorAll('[data-chrome]').forEach(function (el) {
      const k = el.getAttribute('data-chrome');
      if (k === 'topbar') el.outerHTML = topbar(o);
      else if (k === 'sidebar') el.outerHTML = sidebar(o);
      else if (k === 'sidebar-collapsed') el.outerHTML = sidebar(Object.assign({}, o, { collapsed: true }));
      else if (k === 'statusbar') el.outerHTML = statusbar(o);
      else if (k === 'board') el.outerHTML = board(o.cols);
      else if (k === 'crt') el.outerHTML = crt();
    });
  }

  g.Chrome = { icon: icon, svg: svg, eye: eye, card: card, column: column, qa: qa,
    topbar: topbar, sidebar: sidebar, statusbar: statusbar, board: board, crt: crt,
    mount: mount, DATA: DATA, I: I };
})(window);
