// ═══════════════════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════════════════

const AXIS_MIN       = 1700;
const AXIS_MAX_LIN   = 3000;   // linear-mode upper bound
const LOG_CUTOFF     = 3000;   // linear/log split year
const LOG_SPLIT_FRAC = 0.60;   // fraction of inner width for linear portion in log mode
const LOG_MAX        = 1e13;   // right-edge year in log mode
const NOW            = 2026;

const MARGIN = { left: 56, right: 36, top: 32, bottom: 48 };

const ARC_HEIGHT_RATIO = 0.76;   // arc height = pixel_span × ratio (capped)
const ARC_MIN_H        = 6;
const DEFAULT_OPACITY  = 0.22;
const DEFAULT_STROKE   = 1.2;

const MEDIUM_COLORS = {
  'film':          '#FF8CA1',
  'prose fiction': '#00B0BE',
  'television':    '#FFB255',
  'video game':    '#8FD7D7',
  'comics':        '#c084fc',
  'radio':         '#86efac',
  'tabletop game': '#fbbf24',
  'drama':         '#fb923c',
  'ride':          '#f9a8d4',
  'illustration':  '#d4d4aa',
};

function mColor(medium) {
  return MEDIUM_COLORS[medium?.trim()] || '#8888aa';
}

// ═══════════════════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════════════════

let allData   = [];
let seriesMap = {};

let activeFilters  = new Set();  // empty = show all
let isMultiSelect  = false;
let isLogScale     = false;
let searchQuery   = '';
let hoveredId     = null;
let selectedId    = null;

let _ttTimer = null;   // mini-tooltip hide timer

// SVG references (refreshed on each drawViz call)
let svgSel = null;
let gArcs  = null;
let gHigh  = null;
let scaleX = null;   // function(year) → pixel x
let yMid   = 0;
let maxArcH = 0;

// ═══════════════════════════════════════════════════════════
//  UTILS
// ═══════════════════════════════════════════════════════════

function fmt(n) {
  if (n == null || isNaN(n)) return '—';
  return Math.round(n).toLocaleString('en-US');
}

function pluralYears(n) {
  const r = Math.round(Math.abs(n));
  return r === 1 ? '1 year' : `${r.toLocaleString('en-US')} years`;
}

function formatAxisYear(y) {
  if (y < 10000) return String(y);
  if (y < 1e6)  return (y / 1e3).toFixed(0) + 'k';
  if (y < 1e9)  return (y / 1e6).toFixed(0) + 'M';
  if (y < 1e12) return (y / 1e9).toFixed(0) + 'B';
  return (y / 1e12).toFixed(0) + 'T';
}

function yearLabel(d) {
  if (d._isFarFuture) {
    const cap = isLogScale ? LOG_MAX : AXIS_MAX_LIN;
    return '> ' + formatAxisYear(cap);
  }
  return fmt(d.year_set);
}

// ═══════════════════════════════════════════════════════════
//  SCALE
// ═══════════════════════════════════════════════════════════

function buildScaleX(W) {
  if (!isLogScale) {
    const s = d3.scaleLinear()
      .domain([AXIS_MIN, AXIS_MAX_LIN])
      .range([MARGIN.left, W - MARGIN.right]);

    scaleX            = y => s(Math.max(AXIS_MIN, Math.min(y, AXIS_MAX_LIN)));
    scaleX.isFarFuture = y => y > AXIS_MAX_LIN;
    scaleX.linTicks    = d3.range(1800, AXIS_MAX_LIN + 1, 100);
    scaleX.logTicks    = null;

  } else {
    const innerW = W - MARGIN.left - MARGIN.right;
    const splitX = MARGIN.left + innerW * LOG_SPLIT_FRAC;
    const linS   = d3.scaleLinear().domain([AXIS_MIN, LOG_CUTOFF]).range([MARGIN.left, splitX]);
    const logS   = d3.scaleLog().domain([LOG_CUTOFF, LOG_MAX]).range([splitX, W - MARGIN.right]);

    scaleX = y => {
      if (y <= LOG_CUTOFF) return linS(Math.max(AXIS_MIN, y));
      return Math.min(logS(Math.min(y, LOG_MAX)), W - MARGIN.right);
    };
    scaleX.isFarFuture = y => y > LOG_MAX;
    scaleX.linTicks    = d3.range(1800, LOG_CUTOFF + 1, 100);
    scaleX.logTicks    = [5e3, 1e4, 5e4, 1e5, 1e6, 1e9, 1e12];
  }
}

