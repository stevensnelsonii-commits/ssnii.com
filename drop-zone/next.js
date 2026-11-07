/* DROP ZONE — NEXT BUILD (staged at /next/, live map34 untouched).
 * Steve's Nov 3 playtest punch-list, rolled into one build:
 *  1. THE DROP IS A SCENARIO — a PLAYABLE CINEMATIC descent (camera on the
 *     falling squad; lightning strikes + crosswind gusts drawn from the
 *     tile's own weather — dodge them or eat a wound check at touchdown),
 *     then a TURN-BASED EXPLORATION phase on the ground (encounters.js:
 *     action points, fog, seeded encounters — TIPSTERS and BLACK-MARKET
 *     TRADERS among them — loot found by walking), closed by the balloon
 *     lift. The report is written from what the expedition actually did;
 *     core's resolveDrop is never the player path.
 *  2. SQUADS — click / shift-click / shift-drag-box multi-select, squad
 *     orders from one panel.
 *  3. DROP FLOW — selected squad + target = the drop happens. ZERO menus in
 *     the drop path. The one remaining menu (multi-occupant tile chooser)
 *     got the readability pass.
 *  4. ONE WINDOW — #dz-panel holds every control. The stage is display only.
 *  5. CAMERA — classic RTS: arrow keys, first-class edge pan, drag to move,
 *     wheel/pinch/button zoom. Touchpad-first: no order requires right-click.
 *     F focuses the selection (single = close zoom, squad = framed); wheel
 *     and pinch zoom anchor on the selected object when there is one, and
 *     on the cursor when there is not. (Steve, mid-playtest.)
 *  6. FACES — procedural portrait thumbnails + a lightweight creator step
 *     (name + look variant + traits), the hook for Prime's creator.
 *  7. SPECTACLE — one world weather system (weather.js) drives the map's
 *     storms, rain, ship ride, panel readouts AND the descent drift.
 * Presentation law stands: 3/4 tilted plane, models on the ground plane.
 */
