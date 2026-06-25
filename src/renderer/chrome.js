/* ════════════════════════════════════════════════════════════════
   CONSOMNI — chrome.js  (versión parametrizada para datos vivos)
   ── Mismo markup y mismas clases que design-reference/chrome.js ──
   Los builders chrome (topbar/sidebar/statusbar) y board ahora aceptan
   datos vivos vía el objeto `o`; SIN argumentos reproducen el reference
   byte-idéntico (los valores mock quedan como defaults). Se agregó esc()
   para escapar datos del usuario (nombres/branches/cmds) sin tocar el markup.
   ════════════════════════════════════════════════════════════════ */
(function (g) {
  'use strict';

  /* ── escape de datos del usuario (evita romper markup / inyección) ── */
  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"]/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch];
    });
  }
  function pick(v, d) { return (v == null) ? d : v; }

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
    sun:    '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
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
    dispatch:'<polyline points="4 7 8 11 4 15"/><line x1="10" y1="16" x2="15" y2="16"/><path d="M18.5 3.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z"/>',
    eye:    '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    download:'<path d="M12 3v12"/><polyline points="7 11 12 16 17 11"/><path d="M5 20h14"/>',
    tasks:  '<polyline points="3.5 7 5.5 9 8.5 5"/><polyline points="3.5 16 5.5 18 8.5 14"/><line x1="11" y1="7" x2="20" y2="7"/><line x1="11" y1="17" x2="20" y2="17"/>',
    book:   '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
    edit:   '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    trash:  '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
    sparkles: '<path d="M12 4l1.7 4.8L18.5 10l-4.8 1.5L12 16l-1.5-4.5L5.5 10l4.8-1.2z"/><path d="M18.5 4.5l.6 1.7 1.7.6-1.7.6-.6 1.7-.6-1.7-1.7-.6 1.7-.6z"/>',
    selection: '<path d="M9 4.5h6M9 19.5h6M12 4.5v15"/>',
    scroll: '<polyline points="8 8 12 4 16 8"/><polyline points="8 16 12 20 16 16"/><line x1="12" y1="4.5" x2="12" y2="19.5"/>'
  };
  function svg(name, sz, sw) {
    sz = sz || 14; sw = sw || 1.7;
    return '<svg width="' + sz + '" height="' + sz + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + sw + '" stroke-linecap="round" stroke-linejoin="round">' + I[name] + '</svg>';
  }
  function icon(name, sz, sw) { return svg(name, sz, sw); }

  /* ── marca de GitHub (octocat, relleno) ── */
  function gh(sz) {
    sz = sz || 14;
    return '<svg width="' + sz + '" height="' + sz + '" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
      '<path d="M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58 0-.29-.01-1.04-.02-2.04-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.21.09 1.84 1.24 1.84 1.24 1.07 1.84 2.81 1.31 3.5 1 .11-.78.42-1.31.76-1.61-2.67-.3-5.47-1.34-5.47-5.96 0-1.32.47-2.39 1.24-3.23-.12-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23.96-.27 1.98-.4 3-.4 1.02 0 2.04.14 3 .4 2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.24 2.88.12 3.18.77.84 1.24 1.91 1.24 3.23 0 4.63-2.81 5.65-5.49 5.95.43.37.81 1.1.81 2.22 0 1.61-.01 2.9-.01 3.29 0 .32.22.7.83.58A12 12 0 0 0 24 12.5C24 5.87 18.63.5 12 .5z"/></svg>';
  }

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
      return '<button class="qa-btn" title="' + b + '" data-act="' + b + '">' + svg(b, 12, 2) + '</button>';
    }).join('') + '</div>';
  }

  /* ── builder de CARD de sesión (datos vivos; markup idéntico) ── */
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
    const em = s.em ? ' <span class="em">' + esc(s.em) + '</span>' : '';

    return '<div class="' + cls.join(' ') + '"' + (d.id ? ' data-sid="' + esc(d.id) + '"' : '') + '>' +
      (d.state === 'attn' ? '<span class="card-pip"></span>' : '') +
      qa(d.qaBtns) +
      '<div class="card-head">' + lead +
        '<span class="card-title">' + esc(d.name) + '</span>' +
        '<span class="badge badge--' + d.mode + '">' + esc(d.mode) + '</span></div>' +
      '<div class="card-metrics">' +
        '<span class="ctx"><span class="ctx-fill ctx-fill--' + (d.lvl || 'green') + '" style="width:' + d.ctx + '%"></span></span>' +
        '<span class="ctx-pct' + (d.lvl && d.lvl !== 'green' ? ' ctx-pct--' + d.lvl : '') + '">' + d.ctx + '%</span>' +
        '<span class="sep">·</span><span>' + esc(d.tokens) + '</span>' +
        '<span class="sep">·</span><span class="model">' + esc(d.model) + '</span></div>' +
      '<div class="card-status st--' + (s.kind || 'idle') + '">' + statusLead + ' ' + esc(s.text || '') + em + '</div>' +
    '</div>';
  }

  /* ── builder de columna ── */
  function column(c) {
    const meta = (c.meta || []).map(function (m) {
      return '<span style="' + (m.color ? 'color:' + m.color : '') + '"><span class="d" style="background:' + m.dot + '"></span>' + esc(m.label) + '</span>';
    }).join('');
    const cards = (c.cards || []).map(card).join('');
    // badge de cambios git sin commitear (+N/−N), estilo Warp. data-cwd propio (data-proj es el projKey normalizado, no un path).
    const dz = c.diff || null;
    const diffBadge = (dz && (dz.added || dz.removed) && c.cwd)
      ? '<button class="col-diff" data-act="diff-cwd" data-cwd="' + esc(c.cwd) + '" title="cambios sin commitear · ver git diff">'
          + (dz.added ? '<span class="col-diff-add">+' + dz.added + '</span>' : '')
          + (dz.removed ? '<span class="col-diff-del">−' + dz.removed + '</span>' : '')
        + '</button>'
      : '';
    let closed = '';
    if (c.closed && c.closed.length) {
      const rows = c.closed.map(function (r) {
        return '<div class="closed-row"' + (r.id ? ' data-sid="' + esc(r.id) + '"' : '') + '><span class="d"></span><span class="nm">' + esc(r.name) + '</span><span class="tk">' + esc(r.tokens) + '</span></div>';
      }).join('');
      closed = '<details' + (c.openClosed ? ' open' : '') + '><summary class="closed-toggle">' + svg('chevD', 11, 2.4) +
        ' cerradas <span class="n">(' + c.closedCount + ')</span></summary>' +
        '<div class="closed-list">' + rows + '</div></details>';
    }
    return '<section class="col"' + (c.id ? ' data-proj="' + esc(c.id) + '"' : '') + '>' +
      '<div class="col-head"><div class="col-title">' +
        '<span style="color:' + (c.fav ? 'var(--amber)' : '#7a7a82') + '">' + svg(c.fav ? 'star' : 'repo', c.fav ? 13 : 14, 1.7) + '</span>' +
        '<span class="nm">' + esc(c.name) + '</span><span class="ct">' + c.count + '</span>' + diffBadge + '</div>' +
        '<div class="col-meta">' + meta + '</div></div>' +
      '<div class="col-cards">' + cards + closed + '</div></section>';
  }

  /* ════════ TOP BAR (parametrizado) ════════ */
  function topbar(o) {
    o = o || {};
    const c = o.counts || {};
    const total = pick(c.total, 24);
    const attn = pick(c.attn, (o.alert ? 2 : 0));
    const working = pick(c.working, 3);
    const idle = pick(c.idle, 2);
    const closed = pick(c.closed, 19);
    const tok = pick(c.tokens, '9.0M');
    const hasAttn = attn > 0 || !!o.alert;

    const defaultPills = !o.modeFilter; // sin filtro ⇒ visual del reference (auto activo)
    const mf = o.modeFilter || {};
    const pill = function (mode, varname) {
      const on = defaultPills ? (mode === 'auto') : !!mf[mode];
      return '<span class="fpill' + (on ? ' on' : '') + '" data-mode="' + mode + '"><span class="d" style="background:var(' + varname + ')"></span>' + mode + '</span>';
    };
    const sortLabel = o.sortLabel || 'prioridad';
    const density = o.density || 'comodo';
    // buscador: estado ACTIVO (foco + caret titilando) / CON-FILTRO (× para borrar) hermosos; INACTIVO = design-reference.
    const sActive = !!o.searchActive, sQuery = o.searchQuery || '';
    const sPh = 'buscar nombre / proyecto / branch…';
    let searchInner;
    if (sActive || sQuery) {
      const sTxt = sQuery
        ? '<span class="search-q">' + esc(sQuery) + '</span>' + (sActive ? '<i class="search-caret"></i>' : '')
        : (sActive ? '<i class="search-caret"></i>' : '') + '<span class="search-ph">' + sPh + '</span>';
      searchInner = svg('search', 13, 2) + '<span class="search-body">' + sTxt + '</span>' +
        (sQuery ? '<button class="search-clear" data-act="search-clear" title="borrar filtro (Esc)">' + svg('x', 11, 2.4) + '</button>' : '');
    } else {
      searchInner = svg('search', 13, 2) + '<span class="search-ph">' + sPh + '</span><kbd class="kbd">/</kbd>';
    }

    return '<header class="topbar">' +
      '<div class="brand">' + eye(27, hasAttn) + '<span class="wordmark">CONSOMNI</span>' +
        '<span class="brand-meta"><span class="brand-ver">' + esc(o.version || 'v1.9.7') + '</span>' +
        '<button class="brand-changelog" data-act="changelog-all" title="ver todas las novedades">' + svg('sparkles', 10, 1.7) + '<span>Changelog</span></button></span></div>' +
      '<div class="divider-v"></div>' +
      '<div class="counters">' +
        '<span><b>' + total + '</b> sesiones</span><span class="sep">·</span>' +
        '<span style="color:var(--amber)' + (hasAttn ? ';animation:amberBlink 1.6s ease-in-out infinite;font-weight:500' : '') + '">' + attn + ' atención</span><span class="sep">·</span>' +
        '<span style="color:var(--green)">' + working + ' working</span><span class="sep">·</span>' +
        '<span style="color:#7a7a82">' + idle + ' idle</span><span class="sep">·</span>' +
        '<span style="color:var(--text-3)">' + closed + ' cerradas</span><span class="sep">·</span>' +
        '<span class="muted">Σ <b>' + tok + '</b> tok</span></div>' +
      '<div class="spacer"></div>' +
      '<div class="search' + (sActive ? ' searching' : '') + (sQuery ? ' has-q' : '') + '" data-act="search" title="buscar (o apretá /)">' + searchInner + '</div>' +
      '<div class="mode-pills">' +
        pill('ask', '--ask') + pill('plan', '--blue') + pill('edit', '--violet') + pill('auto', '--red') + '</div>' +
      '<button class="tbtn">orden: <b>' + esc(sortLabel) + '</b>' + svg('chevD', 10, 2.4) + '</button>' +
      '<div class="seg"><span' + (density === 'comodo' ? ' class="on"' : '') + ' data-density="comodo">cómodo</span><span' + (density === 'compacto' ? ' class="on"' : '') + ' data-density="compacto">compacto</span></div>' +
      // botón de actualización: oculto por default; lo muestra app.js cuando hay update.
      '<button class="upbtn" data-act="update" title="actualizar Consomni" hidden>' +
        '<span class="upbtn-bar"></span>' +
        '<span class="upbtn-ic">' + svg('download', 13, 2) + '</span>' +
        '<span class="upbtn-tx">Actualizar</span>' +
      '</button>' +
      '<button class="iconbtn notif-bell" title="notificaciones" data-act="notifs">' + svg('bell', 15, 1.7) + '<span class="notif-badge" hidden></span></button>' +
      '<button class="cmdk"><kbd class="kbd">⌘</kbd><kbd class="kbd">K</kbd></button>' +
    '</header>';
  }

  /* ════════ SIDEBAR (parametrizado) ════════ */
  function mini(color, n) {
    return '<span class="sb-mini" style="color:' + color + '"><span class="d" style="background:' + color + (color.indexOf('green') > -1 ? ';box-shadow:0 0 6px rgba(74,222,128,.6)' : '') + '"></span>' + n + '</span>';
  }
  function minis(arr) { return (arr || []).map(function (m) { return mini(m.color, m.n); }).join(''); }

  function sbItem(it, sub) {
    if (it.isAll) {
      return '<div class="sb-item' + (it.active ? ' active' : '') + '" data-proj="all">' + svg('target', 14, 1.7) +
        '<span class="nm">todos</span><span style="font-size:10px;color:var(--text-3)">vista global</span></div>';
    }
    if (it.isArchived) {
      return '<div class="sb-item' + (it.active ? ' active' : '') + '" style="color:var(--text-4)" data-proj="' + esc(it.id || 'archived') + '">' + svg('archive', 13, 1.7) +
        '<span class="nm" style="color:var(--text-4)">' + esc(it.name || 'archivados') + '</span><span style="font-size:10px">' + (it.count || 0) + '</span></div>';
    }
    const dp = ' data-proj="' + esc(it.id || it.name) + '"';
    if (sub) {
      return '<div class="sb-item sub"' + dp + '><span style="width:14px;display:flex;justify-content:center;color:var(--text-faint)">└</span>' +
        '<span class="nm">' + esc(it.name) + '</span>' + minis(it.minis) + '</div>';
    }
    let lead;
    if (it.hasChildren) {
      lead = '<span style="color:var(--text-3);margin-right:-2px">' + svg('chevR', 11, 2.4) + '</span>' + svg('folder', 14, 1.7);
    } else if (it.icon === 'star') {
      lead = '<span style="color:var(--amber)">' + svg('star', 13, 1.7) + '</span>';
    } else if (it.icon === 'folder') {
      lead = svg('folder', 14, 1.7);
    } else {
      lead = svg('repo', 14, 1.7);
    }
    const nmStyle = it.dim ? ' style="color:#a8a8ae"' : '';
    // proyecto "fijado" sin sesiones activas → 'x' (en hover) para quitarlo del sidebar
    const rmX = it.finished ? '<button class="sb-x" data-unkeep="' + esc(it.id || it.name) + '" title="quitar del sidebar">' + svg('x', 11, 2.2) + '</button>' : '';
    let html = '<div class="sb-item' + (it.active ? ' active' : '') + '"' + dp + '>' + lead +
      '<span class="nm"' + nmStyle + '>' + esc(it.name) + '</span>' + minis(it.minis) + rmX + '</div>';
    if (it.sub && it.sub.length) html += it.sub.map(function (s) { return sbItem(s, true); }).join('');
    return html;
  }

  function sidebar(o) {
    o = o || {};
    const tree = o.tree;

    if (o.collapsed) {
      const ci = function (name, active, dot, proj) {
        return '<div class="ci' + (active ? ' active' : '') + '"' + (proj ? ' data-proj="' + esc(proj) + '"' : '') + ' title="' + (o._t || '') + '">' + svg(name, 17, 1.7) +
          (dot ? '<span class="ci-dot" style="background:' + dot + '"></span>' : '') + '</div>';
      };
      let items;
      if (tree && tree.ci) {
        items = tree.ci.map(function (x) { return ci(x.icon, x.active, x.dot, x.proj); }).join('');
      } else {
        items = ci('target', true, null) +
          ci('star', false, 'var(--amber)') + ci('star', false, 'var(--green)') +
          ci('repo', false, 'var(--amber)') + ci('folder', false, 'var(--text-3)') + ci('repo', false, null);
      }
      return '<aside class="sidebar collapsed">' +
        '<div class="sb-head" style="justify-content:center;padding:15px 0 11px;"><button class="sb-add" style="padding:5px;">' + svg('plus', 13, 2.4) + '</button></div>' +
        '<div class="ci ci-home' + ((tree && tree.home) ? ' active' : '') + '" data-act="home" title="inicio · terminales" style="margin:0 auto 6px;">' + svg('grid', 17, 1.8) + '</div>' +
        '<div class="ci ci-plans' + ((tree && tree.plans) ? ' active' : '') + '" data-act="plans" title="planes · frentes (pendiente vs hecho)" style="margin:0 auto 6px;">' + svg('tasks', 17, 1.8) + '</div>' +
        '<div class="ci ci-lib' + ((tree && tree.library) ? ' active' : '') + '" data-act="library" title="biblioteca · prompts/skills/rules" style="margin:0 auto 6px;">' + svg('book', 17, 1.8) + '</div>' +
        '<div class="sb-scroll" style="gap:6px;">' + items + '</div>' +
        '<div class="sb-foot" style="flex-direction:column;gap:7px;padding:10px 0;">' +
          '<button class="sbtn sb-toggle" data-act="sbtoggle" title="expandir sidebar">' + svg('chevR', 15, 2.4) + '</button>' +
          '<button class="sbtn" data-act="terminals" title="terminales embebidas (Shift+T)">' + svg('term', 15, 1.8) + '</button>' +
          '<a class="sbtn" data-href="https://github.com/JoaquimColacilli" title="by Joaquim Colacilli · github.com/JoaquimColacilli">' + gh(15) + '</a>' +
          '<button class="sbtn" data-act="settings">' + svg('gear', 15, 1.7) + '</button>' +
          '<button class="sbtn" data-act="theme" title="' + (o.light ? 'modo oscuro' : 'modo claro') + '">' + svg(o.light ? 'moon' : 'sun', 14, 1.7) + '</button></div>' +
      '</aside>';
    }

    let body;
    if (tree) {
      const all = sbItem({ isAll: true, active: !tree.home && !tree.plans && !tree.library && (!tree.active || tree.active === 'all') });
      const groups = (tree.groups || []).map(function (gr) {
        const head = '<div class="sb-group">' + esc(gr.label) + '</div>';
        const rows = (gr.items || []).map(function (it) { return sbItem(it, false); }).join('');
        return head + rows;
      }).join('');
      body = all + groups;
    } else {
      // fallback = reference verbatim (e1)
      body =
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
        '<div class="sb-item" style="color:var(--text-4)">' + svg('archive', 13, 1.7) + '<span class="nm" style="color:var(--text-4)">archivados</span><span style="font-size:10px">7</span></div>';
    }

    return '<aside class="sidebar">' +
      '<div class="sb-home' + ((tree && tree.home) ? ' active' : '') + '" data-act="home" title="tus terminales abiertas (pantalla completa)">' + svg('grid', 14, 1.8) + '<span class="nm">inicio</span><span class="sb-home-tag">terminales</span></div>' +
      '<div class="sb-home sb-plans' + ((tree && tree.plans) ? ' active' : '') + '" data-act="plans" title="planes y specs detectados · pendiente vs hecho">' + svg('tasks', 14, 1.8) + '<span class="nm">planes</span><span class="sb-home-tag">frentes</span></div>' +
      '<div class="sb-home sb-lib' + ((tree && tree.library) ? ' active' : '') + '" data-act="library" title="biblioteca · tus prompts, skills y rules reutilizables">' + svg('book', 14, 1.8) + '<span class="nm">biblioteca</span><span class="sb-home-tag">prompts</span></div>' +
      '<div class="sb-head"><span class="lbl">proyectos</span>' +
        '<button class="sb-add">' + svg('plus', 11, 2.4) + ' agregar</button></div>' +
      '<div class="sb-scroll">' + body + '</div>' +
      '<a class="sb-author" data-href="https://github.com/JoaquimColacilli" title="github.com/JoaquimColacilli">' +
        gh(13) + '<span>by <b>Joaquim Colacilli</b></span></a>' +
      '<div class="sb-foot">' +
        '<button class="sbtn sb-toggle" data-act="sbtoggle" title="colapsar / expandir sidebar">' + svg('chevR', 15, 2.4) + '</button>' +
        '<button class="sbtn" data-act="terminals" title="terminales embebidas (Shift+T)">' + svg('term', 15, 1.8) + '</button>' +
        '<button class="sbtn" data-act="settings">' + svg('gear', 15, 1.7) + '</button>' +
        '<button class="sbtn" data-act="theme" title="' + (o.light ? 'modo oscuro' : 'modo claro') + '">' + svg(o.light ? 'moon' : 'sun', 14, 1.7) + '</button>' +
        '<span class="ver">' + esc(o.version || 'v1.9.7') + '</span></div>' +
    '</aside>';
  }

  /* ════════ STATUS BAR (parametrizado) ════════ */
  function statusbar(o) {
    o = o || {};
    const st = o.status || {};
    const connected = pick(st.hooksConnected, true);
    const tokensToday = pick(st.tokensToday, '9.0M');
    const activeCount = pick(st.activeCount, 3);
    const attnCount = pick(st.attnCount, (o.alert ? 2 : 0));
    const refreshSecs = pick(st.refreshSecs, 2);
    const lastUpdate = pick(st.lastUpdate, 'hace 3s');
    const hookDot = connected
      ? '<span class="dot dot--green pulse" style="box-shadow:none"></span>'
      : '<span class="dot dot--idle"></span>';
    const hookColor = connected ? 'var(--green)' : 'var(--text-3)';
    const hookLabel = connected ? 'hooks: conectado' : 'hooks: desconectado';

    return '<footer class="statusbar">' +
      '<span class="row" style="gap:6px;color:' + hookColor + '">' + hookDot + hookLabel + '</span><span class="sep">·</span>' +
      '<span>Σ <b>' + tokensToday + '</b> tok hoy</span><span class="sep">·</span>' +
      '<span><b>' + activeCount + '</b> sesiones activas</span><span class="sep">·</span>' +
      '<span style="color:var(--amber)">' + attnCount + ' esperan atención</span>' +
      '<span class="right">auto-refresh ' + refreshSecs + 's · última actualización ' + esc(lastUpdate) + '</span>' +
    '</footer>';
  }

  function crt() { return '<div class="crt-vignette"></div><div class="crt-scan"></div>'; }

  /* ════════ datos de muestra (board compartido — fallback de e1) ════════ */
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
      '<button class="iconbtn board-add" title="nueva sesión (⌘K)" style="width:54px;height:54px;align-self:flex-start;border-radius:10px;border:1px dashed var(--border);background:transparent;color:var(--text-4);">' + svg('plus', 16, 2) + '</button>' +
    '</main>';
  }

  /* ════════ auto-mount (compat con el reference) ════════ */
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

  g.Chrome = { icon: icon, svg: svg, gh: gh, eye: eye, card: card, column: column, qa: qa,
    topbar: topbar, sidebar: sidebar, statusbar: statusbar, board: board, crt: crt,
    mount: mount, esc: esc, DATA: DATA, I: I };
})(window);