// ═══════════════════════════════════════════════════════════
//  ARC PATHS
// ═══════════════════════════════════════════════════════════

function getX2(d) {
  if (d._isFarFuture) {
    return scaleX(isLogScale ? Math.min(d.year_set, LOG_MAX) : AXIS_MAX_LIN);
  }
  return scaleX(d.year_set);
}

function makeArcPath(d) {
  const x1   = scaleX(d.released);
  const x2   = getX2(d);
  const span = Math.abs(x2 - x1);
  const h    = Math.max(ARC_MIN_H, Math.min(span * ARC_HEIGHT_RATIO, maxArcH));
  const xm   = (x1 + x2) / 2;
  const yc   = d._above ? yMid - h : yMid + h;
  return `M${x1},${yMid} Q${xm},${yc} ${x2},${yMid}`;
}

// ═══════════════════════════════════════════════════════════
//  DATA LOAD
// ═══════════════════════════════════════════════════════════

d3.csv('./futuristic_fiction.csv').then(raw => {

  allData = raw
    .map(d => ({
      ...d,
      released:      +d.released,
      year_set:      +d.year_set,
      years_distant: +d.years_distant,
      _isFarFuture:  false,  // computed per-draw
      _above:        false,  // set below
    }))
    .filter(d => !isNaN(d.released) && !isNaN(d.year_set) && d.year_set > 0);

  // Sort and assign above/below alternation
  allData.sort((a, b) => a.released - b.released || a.year_set - b.year_set);
  allData.forEach((d, i) => { d._above = (i % 2 === 0); });

  // Build series map (Wikidata QID → [records])
  allData.forEach(d => {
    const sid = d.is_series?.trim();
    if (sid) {
      if (!seriesMap[sid]) seriesMap[sid] = [];
      seriesMap[sid].push(d);
    }
  });

  setupControls();
  drawViz();
  window.addEventListener('resize', drawViz);
});

// ═══════════════════════════════════════════════════════════
//  CONTROLS SETUP
// ═══════════════════════════════════════════════════════════

function setupControls() {
  // Medium buttons
  const mf = document.getElementById('medium-filters');

  const allBtn = makeMediumBtn('All', '#8888aa', null);
  mf.appendChild(allBtn);

  const counts = {};
  allData.forEach(d => {
    const m = d.medium?.trim();
    if (m) counts[m] = (counts[m] || 0) + 1;
  });

  Object.entries(MEDIUM_COLORS)
    .filter(([m]) => counts[m] > 0)
    .sort((a, b) => (counts[b[0]] || 0) - (counts[a[0]] || 0))
    .forEach(([m, c]) => mf.appendChild(makeMediumBtn(m, c, m)));

  // Initial style: "All" active
  syncBtnStyles();

  // Multi-select toggle
  document.getElementById('btn-multiselect').addEventListener('click', () => {
    isMultiSelect = !isMultiSelect;
    document.getElementById('btn-multiselect').classList.toggle('active', isMultiSelect);
  });

  // Scale toggle
  document.getElementById('btn-linear').addEventListener('click', () => setScale(false));
  document.getElementById('btn-log').addEventListener('click', () => setScale(true));

  // Search
  const input = document.getElementById('search-input');
  input.addEventListener('input', e => {
    searchQuery = e.target.value.toLowerCase().trim();
    document.getElementById('search-clear').style.display = searchQuery ? 'block' : 'none';
    if (selectedId) deselect();
    applyCurrentFilter();
  });
  document.getElementById('search-clear').addEventListener('click', () => {
    searchQuery = '';
    input.value = '';
    document.getElementById('search-clear').style.display = 'none';
    applyCurrentFilter();
  });
}