(function () {
  'use strict';
  var C = window.DropZoneCore;
  var E = window.DropZoneEncounters;
  var W = window.DropZoneWeather;
  var P = window.DropZonePortraits;
  var T = C.TUNABLES;

  var qs = new URLSearchParams(location.search);
  var seed = qs.get('seed') || 'dropzone-next-1';
  var state = C.createGame(seed);
  var weather = W.createWeather(seed);

  var stage = document.getElementById('dz-stage');
  var viewport = document.getElementById('dz-viewport');
  var plane = document.getElementById('dz-plane');
  var panel = document.getElementById('dz-panel');
  var menuEl = document.getElementById('dz-menu');
  var boxEl = document.getElementById('dz-box');
  var scenEl = document.getElementById('dz-scen');
  var scenCanvas = document.getElementById('dz-scen-canvas');
  var scenCtx = scenCanvas.getContext('2d');
  var scenCaption = document.getElementById('dz-scen-caption');
  var flashEl = document.getElementById('dz-flash');
  var minimap = document.getElementById('dz-minimap');
  var mmCtx = minimap.getContext('2d');

  /* ---------------- state: selection, camera, looks ---------------- */
  var sel = { tile: null, ship: false, squad: [], primary: null };
  var cam = { zoom: 1, tZoom: 1, panX: 0, tPanX: 0, panY: 0, tPanY: 0 };
  var looks = {};
  try { looks = JSON.parse(localStorage.getItem('dz-next-looks') || '{}'); } catch (e) { looks = {}; }
  var reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var dropArmed = false;
  var lastReport = null;
  var lastLanding = null;
  var pings = []; // {x,y,at}
  var keysDown = {};
  var mouseStage = null; // {x,y} stage-relative
  var edgePanOn = true;

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function $(id) { return document.getElementById(id); }
  function diverById(id) { return state.divers.find(function (d) { return d.id === id; }) || null; }
  function tileLabel(x, y) { return C.tileLabel ? C.tileLabel(x, y) : (String.fromCharCode(65 + x) + (y + 1)); }
  function variantOf(d) { return looks[d.id] || 0; }

  var logEl = $('dz-log');
  function log(msg, cls) {
    var li = document.createElement('li');
    if (cls) li.className = cls;
    li.textContent = msg;
    logEl.appendChild(li);
    while (logEl.children.length > 60) logEl.removeChild(logEl.firstChild);
    logEl.scrollTop = logEl.scrollHeight;
  }
  function feedback(msg, isError) { log(msg, isError ? 'err' : ''); }
  function feedbackGood(msg) { log(msg, 'good'); }

  /* ---------------- clouds (lab sky work, DOM layer) ---------------- */
  function buildClouds() {
    document.querySelectorAll('[data-cloud-layer]').forEach(function (layer) {
      var front = layer.getAttribute('data-cloud-layer') === 'front';
      layer.textContent = '';
      for (var i = 0; i < (front ? 5 : 8); i++) {
        var c = document.createElement('span');
        var wisp = i % 3 === 2;
        c.className = 'dz-cloud' + (wisp ? ' dz-cloud-wisp' : '');
        var wdt = (wisp ? 150 : 240) + ((i * 53) % 190);
        c.style.width = wdt + 'px';
        c.style.left = ((i * 29 + (front ? 9 : 3)) % 88) + '%';
        c.style.top = (front ? 58 + (i * 11) % 34 : 2 + (i * 13) % 62) + '%';
        c.style.setProperty('--cloud-duration', (48 + (i * 7) % 50) + 's');
        c.style.setProperty('--cloud-delay', (-i * 6) + 's');
        layer.appendChild(c);
      }
    });
  }

  /* ---------------- map rendering (adapted from map34) ---------------- */
  var shipSVG = '<svg width="118" height="76" viewBox="0 0 118 76" aria-hidden="true">' +
    '<ellipse cx="59" cy="40" rx="49" ry="17" fill="#5a4632" stroke="#2b2118" stroke-width="2.5"/>' +
    '<path d="M18 40 Q59 17 100 40 Q59 52 18 40Z" fill="#8a6f47"/>' +
    '<path d="M31 30 L45 10 L56 28Z" fill="#7a5f3a" stroke="#2b2118" stroke-width="1.6"/>' +
    '<path d="M87 30 L73 10 L62 28Z" fill="#7a5f3a" stroke="#2b2118" stroke-width="1.6"/>' +
    '<rect x="47" y="27" width="24" height="13" rx="4" fill="#d8b84a" stroke="#2b2118" stroke-width="2"/>' +
    '<circle cx="59" cy="33" r="3.4" fill="#1d2a33"/><path d="M20 42 L5 55 M98 42 L113 55" stroke="#2b2118" stroke-width="2.4"/>' +
    '<circle cx="12" cy="59" r="4" fill="#bf4e4e" stroke="#2b2118"/><circle cx="106" cy="59" r="4" fill="#bf4e4e" stroke="#2b2118"/></svg>';

  var tileEls = [], probeEls = {}, stormEls = {}, shipEl = null, tileState = [];
  var diverAnchorEls = {};

  function objectModel(kind, glyph, label) {
    return '<span class="object-anchor"><span class="contact-shadow"></span>' +
      '<span class="object-model object-model-' + kind + '"><span class="object-glyph">' + glyph + '</span>' +
      (label ? '<span class="object-label">' + label + '</span>' : '') + '</span></span>';
  }
  function tileVisual(tile) {
    if (!tile.discovered) return { cls: 'fog', shade: 0.78, object: '' };
    var shade = clamp(tile.y / (T.gridH * 1.7), 0.1, 0.68);
    if (tile.isColony) return { cls: 'ruin', shade: shade, object: objectModel('colony', '⌂', 'COLONY') };
    if (tile.isGreenZone) return { cls: 'open', shade: shade * 0.7, object: objectModel('green', '✦', 'GREEN ZONE') };
    if (tile.terrain === 'water') return { cls: 'water', shade: shade, object: '' };
    if (tile.supplySite && !tile.supplySite.looted) return { cls: 'ruin', shade: shade, object: objectModel('supply', '▣', 'SUPPLY CACHE') };
    if (tile.robotSite && !tile.robotSite.cleared) return { cls: 'ruin', shade: shade, object: objectModel('robot', '▦', 'ROBOT RUIN') };
    if (tile.isInterdiction) return { cls: 'rough', shade: shade, object: objectModel('hostile', '✖', 'INTERDICTION') };
    if (tile.resourceType && ((tile.reconTier || 0) >= 1 || tile.threat === 0)) return { cls: tile.terrain, shade: shade, object: objectModel('resource', tile.resourceType === 'FUEL' ? '⛽' : tile.resourceType === 'FOOD' ? '♨' : '⬢', tile.resourceType) };
    if (tile.threat >= 3 && (tile.reconTier || 0) >= 1) return { cls: tile.terrain, shade: shade, object: objectModel('threat', '!', 'THREAT ' + tile.threat) };
    return { cls: tile.terrain, shade: shade, object: '' };
  }
  function diversAtShip() {
    return C.livingDivers(state).filter(function (d) { return d.status === 'ready'; });
  }
  // Visual staging offsets for divers waiting at the airship (presentation
  // only; core has no diver positions).
  function stagedDivers() {
    var around = [[-1, 0], [1, 0], [0, 1], [-1, 1], [1, 1], [0, -1], [-1, -1], [1, -1], [-2, 0], [2, 0], [0, 2], [-2, 1]];
    return diversAtShip().map(function (d, i) {
      var o = around[i % around.length];
      return { diver: d, x: clamp(state.airship.x + o[0], 0, T.gridW - 1), y: clamp(state.airship.y + o[1], 0, T.gridH - 1), home: o[0] === 0 && o[1] === 0 };
    });
  }
  function diversOnTile(x, y) {
    var out = [];
    if (x === state.airship.x && y === state.airship.y) out = out.concat(diversAtShip());
    stagedDivers().forEach(function (s) { if (s.x === x && s.y === y && out.indexOf(s.diver) < 0) out.push(s.diver); });
    return out;
  }

  function buildPlane() {
    plane.textContent = '';
    tileEls = []; tileState = []; probeEls = {}; diverAnchorEls = {};
    for (var y = 0; y < T.gridH; y++) {
      tileEls.push([]); tileState.push([]);
      for (var x = 0; x < T.gridW; x++) {
        var tile = C.tileAt(state, x, y);
        var el = document.createElement('div');
        el.dataset.x = x; el.dataset.y = y;
        el.setAttribute('role', 'img');
        el.setAttribute('aria-label', tileLabel(x, y) + ', ' + (tile.discovered ? tile.terrain : 'unknown'));
        plane.appendChild(el);
        tileEls[y].push(el); tileState[y].push('');
      }
    }
    [[0, 0, 'nw'], [T.gridW - 1, 0, 'ne'], [0, T.gridH - 1, 'sw'], [T.gridW - 1, T.gridH - 1, 'se']].forEach(function (p) {
      var probe = document.createElement('span');
      probe.className = 'pick-probe';
      probe.style.left = (p[0] === 0 ? '0%' : '100%');
      probe.style.top = (p[1] === 0 ? '0%' : '100%');
      tileEls[p[1]][p[0]].appendChild(probe);
      probeEls[p[2]] = probe;
    });
    stormEls = {};
    weather.cells.forEach(function (c) {
      var w = document.createElement('div');
      w.className = 'storm-cell';
      w.innerHTML = '<div class="storm-footprint"></div><div class="storm-rain"></div>' +
        '<div class="storm-label">' + (c.kind === 'storm' ? 'STORM' : 'SQUALL') + ' · ' + Math.round(c.intensity * 100) + '%</div>';
      tileEls[0][0].appendChild(w);
      stormEls[c.id] = w;
    });
    shipEl = document.createElement('div');
    shipEl.className = 'dz-ship';
    shipEl.innerHTML = '<span class="contact-shadow ship-shadow"></span><div class="ship-model">' + shipSVG +
      '<span class="object-label">AIRSHIP · FUEL <b data-ship-fuel></b></span></div>';
    tileEls[0][0].appendChild(shipEl);
    tileState = tileState.map(function (row) { return row.map(function () { return ''; }); });
    renderSector(true);
  }

  function renderSector(force) {
    for (var y = 0; y < T.gridH; y++) for (var x = 0; x < T.gridW; x++) {
      var tile = C.tileAt(state, x, y);
      var v = tileVisual(tile);
      var key = v.cls + '|' + v.object + '|' + tile.discovered + '|' + tile.reconTier;
      var el = tileEls[y][x];
      if (force || tileState[y][x] !== key) {
        tileState[y][x] = key;
        el.className = 'plane-tile ' + v.cls;
        el.style.setProperty('--depth', v.shade.toFixed(2));
        el.innerHTML = '<span class="depth-shade"></span>' + v.object;
        el.title = tileLabel(x, y) + ' — ' + (tile.discovered ? tile.terrain : 'unknown');
        if (x === 0 && y === 0) { /* storm/ship/probes re-attach below */ }
      }
      el.classList.toggle('tile-selected', !!(sel.tile && sel.tile.x === x && sel.tile.y === y));
    }
    // Re-attach persistent overlays into tile (0,0)'s stacking context.
    var host = tileEls[0][0];
    weather.cells.forEach(function (c) { if (stormEls[c.id].parentNode !== host) host.appendChild(stormEls[c.id]); });
    if (shipEl.parentNode !== host) host.appendChild(shipEl);
    Object.keys(probeEls).forEach(function (k) {
      var p = probeEls[k];
      var corner = { nw: [0, 0], ne: [T.gridW - 1, 0], sw: [0, T.gridH - 1], se: [T.gridW - 1, T.gridH - 1] }[k];
      if (p.parentNode !== tileEls[corner[1]][corner[0]]) tileEls[corner[1]][corner[0]].appendChild(p);
    });
    // Divers staged around the ship (portrait glyphs — the FACES hook).
    Object.keys(diverAnchorEls).forEach(function (id) {
      var a = diverAnchorEls[id];
      if (a.parentNode) a.parentNode.removeChild(a);
    });
    diverAnchorEls = {};
    stagedDivers().forEach(function (s) {
      var a = document.createElement('span');
      a.className = 'object-anchor diver-anchor';
      a.innerHTML = '<span class="contact-shadow"></span><span class="object-model object-model-diver">' +
        '<span class="object-glyph"><img alt="" src="' + P.url(s.diver, variantOf(s.diver)) + '"></span>' +
        '<span class="object-label">' + s.diver.name.split(' ')[0].toUpperCase() + '</span></span>';
      if (sel.squad.indexOf(s.diver.id) >= 0) a.classList.add('unit-selected');
      tileEls[s.y][s.x].appendChild(a);
      diverAnchorEls[s.diver.id] = a;
    });
    positionOverlays();
  }

  function tileAnchorPoint(tx, ty) {
    var tileW = 100 / T.gridW, tileH = 100 / T.gridH;
    return { leftPct: (tx + 0.5) * tileW, topPct: (ty + 0.5) * tileH, wPct: tileW, hPct: tileH };
  }
  function positionOverlays() {
    weather.cells.forEach(function (c) {
      var el = stormEls[c.id]; if (!el) return;
      var p = tileAnchorPoint(c.position.x, c.position.y);
      var d = (c.radius * 2) * p.wPct;
      el.style.left = p.leftPct + '%'; el.style.top = p.topPct + '%';
      el.style.width = d + '%'; el.style.height = (d * 0.82) + '%';
    });
    if (shipEl) {
      var sp = tileAnchorPoint(state.airship.x, state.airship.y);
      shipEl.style.left = sp.leftPct + '%'; shipEl.style.top = sp.topPct + '%';
      var f = shipEl.querySelector('[data-ship-fuel]');
      if (f) f.textContent = state.airship.fuel;
      shipEl.classList.toggle('ship-selected', !!sel.ship);
      var smp = W.sampleWeather(weather, state.airship.x, state.airship.y);
      shipEl.classList.toggle('in-storm', smp.storm > 0.3);
      shipEl.style.setProperty('--ship-rock', (Math.sin(performance.now() / 900) * (1 + smp.turbulence * 5)).toFixed(2) + 'deg');
    }
  }

  /* ---------------- picking: homography (from map34, forgiving) ------- */
  function solveHomography(src, dst) {
    var A = [], b = [];
    for (var i = 0; i < 4; i++) {
      var x = src[i][0], y = src[i][1], X = dst[i][0], Y = dst[i][1];
      A.push([x, y, 1, 0, 0, 0, -X * x, -X * y]); b.push(X);
      A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y]); b.push(Y);
    }
    var n = 8;
    for (var col = 0; col < n; col++) {
      var piv = col;
      for (var r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
      if (Math.abs(A[piv][col]) < 1e-12) return null;
      var tmp = A[col]; A[col] = A[piv]; A[piv] = tmp;
      var tb = b[col]; b[col] = b[piv]; b[piv] = tb;
      for (var r2 = 0; r2 < n; r2++) {
        if (r2 === col) continue;
        var f = A[r2][col] / A[col][col];
        if (!f) continue;
        for (var c2 = col; c2 < n; c2++) A[r2][c2] -= f * A[col][c2];
        b[r2] -= f * b[col];
      }
    }
    var h = [];
    for (var i2 = 0; i2 < n; i2++) h.push(b[i2] / A[i2][i2]);
    return h;
  }
  function planePointFromScreen(clientX, clientY) {
    var sr = stage.getBoundingClientRect();
    function rel(el) { var r = el.getBoundingClientRect(); return [r.left + r.width / 2 - sr.left, r.top + r.height / 2 - sr.top]; }
    var dst = [rel(probeEls.nw), rel(probeEls.ne), rel(probeEls.sw), rel(probeEls.se)];
    var src = [[0, 0], [T.gridW, 0], [0, T.gridH], [T.gridW, T.gridH]];
    // Picking needs screen -> plane, i.e. the INVERSE of the render mapping:
    // solve with screen points as the source and grid corners as destination.
    var h = solveHomography(dst, src);
    if (!h) return null;
    var px = clientX - sr.left, py = clientY - sr.top;
    var den = h[6] * px + h[7] * py + 1;
    if (!den) return null;
    return { fx: (h[0] * px + h[1] * py + h[2]) / den, fy: (h[3] * px + h[4] * py + h[5]) / den };
  }
  function pickTile(clientX, clientY) {
    // Forgiving pad tolerance: a diver marker near the tap wins over the tile.
    var bestDiver = null, bestDist = 30;
    Object.keys(diverAnchorEls).forEach(function (id) {
      var r = diverAnchorEls[id].getBoundingClientRect();
      var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      var d = Math.hypot(clientX - cx, clientY - cy);
      if (d < bestDist) { bestDist = d; bestDiver = diverById(id); }
    });
    if (bestDiver) {
      var st = stagedDivers().find(function (s) { return s.diver.id === bestDiver.id; });
      return { x: st.x, y: st.y, diver: bestDiver };
    }
    var p = planePointFromScreen(clientX, clientY);
    if (p) {
      var fx = p.fx, fy = p.fy;
      // Snap tolerance: accept taps slightly outside the plane edge.
      if (fx >= -0.75 && fx < T.gridW + 0.75 && fy >= -0.75 && fy < T.gridH + 0.75) {
        return { x: clamp(Math.floor(fx), 0, T.gridW - 1), y: clamp(Math.floor(fy), 0, T.gridH - 1), diver: null };
      }
      // Out of the plane's quad: fall through to the element fallback below.
    }
    var el = document.elementFromPoint(clientX, clientY);
    var t = el && el.closest ? el.closest('.plane-tile') : null;
    if (t) return { x: +t.dataset.x, y: +t.dataset.y, diver: null };
    return null;
  }
  function ping(x, y) {
    var el = tileEls[y][x];
    var ring = document.createElement('span');
    ring.className = 'ping-ring';
    el.appendChild(ring);
    setTimeout(function () { ring.remove(); }, 1700);
    pings.push({ x: x, y: y, at: Date.now() });
  }

  /* ---------------- panel: status / weather / roster / orders -------- */
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }

  function renderStatus() {
    var alive = C.livingDivers(state).length;
    var chips = [
      ['TURN', state.turn],
      ['SCRAP', state.resources.SCRAP], ['FUEL', state.resources.FUEL],
      ['FOOD', state.resources.FOOD], ['INTEL', state.resources.INTEL],
      ['SHIP FUEL', state.airship.fuel + '/' + state.airship.maxFuel],
      ['CARGO', C.cargoUsed(state) + '/' + state.airship.cargoCapacity],
      ['CREW', alive + '/' + state.divers.length],
      ['DROPS', state.totalDrops]
    ];
    $('dz-status').innerHTML = chips.map(function (c) {
      return '<span class="dz-chip">' + c[0] + ' <b>' + c[1] + '</b></span>';
    }).join('') +
      (C.isGrounded(state) ? '<span class="dz-chip warn">⚠ AIRSHIP GROUNDED — refuel her</span>' : '') +
      (state.settlement ? '<span class="dz-chip">SETTLEMENT <b>TIER ' + state.settlement.tier + ' · POP ' + state.settlement.population + '</b></span>' : '') +
      (state.gameStatus !== 'playing' ? '<span class="dz-chip warn">🏁 ' + state.gameStatus.toUpperCase() + (state.endReason ? ' — ' + esc(state.endReason) : '') + '</span>' : '');
    var smp = W.sampleWeather(weather, state.airship.x, state.airship.y);
    $('dz-ship-line').textContent = 'Airship at ' + tileLabel(state.airship.x, state.airship.y) +
      (smp.storm > 0.05 ? ' · riding in ' + Math.round(smp.storm * 100) + '% storm (turbulence ' + Math.round(smp.turbulence * 100) + '%)' : ' · clear air overhead');
  }

  function renderWeather() {
    var rows = weather.cells.map(function (c) {
      return '<div><b>' + (c.kind === 'storm' ? '⛈ Storm cell' : '🌦 Squall') + ' ' + c.id + '</b> — over ' +
        tileLabel(clamp(Math.round(c.position.x), 0, 23), clamp(Math.round(c.position.y), 0, 23)) +
        ', intensity ' + Math.round(c.intensity * 100) + '%, wind → ' + c.windVector.x.toFixed(1) + ', ' + c.windVector.y.toFixed(1) + '</div>';
    }).join('');
    var focus = sel.tile || { x: state.airship.x, y: state.airship.y };
    var s = W.sampleWeather(weather, focus.x, focus.y);
    $('dz-weather').innerHTML = rows +
      '<div class="dz-note">At ' + tileLabel(focus.x, focus.y) + ': wind ' + s.wind.x.toFixed(2) + ', ' + s.wind.y.toFixed(2) +
      ' · storm ' + Math.round(s.storm * 100) + '% · cloud ' + Math.round(s.cloud * 100) + '% · visibility ' + Math.round(s.visibility * 100) +
      '% · gusts ' + (weather.gust >= 0 ? '+' : '') + weather.gust.toFixed(2) + '. The descent steers through this same sample.</div>';
  }

  function statusText(d) {
    if (d.status === 'dead') return '☠ dead';
    if (d.status === 'wounded') return 'wounded · ' + d.wounds + ' wound(s) — rest heals';
    if (d.status === 'dropped') return 'on the ground — back aboard next turn';
    if (d.status === 'ready') return 'ready aboard the airship';
    return d.status;
  }
  function renderRoster() {
    var roster = $('dz-roster');
    roster.innerHTML = '';
    state.divers.forEach(function (d) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dz-diver' + (sel.squad.indexOf(d.id) >= 0 ? ' in-squad' : '') + (d.status === 'dead' ? ' dead' : '');
      btn.disabled = d.status === 'dead';
      btn.dataset.diverId = d.id;
      btn.innerHTML = '<img class="thumb" alt="Portrait of ' + esc(d.name) + '" src="' + P.url(d, variantOf(d)) + '">' +
        '<span class="who"><span class="nm">' + esc(d.name) + '</span><br>' +
        '<span class="st">Lv ' + d.level + ' · ' + statusText(d) + '<br>G<b>' + d.stats.GRIT + '</b> A<b>' + d.stats.AIM + '</b> N<b>' + d.stats.NERVE + '</b> H<b>' + d.stats.HAUL + '</b>' +
        (d.traits.length ? ' · ' + d.traits.join(', ') : '') + '</span></span>';
      btn.addEventListener('click', function (ev) { selectDiver(d.id, ev.shiftKey); });
      roster.appendChild(btn);
    });
    var ids = sel.squad;
    var summary = 'No squad selected — click divers (shift-click adds).';
    if (ids.length) {
      var names = ids.map(function (id) { var d = diverById(id); return d ? d.name.split(' ')[0] : '?'; }).join(', ');
      var objs = ids.map(diverById).filter(Boolean);
      summary = 'Squad of ' + ids.length + ': ' + names + ' · squad score ' + (objs.length ? C.squadScore(state, objs).toFixed(1) : '—') +
        ' · drop cost ' + T.dropFuelCost + ' ship fuel. Right-click a tile to drop them NOW, or use Orders.';
    }
    $('dz-squad-summary').textContent = summary;
  }

  function renderCreator() {
    var host = $('dz-creator');
    var d = (sel.primary && diverById(sel.primary)) || (sel.squad.length && diverById(sel.squad[0])) || C.livingDivers(state)[0];
    if (!d) { host.innerHTML = '<p class="dz-note">No living divers.</p>'; return; }
    host.innerHTML =
      '<img class="big" alt="Portrait of ' + esc(d.name) + '" src="' + P.url(d, variantOf(d)) + '">' +
      '<div class="fields"><b>' + esc(d.name) + '</b> · ' + esc(d.origin || 'the fleet') + '<br>' +
      '<span class="st">Lv ' + d.level + ' · ' + d.xp + ' xp · ' + d.dropsSurvived + ' drops survived · ' + statusText(d) + '</span><br>' +
      d.traits.map(function (t) { return '<span class="trait-chip">' + t + '</span>'; }).join('') +
      '<span class="st">GRIT ' + d.stats.GRIT + ' · AIM ' + d.stats.AIM + ' · NERVE ' + d.stats.NERVE + ' · HAUL ' + d.stats.HAUL + '</span>' +
      '<div class="row"><input type="text" id="dz-rename" value="' + esc(d.name) + '" maxlength="24" aria-label="Diver name">' +
      '<button type="button" id="dz-btn-rename">Rename</button></div>' +
      '<div class="row"><button type="button" id="dz-btn-look">New look ▸</button>' +
      '<button type="button" id="dz-btn-focus">Select diver</button></div></div>';
    $('dz-btn-rename').addEventListener('click', function () {
      var v = $('dz-rename').value.trim();
      if (!v) { feedback('Name cannot be empty.', true); return; }
      var r = C.renameDiver(state, d.id, v);
      if (r.ok) { feedbackGood(d.name + ' is now on the roster.'); renderAll(); }
      else feedback(r.reason || 'Rename refused.', true);
    });
    $('dz-btn-look').addEventListener('click', function () {
      looks[d.id] = (variantOf(d) + 1) % 6;
      try { localStorage.setItem('dz-next-looks', JSON.stringify(looks)); } catch (e) {}
      feedback(d.name + ' tries a new look (variant ' + looks[d.id] + ').');
      renderAll();
    });
    $('dz-btn-focus').addEventListener('click', function () { selectDiver(d.id, false); });
  }

  function orderAvailability() {
    var tile = sel.tile ? C.tileAt(state, sel.tile.x, sel.tile.y) : null;
    var shipTile = sel.tile && sel.tile.x === state.airship.x && sel.tile.y === state.airship.y;
    var avail = {};
    avail.drop = { ok: sel.squad.length > 0 && !scen.active, why: !sel.squad.length ? 'Select a squad first.' : '' };
    avail.move = { ok: !!sel.ship && !!tile && !shipTile, why: !sel.ship ? 'Select the airship first.' : (!tile ? 'Pick a destination tile.' : 'That is the airship tile.') };
    var nextTier = tile ? (tile.reconTier || 0) + 1 : 0;
    var reconCost = (tile && nextTier <= 3) ? T.reconCosts[nextTier] : null;
    var anyAvailable = state.divers.some(function (d) { return C.diverAvailable(state, d); });
    avail.recon = {
      ok: !!tile && nextTier <= 3 && !!reconCost && C.canAfford(state, reconCost) && (nextTier < 3 || anyAvailable),
      why: !tile ? 'Select a tile.' : (nextTier > 3 ? 'Fully reconned.' : (!C.canAfford(state, reconCost) ? 'Needs ' + JSON.stringify(reconCost) + '.' : (nextTier >= 3 && !anyAvailable ? 'Tier 3 needs an available diver to sit out.' : '')))
    };
    var green = state.greenZone ? C.tileAt(state, state.greenZone.x, state.greenZone.y) : null;
    var canFound = !state.settlement && green && green.discovered && C.canAfford(state, T.foundCost);
    avail.found = {
      ok: !!canFound,
      why: state.settlement ? 'A settlement already stands.' : (!green || !green.discovered ? 'The green zone has not been discovered yet.' : 'Founding costs ' + JSON.stringify(T.foundCost) + '.')
    };
    avail.refuel = { ok: state.resources.FUEL > 0 && state.airship.fuel < state.airship.maxFuel, why: state.airship.fuel >= state.airship.maxFuel ? 'Tanks are full.' : 'No FUEL in stores.' };
    return { avail: avail, tile: tile, shipTile: shipTile, reconCost: reconCost, nextTier: nextTier, green: green };
  }

  function renderOrders() {
    var o = orderAvailability();
    var tile = o.tile;
    var info = $('dz-target-info');
    if (sel.ship) {
      info.innerHTML = '<b>Airship selected</b> — fuel ' + state.airship.fuel + '/' + state.airship.maxFuel + ' at ' + tileLabel(state.airship.x, state.airship.y) +
        '.<br><span class="dz-note">Right-click a tile to fly there, or select a tile and use “Move airship here”.</span>';
    } else if (tile) {
      var t = tile;
      var threat = C.knownThreat(state, t);
      var rows = [['Position', tileLabel(t.x, t.y)], ['Terrain', t.discovered ? t.terrain : 'unknown']];
      if (t.discovered) {
        rows.push(['Threat', threat === null ? 'unknown' : threat]);
        rows.push(['Wind', t.windX + ', ' + t.windY]);
        rows.push(['Recon', 'tier ' + (t.reconTier || 0)]);
        if (t.resourceType) rows.push(['Resource', t.resourceType + ' ×' + t.resourceYield]);
        if (t.supplySite) rows.push(['Site', 'supply cache — ' + t.supplySite.name + (t.supplySite.looted ? ' (looted)' : ' · ~' + t.supplySite.amount + ' ' + t.supplySite.resource)]);
        if (t.robotSite) rows.push(['Site', 'robot ruin — ' + t.robotSite.name + (t.robotSite.cleared ? ' (cleared)' : '')]);
        if (t.isGreenZone) rows.push(['Zone', 'green — settlement candidate']);
        if (t.isColony) rows.push(['Zone', 'standing colony']);
        if (t.isInterdiction) rows.push(['Warning', 'interdiction point — high threat']);
      }
      var band = sel.squad.length ? C.projectedBand(state, sel.squad, t.x, t.y, t.reconTier || 0) : null;
      info.innerHTML = '<dl>' + rows.map(function (r) { return '<dt>' + r[0] + '</dt><dd>' + esc(r[1]) + '</dd>'; }).join('') + '</dl>' +
        (band ? '<div>Outlook for this squad: <b>' + band.word + '</b> (expected outcome ~' + band.expected + ') <span class="dz-note">— the scenario decides the rest</span></div>' : '');
    } else if (sel.squad.length) {
      info.innerHTML = '<b>Squad ready.</b> Pick a target tile — or right-click one to drop immediately.';
    } else {
      info.innerHTML = '<span class="dz-note">Click a diver to start a squad, the airship tile to select the ship, any tile to inspect it.</span>';
    }
    var bd = $('dz-btn-drop');
    bd.disabled = !o.avail.drop.ok;
    bd.textContent = sel.squad.length
      ? (sel.tile ? '▶ Drop squad (' + sel.squad.length + ') at ' + tileLabel(sel.tile.x, sel.tile.y) : '▶ Drop squad (' + sel.squad.length + ') — pick target')
      : '▶ Drop squad';
    bd.title = o.avail.drop.why || '';
    var bm = $('dz-btn-move');
    bm.disabled = !o.avail.move.ok; bm.title = o.avail.move.why || '';
    if (o.avail.move.ok) {
      var mv = C.quoteMove ? null : null;
      bm.textContent = 'Move airship to ' + tileLabel(sel.tile.x, sel.tile.y);
    } else bm.textContent = 'Move airship here';
    var br = $('dz-btn-recon');
    br.disabled = !o.avail.recon.ok; br.title = o.avail.recon.why || '';
    br.textContent = tile && o.reconCost ? 'Buy recon → tier ' + o.nextTier + ' (' + JSON.stringify(o.reconCost) + ')' : 'Buy recon';
    var bf = $('dz-btn-found');
    bf.disabled = !o.avail.found.ok; bf.title = o.avail.found.why || '';
    bf.textContent = state.greenZone ? 'Found settlement at ' + tileLabel(state.greenZone.x, state.greenZone.y) : 'Found settlement';
    $('dz-btn-refuel').disabled = !o.avail.refuel.ok;
    $('dz-btn-refuel').title = o.avail.refuel.why || '';
    $('dz-btn-endturn').disabled = !!scen.active;
    $('dz-squad-all').disabled = !!scen.active;
    $('dz-squad-clear').disabled = !!scen.active || !sel.squad.length;
  }

  function renderReport() {
    var host = $('dz-report');
    if (!lastReport) { host.innerHTML = '<p class="dz-note">No drops yet this game.</p>'; return; }
    var r = lastReport;
    var yieldTxt = Object.keys(r.yield || {}).filter(function (k) { return r.yield[k] > 0; }).map(function (k) { return k + ' +' + r.yield[k]; }).join(', ') || 'nothing hauled';
    host.innerHTML = '<div class="band" style="color:' + (r.band === 'Flawless' || r.band === 'Success' ? '#b7e3ae' : (String(r.band).indexOf('Costly') === 0 ? '#daca47' : '#ff9d94')) + '">' +
      esc(r.band.toUpperCase()) + ' — ' + esc(r.outcome) + '</div>' +
      '<div>Yield delivered: <b>' + yieldTxt + '</b>' +
      (r.ascent && r.ascent.trimmed && Object.keys(r.ascent.trimmed).length ? ' · balloons lost ' + Object.keys(r.ascent.trimmed).map(function (k) { return k + ' ' + r.ascent.trimmed[k]; }).join(', ') + ' to a snag' : '') + '</div>' +
      (lastLanding ? '<div class="dz-note">Landing: ' + lastLanding.reasons.join(' ') + '</div>' : '') +
      '<ul>' + (r.lines || []).map(function (l) { return '<li>' + esc(l) + '</li>'; }).join('') + '</ul>';
  }

  function drawMinimap() {
    var s = minimap.width / T.gridW;
    mmCtx.clearRect(0, 0, minimap.width, minimap.height);
    for (var y = 0; y < T.gridH; y++) for (var x = 0; x < T.gridW; x++) {
      var t = C.tileAt(state, x, y);
      mmCtx.fillStyle = !t.discovered ? '#232a33' : t.terrain === 'water' ? '#2f5676' : t.terrain === 'rough' ? '#8a7648' : t.terrain === 'ruin' ? '#786d60' : '#7d9a52';
      if (t.isGreenZone && t.discovered) mmCtx.fillStyle = '#79c96f';
      if (t.isColony) mmCtx.fillStyle = '#daca47';
      mmCtx.fillRect(x * s, y * s, s - 0.5, s - 0.5);
    }
    weather.cells.forEach(function (c) {
      var g = mmCtx.createRadialGradient(c.position.x * s, c.position.y * s, 2, c.position.x * s, c.position.y * s, c.radius * s);
      g.addColorStop(0, 'rgba(191,78,78,0.55)'); g.addColorStop(1, 'rgba(191,78,78,0)');
      mmCtx.fillStyle = g;
      mmCtx.beginPath(); mmCtx.arc(c.position.x * s, c.position.y * s, c.radius * s, 0, Math.PI * 2); mmCtx.fill();
    });
    mmCtx.fillStyle = '#daca47';
    mmCtx.beginPath(); mmCtx.arc((state.airship.x + 0.5) * s, (state.airship.y + 0.5) * s, 4, 0, Math.PI * 2); mmCtx.fill();
    if (sel.tile) {
      mmCtx.strokeStyle = '#ffffff'; mmCtx.lineWidth = 1.6;
      mmCtx.strokeRect(sel.tile.x * s + 0.5, sel.tile.y * s + 0.5, s - 1, s - 1);
    }
  }

  function renderPanel() { renderStatus(); renderWeather(); renderRoster(); renderOrders(); renderCreator(); renderReport(); }
  function renderAll() { renderSector(false); renderPanel(); drawMinimap(); }

  /* ---------------- selection ---------------- */
  function selectDiver(id, additive) {
    var d = diverById(id);
    if (!d || d.status === 'dead' || scen.active) return;
    if (additive) {
      var i = sel.squad.indexOf(id);
      if (i >= 0) sel.squad.splice(i, 1); else sel.squad.push(id);
    } else sel.squad = [id];
    sel.primary = id;
    if (sel.squad.length) { sel.ship = false; dropArmed = false; }
    hideMenu();
    renderSector(false); renderPanel();
  }
  function selectShip() { sel.ship = true; sel.squad = []; sel.primary = null; dropArmed = false; hideMenu(); renderSector(false); renderPanel(); }
  function selectTile(x, y) { sel.tile = { x: x, y: y }; renderSector(false); renderPanel(); }
  function clearSelection() { sel.tile = null; sel.ship = false; sel.squad = []; sel.primary = null; dropArmed = false; hideMenu(); renderSector(false); renderPanel(); }

  /* ---------------- orders (immediate execution) ---------------- */
  function doMove(x, y) {
    var r = C.moveAirship(state, x, y);
    if (r.ok) feedbackGood('Airship underway to ' + tileLabel(x, y) + ' — ' + r.distance + ' tiles, ' + r.cost + ' fuel.');
    else feedback(r.reason || 'Move refused.', true);
    renderAll();
  }
  function doRecon() {
    if (!sel.tile) return;
    var tile = C.tileAt(state, sel.tile.x, sel.tile.y);
    var nextTier = (tile.reconTier || 0) + 1;
    var sitter = null;
    if (nextTier >= 3) {
      var cand = state.divers.find(function (d) { return C.diverAvailable(state, d); });
      sitter = cand ? cand.id : undefined;
    }
    var r = C.buyRecon(state, sel.tile.x, sel.tile.y, nextTier, sitter);
    if (r.ok) {
      feedbackGood('Recon at ' + tileLabel(sel.tile.x, sel.tile.y) + ' is now tier ' + r.tier + ' (cost ' + JSON.stringify(r.cost) + ')' + (r.satOut ? ' — ' + r.satOut + ' sat this one out.' : '.'));
    } else feedback(r.reason || 'Recon refused.', true);
    renderAll();
  }
  function doFound() {
    var r = C.foundSettlement(state);
    if (r.ok) feedbackGood('Settlement founded at ' + tileLabel(r.settlement.x, r.settlement.y) + ' — tier 1, population ' + r.settlement.population + '.');
    else feedback(r.reason || 'Founding refused.', true);
    renderAll();
  }
  function doRefuel() {
    var r = C.refuelAirship(state);
    if (r.ok) feedbackGood('Airship refuelled: +' + r.transferred + ' FUEL from stores (tank now ' + state.airship.fuel + '/' + state.airship.maxFuel + ').');
    else feedback(r.reason || 'Refuel refused.', true);
    renderAll();
  }
  function doEndTurn() {
    var r = C.endTurn(state);
    (r.lines || []).forEach(function (l) { log(l, /DEFEAT|STARV|GROUNDED|destroyed|fell/i.test(l) ? 'err' : ''); });
    if (r.gameStatus && r.gameStatus !== 'playing') feedback('🏁 ' + r.gameStatus.toUpperCase() + (state.endReason ? ' — ' + state.endReason : ''), r.gameStatus === 'lost');
    else feedback('Turn ' + state.turn + ' begins.');
    renderAll();
  }

  /* ---------------- context menu: genuine choices ONLY ----------------
   * It never appears in the drop path. Its one job: a tile holding more
   * than one diver, where the player genuinely has to pick who they mean.
   * Readability pass: 16px items, 11px padding, white on near-black. */
  function hideMenu() { menuEl.hidden = true; menuEl.innerHTML = ''; }
  function menuOpen() { return !menuEl.hidden; }
  function showChooserMenu(x, y, divers, clientX, clientY) {
    menuEl.innerHTML = '<div class="dz-menu-head">' + tileLabel(x, y) + ' — who do you mean?</div>';
    divers.forEach(function (d) {
      var b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = esc(d.name) + '<small>Lv ' + d.level + ' · ' + statusText(d) + ' — click selects, and makes them the squad</small>';
      b.addEventListener('click', function () { selectDiver(d.id, false); });
      menuEl.appendChild(b);
    });
    var all = document.createElement('button');
    all.type = 'button';
    all.innerHTML = 'Select all ' + divers.length + ' here<small>Make the whole group the squad</small>';
    all.addEventListener('click', function () {
      sel.squad = divers.map(function (d) { return d.id; });
      sel.primary = divers[0].id; sel.ship = false; hideMenu(); renderSector(false); renderPanel();
    });
    menuEl.appendChild(all);
    menuEl.hidden = false;
    var mw = 300, mh = 90 + divers.length * 58;
    menuEl.style.left = clamp(clientX, 8, window.innerWidth - mw - 12) + 'px';
    menuEl.style.top = clamp(clientY, 8, window.innerHeight - mh - 12) + 'px';
  }

  /* ---------------- click / right-click resolution ---------------- */
  function handleClick(pick, ev) {
    hideMenu();
    if (scen.active) return;
    if (dropArmed && sel.squad.length) {
      dropArmed = false;
      startScenario(pick.x, pick.y);
      return;
    }
    if (ev.shiftKey && pick.diver) { selectDiver(pick.diver.id, true); return; }
    if (sel.squad.length && !ev.shiftKey) {
      // A squad is already picked: a plain tap sets the drop target.
      selectTile(pick.x, pick.y);
      return;
    }
    if (pick.diver) { selectDiver(pick.diver.id, ev.shiftKey); selectTile(pick.x, pick.y); return; }
    var onShip = pick.x === state.airship.x && pick.y === state.airship.y;
    var here = diversOnTile(pick.x, pick.y).filter(function (d) { return d.status !== 'dead'; });
    if (onShip && !ev.shiftKey && sel.squad.length === 0) {
      // Tapping the airship tile with no squad selects the ship itself.
      selectTile(pick.x, pick.y); selectShip(); return;
    }
    if (here.length === 1) { selectDiver(here[0].id, ev.shiftKey); selectTile(pick.x, pick.y); return; }
    if (here.length > 1 && !ev.shiftKey) { showChooserMenu(pick.x, pick.y, here, ev.clientX, ev.clientY); selectTile(pick.x, pick.y); return; }
    selectTile(pick.x, pick.y);
  }
  function handleRightClick(pick, ev) {
    hideMenu();
    if (scen.active) return;
    // SQUAD + TARGET = DROP. Immediately. No menu — that is the ruling.
    if (sel.squad.length) {
      if (dropArmed) dropArmed = false;
      startScenario(pick.x, pick.y);
      return;
    }
    if (sel.ship) {
      if (pick.x === state.airship.x && pick.y === state.airship.y) doRefuel();
      else doMove(pick.x, pick.y);
      return;
    }
    if (pick.diver) { selectDiver(pick.diver.id, ev.shiftKey); selectTile(pick.x, pick.y); return; }
    var here = diversOnTile(pick.x, pick.y).filter(function (d) { return d.status !== 'dead'; });
    if (pick.x === state.airship.x && pick.y === state.airship.y) { selectTile(pick.x, pick.y); selectShip(); return; }
    if (here.length === 1) { selectDiver(here[0].id, ev.shiftKey); selectTile(pick.x, pick.y); return; }
    if (here.length > 1) { showChooserMenu(pick.x, pick.y, here, ev.clientX, ev.clientY); selectTile(pick.x, pick.y); return; }
    selectTile(pick.x, pick.y);
    ping(pick.x, pick.y);
    var t = C.tileAt(state, pick.x, pick.y);
    feedback('Ping ' + tileLabel(pick.x, pick.y) + ' — ' + (t.discovered ? t.terrain : 'unknown') + '.');
  }

  /* ---------------- camera — CLASSIC RTS LAW ----------------
   * Arrow keys pan. Mouse at the screen border pans (first-class).
   * Drag the ground to move. Wheel / pinch / buttons / keys zoom.
   * The 55° tilt stays inside the one plane transform — never isometric. */
  function applyCam() {
    plane.style.transform = 'translate(-50%, -45%) translate(' + cam.panX.toFixed(1) + 'px, ' + cam.panY.toFixed(1) + 'px) rotateX(55deg) scale(' + cam.zoom.toFixed(3) + ')';
    $('dz-zoom-level').textContent = Math.round(cam.zoom * 100) + '%';
    var back = document.querySelector('[data-cloud-layer="back"]');
    var front = document.querySelector('[data-cloud-layer="front"]');
    if (back) back.style.transform = 'translate(' + (cam.panX * 0.03).toFixed(1) + 'px, ' + (cam.panY * 0.02).toFixed(1) + 'px)';
    if (front) front.style.transform = 'translate(' + (cam.panX * 0.06).toFixed(1) + 'px, ' + (cam.panY * 0.04).toFixed(1) + 'px)';
  }
  function clampPan() {
    cam.tPanX = clamp(cam.tPanX, -(620 * cam.tZoom + 200), 620 * cam.tZoom + 200);
    cam.tPanY = clamp(cam.tPanY, -(460 * cam.tZoom + 180), 460 * cam.tZoom + 180);
  }
  function setZoomTarget(z) { cam.tZoom = clamp(z, 0.5, 2.5); }
  function zoomAt(factor, clientX, clientY) {
    // Steve's rule: with a selection, the SELECTED OBJECT is the zoom
    // anchor — it stays put on screen while the world scales around it.
    // No selection: the cursor anchors, as before.
    var selPts = selectionFocusPoints();
    if (selPts) {
      var anchorBefore = screenCenterOfTiles(selPts);
      cam.zoom = clamp(cam.zoom * factor, 0.5, 2.5);
      cam.tZoom = cam.zoom;
      applyCam();
      // Perspective shifts a point by pan/w, not pan: iterate the
      // correction until the anchor sits back where it started.
      for (var wi = 0; wi < 5; wi++) {
        var anchorNow = screenCenterOfTiles(selPts);
        var adx = anchorBefore.x - anchorNow.x, ady = anchorBefore.y - anchorNow.y;
        if (Math.abs(adx) < 0.75 && Math.abs(ady) < 0.75) break;
        cam.panX += adx; cam.panY += ady; applyCam();
      }
      cam.tPanX = cam.panX; cam.tPanY = cam.panY;
      clampPan(); applyCam();
      return;
    }
    var before = planePointFromScreen(clientX, clientY);
    cam.zoom = clamp(cam.zoom * factor, 0.5, 2.5);
    cam.tZoom = cam.zoom;
    applyCam();
    if (before) {
      requestAnimationFrame(function () {
        var after = planePointFromScreen(clientX, clientY);
        if (!after) return;
        var sr = stage.getBoundingClientRect();
        var stepX = (after.fx - before.fx), stepY = (after.fy - before.fy);
        // Convert tile delta to pixels via two probe screen positions.
        var a = probeEls.nw.getBoundingClientRect(), b = probeEls.se.getBoundingClientRect();
        var pxPerTileX = (b.left - a.left) / T.gridW, pxPerTileY = (b.top - a.top) / T.gridH;
        cam.tPanX = cam.panX += clamp(stepX * pxPerTileX, -90, 90);
        cam.tPanY = cam.panY += clamp(stepY * pxPerTileY, -90, 90);
        clampPan(); applyCam();
      });
    }
  }
  function centerOn(x, y) {
    var tr = tileEls[y][x].getBoundingClientRect();
    var vr = viewport.getBoundingClientRect();
    cam.tPanX = cam.panX += (vr.left + vr.width / 2) - (tr.left + tr.width / 2);
    cam.tPanY = cam.panY += (vr.top + vr.height / 2) - (tr.top + tr.height / 2);
    clampPan(); applyCam();
  }

  /* ---------------- focus (F) + selection-anchored zoom ----------------
   * Steve, mid-playtest: "f hotkey. zoom to selected." and "the mouse
   * should zoom to the selected object." One resolver serves both: the
   * selection's tile points — the ship's tile, or the squad's staged
   * tiles around it. A lone inspected tile is not an object: no anchor. */
  var FOCUS_ZOOM_SINGLE = 1.8;
  function selectionFocusPoints() {
    if (sel.ship) return [{ x: state.airship.x, y: state.airship.y }];
    if (sel.squad.length) {
      var staged = {};
      stagedDivers().forEach(function (s) { staged[s.diver.id] = s; });
      var pts = [];
      sel.squad.forEach(function (id) { if (staged[id]) pts.push({ x: staged[id].x, y: staged[id].y }); });
      if (pts.length) return pts;
      // A squad exists but nobody is staged at the ship (e.g. just
      // dropped): the airship they left from is their world anchor.
      return [{ x: state.airship.x, y: state.airship.y }];
    }
    return null;
  }
  function screenCenterOfTiles(pts) {
    var sx = 0, sy = 0;
    pts.forEach(function (p) {
      var r = tileEls[p.y][p.x].getBoundingClientRect();
      sx += r.left + r.width / 2; sy += r.top + r.height / 2;
    });
    return { x: sx / pts.length, y: sy / pts.length };
  }
  function screenBoxOfTiles(pts) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    pts.forEach(function (p) {
      var r = tileEls[p.y][p.x].getBoundingClientRect();
      x0 = Math.min(x0, r.left); y0 = Math.min(y0, r.top);
      x1 = Math.max(x1, r.right); y1 = Math.max(y1, r.bottom);
    });
    return { w: x1 - x0, h: y1 - y0 };
  }
  // Solve the pan TARGETS that put posFn()'s point at desiredScreen once
  // the camera settles at targetZoom. The viewport's CSS perspective
  // means a point's screen position shifts by pan/w, not pan — one raw
  // delta under-corrects by a fixed ratio, so iterate the measurement:
  // each pass shrinks the residual by that ratio, and a handful of
  // passes lands sub-pixel. The rendered state is restored untouched at
  // the end (all in one tick) and the frame loop's easing does the glide.
  function solvePanTarget(posFn, targetZoom, desiredScreen) {
    var oldZoom = cam.zoom, oldPanX = cam.panX, oldPanY = cam.panY;
    cam.zoom = targetZoom;
    var gx = oldPanX, gy = oldPanY, ok = false;
    for (var i = 0; i < 6; i++) {
      cam.panX = gx; cam.panY = gy; applyCam();
      var p = posFn();
      if (!p) break;
      ok = true;
      var dx = desiredScreen.x - p.x, dy = desiredScreen.y - p.y;
      if (Math.abs(dx) < 0.75 && Math.abs(dy) < 0.75) break;
      gx += dx; gy += dy;
    }
    cam.zoom = oldZoom; cam.panX = oldPanX; cam.panY = oldPanY; applyCam();
    return ok ? { x: gx, y: gy } : null;
  }
  function focusSelection() {
    var pts = selectionFocusPoints();
    if (!pts) return; // nothing selected: a true no-op — no log, no motion
    var targetZoom;
    if (pts.length === 1 && sel.squad.length <= 1) {
      // Single object (one diver, or the airship): close working zoom;
      // never pull BACK from a closer view the player already chose.
      targetZoom = clamp(Math.max(cam.tZoom, FOCUS_ZOOM_SINGLE), 0.5, 2.5);
    } else {
      // Squad: frame them — zoom OUT only as far as needed to fit.
      var vr0 = viewport.getBoundingClientRect();
      var box = screenBoxOfTiles(pts);
      var fit = Math.min(box.w > 1 ? (vr0.width * 0.72) / box.w : Infinity,
                         box.h > 1 ? (vr0.height * 0.72) / box.h : Infinity);
      targetZoom = clamp(Math.min(cam.tZoom, cam.zoom * fit), 0.5, 2.5);
    }
    var vr = viewport.getBoundingClientRect();
    var center = { x: vr.left + vr.width / 2, y: vr.top + vr.height / 2 };
    var sol = solvePanTarget(function () { return screenCenterOfTiles(pts); }, targetZoom, center);
    if (!sol) return;
    cam.tZoom = targetZoom; cam.tPanX = sol.x; cam.tPanY = sol.y;
    clampPan();
    var who;
    if (sel.ship) who = 'the airship';
    else if (sel.squad.length > 1) who = 'the squad (' + sel.squad.length + ')';
    else { var d0 = diverById(sel.squad[0]); who = d0 ? d0.name : 'the selection'; }
    feedback('Camera focused on ' + who + '.');
  }

  /* ---------------- input: touchpad-first ----------------
   * No order requires right-click: right-click is only the fast path.
   * Plain drag = grab the world (RTS). Shift-drag = box-select a squad.
   * A press that barely moves is a click (forgiving for trackpads). */
  var drag = null;
  var pointers = new Map();
  var pinchDist = 0;
  stage.addEventListener('pointerdown', function (e) {
    if (e.button === 2) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      var pts = Array.from(pointers.values());
      pinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      drag = null;
      return;
    }
    drag = { x: e.clientX, y: e.clientY, panX: cam.tPanX, panY: cam.tPanY, moved: false, box: !!e.shiftKey };
    if (drag.box) { boxEl.hidden = false; boxEl.style.left = '0px'; boxEl.style.top = '0px'; boxEl.style.width = '0px'; boxEl.style.height = '0px'; }
  });
  stage.addEventListener('pointermove', function (e) {
    var sr = stage.getBoundingClientRect();
    mouseStage = { x: e.clientX - sr.left, y: e.clientY - sr.top, w: sr.width, h: sr.height };
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2 && pinchDist > 0) {
      var pts = Array.from(pointers.values());
      var d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (Math.abs(d - pinchDist) > 4) {
        // Pinch follows the wheel's rule: a selection anchors the zoom.
        var nz = clamp(cam.tZoom * (d / pinchDist), 0.5, 2.5);
        var selPts = selectionFocusPoints();
        var sol = null;
        if (selPts) {
          var anchorNow = screenCenterOfTiles(selPts);
          sol = solvePanTarget(function () { return screenCenterOfTiles(selPts); }, nz, anchorNow);
        }
        cam.tZoom = nz;
        if (sol) { cam.tPanX = sol.x; cam.tPanY = sol.y; clampPan(); }
        pinchDist = d;
      }
      return;
    }
    if (!drag) return;
    var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 7) drag.moved = true;
    if (!drag.moved) return;
    if (drag.box) {
      var l = Math.min(drag.x, e.clientX) - sr.left, t = Math.min(drag.y, e.clientY) - sr.top;
      boxEl.style.left = l + 'px'; boxEl.style.top = t + 'px';
      boxEl.style.width = Math.abs(dx) + 'px'; boxEl.style.height = Math.abs(dy) + 'px';
    } else {
      cam.tPanX = drag.panX + dx; cam.tPanY = drag.panY + dy; clampPan();
    }
  });
  function endPointer(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchDist = 0;
    if (!drag) return;
    var wasDrag = drag;
    drag = null;
    if (e.type === 'pointercancel') { boxEl.hidden = true; return; }
    if (wasDrag.box) {
      boxEl.hidden = true;
      var l = Math.min(wasDrag.x, e.clientX), r = Math.max(wasDrag.x, e.clientX);
      var t = Math.min(wasDrag.y, e.clientY), b = Math.max(wasDrag.y, e.clientY);
      var added = [];
      Object.keys(diverAnchorEls).forEach(function (id) {
        var rc = diverAnchorEls[id].getBoundingClientRect();
        var cx = rc.left + rc.width / 2, cy = rc.top + rc.height / 2;
        if (cx >= l && cx <= r && cy >= t && cy <= b) added.push(id);
      });
      if (added.length) {
        var union = sel.squad.slice();
        added.forEach(function (id) { if (union.indexOf(id) < 0) union.push(id); });
        sel.squad = union; sel.primary = added[0]; sel.ship = false;
        feedbackGood('Box-selected a squad of ' + union.length + '.');
        renderSector(false); renderPanel();
      }
      return;
    }
    if (!wasDrag.moved && e.button === 0) {
      var pick = pickTile(e.clientX, e.clientY);
      if (pick) handleClick(pick, e);
    }
  }
  stage.addEventListener('pointerup', endPointer);
  stage.addEventListener('pointercancel', endPointer);
  stage.addEventListener('pointerleave', function () { mouseStage = null; });
  stage.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    var pick = pickTile(e.clientX, e.clientY);
    if (pick) handleRightClick(pick, e);
  });
  stage.addEventListener('wheel', function (e) {
    e.preventDefault();
    if (e.ctrlKey) { zoomAt(e.deltaY < 0 ? 1.09 : 0.92, e.clientX, e.clientY); return; }
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) {
      cam.tPanX -= e.deltaX; cam.tPanY -= (e.shiftKey ? e.deltaY : 0); clampPan(); return;
    }
    zoomAt(e.deltaY < 0 ? 1.09 : 0.92, e.clientX, e.clientY);
  }, { passive: false });
  document.addEventListener('pointerdown', function (e) {
    if (menuOpen() && !menuEl.contains(e.target)) hideMenu();
  });

  window.addEventListener('keydown', function (e) {
    var tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    keysDown[e.key] = true;
    if (e.key.indexOf('Arrow') === 0 || e.key === ' ') e.preventDefault();
    if (e.key === 'Escape') {
      if (scen.active) skipScenario();
      else if (menuOpen()) hideMenu();
      else if (dropArmed) { dropArmed = false; feedback('Drop disarmed.'); }
      else clearSelection();
    }
    if (!scen.active) {
      if (e.key === '+' || e.key === '=') setZoomTarget(cam.tZoom + 0.15);
      if (e.key === '-') setZoomTarget(cam.tZoom - 0.15);
      if (e.key === '0') { cam.tZoom = 1; cam.tPanX = 0; cam.tPanY = 0; }
      if (e.key === 'f' || e.key === 'F') focusSelection();
      if ((e.key === 'd' || e.key === 'D') && sel.squad.length) {
        if (sel.tile) startScenario(sel.tile.x, sel.tile.y);
        else { dropArmed = true; feedback('Drop armed — tap the target tile.'); }
      }
    }
  });
  window.addEventListener('keyup', function (e) { keysDown[e.key] = false; });

  /* ================= THE DROP SCENARIO =================
   * Descent (steer through tile wind + the world weather sample) →
   * touchdown (particles, shake, splash) → the encounter plays out as
   * timed beats staged from the resolveDrop report → balloon lift.
   * Core resolves the outcome only at touchdown, from where the squad
   * ACTUALLY lands — weather is causal through drift. */
  var scen = {
    active: false, phase: null, t: 0, target: null, kind: 'generic', squadIds: [],
    mx: 0, my: 0, dur: 8, landing: null, report: null,
    beats: [], beatIdx: -1, beatT: 0, beatInt: 0.9,
    effects: [], particles: [], ff: false, shake: 0, estT: 0, landEst: null,
    sample: null, pointer: null, figScreen: [], resolvedAt: 0,
    // Exploration build (Steve, playtest #16/#17–20/#22–23):
    exp: null, logShown: 0, hits: 0, hazards: [],
    gustT: 0, gustWasOn: false, moveTick: 0, keyTick: 0
  };
  function defaultKind(tile) {
    if (tile.isInterdiction) return 'interdiction';
    if (tile.robotSite && !tile.robotSite.cleared) return 'robot';
    if (tile.supplySite && !tile.supplySite.looted) return 'supply';
    if (state.supply.status === 'established') {
      var route = C.routeTiles(state);
      for (var i = 0; i < route.length; i++) if (route[i].x === tile.x && route[i].y === tile.y) return 'clear-route';
    }
    if (!tile.discovered || (tile.reconTier || 0) === 0) return 'scout';
    if (tile.resourceType) return 'gather';
    return 'generic';
  }
  function startScenario(x, y) {
    if (scen.active) return false;
    var ids = sel.squad.slice();
    if (!ids.length) { feedback('Select a squad first — click divers, shift-click to add.', true); return false; }
    var tile = C.tileAt(state, x, y);
    if (!tile) { feedback('No such tile.', true); return false; }
    var unavail = ids.map(diverById).filter(function (d) { return !d || !C.diverAvailable(state, d); });
    if (unavail.length) { feedback(unavail.map(function (d) { return d ? d.name : '?'; }).join(', ') + ' cannot drop right now.', true); return false; }
    if (state.airship.fuel < T.dropFuelCost) { feedback('The airship needs ' + T.dropFuelCost + ' fuel to run a drop.', true); return false; }
    scen.active = true; scen.phase = 'descent'; scen.t = 0;
    scen.target = { x: x, y: y }; scen.kind = defaultKind(tile);
    scen.squadIds = ids; scen.mx = x; scen.my = y;
    scen.dur = reducedMotion ? 1.4 : T.descentSeconds;
    scen.landing = null; scen.report = null; scen.beats = []; scen.beatIdx = -1; scen.beatT = 0;
    scen.effects = []; scen.particles = []; scen.ff = false; scen.shake = 0; scen.estT = 0;
    scen.exp = null; scen.logShown = 0; scen.hits = 0; scen.descentT = 0;
    scen.gustT = 0; scen.gustWasOn = false; scen.moveTick = 0; scen.keyTick = 0;
    scen.sample = W.sampleWeather(weather, x, y);
    // THE FALL IS PLAYABLE (#22): telegraphed lightning strikes drawn from
    // THIS tile's weather. Calm tile = a gentle fall (no strikes); a storm
    // tile is a fight. Severity scales with the sample's storm value.
    scen.hazards = [];
    var storm0 = scen.sample ? scen.sample.storm : 0;
    var nStrikes = storm0 < 0.15 ? 0 : Math.min(4, Math.round(storm0 * 5));
    if (reducedMotion) nStrikes = Math.ceil(nStrikes / 2);
    for (var hi = 0; hi < nStrikes; hi++) {
      scen.hazards.push({
        at: scen.dur * (0.18 + 0.62 * ((hi + 0.3 + Math.random() * 0.4) / Math.max(1, nStrikes))),
        state: 'pending', hx: null, teleUntil: 0, strikeUntil: 0
      });
    }
    scen.landEst = C.computeLanding(state, x, y, x, y, tile.reconTier || 0);
    scenEl.hidden = false;
    $('dz-scen-block').hidden = false;
    setScenarioUI(true);
    scenCaption.textContent = 'DROP — ' + ids.length + ' diver(s) away to ' + tileLabel(x, y) + '. Steer!';
    feedback('Drop away: ' + ids.map(function (id) { return diverById(id).name.split(' ')[0]; }).join(', ') + ' → ' + tileLabel(x, y) + ' (' + scen.kind + '). The scenario plays out…');
    renderOrders();
    return true;
  }
  function setScenarioUI(on) {
    ['dz-btn-move', 'dz-btn-recon', 'dz-btn-found', 'dz-btn-refuel', 'dz-squad-all', 'dz-squad-clear'].forEach(function (id) {
      var b = $(id); if (b) b.disabled = on;
    });
    $('dz-scen-phase').textContent = on ? 'Phase: descent — steer the squad.' : '';
  }
  function finishDescent() {
    var fx = clamp(Math.round(scen.mx), 0, T.gridW - 1);
    var fy = clamp(Math.round(scen.my), 0, T.gridH - 1);
    var tile = C.tileAt(state, scen.target.x, scen.target.y);
    scen.landing = C.computeLanding(state, scen.target.x, scen.target.y, fx, fy, tile.reconTier || 0);
    lastLanding = scen.landing;
    spawnImpact(fx, fy);
    scen.shake = scen.landing.finalTile.terrain === 'water' ? 0.4 : 1;
    scen.phase = 'impact'; scen.t = 0;
    scenCaption.textContent = 'TOUCHDOWN at ' + tileLabel(fx, fy) + ' — LAND ' + scen.landing.land + '. ' + scen.landing.reasons[0];
    $('dz-scen-phase').textContent = 'Phase: touchdown.';
  }
  /* ---------- exploration phase (encounters.js) ----------
   * Touchdown hands the drop to the expedition engine: the squad walks the
   * ground window turn by turn (AP economy), finds loot by exploring, meets
   * seeded encounters, and the player calls the balloon lift when ready.
   * The report is generated FROM the expedition at extraction. */
  function startExploration() {
    var fx = scen.landing.finalTile.x, fy = scen.landing.finalTile.y;
    var smpLand = W.sampleWeather(weather, fx, fy);
    var exp0 = E.createExpedition(C, state, {
      squadIds: scen.squadIds, targetX: scen.target.x, targetY: scen.target.y,
      landX: fx, landY: fy, land: scen.landing.land, kind: scen.kind,
      storm: smpLand.storm, descentHits: scen.hits
    });
    if (!exp0.ok) {
      scen.report = exp0; scen.phase = 'done'; scen.t = 0;
      scenCaption.textContent = exp0.reason || 'The expedition could not form.';
      return;
    }
    scen.exp = exp0;
    scen.logShown = 0;
    scen.phase = 'explore'; scen.t = 0;
    $('dz-scen-phase').textContent = 'Phase: ON THE GROUND — turn-based exploration.';
    syncExpLog();
    scenCaption.textContent = 'ON THE GROUND at ' + tileLabel(fx, fy) + '. The murk is thick — walk it. Loot is out there, and so is everything else. Extract when the haul is worth it.';
    renderExpeditionUI();
  }
  function syncExpLog() {
    var exp = scen.exp; if (!exp) return;
    var shown = scen.logShown || 0;
    for (var i = shown; i < exp.log.length; i++) {
      log('⬢ ' + exp.log[i], /wounded|struck|died|kill|bleed|attack|down/i.test(exp.log[i]) ? 'err' : '');
    }
    scen.logShown = exp.log.length;
    var last = exp.log[exp.log.length - 1];
    if (last && !exp.encounter) scenCaption.textContent = last;
  }
  function carriedText(exp) {
    var parts = Object.keys(exp.carried).filter(function (k) { return exp.carried[k] > 0; })
      .map(function (k) { return k + ' ' + exp.carried[k]; });
    return parts.length ? parts.join(' · ') : 'nothing yet';
  }
  function afterExpAction(r) {
    if (r && !r.ok && r.reason) scenCaption.textContent = r.reason;
    syncExpLog();
    if (scen.exp && scen.exp.encounter) {
      scenCaption.textContent = scen.exp.encounter.title + ' — make the call in the panel.';
    }
    renderExpeditionUI();
    renderSector(false);
    if (scen.exp && scen.exp.finished === 'wiped') {
      scen.phase = 'done'; scen.t = 0;
      scenCaption.textContent = 'The whole squad is down. The balloon comes for what it can…';
    }
  }
  function extractNow() {
    if (!scen.exp || scen.report) { finishScenario(); return; }
    scen.report = E.extract(C, state, scen.exp);
    lastReport = scen.report;
    scen.resolvedAt = performance.now();
    syncExpLog();
    finishScenario();
  }
  function renderExpeditionUI() {
    var act = $('dz-scen-actions'), ch = $('dz-scen-choices');
    if (!act || !ch) return;
    act.innerHTML = ''; ch.innerHTML = '';
    var exp = scen.exp;
    if (!exp || scen.phase !== 'explore') return;
    $('dz-scen-phase').textContent = 'Phase: ON THE GROUND — ground turn ' + exp.turn +
      ' · carried: ' + carriedText(exp) +
      (exp.hostiles.length ? ' · ⚠ ' + exp.hostiles.length + ' hostile(s) out' : '');
    exp.members.forEach(function (m) {
      var d = diverById(m.id); if (!d) return;
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'dz-member' + (exp.activeId === m.id ? ' active' : '') + (d.status === 'dead' ? ' dead' : '');
      var pips = '';
      for (var i = 0; i < E.TUN.apPerTurn; i++) pips += i < m.ap ? '●' : '○';
      b.innerHTML = '<img alt="" src="' + P.url(d, variantOf(d)) + '"><span><b>' + esc(d.name.split(' ')[0]) + '</b><br>' +
        '<span class="ap">' + pips + ' AP</span>' + (d.wounds ? ' · <span class="wnd">' + d.wounds + ' wound(s)</span>' : '') + '</span>';
      b.disabled = d.status === 'dead';
      b.addEventListener('click', function () { E.setActive(exp, m.id); renderExpeditionUI(); });
      act.appendChild(b);
    });
    var am = E.activeMember(C, state, exp);
    if (!exp.encounter) {
      exp.hostiles.forEach(function (h) {
        var dist = am ? Math.max(Math.abs(h.x - am.x), Math.abs(h.y - am.y)) : 99;
        var b2 = document.createElement('button');
        b2.type = 'button'; b2.className = 'dz-act dz-fire';
        b2.textContent = '🔥 Fire at ' + h.name + ' (' + h.hp + ' hp)' +
          (dist > E.TUN.fireRange ? ' — out of range' : ' — ' + E.TUN.costFire + ' AP');
        b2.disabled = !am || am.ap < E.TUN.costFire || dist > E.TUN.fireRange;
        b2.addEventListener('click', function () { afterExpAction(E.fireAt(C, state, exp, h.id)); renderPanel(); });
        act.appendChild(b2);
      });
      var site = am ? E.siteAt(C, state, exp, am) : null;
      var siteLabel = site ? (site.type === 'cache'
        ? 'Crack the supply cache — ' + (site.tile.supplySite ? site.tile.supplySite.name : 'cache')
        : 'Work the ruin vault — ' + (site.tile.robotSite ? site.tile.robotSite.name : 'ruin')) : null;
      var bi = document.createElement('button');
      bi.type = 'button'; bi.className = 'dz-act';
      bi.textContent = site ? '✋ ' + siteLabel + ' (' + E.TUN.costInteract + ' AP)' : '✋ Interact — nothing in reach';
      bi.disabled = !site || !am || am.ap < E.TUN.costInteract;
      bi.addEventListener('click', function () { afterExpAction(E.interact(C, state, exp)); renderPanel(); });
      act.appendChild(bi);
      var be = document.createElement('button');
      be.type = 'button'; be.className = 'dz-act';
      be.textContent = '⏭ End ground turn';
      be.addEventListener('click', function () { afterExpAction(E.endTurn(C, state, exp)); renderPanel(); });
      act.appendChild(be);
      var bx = document.createElement('button');
      bx.type = 'button'; bx.className = 'dz-act dz-extract';
      bx.textContent = '⤒ Call the balloon lift — EXTRACT';
      bx.addEventListener('click', function () { extractNow(); });
      act.appendChild(bx);
    }
    if (exp.encounter) {
      var enc = exp.encounter;
      var head = document.createElement('div');
      head.className = 'dz-enc-head';
      head.innerHTML = '<b>' + esc(enc.title) + '</b><p>' + esc(enc.text) + '</p>';
      ch.appendChild(head);
      enc.choices.forEach(function (c) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'dz-choice';
        var priceTxt = (!c.sub && c.price) ? ' — ' + Object.keys(c.price).map(function (k) { return c.price[k] + ' ' + k; }).join(', ') : '';
        b.textContent = c.label + (c.sub ? ' — ' + c.sub : '') + priceTxt + (c.cost ? ' (' + c.cost + ' AP)' : '');
        var cant = (c.cost && (!am || am.ap < c.cost)) || (c.price && !E.canPay(C, state, exp, c.price));
        b.disabled = !!cant;
        b.addEventListener('click', function () {
          var r = E.choose(C, state, exp, c.id);
          if (r && r.extract) { extractNow(); return; }
          afterExpAction(r);
          renderPanel();
        });
        ch.appendChild(b);
      });
    }
  }
  function handleGroundTap(px, py) {
    var exp = scen.exp;
    if (!exp || exp.encounter || exp.finished) return;
    var w = canvasToWorld(px, py);
    if (!w) return;
    var tx = Math.round(w.x), ty = Math.round(w.y);
    var h = exp.hostiles.find(function (hh) { return hh.x === tx && hh.y === ty; });
    if (h) { afterExpAction(E.fireAt(C, state, exp, h.id)); renderPanel(); return; }
    var mm = exp.members.find(function (m2) { return m2.x === tx && m2.y === ty; });
    if (mm) {
      E.setActive(exp, mm.id);
      var d = diverById(mm.id);
      scenCaption.textContent = (d ? d.name : 'Diver') + ' takes the lead.';
      renderExpeditionUI();
      return;
    }
    afterExpAction(E.moveActive(C, state, exp, tx, ty));
    renderPanel();
  }
  function finishScenario() {
    var r = scen.report;
    scen.active = false; scen.phase = null; scen.exp = null;
    scenEl.hidden = true; scenCaption.textContent = '';
    $('dz-scen-block').hidden = true;
    var act = $('dz-scen-actions'), ch = $('dz-scen-choices');
    if (act) act.innerHTML = '';
    if (ch) ch.innerHTML = '';
    setScenarioUI(false);
    if (r && r.ok) {
      feedbackGood('DROP RESULT — ' + r.band + ': ' + r.outcome + ' (' + (r.wounded.length ? r.wounded.length + ' wounded' : 'no wounds') +
        (r.deaths.length ? ', ' + r.deaths.length + ' lost' : '') + ').');
      sel.squad = sel.squad.filter(function (id) { var d = diverById(id); return d && d.status !== 'dead'; });
    } else if (r) feedback(r.reason || 'Drop failed to resolve.', true);
    renderAll();
  }
  function skipScenario() {
    if (!scen.active) return;
    if (scen.phase === 'descent') finishDescent();
    else if (scen.phase === 'impact') { startExploration(); extractNow(); }
    else if (scen.phase === 'explore') extractNow();
    else finishScenario();
  }
  function scenarioFF() { scen.ff = true; }

  var FORMATION = [[0, 0], [0.55, 0.35], [-0.55, 0.35], [0.3, -0.55], [-0.3, -0.55], [0.85, -0.1], [-0.85, -0.1], [0, 0.8]];
  function groundProject(u, v) {
    // Bilinear point on the scenario's ground quad (window coords 0..13).
    var TL = [170, 452], TR = [930, 452], BR = [1052, 668], BL = [48, 668];
    var topX = TL[0] + (TR[0] - TL[0]) * (u / 13), botX = BL[0] + (BR[0] - BL[0]) * (u / 13);
    var topY = TL[1], botY = BL[1];
    return { x: topX + (botX - topX) * (v / 13), y: topY + (botY - topY) * (v / 13) };
  }
  function spawnImpact(fx, fy) {
    var tile = C.tileAt(state, fx, fy);
    var winX0 = clamp(scen.target.x - 6, 0, T.gridW - 13), winY0 = clamp(scen.target.y - 6, 0, T.gridH - 13);
    var gp = groundProject(fx - winX0 + 0.5, fy - winY0 + 0.5);
    var water = tile.terrain === 'water';
    var n = water ? 34 : 30;
    for (var i = 0; i < n; i++) {
      var ang = Math.random() * Math.PI * 2, sp = 20 + Math.random() * (water ? 130 : 95);
      scen.particles.push({
        x: gp.x, y: gp.y - 4, vx: Math.cos(ang) * sp, vy: -Math.abs(Math.sin(ang)) * sp * (water ? 0.9 : 0.55) - 20,
        life: 0, ttl: 0.5 + Math.random() * 0.6,
        color: water ? 'rgba(150,200,240,0.85)' : (i % 3 ? 'rgba(178,152,105,0.85)' : 'rgba(120,105,80,0.85)'),
        size: 2 + Math.random() * 3.5
      });
    }
    if (water) scenCaption.textContent = 'SPLASHDOWN at ' + tileLabel(fx, fy) + ' — water landing. LAND ' + scen.landing.land + '.';
  }
  function classifyLine(line) {
    if (/BALLOON LIFT/i.test(line)) return 'balloon';
    if (/snag/i.test(line)) return 'snag';
    if (/did not come back|KILLED|left behind|died/i.test(line)) return 'death';
    if (/wounded/i.test(line)) return 'wound';
    if (/Yield:|seized|cache|gathered|science/i.test(line)) return 'yield';
    return 'note';
  }
  function spawnBeatEffect(line) {
    var kind = classifyLine(line);
    var fx = scen.landing ? scen.landing.finalTile.x : scen.target.x;
    var fy = scen.landing ? scen.landing.finalTile.y : scen.target.y;
    var diver = null;
    state.divers.forEach(function (d) { if (line.indexOf(d.name) >= 0) diver = d; });
    scen.effects.push({ kind: kind, at: scen.t, diverId: diver ? diver.id : null, x: fx, y: fy, line: line });
  }

  function updateScenario(dt) {
    scen.t += dt;
    var step = scen.ff ? dt * 9 : dt;
    if (scen.phase === 'descent') {
      scen.t = scen.t; // t already advanced; descent uses its own clock below
      scen.descentT = (scen.descentT || 0) + step;
      var t01 = clamp(scen.descentT / scen.dur, 0, 1);
      // Steering input: keys or pointer.
      var sx = 0, sy = 0;
      if (keysDown.ArrowLeft || keysDown.a || keysDown.A) sx -= 1;
      if (keysDown.ArrowRight || keysDown.d || keysDown.D) sx += 1;
      if (keysDown.ArrowUp || keysDown.w || keysDown.W) sy -= 1;
      if (keysDown.ArrowDown || keysDown.s || keysDown.S) sy += 1;
      if (scen.pointer) {
        var want = canvasToWorld(scen.pointer.x, scen.pointer.y);
        if (want) { sx = clamp((want.x - scen.mx) * 1.6, -1, 1); sy = clamp((want.y - scen.my) * 1.6, -1, 1); }
      }
      var len = Math.hypot(sx, sy) || 1;
      var steerV = 3.2 / len;
      // Wind: the tile's own wind PLUS the world weather sample — one system.
      var ct = C.tileAt(state, clamp(Math.round(scen.mx), 0, 23), clamp(Math.round(scen.my), 0, 23));
      var smp = W.sampleWeather(weather, scen.mx, scen.my);
      scen.sample = smp;
      // Crosswind gusts (#22): periodic shoves scaled by the tile's storm —
      // the player fights them with the same one-input steering.
      scen.gustT += step;
      var gustOn = smp.storm > 0.18 && (scen.gustT % 2.6) < 0.85;
      if (gustOn && !scen.gustWasOn) scenCaption.textContent = '💨 CROSSWIND GUST — fight it, stay on the drop zone!';
      scen.gustWasOn = gustOn;
      var gustMult = gustOn ? 2.3 : 1;
      var driftX = (ct.windX + smp.wind.x * 0.85) * (2 / T.descentSeconds) * gustMult;
      var driftY = (ct.windY + smp.wind.y * 0.85) * (2 / T.descentSeconds) * gustMult;
      var turb = smp.turbulence;
      var wob = reducedMotion ? 0 : Math.sin(scen.descentT * 11) * turb * 0.5;
      scen.mx += (sx * steerV + driftX + wob) * step;
      scen.my += (sy * steerV + driftY + Math.cos(scen.descentT * 9.3) * (reducedMotion ? 0 : turb * 0.4)) * step;
      scen.mx = clamp(scen.mx, Math.max(0, scen.target.x - 6.5), Math.min(23, scen.target.x + 6.5));
      scen.my = clamp(scen.my, Math.max(0, scen.target.y - 6.5), Math.min(23, scen.target.y + 6.5));
      // Lightning hazards (#22): telegraphed, then the strike lands. A hit
      // knocks the fall sideways NOW and buys a GRIT-save wound check at
      // touchdown (resolved inside the expedition — see encounters.js).
      scen.hazards.forEach(function (hz) {
        if (hz.state === 'pending' && scen.descentT >= hz.at) {
          hz.state = 'tele';
          hz.teleUntil = hz.at + scen.dur * 0.11;
          hz.hx = clamp(scen.mx + (Math.random() * 2 - 1) * 1.3, Math.max(0, scen.target.x - 6.5), Math.min(23, scen.target.x + 6.5));
          scenCaption.textContent = '⚡ LIGHTNING CHARGING over the drop zone — clear the flash point!';
        } else if (hz.state === 'tele' && scen.descentT >= hz.teleUntil) {
          hz.state = 'strike';
          hz.strikeUntil = scen.descentT + 0.16;
          if (Math.abs(scen.mx - hz.hx) <= 0.9) {
            scen.hits++;
            scen.shake = Math.max(scen.shake, reducedMotion ? 0.2 : 0.8);
            var dir = scen.mx < hz.hx ? -1 : 1;
            scen.mx = clamp(scen.mx + dir * 1.6, Math.max(0, scen.target.x - 6.5), Math.min(23, scen.target.x + 6.5));
            scenCaption.textContent = '⚡⚡ STRUCK! The fall is knocked sideways — a hit like that can wound a diver at touchdown.';
          } else {
            scenCaption.textContent = '⚡ The strike splits the murk wide of the squad.';
          }
        } else if (hz.state === 'strike' && scen.descentT >= hz.strikeUntil) {
          hz.state = 'spent';
        }
      });
      scen.estT += step;
      if (scen.estT > 0.25) {
        scen.estT = 0;
        var tt = C.tileAt(state, scen.target.x, scen.target.y);
        scen.landEst = C.computeLanding(state, scen.target.x, scen.target.y, clamp(Math.round(scen.mx), 0, 23), clamp(Math.round(scen.my), 0, 23), tt.reconTier || 0);
      }
      if (scen.descentT >= scen.dur) { scen.descentT = 0; finishDescent(); }
    } else if (scen.phase === 'impact') {
      scen.shake = Math.max(0, scen.shake - dt * 1.4);
      if (scen.t > (scen.ff ? 0.15 : 0.85)) startExploration();
    } else if (scen.phase === 'explore') {
      var exp = scen.exp;
      if (exp && !exp.finished) {
        // Keyboard stepping for the active diver — a bonus on top of tap
        // movement (the touch law: nothing requires the keyboard).
        scen.keyTick += dt;
        var kd = null;
        if (keysDown.ArrowLeft || keysDown.a || keysDown.A) kd = [-1, 0];
        else if (keysDown.ArrowRight || keysDown.d || keysDown.D) kd = [1, 0];
        else if (keysDown.ArrowUp || keysDown.w || keysDown.W) kd = [0, -1];
        else if (keysDown.ArrowDown || keysDown.s || keysDown.S) kd = [0, 1];
        if (kd && !exp.encounter && scen.keyTick > 0.22) {
          scen.keyTick = 0;
          var am3 = E.activeMember(C, state, exp);
          if (am3) afterExpAction(E.moveActive(C, state, exp, am3.x + kd[0], am3.y + kd[1]));
        }
        // Walk the plotted course a tile at a time.
        if (exp.pendingPath && !exp.encounter) {
          scen.moveTick += scen.ff ? dt * 4 : dt;
          if (scen.moveTick >= 0.16) {
            scen.moveTick = 0;
            var st = E.continueMove(C, state, exp);
            if (st.moved) afterExpAction(st);
          }
        } else scen.moveTick = 0;
      }
    } else if (scen.phase === 'done') {
      if (scen.t > 1.4) {
        if (scen.exp && !scen.report) {
          scen.report = E.extract(C, state, scen.exp);
          lastReport = scen.report;
          syncExpLog();
        }
        finishScenario();
      }
    }
    if (!scen.active) return; // finishScenario() may have closed mid-update
    // Particles always tick.
    scen.particles = scen.particles.filter(function (p) {
      p.life += dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 300 * dt;
      return p.life < p.ttl;
    });
    scen.effects = scen.effects.filter(function (e) { return scen.t - e.at < 4.5; });
    drawScenario();
  }
  function canvasToWorld(px, py) {
    var v = clamp((py - 452) / (668 - 452), 0, 1);
    var leftX = 170 + (48 - 170) * v, rightX = 930 + (1052 - 930) * v;
    var u = clamp((px - leftX) / Math.max(1, rightX - leftX), 0, 1) * 13;
    var winX0 = clamp(scen.target.x - 6, 0, T.gridW - 13), winY0 = clamp(scen.target.y - 6, 0, T.gridH - 13);
    return { x: winX0 + u - 0.5, y: winY0 + v * 13 - 0.5 };
  }
  scenCanvas.addEventListener('pointerdown', function (e) {
    var r = scenCanvas.getBoundingClientRect();
    var px = (e.clientX - r.left) * (scenCanvas.width / r.width);
    var py = (e.clientY - r.top) * (scenCanvas.height / r.height);
    // On the ground, a tap is an ORDER (move / fire / select) — same input
    // for mouse, touchpad and touch. During the fall it is steering.
    if (scen.phase === 'explore' && scen.exp) { handleGroundTap(px, py); return; }
    scen.pointer = { x: px, y: py };
  });
  scenCanvas.addEventListener('pointermove', function (e) {
    if (!scen.pointer) return;
    var r = scenCanvas.getBoundingClientRect();
    scen.pointer = { x: (e.clientX - r.left) * (scenCanvas.width / r.width), y: (e.clientY - r.top) * (scenCanvas.height / r.height) };
  });
  window.addEventListener('pointerup', function () { scen.pointer = null; });

  var SUIT_DRAW = { Steady: '#3e5a54', Reckless: '#bf4e4e', Medic: '#e8e4d8', none: '#46525e' };
  /* Ground-phase figures: every diver at their REAL tile (the AP game is
   * positional), hostiles with HP pips, the active diver ringed, AP pips
   * under the name plate, and the plotted course drawn dashed. */
  function drawGroundFigures(ctx, winX0, winY0, smp) {
    var exp = scen.exp;
    scen.figScreen = [];
    exp.hostiles.forEach(function (h) {
      var gp = groundProject(h.x - winX0 + 0.5, h.y - winY0 + 0.5);
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath(); ctx.ellipse(gp.x, gp.y + 2, 13, 4.5, 0, 0, Math.PI * 2); ctx.fill();
      if (h.kind === 'guardian') {
        ctx.fillStyle = '#5d666e'; ctx.fillRect(gp.x - 10, gp.y - 20, 20, 20);
        ctx.fillStyle = '#8a9299'; ctx.fillRect(gp.x - 10, gp.y - 20, 20, 5);
        ctx.fillStyle = '#ff4030'; ctx.beginPath(); ctx.arc(gp.x, gp.y - 10, 3.4, 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.fillStyle = '#23282c';
        ctx.beginPath(); ctx.ellipse(gp.x, gp.y - 8, 13, 8, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#39424a';
        ctx.beginPath(); ctx.ellipse(gp.x - 4, gp.y - 13, 6, 4.4, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#ffd75e';
        ctx.beginPath(); ctx.arc(gp.x - 6, gp.y - 13, 1.6, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(gp.x - 2, gp.y - 13, 1.6, 0, Math.PI * 2); ctx.fill();
      }
      for (var i = 0; i < h.hp; i++) { ctx.fillStyle = '#ff8d84'; ctx.fillRect(gp.x - 8 + i * 6, gp.y - 30, 4.5, 3.5); }
      ctx.fillStyle = 'rgba(10,14,18,0.85)';
      ctx.font = '800 8.5px sans-serif'; ctx.textAlign = 'center';
      var nm = h.name.toUpperCase();
      var tw = ctx.measureText(nm).width + 7;
      ctx.fillRect(gp.x - tw / 2, gp.y + 5, tw, 12);
      ctx.fillStyle = '#ff9d94'; ctx.fillText(nm, gp.x, gp.y + 14);
    });
    var am = exp.members.find(function (m) { return m.id === exp.activeId; });
    if (am && exp.pendingPath && exp.pendingPath.length) {
      ctx.strokeStyle = 'rgba(218,202,71,0.75)'; ctx.lineWidth = 2; ctx.setLineDash([4, 4]);
      ctx.beginPath();
      var p0 = groundProject(am.x - winX0 + 0.5, am.y - winY0 + 0.5);
      ctx.moveTo(p0.x, p0.y);
      exp.pendingPath.forEach(function (s) {
        var pp = groundProject(s.x - winX0 + 0.5, s.y - winY0 + 0.5);
        ctx.lineTo(pp.x, pp.y);
      });
      ctx.stroke(); ctx.setLineDash([]);
    }
    exp.members.forEach(function (m) {
      var d = diverById(m.id); if (!d) return;
      var gp = groundProject(m.x - winX0 + 0.5, m.y - winY0 + 0.5);
      var fx2 = gp.x, fy2 = gp.y;
      scen.figScreen.push({ id: m.id, x: fx2, y: fy2, gx: gp.x, gy: gp.y });
      ctx.fillStyle = 'rgba(0,0,0,0.42)';
      ctx.beginPath(); ctx.ellipse(gp.x, gp.y, 12, 4.5, 0, 0, Math.PI * 2); ctx.fill();
      var dead = d.status === 'dead';
      ctx.save();
      if (dead) { ctx.translate(fx2, fy2); ctx.rotate(1.35); ctx.globalAlpha = 0.5; ctx.translate(-fx2, -fy2); }
      var suit = SUIT_DRAW[P.primaryTrait(d)] || SUIT_DRAW.none;
      ctx.fillStyle = suit;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(fx2 - 7, fy2 - 14, 14, 16, 4); else ctx.rect(fx2 - 7, fy2 - 14, 14, 16);
      ctx.fill();
      var img = P.image(d, variantOf(d));
      if (img.complete && img.naturalWidth) {
        ctx.save();
        ctx.beginPath(); ctx.arc(fx2, fy2 - 20, 9, 0, Math.PI * 2); ctx.clip();
        ctx.drawImage(img, fx2 - 9, fy2 - 29, 18, 18);
        ctx.restore();
        ctx.strokeStyle = d.wounds ? '#ff5040' : '#daca47'; ctx.lineWidth = d.wounds ? 2.6 : 1.4;
        ctx.beginPath(); ctx.arc(fx2, fy2 - 20, 9, 0, Math.PI * 2); ctx.stroke();
      } else {
        ctx.fillStyle = '#e8b48c'; ctx.beginPath(); ctx.arc(fx2, fy2 - 20, 8, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
      if (exp.activeId === m.id && !dead) {
        ctx.strokeStyle = '#daca47'; ctx.lineWidth = 2.4;
        ctx.beginPath(); ctx.ellipse(gp.x, gp.y + 1, 16, 6.5, 0, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.fillStyle = 'rgba(10,14,18,0.85)';
      var nm2 = d.name.split(' ')[0].toUpperCase();
      ctx.font = '800 9.5px sans-serif'; ctx.textAlign = 'center';
      var tw2 = ctx.measureText(nm2).width + 8;
      ctx.fillRect(gp.x - tw2 / 2, gp.y + 5, tw2, 13);
      ctx.fillStyle = dead ? '#888' : '#fff'; ctx.fillText(nm2, gp.x, gp.y + 15);
      if (!dead) for (var pi = 0; pi < E.TUN.apPerTurn; pi++) {
        ctx.fillStyle = pi < m.ap ? '#daca47' : 'rgba(218,202,71,0.25)';
        ctx.beginPath(); ctx.arc(gp.x - (E.TUN.apPerTurn - 1) * 4 + pi * 8, gp.y + 24, 2.6, 0, Math.PI * 2); ctx.fill();
      }
    });
  }
  function drawScenario() {
    var ctx = scenCtx, Wd = scenCanvas.width, H = scenCanvas.height;
    ctx.save();
    if (scen.shake > 0) ctx.translate((Math.random() - 0.5) * 10 * scen.shake, (Math.random() - 0.5) * 7 * scen.shake);
    var smp = scen.sample || { storm: 0, cloud: 0.3, wind: { x: 0, y: 0 }, turbulence: 0 };
    // Sky
    var sky = ctx.createLinearGradient(0, 0, 0, H);
    var dark = smp.storm * 0.5;
    sky.addColorStop(0, 'rgb(' + Math.round(38 - dark * 18) + ',' + Math.round(66 - dark * 24) + ',' + Math.round(94 - dark * 30) + ')');
    sky.addColorStop(0.62, 'rgb(' + Math.round(24 - dark * 8) + ',' + Math.round(46 - dark * 14) + ',' + Math.round(66 - dark * 18) + ')');
    sky.addColorStop(1, '#131e28');
    ctx.fillStyle = sky; ctx.fillRect(-20, -20, Wd + 40, H + 40);
    // Drifting cloud masses
    ctx.fillStyle = 'rgba(235,242,248,0.20)';
    for (var ci = 0; ci < 6; ci++) {
      var cx = ((ci * 230 + scen.t * (6 + smp.wind.x * 22)) % (Wd + 260)) - 130;
      var cy = 40 + (ci % 3) * 52;
      ctx.beginPath(); ctx.ellipse(cx, cy, 120 + (ci % 3) * 40, 17 + (ci % 2) * 7, 0, 0, Math.PI * 2); ctx.fill();
    }
    // Cinematic fall (#17/#22): during the descent the cloud layer RUSHES
    // past the camera — the squad is falling through it, fast.
    if (scen.phase === 'descent' && !reducedMotion) {
      ctx.fillStyle = 'rgba(235,242,248,0.13)';
      for (var si = 0; si < 10; si++) {
        var sx2 = (si * 113 + 40) % Wd, sy2 = (scen.t * 720 + si * 137) % (H + 60) - 30;
        ctx.beginPath(); ctx.ellipse(sx2, sy2, 60 + (si % 3) * 30, 10, 0, 0, Math.PI * 2); ctx.fill();
      }
    }
    // Rain, driven by the same sample the map uses
    if (smp.storm > 0.22 && !reducedMotion) {
      ctx.strokeStyle = 'rgba(180,215,245,0.5)'; ctx.lineWidth = 1.4;
      var rn = Math.floor(smp.storm * 150);
      ctx.beginPath();
      for (var ri = 0; ri < rn; ri++) {
        var rx = (ri * 89.7 + (scen.t * 620) % 97) % Wd;
        var ry = (ri * 57.3 + scen.t * 880) % H;
        ctx.moveTo(rx, ry); ctx.lineTo(rx - 5 - smp.wind.x * 4, ry + 15);
      }
      ctx.stroke();
    }
    // Airship leaving the frame (descent only)
    if (scen.phase === 'descent') {
      var shx = 170 - scen.descentT * 9, shy = 66 + Math.sin(scen.t * 2) * 3;
      ctx.fillStyle = '#241a10';
      ctx.beginPath(); ctx.ellipse(shx, shy, 74, 22, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#3a2c1c';
      ctx.fillRect(shx - 14, shy + 12, 28, 10);
      ctx.fillStyle = 'rgba(242,236,217,0.85)'; ctx.font = '700 11px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('AIRSHIP', shx, shy + 38);
    }
    // Ground window (13x13 around the target)
    var winX0 = clamp(scen.target.x - 6, 0, T.gridW - 13), winY0 = clamp(scen.target.y - 6, 0, T.gridH - 13);
    for (var wy = 0; wy < 13; wy++) for (var wx = 0; wx < 13; wx++) {
      var tx = winX0 + wx, ty = winY0 + wy;
      var t = C.tileAt(state, tx, ty);
      var p1 = groundProject(wx, wy), p2 = groundProject(wx + 1, wy), p3 = groundProject(wx + 1, wy + 1), p4 = groundProject(wx, wy + 1);
      ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.lineTo(p3.x, p3.y); ctx.lineTo(p4.x, p4.y); ctx.closePath();
      var terrainCol = !t.discovered ? '#252d36' : t.terrain === 'water' ? '#2f5676' : t.terrain === 'rough' ? '#8a7648' : t.terrain === 'ruin' ? '#786d60' : '#74904e';
      if (t.isGreenZone && t.discovered) terrainCol = '#679c46';
      // Exploration fog (#16): on the ground you only SEE what the squad has
      // lit — seen tiles burn bright, mapped tiles are memory (dim), and
      // the rest is murk. Sites/caches show only when seen (or when a
      // tipster's intel has marked the ground).
      var key2 = tx + ',' + ty;
      var seenNow = !scen.exp ? true : !!scen.exp.seen[key2];
      var mappedNow = !scen.exp ? true : !!scen.exp.mapped[key2];
      if (scen.exp && scen.phase === 'explore') {
        ctx.fillStyle = seenNow ? terrainCol : mappedNow ? '#3a3f45' : '#10151b';
      } else ctx.fillStyle = terrainCol;
      ctx.fill();
      ctx.strokeStyle = 'rgba(5,8,10,0.35)'; ctx.lineWidth = 1; ctx.stroke();
      var ctr = groundProject(wx + 0.5, wy + 0.5);
      var intelNow = !!(scen.exp && scen.exp.intelSites && mappedNow);
      if (t.discovered && (seenNow || intelNow) && ((t.supplySite && !t.supplySite.looted) || (t.robotSite && !t.robotSite.cleared))) { ctx.fillStyle = '#e8e4d8'; ctx.font = '900 13px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(t.robotSite && !t.robotSite.cleared ? '▦' : '▣', ctr.x, ctr.y + 4); }
      if (t.discovered && seenNow && t.resourceType) {
        ctx.fillStyle = '#ffe9a8'; ctx.font = '900 12px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(t.resourceType === 'FUEL' ? '⛽' : t.resourceType === 'FOOD' ? '♨' : '⬢', ctr.x, ctr.y + 4);
      }
      if (scen.exp && scen.phase === 'explore' && seenNow) {
        if (scen.exp.drift[key2]) { ctx.fillStyle = '#daca47'; ctx.font = '900 14px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('✦', ctr.x, ctr.y + 5); }
        if (scen.exp.decoy && scen.exp.decoy.x === tx && scen.exp.decoy.y === ty) {
          ctx.strokeStyle = '#daca47'; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.ellipse(ctr.x, ctr.y, 12, 6, 0, 0, Math.PI * 2); ctx.stroke();
          ctx.fillStyle = '#daca47'; ctx.font = '900 13px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('?', ctr.x, ctr.y + 4);
        }
      }
      if (t.discovered && (seenNow || (scen.exp && scen.exp.intelThreats && mappedNow)) && t.threat >= 3 && ((t.reconTier || 0) >= 1 || (scen.exp && scen.exp.intelThreats))) { ctx.fillStyle = '#ff8d84'; ctx.font = '900 13px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('!', ctr.x, ctr.y + 4); }
      if (tx === scen.target.x && ty === scen.target.y) {
        ctx.strokeStyle = '#daca47'; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.ellipse(ctr.x, ctr.y, 15, 7, 0, 0, Math.PI * 2); ctx.stroke();
      }
    }
    // Lightning hazards in the cloud layer (#22): a charging column the
    // player steers clear of, then the strike itself.
    if (scen.phase === 'descent') {
      var anyStrike = false;
      scen.hazards.forEach(function (hz) {
        if (hz.state !== 'tele' && hz.state !== 'strike') return;
        if (hz.state === 'strike') anyStrike = true;
        var hp2 = groundProject(hz.hx - winX0 + 0.5, 6.5);
        var tele = hz.state === 'tele';
        var prog = tele ? clamp((scen.descentT - hz.at) / Math.max(0.01, hz.teleUntil - hz.at), 0, 1) : 1;
        ctx.save();
        ctx.globalAlpha = tele ? 0.22 + prog * 0.5 : 0.95;
        ctx.fillStyle = tele ? '#cfe6ff' : '#ffffff';
        var colW = tele ? 5 + prog * 9 : 16;
        ctx.fillRect(hp2.x - colW / 2, 58, colW, Math.max(10, hp2.y - 58));
        ctx.font = '900 ' + (tele ? 17 : 24) + 'px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('⚡', hp2.x, 50);
        ctx.restore();
      });
      if (anyStrike && !reducedMotion) { ctx.fillStyle = 'rgba(255,255,255,0.16)'; ctx.fillRect(-20, -20, Wd + 40, H + 40); }
    }
    // Projected landing ring (fall + touchdown only — on the ground the
    // squad IS the marker)
    if (scen.phase === 'descent' || scen.phase === 'impact') {
      var lx = clamp(Math.round(scen.mx), 0, 23), ly = clamp(Math.round(scen.my), 0, 23);
      var lp = groundProject(lx - winX0 + 0.5, ly - winY0 + 0.5);
      ctx.strokeStyle = scen.phase === 'descent' ? 'rgba(255,255,255,0.9)' : '#bf4e4e';
      ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.ellipse(lp.x, lp.y, 17, 8, 0, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
    }
    // Squad figures. During the fall the camera is ZOOMED on them (#17 —
    // the cinematic): figures render at 1.5×. On the ground, the expedition
    // renderer draws each diver at their real tile.
    var alt = scen.phase === 'descent' ? 1 - clamp((scen.descentT || 0) / scen.dur, 0, 1) : 0;
    var FS = scen.phase === 'descent' ? 1.5 : 1;
    scen.figScreen = [];
    if (scen.exp && scen.phase === 'explore') drawGroundFigures(ctx, winX0, winY0, smp);
    else scen.squadIds.forEach(function (id, i) {
      var d = diverById(id); if (!d) return;
      var off = FORMATION[i % FORMATION.length];
      var gp = groundProject(scen.mx - winX0 + 0.5 + off[0], scen.my - winY0 + 0.5 + off[1]);
      var sway = alt > 0 ? Math.sin(scen.t * 3 + i * 1.7) * 6 * (0.4 + smp.turbulence) : 0;
      var fx2 = gp.x + sway, fy2 = gp.y - alt * 400;
      scen.figScreen.push({ id: id, x: fx2, y: fy2, gx: gp.x, gy: gp.y });
      // Shadow
      ctx.fillStyle = 'rgba(0,0,0,' + (0.14 + 0.3 * (1 - alt)).toFixed(2) + ')';
      ctx.beginPath(); ctx.ellipse(gp.x, gp.y, 5 + 13 * (1 - alt), 2.5 + 5 * (1 - alt), 0, 0, Math.PI * 2); ctx.fill();
      var deadFx = scen.effects.some(function (e) { return e.kind === 'death' && e.diverId === id; });
      var woundFx = scen.effects.some(function (e) { return e.kind === 'wound' && e.diverId === id; });
      ctx.save();
      if (deadFx) { ctx.translate(fx2, fy2); ctx.rotate(1.35); ctx.globalAlpha = 0.55; ctx.translate(-fx2, -fy2); }
      // Canopy
      if (alt > 0.03) {
        ctx.strokeStyle = 'rgba(240,231,211,0.9)'; ctx.lineWidth = 1.6;
        ctx.beginPath(); ctx.arc(fx2, fy2 - 30 * FS, 16 * FS, Math.PI, 0); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(fx2 - 16 * FS, fy2 - 30 * FS); ctx.lineTo(fx2 - 4 * FS, fy2 - 12 * FS); ctx.moveTo(fx2 + 16 * FS, fy2 - 30 * FS); ctx.lineTo(fx2 + 4 * FS, fy2 - 12 * FS); ctx.stroke();
      }
      // Body + portrait head
      var suit = SUIT_DRAW[P.primaryTrait(d)] || SUIT_DRAW.none;
      ctx.fillStyle = suit;
      var crouch = scen.phase === 'impact' ? 1 - 0.3 * Math.sin(Math.PI * clamp(scen.t / 0.85, 0, 1)) : 1;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(fx2 - 7 * FS, fy2 - 14 * FS * crouch, 14 * FS, 16 * FS * crouch, 4); else ctx.rect(fx2 - 7, fy2 - 14, 14, 16);
      ctx.fill();
      var img = P.image(d, variantOf(d));
      if (img.complete && img.naturalWidth) {
        ctx.save();
        ctx.beginPath(); ctx.arc(fx2, fy2 - 20 * FS * crouch, 9 * FS, 0, Math.PI * 2); ctx.clip();
        ctx.drawImage(img, fx2 - 9 * FS, fy2 - 20 * FS * crouch - 9 * FS, 18 * FS, 18 * FS);
        ctx.restore();
        ctx.strokeStyle = woundFx ? '#ff5040' : '#daca47'; ctx.lineWidth = woundFx ? 2.6 : 1.4;
        ctx.beginPath(); ctx.arc(fx2, fy2 - 20 * FS * crouch, 9 * FS, 0, Math.PI * 2); ctx.stroke();
      } else {
        ctx.fillStyle = '#e8b48c'; ctx.beginPath(); ctx.arc(fx2, fy2 - 20 * FS * crouch, 8 * FS, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
      if (alt < 0.45) {
        ctx.fillStyle = 'rgba(10,14,18,0.85)';
        var nm = d.name.split(' ')[0].toUpperCase();
        ctx.font = '800 9.5px sans-serif'; ctx.textAlign = 'center';
        var tw = ctx.measureText(nm).width + 8;
        ctx.fillRect(gp.x - tw / 2, gp.y + 5, tw, 13);
        ctx.fillStyle = '#fff'; ctx.fillText(nm, gp.x, gp.y + 15);
      }
    });
    // Particles (dust / splash)
    scen.particles.forEach(function (p) {
      ctx.globalAlpha = clamp(1 - p.life / p.ttl, 0, 1);
      ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
    });
    ctx.globalAlpha = 1;
    // Encounter effects: balloons haul the yield up; yield chips float.
    scen.effects.forEach(function (e) {
      var age = scen.t - e.at;
      var fig = scen.figScreen[0];
      if (!fig) return;
      if (e.kind === 'balloon' || e.kind === 'yield') {
        var bx = fig.gx + 26, by = fig.gy - 30 - age * 46;
        ctx.strokeStyle = 'rgba(240,231,211,0.8)'; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(bx, by + 14); ctx.lineTo(bx, by + 30); ctx.stroke();
        ctx.fillStyle = e.kind === 'snag' && age > 1.2 ? '#8a8f96' : '#d8b84a';
        ctx.beginPath(); ctx.ellipse(bx, by, 11, 13, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#5a4632'; ctx.fillRect(bx - 6, by + 28, 12, 9);
        if (e.kind === 'snag') { ctx.fillStyle = '#ff8d84'; ctx.font = '900 15px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('✖', bx + 14, by + 4); }
      }
      if (e.kind === 'wound') {
        var wf = scen.figScreen.find(function (f) { return f.id === e.diverId; }) || fig;
        ctx.fillStyle = '#ff5040'; ctx.font = '900 20px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('✚', wf.x + 14, wf.y - 26);
      }
    });
    // Letterbox bars — the fall is a MOVIE (#17).
    if (scen.phase === 'descent') {
      ctx.fillStyle = '#05080a';
      ctx.fillRect(-20, -20, Wd + 40, 52);
      ctx.fillRect(-20, H - 32, Wd + 40, 52);
      ctx.fillStyle = 'rgba(218,202,71,0.5)';
      ctx.fillRect(-20, 31, Wd + 40, 1.5);
      ctx.fillRect(-20, H - 33, Wd + 40, 1.5);
    }
    // HUD
    ctx.fillStyle = 'rgba(10,14,18,0.88)';
    ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(14, 12, 300, 86, 8); else ctx.rect(14, 12, 300, 86); ctx.fill();
    ctx.strokeStyle = '#daca47'; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.fillStyle = '#f2ecd9'; ctx.textAlign = 'left';
    ctx.font = '900 14px sans-serif';
    ctx.fillText('DROP → ' + tileLabel(scen.target.x, scen.target.y) + ' · ' + scen.kind.toUpperCase(), 26, 36);
    ctx.font = '700 12.5px sans-serif';
    if (scen.phase === 'descent') {
      ctx.fillText('ALTITUDE ' + Math.round(alt * 100) + '%', 26, 56);
      ctx.fillText('WIND → ' + smp.wind.x.toFixed(1) + ', ' + smp.wind.y.toFixed(1) + (smp.storm > 0.25 ? ' · STORM ' + Math.round(smp.storm * 100) + '%' : '') + (scen.gustWasOn ? ' · 💨 GUST' : ''), 26, 74);
      ctx.fillText('LAND IF DOWN NOW: ' + (scen.landEst ? scen.landEst.land : '—') + (scen.hits ? ' · ⚡ STRUCK ×' + scen.hits : ''), 26, 92);
    } else if (scen.phase === 'explore' && scen.exp) {
      var amH = E.activeMember(C, state, scen.exp);
      ctx.fillText('GROUND TURN ' + scen.exp.turn + (amH ? ' · ' + (diverById(amH.id) || {}).name.split(' ')[0] + ' LEADS · ' + amH.ap + ' AP' : ''), 26, 56);
      ctx.fillText('CARRIED: ' + carriedText(scen.exp).toUpperCase(), 26, 74);
      ctx.fillText(scen.exp.encounter ? '⚠ ' + scen.exp.encounter.title.toUpperCase() : (scen.exp.hostiles.length ? '⚠ ' + scen.exp.hostiles.length + ' HOSTILE(S) ON THE GROUND' : 'EXTRACT WHEN READY — THE LIFT WAITS'), 26, 92);
    } else {
      ctx.fillText('PHASE: ' + scen.phase.toUpperCase(), 26, 56);
      if (scen.landing) ctx.fillText('LANDED ' + tileLabel(scen.landing.finalTile.x, scen.landing.finalTile.y) + ' · LAND ' + scen.landing.land, 26, 74);
      if (scen.report && scen.report.ok) ctx.fillText('OUTCOME: ' + scen.report.band.toUpperCase(), 26, 92);
    }
    // Squad portrait chips, top-right
    scen.squadIds.forEach(function (id, i) {
      var d = diverById(id); if (!d) return;
      var img = P.image(d, variantOf(d));
      var cxp = Wd - 46 - i * 42, cyp = 14;
      ctx.fillStyle = 'rgba(10,14,18,0.85)'; ctx.fillRect(cxp - 17, cyp, 34, 34);
      if (img.complete && img.naturalWidth) ctx.drawImage(img, cxp - 16, cyp + 1, 32, 32);
      var dead = d.status === 'dead';
      var wounded = d.wounds > 0;
      ctx.strokeStyle = dead ? '#666' : wounded ? '#ff5040' : '#daca47'; ctx.lineWidth = 2;
      ctx.strokeRect(cxp - 17, cyp, 34, 34);
      if (dead) { ctx.fillStyle = 'rgba(20,20,20,0.55)'; ctx.fillRect(cxp - 17, cyp, 34, 34); }
    });
    ctx.restore();
  }

  /* ---------------- panel wiring ---------------- */
  $('dz-btn-drop').addEventListener('click', function () {
    if (scen.active) return;
    if (!sel.squad.length) { feedback('Select a squad first — click divers (shift-click adds).', true); return; }
    if (sel.tile) startScenario(sel.tile.x, sel.tile.y);
    else { dropArmed = true; feedback('Drop armed — now tap the target tile (or right-click it). Esc cancels.'); }
  });
  $('dz-btn-move').addEventListener('click', function () { if (!scen.active && sel.tile) doMove(sel.tile.x, sel.tile.y); });
  $('dz-btn-recon').addEventListener('click', function () { if (!scen.active) doRecon(); });
  $('dz-btn-found').addEventListener('click', function () { if (!scen.active) doFound(); });
  $('dz-btn-refuel').addEventListener('click', function () { if (!scen.active) doRefuel(); });
  $('dz-btn-endturn').addEventListener('click', function () { if (!scen.active) doEndTurn(); });
  $('dz-btn-skip').addEventListener('click', skipScenario);
  $('dz-squad-all').addEventListener('click', function () {
    if (scen.active) return;
    var ids = state.divers.filter(function (d) { return C.diverAvailable(state, d); }).map(function (d) { return d.id; });
    if (!ids.length) { feedback('No divers are available to drop.', true); return; }
    sel.squad = ids; sel.primary = ids[0]; sel.ship = false;
    feedbackGood('Squad: all ' + ids.length + ' available divers.');
    renderSector(false); renderPanel();
  });
  $('dz-squad-clear').addEventListener('click', function () { sel.squad = []; sel.primary = null; renderSector(false); renderPanel(); });
  $('dz-zoom-in').addEventListener('click', function () { setZoomTarget(cam.tZoom + 0.2); });
  $('dz-zoom-out').addEventListener('click', function () { setZoomTarget(cam.tZoom - 0.2); });
  $('dz-zoom-reset').addEventListener('click', function () { cam.tZoom = 1; cam.tPanX = 0; cam.tPanY = 0; });
  $('dz-edgepan').addEventListener('change', function (e) { edgePanOn = e.target.checked; });
  $('dz-reduced').addEventListener('change', function (e) {
    reducedMotion = e.target.checked;
    document.body.classList.toggle('dz-reduced', reducedMotion);
  });
  minimap.addEventListener('click', function (e) {
    var r = minimap.getBoundingClientRect();
    var x = clamp(Math.floor((e.clientX - r.left) / r.width * T.gridW), 0, 23);
    var y = clamp(Math.floor((e.clientY - r.top) / r.height * T.gridH), 0, 23);
    centerOn(x, y);
    feedback('Camera jumped to ' + tileLabel(x, y) + '.');
  });
  $('dz-seed-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = $('dz-seed').value.trim();
    location.search = '?seed=' + encodeURIComponent(v || seed);
  });
  $('dz-newgame').addEventListener('click', function () {
    location.search = '?seed=' + encodeURIComponent('dz-' + Date.now().toString(36));
  });

  /* ---------------- main loop ---------------- */
  var lastTs = performance.now();
  var mmT = 0, wxT = 0, boltT = 4;
  function frame(ts) {
    requestAnimationFrame(frame); // schedule first: one bad frame can never kill the loop
    var dt = Math.min(0.05, (ts - lastTs) / 1000);
    lastTs = ts;
    W.advance(weather, dt * 0.5, { w: T.gridW, h: T.gridH });
    if (!scen.active) {
      var spd = 560 * dt;
      if (keysDown.ArrowLeft) cam.tPanX += spd;
      if (keysDown.ArrowRight) cam.tPanX -= spd;
      if (keysDown.ArrowUp) cam.tPanY += spd;
      if (keysDown.ArrowDown) cam.tPanY -= spd;
      if (edgePanOn && mouseStage && !drag) {
        var m = 22, es = 500 * dt;
        if (mouseStage.x < m) cam.tPanX += es;
        if (mouseStage.x > mouseStage.w - m) cam.tPanX -= es;
        if (mouseStage.y < m) cam.tPanY += es;
        if (mouseStage.y > mouseStage.h - m) cam.tPanY -= es;
      }
      clampPan();
    }
    var k = Math.min(1, dt * 13);
    cam.panX += (cam.tPanX - cam.panX) * k;
    cam.panY += (cam.tPanY - cam.panY) * k;
    cam.zoom += (cam.tZoom - cam.zoom) * k;
    applyCam();
    positionOverlays();
    var center = W.sampleWeather(weather, 12, 10);
    stage.classList.toggle('dz-stormy', center.storm > 0.34);
    if (center.storm > 0.45 && !reducedMotion) {
      boltT -= dt;
      if (boltT <= 0) {
        boltT = 2.5 + Math.random() * 5;
        flashEl.classList.remove('out'); flashEl.classList.add('go');
        setTimeout(function () { flashEl.classList.add('out'); flashEl.classList.remove('go'); }, 110);
      }
    }
    if (scen.active) updateScenario(dt);
    mmT += dt; if (mmT > 0.5) { mmT = 0; drawMinimap(); }
    wxT += dt; if (wxT > 2.5) { wxT = 0; renderWeather(); renderStatus(); }
  }

  /* ---------------- boot + test handle ---------------- */
  $('dz-seed').value = seed;
  $('dz-reduced').checked = reducedMotion;
  document.body.classList.toggle('dz-reduced', reducedMotion);
  buildClouds();
  buildPlane();
  renderPanel();
  drawMinimap();
  applyCam();
  feedbackGood('Next build staged — the live map is untouched. One window, everything in the panel.');
  log('Controls: click divers to squad up (shift adds) · right-click a tile = drop NOW · arrows/edge/drag pan · scroll zooms to your selection · F focuses it.');
  requestAnimationFrame(frame);

  window.DropZoneNext = {
    version: 'next-1',
    state: state, weather: weather, core: C,
    getSquad: function () { return sel.squad.slice(); },
    getSelection: function () {
      return { tile: sel.tile ? { x: sel.tile.x, y: sel.tile.y } : null, ship: sel.ship, squad: sel.squad.slice(), primary: sel.primary };
    },
    selectDiver: selectDiver, selectShip: selectShip, selectTile: selectTile, clearSelection: clearSelection,
    setSquad: function (ids) { sel.squad = ids.slice(); sel.primary = ids[0] || null; sel.ship = false; renderSector(false); renderPanel(); },
    startDrop: function (x, y) { return startScenario(x, y); },
    scenarioPhase: function () { return scen.active ? scen.phase : null; },
    scenarioActive: function () { return scen.active; },
    scenarioFF: scenarioFF,
    skipScenario: skipScenario,
    lastReport: function () { return lastReport; },
    getCam: function () { return { zoom: cam.zoom, tZoom: cam.tZoom, panX: cam.panX, panY: cam.panY, tPanX: cam.tPanX, tPanY: cam.tPanY }; },
    setZoom: setZoomTarget,
    centerOn: centerOn,
    focusSelection: focusSelection,
    stagedPositions: function () { return stagedDivers().map(function (s) { return { id: s.diver.id, x: s.x, y: s.y }; }); },
    diverScreenPos: function (id) {
      var el = diverAnchorEls[id];
      if (!el) return null;
      var r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    },
    viewportCenter: function () { var r = viewport.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; },
    viewportRect: function () { var r = viewport.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; },
    menuOpen: menuOpen,
    pickTileAt: function (clientX, clientY) { return pickTile(clientX, clientY); },
    planePointAt: function (clientX, clientY) { return planePointFromScreen(clientX, clientY); },
    probeRects: function () {
      var out = {};
      Object.keys(probeEls).forEach(function (k) { var r = probeEls[k].getBoundingClientRect(); out[k] = { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width }; });
      return out;
    },
    tileCenter: function (x, y) { var r = tileEls[y][x].getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; },
    endTurn: doEndTurn,
    // Exploration phase (encounters.js) — dev/test surface.
    encounters: function () { return window.DropZoneEncounters || null; },
    expedition: function () { return scen.exp; },
    expMove: function (x, y) {
      if (!scen.exp) return null;
      var r = E.moveActive(C, state, scen.exp, x, y);
      var guard = 0;
      while (scen.exp.pendingPath && !scen.exp.encounter && guard++ < 60) {
        var st = E.continueMove(C, state, scen.exp);
        if (!st.moved) break;
      }
      afterExpAction(r); renderPanel();
      return r;
    },
    expSetActive: function (id) { if (scen.exp) { E.setActive(scen.exp, id); renderExpeditionUI(); } },
    expChoose: function (id) {
      if (!scen.exp) return null;
      var r = E.choose(C, state, scen.exp, id);
      if (r && r.extract) { extractNow(); return r; }
      afterExpAction(r); renderPanel();
      return r;
    },
    expInteract: function () { if (!scen.exp) return null; var r = E.interact(C, state, scen.exp); afterExpAction(r); renderPanel(); return r; },
    expFire: function (hid) { if (!scen.exp) return null; var r = E.fireAt(C, state, scen.exp, hid); afterExpAction(r); renderPanel(); return r; },
    expEndTurn: function () { if (!scen.exp) return null; var r = E.endTurn(C, state, scen.exp); afterExpAction(r); renderPanel(); return r; },
    expExtract: function () { if (scen.exp) extractNow(); },
    expSpawnHostile: function (x, y, kind) { return scen.exp ? E.spawnHostiles(C, state, scen.exp, kind, x, y, 1, 0) : null; },
    expForceEncounter: function (kind) {
      if (!scen.exp) return null;
      var enc = E.forceEncounter(C, state, scen.exp, kind);
      afterExpAction({ ok: true });
      return enc ? enc.kind : null;
    },
    descentHits: function () { return scen.hits; },
    hazards: function () { return scen.hazards.length; }
  };
})();