function makeMediumBtn(label, color, medium) {
  const btn = document.createElement('button');
  btn.className         = 'medium-btn';
  btn.textContent       = label;
  btn.style.borderColor = color;
  btn.style.color       = color;
  btn.dataset.medium    = medium ?? '';
  btn.dataset.color     = color;
  btn.addEventListener('click', () => toggleFilter(medium));
  return btn;
}

// ═══════════════════════════════════════════════════════════
//  FILTER & OPACITY
// ═══════════════════════════════════════════════════════════

function isArcActive(d) {
  if (searchQuery)         return d.title?.toLowerCase().includes(searchQuery);
  if (activeFilters.size)  return activeFilters.has(d.medium?.trim());
  return true;
}

function getArcOpacity(d) {
  if (!isArcActive(d)) return 0.03;
  return searchQuery ? Math.min(DEFAULT_OPACITY * 2.8, 0.7) : DEFAULT_OPACITY;
}

function applyCurrentFilter() {
  if (!gArcs) return;
  const hasFilter = activeFilters.size > 0 || !!searchQuery;

  gArcs.selectAll('.arc').each(function(d) {
    const active = isArcActive(d);
    d3.select(this)
      .attr('opacity', getArcOpacity(d))
      .attr('stroke-width', active && hasFilter ? 2.0 : DEFAULT_STROKE);
  });

  // Bring active arcs on top so they're not buried under dimmed ones
  if (hasFilter) {
    gArcs.selectAll('.arc').filter(d => isArcActive(d)).raise();
  }
}

function toggleFilter(medium) {
  if (selectedId) deselect();

  if (medium === null) {
    // "All" — clear every selection
    activeFilters.clear();
  } else if (isMultiSelect) {
    // Multi-select: toggle individual mediums
    if (activeFilters.has(medium)) {
      activeFilters.delete(medium);
    } else {
      activeFilters.add(medium);
    }
  } else {
    // Single-select: clicking the active one goes back to "All"; otherwise replace
    if (activeFilters.size === 1 && activeFilters.has(medium)) {
      activeFilters.clear();
    } else {
      activeFilters.clear();
      activeFilters.add(medium);
    }
  }

  syncBtnStyles();
  applyCurrentFilter();
}

// Fill button background when active, reset otherwise
function syncBtnStyles() {
  const allSelected = activeFilters.size === 0;
  document.querySelectorAll('.medium-btn').forEach(btn => {
    const m     = btn.dataset.medium;   // '' for "All"
    const color = btn.dataset.color;
    const isActive = m === ''
      ? allSelected
      : activeFilters.has(m);

    btn.style.backgroundColor = isActive ? color + '38' : 'transparent';
    btn.style.opacity         = isActive ? '1' : '0.4';
  });
}

function setScale(log) {
  isLogScale = log;
  document.getElementById('btn-linear').classList.toggle('active', !log);
  document.getElementById('btn-log').classList.toggle('active', log);
  drawViz();
}

// ═══════════════════════════════════════════════════════════
//  DRAW
// ═══════════════════════════════════════════════════════════

function drawViz() {
  svgSel = d3.select('#viz');
  const wrap = document.getElementById('viz-wrap');
  const W = wrap.clientWidth;
  const H = wrap.clientHeight;
  if (W === 0 || H === 0) return;

  svgSel.attr('width', W).attr('height', H).selectAll('*').remove();

  const iH = H - MARGIN.top - MARGIN.bottom;
  yMid    = MARGIN.top + iH * 0.5;
  maxArcH = Math.min(iH * 0.46, 480);

  buildScaleX(W);

  // Update _isFarFuture for each datum based on current scale mode
  allData.forEach(d => { d._isFarFuture = scaleX.isFarFuture(d.year_set); });

  // Background click deselects
  svgSel.on('click', () => { if (selectedId !== null) deselect(); });

  // Track cursor for mini-tooltip while selected
  svgSel.on('mousemove', event => {
    if (selectedId !== null && hoveredId !== null && hoveredId !== selectedId) {
      positionMiniTooltip(event);
    }
  });

  drawAxis(svgSel, W, H);

  // Arcs layer — visual only, no pointer events
  gArcs = svgSel.append('g').attr('class', 'g-arcs');

  gArcs.selectAll('.arc')
    .data(allData, d => d.record_id)
    .join('path')
    .attr('class', 'arc')
    .attr('d', makeArcPath)
    .attr('stroke', d => mColor(d.medium))
    .attr('stroke-width', DEFAULT_STROKE)
    .attr('opacity', DEFAULT_OPACITY)
    .attr('pointer-events', 'visibleStroke')
    .on('mouseenter', (event, d) => onHover(event, d))
    .on('mouseleave', ()          => onLeave())
    .on('click',      (event, d)  => onClick(event, d));

  // Highlight overlay — no pointer events
  gHigh = svgSel.append('g').attr('class', 'g-highlight').attr('pointer-events', 'none');

  drawLegend(svgSel, W, H);

  // Restore selection state after redraw (resize / scale change)
  if (selectedId !== null) {
    const d = allData.find(r => r.record_id === selectedId);
    if (d) {
      applyHighlight(d, true);
      drawOverlay(d, true);
      return;   // skip applyCurrentFilter – highlight takes precedence
    } else {
      selectedId = null;
    }
  }
  applyCurrentFilter();
}

// ─── Axis ───────────────────────────────────────────────────

function drawAxis(svg, W, H) {
  const g = svg.append('g').attr('class', 'g-axis');

  // Baseline
  g.append('line')
    .attr('class', 'axis-line')
    .attr('x1', MARGIN.left).attr('x2', W - MARGIN.right)
    .attr('y1', yMid).attr('y2', yMid);

  // Linear ticks
  (scaleX.linTicks || []).forEach(t => {
    const x     = scaleX(t);
    const isMaj = t % 100 === 0;
    const tH    = isMaj ? 9 : 5;

    g.append('line')
      .attr('class', 'tick-line')
      .attr('x1', x).attr('x2', x)
      .attr('y1', yMid - tH).attr('y2', yMid + tH)
      .attr('opacity', isMaj ? 0.38 : 0.18);

    if (isMaj) {
      g.append('text')
        .attr('class', 'tick-label')
        .attr('x', x).attr('y', yMid + 22)
        .text(t);
    }
  });

  // Log-scale ticks
  if (isLogScale && scaleX.logTicks) {
    scaleX.logTicks.forEach(t => {
      const x = scaleX(t);
      if (x > W - MARGIN.right - 2) return;
      g.append('line')
        .attr('class', 'tick-line')
        .attr('x1', x).attr('x2', x)
        .attr('y1', yMid - 9).attr('y2', yMid + 9)
        .attr('opacity', 0.38);
      g.append('text')
        .attr('class', 'tick-label')
        .attr('x', x).attr('y', yMid + 22)
        .text(formatAxisYear(t));
    });

    // Dashed separator at the linear/log boundary
    const xSplit = scaleX(LOG_CUTOFF);
    g.append('line')
      .attr('x1', xSplit).attr('x2', xSplit)
      .attr('y1', yMid - maxArcH - 6)
      .attr('y2', yMid + maxArcH + 6)
      .attr('stroke', '#ffffff0a').attr('stroke-width', 1)
      .attr('stroke-dasharray', '4 4');
  }

  // "Today" marker
  const xNow = scaleX(NOW);
  g.append('line')
    .attr('class', 'now-line')
    .attr('x1', xNow).attr('x2', xNow)
    .attr('y1', yMid - maxArcH - 16)
    .attr('y2', yMid + maxArcH + 16);
  g.append('text')
    .attr('class', 'now-label')
    .attr('x', xNow)
    .attr('y', yMid - maxArcH - 22)
    .text('today');

  // Clipping note in linear mode
  if (!isLogScale) {
    g.append('text')
      .attr('class', 'tick-label')
      .attr('x', W - MARGIN.right + 5)
      .attr('y', yMid + 22)
      .attr('text-anchor', 'start')
      .attr('font-size', '9px')
      .text('> ' + formatAxisYear(AXIS_MAX_LIN));
  }
}

// ─── Legend ──────────────────────────────────────────────────

function drawLegend(svg, W, H) {
  const g   = svg.append('g').attr('class', 'g-legend');
  const lx  = MARGIN.left + (W - MARGIN.right - MARGIN.left) / 2 - 185;
  const ly  = 18;   // top of the SVG
  const col = '#55556a';
  const fs  = '12px';
  const ff  = "'Segoe UI', system-ui, sans-serif";

  // Small arc sample
  g.append('path')
    .attr('d', `M${lx},${ly} Q${lx + 22},${ly - 12} ${lx + 44},${ly}`)
    .attr('fill', 'none').attr('stroke', col).attr('stroke-width', 2);

  g.append('text')
    .attr('x', lx + 52).attr('y', ly + 4)
    .attr('fill', col).attr('font-size', fs).attr('font-family', ff)
    .text("Each arc connects a work's release year to the year it is set in");
}

// ═══════════════════════════════════════════════════════════
//  HIGHLIGHT
// ═══════════════════════════════════════════════════════════

function getSiblings(d) {
  const sid = d.is_series?.trim();
  if (!sid) return [];
  return (seriesMap[sid] || []).filter(s => s.record_id !== d.record_id);
}

function applyHighlight(d, isSelected) {
  const siblings = getSiblings(d);

  // Dim all
  gArcs.selectAll('.arc')
    .attr('opacity', 0.04)
    .attr('stroke-width', DEFAULT_STROKE);

  // Semi-highlight series siblings
  if (siblings.length > 0) {
    gArcs.selectAll('.arc')
      .filter(a => siblings.some(s => s.record_id === a.record_id))
      .attr('opacity', 0.50)
      .attr('stroke-width', 1.8);
  }

  // Full highlight on the main arc
  gArcs.selectAll('.arc')
    .filter(a => a.record_id === d.record_id)
    .attr('opacity', 1)
    .attr('stroke-width', isSelected ? 3.5 : 2.8)
    .raise();
}

function drawOverlay(d, isSelected) {
  gHigh.selectAll('*').remove();
  const color = mColor(d.medium);
  const x1    = scaleX(d.released);
  const x2    = getX2(d);

  // ── Multiyears band on axis ──────────────────────────
  const multi = d.multiyears?.trim();
  if (multi) {
    const m = multi.match(/^(\d{4})-(\d{4})$/);
    if (m) {
      const xa = scaleX(Math.max(AXIS_MIN, +m[1]));
      const xb = scaleX(Math.min(isLogScale ? LOG_MAX : AXIS_MAX_LIN, +m[2]));
      const x0 = Math.min(xa, xb);
      const xw = Math.abs(xb - xa);

      gHigh.append('rect')
        .attr('x', x0).attr('y', yMid - 3.5)
        .attr('width', xw).attr('height', 7)
        .attr('fill', color).attr('opacity', 0.22).attr('rx', 3);

      [xa, xb].forEach(xc => {
        gHigh.append('circle')
          .attr('cx', xc).attr('cy', yMid)
          .attr('r', 3.5).attr('fill', color).attr('opacity', 0.55);
      });
    }
  }

  // ── Endpoint markers ────────────────────────────────
  const ySub = d._above ? yMid + 30 : yMid - 18;
  const ySublbl = d._above ? yMid + 42 : yMid - 6;

  const pts = [
    {
      x:     x1,
      label: fmt(d.released),
      sub:   'released',
    },
    {
      x:     x2,
      label: yearLabel(d),
      sub:   'set in',
    },
  ];

  pts.forEach(({ x, label, sub }) => {
    gHigh.append('circle')
      .attr('cx', x).attr('cy', yMid)
      .attr('r', 5).attr('fill', color).attr('opacity', 0.95);

    gHigh.append('text')
      .attr('x', x).attr('y', ySub)
      .attr('text-anchor', 'middle')
      .attr('fill', color)
      .attr('font-size', '11px').attr('font-weight', '700')
      .attr('font-family', "'Segoe UI', system-ui, sans-serif")
      .text(label);

    gHigh.append('text')
      .attr('x', x).attr('y', ySublbl)
      .attr('text-anchor', 'middle')
      .attr('fill', color).attr('opacity', 0.55)
      .attr('font-size', '8.5px')
      .attr('font-family', "'Segoe UI', system-ui, sans-serif")
      .text(sub);
  });

  // ── Selection ring on release endpoint ──────────────
  if (isSelected) {
    gHigh.append('circle')
      .attr('cx', x1).attr('cy', yMid)
      .attr('r', 12).attr('fill', 'none')
      .attr('stroke', color).attr('stroke-width', 1.5)
      .attr('stroke-dasharray', '3 2').attr('opacity', 0.55);
  }
}

// ═══════════════════════════════════════════════════════════
//  INTERACTION — arc events
// ═══════════════════════════════════════════════════════════

function onHover(event, d) {
  // Ignore arcs that are filtered out
  if (!isArcActive(d)) return;

  hoveredId = d.record_id;

  // While another arc is selected: show mini-tooltip only
  if (selectedId !== null && selectedId !== d.record_id) {
    showMiniTooltip(event, d);
    return;
  }

  // Re-entering the already-selected arc: nothing to do
  if (selectedId === d.record_id) return;

  applyHighlight(d, false);
  drawOverlay(d, false);
  updateSidebar(d, getSiblings(d));
}

function onLeave() {
  hoveredId = null;
  scheduleHideTT();

  // If something is selected, keep the visual state intact
  if (selectedId !== null) return;

  applyCurrentFilter();
  gHigh.selectAll('*').remove();
  showEmptySidebar();
}

function onClick(event, d) {
  event.stopPropagation();
  if (!isArcActive(d)) return;

  if (selectedId === d.record_id) {
    // Clicking the selected arc again → deselect
    deselect();
  } else {
    selectedId = d.record_id;
    hoveredId  = d.record_id;
    hideMiniTooltip();
    applyHighlight(d, true);
    drawOverlay(d, true);
    updateSidebar(d, getSiblings(d));
  }
}

function deselect() {
  selectedId = null;
  hoveredId  = null;
  hideMiniTooltip();
  gHigh.selectAll('*').remove();
  applyCurrentFilter();
  showEmptySidebar();
}

// ═══════════════════════════════════════════════════════════
//  MINI TOOLTIP
// ═══════════════════════════════════════════════════════════

const getTT = () => document.getElementById('mini-tooltip');

function showMiniTooltip(event, d) {
  clearTimeout(_ttTimer);
  const el = getTT();
  el.innerHTML = `
    <div class="mtt-title">${d.title || '—'}</div>
    <div class="mtt-years">${fmt(d.released)} → ${yearLabel(d)}</div>
    ${d.medium ? `<div class="mtt-meta">${d.medium}</div>` : ''}
  `;
  el.style.display = 'block';
  positionMiniTooltip(event);
}

function positionMiniTooltip(event) {
  const el  = getTT();
  const x   = event.pageX + 14;
  const y   = event.pageY - 44;
  const maxX = window.innerWidth - el.offsetWidth - 20;
  el.style.left = Math.min(x, maxX) + 'px';
  el.style.top  = Math.max(y, 8)   + 'px';
}

function scheduleHideTT() {
  _ttTimer = setTimeout(hideMiniTooltip, 120);
}

function hideMiniTooltip() {
  getTT().style.display = 'none';
}

// ═══════════════════════════════════════════════════════════
//  SIDEBAR
// ═══════════════════════════════════════════════════════════

function updateSidebar(d, siblings) {
  document.getElementById('info-empty').style.display   = 'none';
  document.getElementById('info-content').style.display = 'flex';

  document.getElementById('info-title').textContent   = d.title   || '—';
  document.getElementById('info-creator').textContent = d.creator || '';

  // Badges
  const badgesEl = document.getElementById('info-badges');
  badgesEl.innerHTML = '';
  const medium = d.medium?.trim();
  const genre  = d.genre?.trim();
  if (medium) addBadge(badgesEl, medium, mColor(medium));
  if (genre && genre !== medium) addBadge(badgesEl, genre, '#8888aa');

  // Timeline card
  const color    = mColor(d.medium);
  const subLabel = 'set in';
  const periodHtml = d.multiyears?.trim()
    ? `<div class="tl-period">Full span: <strong>${d.multiyears}</strong></div>`
    : '';

  document.getElementById('info-timeline').innerHTML = `
    <div class="tl-year">${fmt(d.released)}<span>released</span></div>
    <div class="tl-arrow">↓ ${pluralYears(d.years_distant)} ahead</div>
    <div class="tl-year" style="color:${color}">${yearLabel(d)}<span>${subLabel}</span></div>
    ${periodHtml}
  `;

  // Notes
  const extraEl = document.getElementById('info-extra');
  extraEl.innerHTML = '';
  if (d.notes?.trim()) extraEl.appendChild(infoRow('Notes', d.notes));

  // Series section
  const seriesSec  = document.getElementById('info-series-section');
  const seriesLbl  = document.getElementById('info-series-label');
  const seriesList = document.getElementById('info-series-list');

  if (siblings.length > 0) {
    seriesSec.style.display = 'block';
    seriesLbl.textContent   = `Series · ${siblings.length + 1} works`;
    seriesList.innerHTML    = '';

    siblings.slice(0, 14).forEach(s => {
      const item = document.createElement('div');
      item.className = 'series-item';
      item.innerHTML = `
        <div class="series-item-title">${s.title}</div>
        <div class="series-item-years">${fmt(s.released)} → ${yearLabel(s)}</div>
      `;

      // Hover series item: temporarily highlight that sibling in the viz
      item.addEventListener('mouseenter', event => {
        clearTimeout(_ttTimer);
        if (selectedId !== null) {
          applyHighlight(s, false);
          drawOverlay(s, false);
          showMiniTooltip(event, s);
        }
      });
      item.addEventListener('mouseleave', () => {
        hideMiniTooltip();
        if (selectedId !== null) {
          // Restore the main selected arc
          const sel = allData.find(r => r.record_id === selectedId);
          if (sel) { applyHighlight(sel, true); drawOverlay(sel, true); }
        }
      });

      seriesList.appendChild(item);
    });

    if (siblings.length > 14) {
      const more = document.createElement('div');
      more.className   = 'series-item-more';
      more.textContent = `+ ${siblings.length - 14} more`;
      seriesList.appendChild(more);
    }

  } else {
    seriesSec.style.display = 'none';
  }

  // Predictions
  const predSec = document.getElementById('info-predictions-section');
  if (d.predictions?.trim()) {
    predSec.style.display = 'block';
    document.getElementById('info-predictions').textContent = d.predictions;
  } else {
    predSec.style.display = 'none';
  }

  // Wikipedia link
  const linksEl = document.getElementById('info-links');
  linksEl.innerHTML = '';
  if (d.wikipedia_pg?.trim()) {
    const row = document.createElement('div');
    row.className = 'info-row';
    row.innerHTML = `<div class="info-val"><a href="${d.wikipedia_pg}" target="_blank">View on Wikipedia ↗</a></div>`;
    linksEl.appendChild(row);
  }
}

function showEmptySidebar() {
  document.getElementById('info-empty').style.display   = '';
  document.getElementById('info-content').style.display = 'none';
}

function addBadge(parent, text, color) {
  const b = document.createElement('span');
  b.className             = 'info-badge';
  b.textContent           = text;
  b.style.borderColor     = color + '60';
  b.style.color           = color;
  b.style.backgroundColor = color + '18';
  parent.appendChild(b);
}

function infoRow(key, val) {
  const div = document.createElement('div');
  div.className = 'info-row';
  div.innerHTML = `<div class="info-key">${key}</div><div class="info-val">${val}</div>`;
  return div;
}
