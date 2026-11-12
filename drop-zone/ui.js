/* DROP ZONE slice — UI layer. All rules live in core.js (DropZoneCore); this
 * file only renders state and forwards player actions. No game math here
 * except presentation of the descent steer, whose LAND score is computed
 * by core.computeLanding per spec §5.3. */
(function () {
  'use strict';
  var C = window.DropZoneCore;
  // Optional presentation modules (loaded by index.html; null-guarded so
  // headless harnesses that boot ui.js alone never break).
  var G = window.DropZoneGround || null;       // ground battle engine (§1)
  var P = window.DropZonePortraits || null;    // procedural busts (§6)
  var W = window.DropZoneWeapons || null;      // hand-drawn weapon icons (§6)
  var SFX = window.DropZoneSfx || null;        // catalogue clips (§4)
  var SAVE_KEY = 'dropzone-save-v1';
  var state = null;
  var currentScreen = 'map';
  var selected = { x: 2, y: 2 };
  var lastLanding = null;      // {land, reasons[]} from the descent, shown in the report
  var defenseSpeed = 1;
  var descent = null;
  var expedition = null;       // the live ground battle, if one is running
  var groundTargetId = null;   // hostile selected on the ground grid
  var groundOutcome = null;    // plain-word result lines of the last encounter choice
  var groundEncSeen = null;    // encounter object the ground screen last rendered
  var groundEncToastFor = null; // encounter object the pointer toast already fired for
  var skipBattlePref = false;  // briefing checkbox: resolve by band math
  var firstDropGuideAcknowledged = false;
  var pendingDrop = null;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }
  function toast(msg) {
    var t = $('toast'); t.textContent = msg; t.hidden = false;
    setTimeout(function () { t.hidden = true; }, 3400);
  }

  /* ---------------- Feedback sounds (WebAudio blips, no assets) ---------- */
  var SOUND_KEY = 'dropzone-sound-v1';
  var soundOn = true;
  try { soundOn = localStorage.getItem(SOUND_KEY) !== 'off'; } catch (e) { /* default on */ }
  var audioCtx = null;
  function blip(f0, f1, dur, type, vol, delay) {
    if (!soundOn) return;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      audioCtx = audioCtx || new AC();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      var t0 = audioCtx.currentTime + (delay || 0);
      var osc = audioCtx.createOscillator(), g = audioCtx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(f0, t0);
      if (f1 && f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
      g.gain.setValueAtTime(vol, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g); g.connect(audioCtx.destination);
      osc.start(t0); osc.stop(t0 + dur + 0.03);
    } catch (e) { /* audio is garnish — never break the game for it */ }
  }
  // Feedback (§4): real catalogue clips via sfx.js when present; the
  // legacy synth blips remain the last-resort fallback (and the only
  // path in headless harnesses, where sfx.js is not loaded).
  function playSfx(id) {
    if (SFX) { SFX.setEnabled(soundOn); SFX.play(id); return; }
    if (!soundOn) return;
    var legacy = {
      select: function () { blip(620, 940, 0.07, 'square', 0.035); },
      deselect: function () { blip(480, 300, 0.07, 'square', 0.03); },
      confirm: function () { blip(520, 780, 0.08, 'square', 0.04); },
      denied: function () { blip(150, 105, 0.16, 'sawtooth', 0.05); },
      readyfly: function () { blip(180, 360, 0.22, 'sawtooth', 0.05); }
    };
    (legacy[id] || legacy.select)();
  }
  function fxMark(name) { if (SFX) SFX.fx(name); }
  var sfx = {
    select:   function () { playSfx('select'); },
    deselect: function () { playSfx('deselect'); },
    buy:      function () { playSfx('confirm'); },
    launch:   function () { playSfx('readyfly'); },
    denied:   function () { playSfx('denied'); }
  };

  /* ---------------- Thumbnails (§6): portraits + weapon icons ---------- */
  var LOOKS_KEY = 'dropzone-looks-v1';
  function looksMap() {
    try { return JSON.parse(localStorage.getItem(LOOKS_KEY) || '{}'); } catch (e) { return {}; }
  }
  function lookOf(d) { return looksMap()[d.id] || 0; }
  function cycleLook(d) {
    var m = looksMap(); m[d.id] = ((m[d.id] || 0) + 1) % 4;
    try { localStorage.setItem(LOOKS_KEY, JSON.stringify(m)); } catch (e) { /* ignore */ }
    return m[d.id];
  }
  function thumb(d, cls) {
    if (!P || !d) return '';
    var extra = d.status === 'dead' ? ' thumb-dead' : (d.wounds > 0 ? ' thumb-wounded' : '');
    return '<img class="thumb ' + (cls || '') + extra + '" src="' + P.url(d, lookOf(d)) +
      '" alt="" width="44" height="44">';
  }
  function wicon(weaponName) {
    if (!W) return '';
    return '<span class="wicon" title="' + esc(weaponName) + '">' + W.icon(weaponName) + '</span>';
  }
  function archBadge(d) {
    var a = C.ensureArchetype(d);
    var def = C.ARCHETYPES[a];
    return '<span class="arch-badge" title="Archetype: ' + esc(def.label) + '">' + def.icon + ' ' + esc(def.label) + '</span>';
  }
  function gearHtml(d) {
    var line = C.gearLineFor(state, d);
    var g = C.gearFor(d);
    return '<span class="gear-line">' + wicon(line.split(' · ')[0]) +
      '<span class="gw">' + esc(line) + '</span>' +
      (g ? ' <span class="muted">— ' + esc(g.effect) + '</span>' : '') + '</span>';
  }

  /* ---------------- Lobby visuals: stat bars + meter animation ---------- */
  var fxPrev = { pool: null, exp: null };   // last gauge/needle positions, so re-renders animate instead of jumping
  function statBar(label, v) {
    var pct = Math.max(0, Math.min(100, v * 10));
    return '<span class="sbar"><i>' + label + '</i><b><u style="width:' + pct + '%"></u></b></span>';
  }
  function save() {
    try { localStorage.setItem(SAVE_KEY, C.serialize(state)); } catch (e) { /* storage unavailable */ }
  }
  function load() {
    try {
      var raw = localStorage.getItem(SAVE_KEY);
      if (raw) { state = C.deserialize(raw); return true; }
    } catch (e) { /* start fresh */ }
    return false;
  }
  function newGame(seed) {
    state = C.createGame(seed || ('dz-' + Date.now()));
    selected = { x: state.airship.x, y: state.airship.y };
    lastLanding = null;
    firstDropGuideAcknowledged = false;
    pendingDrop = null;
    save(); show('map');
    toast('New campaign started. Seed: ' + state.seed);
  }

  /* ---------------- Guide + phase clarity ---------------- */
  function openGuide(section) {
    var overlay = $('guide-overlay');
    if (!overlay) return;
    overlay.hidden = false;
    if (section) {
      var target = overlay.querySelector('[data-guide-section="' + section + '"]');
      if (target) setTimeout(function () { target.scrollIntoView({ block: 'start' }); }, 0);
    }
    var close = $('btn-guide-close');
    if (close) close.focus();
  }
  function closeGuide() {
    var overlay = $('guide-overlay');
    if (overlay) overlay.hidden = true;
  }
  function requestDescent(tile, squadIds, kind) {
    // Drop gate (Steve, 2026-11-12): no descent unless the ship is over
    // the target tile. The briefing disables Launch off-tile; this is the
    // enforcement if the path is reached any other way.
    var gate = C.dropGate(state, tile.x, tile.y);
    if (!gate.ok) { sfx.denied(); toast(gate.reason); return; }
    if (state.totalDrops === 0 && !firstDropGuideAcknowledged) {
      pendingDrop = { tile: tile, squadIds: squadIds.slice(), kind: kind };
      $('first-drop-overlay').hidden = false;
      var start = $('btn-first-drop-start');
      if (start) start.focus();
      return;
    }
    startDescent(tile, squadIds, kind);
  }
  function dismissFirstDropGuide(startNow) {
    var drop = pendingDrop;
    firstDropGuideAcknowledged = true;
    pendingDrop = null;
    $('first-drop-overlay').hidden = true;
    if (startNow && drop) startDescent(drop.tile, drop.squadIds, drop.kind);
  }
  function phaseGuidance() {
    if (!state) return '';
    if (state.gameStatus !== 'playing') {
      return '<strong>NEXT:</strong> The campaign is ' + esc(state.gameStatus) +
        '. Read the Chronicle or Memorial, or start a New Game.';
    }
    if (C.isGrounded(state)) {
      return '<strong>NEXT:</strong> The ship is GROUNDED — the tank is dry. Use <strong>Refuel from cargo</strong> on the Map screen banner (or the Crew screen), or trade for FUEL. A grounded ship cannot move or drop.';
    }
    switch (currentScreen) {
      case 'map': {
        var selectedTile = C.tileAt(state, selected.x, selected.y);
        if (!state.settlement) {
          var green = C.tileAt(state, state.greenZone.x, state.greenZone.y);
          if (!green || !green.discovered) {
            return '<strong>NEXT:</strong> Find the hidden Green Zone. Tap a tile to inspect it, move the airship to reveal nearby ground, buy recon, or plan a scout drop.';
          }
          return '<strong>NEXT:</strong> The Green Zone is found. Select it and choose <strong>Found Settlement</strong>, or gather more resources first.';
        }
        if (selectedTile && selectedTile.discovered) {
          return '<strong>NEXT:</strong> Orders phase — inspect the selected tile, move or plan a drop, manage the settlement and crew, then choose <strong>End Turn</strong> when ready.';
        }
        return '<strong>NEXT:</strong> Orders phase — tap a discovered tile to inspect it, or reveal more of the sector by moving and recon.';
      }
      case 'crew': {
        var wounded = C.livingDivers(state).filter(function (d) { return d.wounds > 0; });
        if (wounded.length) {
          return '<strong>NEXT:</strong> Rest wounded divers here if you can spare 2 FOOD per wound, check the tank and assignments, then return to the Map.';
        }
        return '<strong>NEXT:</strong> Check ship fuel, cargo space, crew status, and garrison / escort assignments. Refuel here if the tank is low, then return to the Map.';
      }
      case 'briefing': {
        var picked = selectedSquad().length;
        if (!picked) {
          return '<strong>NEXT:</strong> Read “What happens when you drop?”, choose at least one available diver, and check the mission risk before launching.';
        }
        return '<strong>NEXT:</strong> Your squad is picked. Check threat, wind, recon, and the projected result in plain words, then choose <strong>Launch Drop</strong>.';
      }
      case 'report':
        return '<strong>NEXT:</strong> Read what was delivered, who was hurt, and why the landing scored as it did. Then choose <strong>Continue</strong> to return to orders.';
      case 'settlement':
        if (!state.settlement) return '<strong>NEXT:</strong> Find and select the Green Zone on the Map, then found the settlement.';
        return '<strong>NEXT:</strong> Build within the structure slots, keep a garrison if a raid is near, and watch FOOD. Founding is done — growth and defense are the job now.';
      case 'defense':
        return state.lastRaidReport
          ? '<strong>NEXT:</strong> Watch the raid waves resolve. The result comes from structures and garrison choices made before the raid.'
          : '<strong>NEXT:</strong> No raid has landed yet. Build defenses and assign a garrison from Settlement and Crew before the raid timer reaches zero.';
      case 'trade':
        return '<strong>NEXT:</strong> Compare each deal’s “Wants” and “Gives” in resource units. Accept only trades that solve a shortage or improve your position.';
      case 'training':
        return state.airship.trainingQueue
          ? '<strong>NEXT:</strong> Training is underway. End turns to advance it, or cancel here with no refund.'
          : '<strong>NEXT:</strong> Pick the one guaranteed stat and enlist only if you need a future replacement; training takes 4 turns.';
      case 'memorial':
        return state.tombstones.length
          ? '<strong>NEXT:</strong> These losses are permanent. Train or trade for replacements if the roster is thin, then return to the Map.'
          : '<strong>NEXT:</strong> Nobody has died yet. Return to the Map and keep the roster alive.';
      case 'chronicle':
        return '<strong>NEXT:</strong> Review the last turn’s consequences, then return to the Map for new orders.';
      default:
        return '<strong>NEXT:</strong> Use the Map to inspect a tile and choose the next order.';
    }
  }
  function renderPhaseBanner() {
    var banner = $('phase-banner');
    if (banner) banner.innerHTML = phaseGuidance();
  }

  /* ---------------- HUD ---------------- */
  function hudStat(term, label, value, unit, explanation) {
    var display = label + ' ' + value + ' ' + unit;
    return '<button type="button" class="chip hud-stat" data-guide-term="' + term + '" ' +
      'title="' + esc(explanation) + '" aria-label="' + esc(display + '. ' + explanation) + '">' +
      esc(label) + ' <b>' + esc(value) + '</b> <span class="unit">' + esc(unit) + '</span></button>';
  }
  function renderHud() {
    var turnEl = $('hud-turn');
    turnEl.textContent = 'Turn ' + state.turn + ' · round';
    turnEl.className = 'hud-turn-stat';
    turnEl.title = 'Current round. Tap Help / Guide for what happens when a turn ends.';
    turnEl.setAttribute('aria-label', 'Turn ' + state.turn + ', measured in rounds');
    $('hud-status').textContent = state.gameStatus === 'playing' ? '' :
      (state.gameStatus === 'won' ? '— WON' : '— LOST');
    var r = state.resources;
    $('hud-resources').innerHTML =
      hudStat('scrap', 'SCRAP', r.SCRAP, 'units', 'Resource units in cargo. Spend SCRAP on buildings, training, founding, and trades.') +
      hudStat('fuel-cargo', 'FUEL', r.FUEL, 'units', 'Resource units in cargo. Refuel on the Crew screen to move FUEL into the ship tank.') +
      hudStat('food', 'FOOD', r.FOOD, 'units', 'Resource units in cargo. Crew and settlement residents eat FOOD when a turn ends.') +
      hudStat('intel', 'INTEL', r.INTEL, 'units', 'Information units in cargo. Spend INTEL on recon and some trades.') +
      hudStat('ship-fuel', 'Fuel', state.airship.fuel + '/' + state.airship.maxFuel + ' (+' + r.FUEL + ' in cargo)', 'tank pts', 'Usable points in the airship tank, plus FUEL units in cargo. A drop costs 2 points; moving costs 1 point per tile. Refuel from cargo on the Map or Crew screen.') +
      hudStat('cargo', 'Cargo', C.cargoUsed(state) + '/' + state.airship.cargoCapacity, 'units', 'All resource units share this cargo hold. Only delivered haul can bank into it.') +
      hudStat('crew', 'Crew', C.livingDivers(state).length + '/' + state.airship.crewCapacity, 'divers', 'Living divers aboard, out of the airship crew capacity.') +
      hudStat('population', 'Souls', state.population != null ? state.population : '—', 'people', 'Everyone aboard — the campaign stakes. The count drifts down with time; settlements, farms and woken sleepers push it back up. It is stakes, not a lose timer.') +
      hudStat('green-fuel', 'Green fuel', C.remainingGreenFuel(state).sources, 'sites', 'Green-zone sites still holding fuel cells. Worked green sites are picked clean — the green zones are running out. See the exact cell count on the Map.') +
      (state.starving ? '<span class="chip bad">STARVING — squad penalty</span>' : '') +
      (state.airship.fuel <= 0 ? '<span class="chip bad">GROUNDED — tank dry</span>' : '') +
      (state.airship.fuel > 0 && state.airship.fuel <= 3 ? '<span class="chip warn-chip">LOW FUEL — ' + state.airship.fuel + ' left; refuel from cargo</span>' : '') +
      (state.supply.status === 'choked' ? '<span class="chip bad">ROUTE CHOKED</span>' : '');
    Array.prototype.forEach.call($('hud-resources').querySelectorAll('[data-guide-term]'), function (el) {
      el.addEventListener('click', function () { openGuide('numbers'); });
    });
    renderPhaseBanner();
    var banner = $('hud-banner');
    if (state.gameStatus !== 'playing') {
      banner.hidden = false;
      banner.textContent = (state.gameStatus === 'won' ? 'CAMPAIGN WON — ' : 'CAMPAIGN LOST — ') + (state.endReason || '');
    } else banner.hidden = true;
  }

  /* ---------------- Map screen ---------------- */
  function routeSet() {
    var set = {};
    C.routeTiles(state).forEach(function (p) { set[p.x + ',' + p.y] = true; });
    return set;
  }
  function tilePresentation(t) {
    if (!t.discovered) {
      return {
        icon: '?', label: 'FOG', name: 'Fog / unknown tile',
        detail: 'Not scouted yet. Move the airship closer or buy recon to reveal what is here.'
      };
    }
    var terrainIcon = t.terrain === 'water' ? '≈' : t.terrain === 'rough' ? '▲' : t.terrain === 'ruin' ? '▦' : '●';
    var terrainName = t.terrain === 'water' ? 'Water' : t.terrain === 'rough' ? 'Rough terrain' :
      t.terrain === 'ruin' ? 'Ruin terrain' : 'Open terrain';
    var pres = {
      icon: terrainIcon, label: t.terrain.toUpperCase(), name: terrainName,
      detail: t.terrain === 'water' ? 'Water — no landing here.' :
        t.terrain === 'open' ? 'Open terrain — the clearest landing ground.' :
        t.terrain === 'rough' ? 'Rough terrain — a harder landing.' : 'Ruin terrain — rough ground, often valuable or dangerous.'
    };
    if (t.isGreenZone) {
      pres = { icon: 'G', label: 'GREEN', name: 'Green Zone', detail: 'Safe ground where a settlement can be founded.' };
    } else if (t.isColony) {
      pres = { icon: '⌂', label: 'COLONY', name: 'Kestrel Colony', detail: 'Your on-map trade partner.' };
    } else if (t.isInterdiction) {
      pres = { icon: '✕', label: 'RAID', name: 'Hostile supply cache', detail: 'Raid this tile with an interdiction drop; expect retaliation.' };
    } else if (t.robotSite && !t.robotSite.cleared) {
      pres = { icon: '⚠', label: 'ROBOT', name: 'Robot ruin — ' + t.robotSite.name, detail: 'Rich tech vaults guarded by sentient machines. The most dangerous site type.' };
    } else if (t.supplySite && !t.supplySite.looted) {
      pres = { icon: '$', label: 'CACHE', name: 'Supply cache — ' + t.supplySite.name, detail: 'A rich haul under dangerous ground.' };
    } else if (t.resourceType) {
      var resourceIcon = t.resourceType === 'SCRAP' ? '⚙' : t.resourceType === 'FUEL' ? '⛽' : '◉';
      pres = {
        icon: resourceIcon, label: t.resourceType, name: t.resourceType + ' resource node',
        detail: 'Gather this node by drop to collect its yield in resource units.'
      };
    } else if (t.x === state.airship.x && t.y === state.airship.y) {
      pres = { icon: 'A', label: 'SHIP', name: 'Airship position', detail: 'The airship is holding over this tile.' };
    } else if (t.threat > 0) {
      pres.label = 'T' + t.threat;
      pres.name = terrainName + ' — threat rating ' + t.threat + ' of 5';
      pres.detail += ' T' + t.threat + ' means threat rating ' + t.threat + ' of 5; higher is worse.';
    }
    return pres;
  }
  /* ---------------- Live map: hexes, atlas sprites, POIs, apex ----------
   * The live map is a HEX field (Steve, 2026-11-07): pointy-top hexagons
   * in offset rows. Offset coordinates map 1:1 onto the sector's tile
   * addressing, so the hex layer is presentation over the same state —
   * state.pois (core) is the one canonical POI list read here, in the
   * briefing, and in drop reports. Sprites are Blender-modeled renders
   * (tools/build_poi_models.py) packed into assets/poi-atlas.png; FAR
   * tier rides inside the hexes, NEAR tier on the overlay layer, and the
   * tier crossfades at the NEAR_MIN zoom threshold. */
  var ATLAS = window.DZ_POI_ATLAS || null;
  var ZOOMS = [0.8, 1, 1.35, 1.8, 2.4, 3.2];
  var NEAR_MIN = 1.8;
  var zoomIdx = 3;   // DEFAULT_ZOOM_IDX (declared with the camera) — opens at 1.8

  /* ---------------- Camera: 3/4 presentation (2026-11-12, PM) --------
   * Steve's rulings, implemented here and nowhere else. History: the
   * 2026-11-10 build shipped 3/4 (rotateX 55deg); Steve's 2026-11-12
   * morning phone playtest flattened it (top-down, TILT 0, zoom 1.35)
   * because 3/4 did not work AT THAT SCALE. The same afternoon, with
   * the Rule 27 figures standing on the field and the tiles smaller,
   * Steve reversed it again — "This is 3/4. Which I like now that the
   * tiles are smaller." His latest word stands:
   *  - 3/4 IS THE playable view again: TILT_DEG = 55 (the proven Nov 10
   *    value — the homography picking + sprite counter-rotation were
   *    built and proven at exactly this tilt), CSS perspective +
   *    preserve-3d restored on the viewport/board. TILT_DEG stays the
   *    single knob the transform + counter-rotations read.
   *  - The default zoom steps ONE MORE STEP IN from the morning's
   *    1.35: the camera opens at ZOOMS[DEFAULT_ZOOM_IDX] = 1.8 —
   *    roughly HALF the tile area visible again — and 1.8 IS the
   *    NEAR_MIN threshold, so the detailed NEAR tier (modeled POI
   *    sprites) is the default read: tiles carry detail, not flat
   *    cells. The world itself is unchanged (24x24).
   *  - A WORLD MAP (minimap, #world-map) shows the whole charted
   *    sector, the ship + selection, and the current viewport
   *    rectangle; tapping it centres the main view there.
   *  - The map owns its touch input: touch-action:none on the scene,
   *    a non-passive touchmove preventDefault, and overscroll-behavior
   *    none — a map drag never scrolls or pinch-zooms the page.
   *  - Selection NEVER moves the camera. The old code set the board's
   *    transform-origin to the selected tile on every render, so at
   *    zoom != 1 clicking a tile shifted the whole board — the
   *    "clicking tiles moves the map" bug. applyCam() below is the ONLY
   *    writer of the board transform, transform-origin is fixed at
   *    50% 50%, and selection does not touch cam state at all.
   *  - Pan inputs (ruled): one-finger touch drag; middle-mouse drag on
   *    PC; arrow keys + edge pan on PC. Left-mouse drag does NOT pan.
   *  - Zoom anchors: wheel -> the pointer point; pinch -> the pinch
   *    midpoint; buttons/keys -> the selected tile, else viewport
   *    center. F focuses the selection (2026-11-03 ruling).
   *  - Picking goes through the screen<->plane homography defined by
   *    the board's corner probes (proven in map34/next at this tilt);
   *    the same solver served the flat morning build (affine case).
   * Zoom/pan are presentation state only — never saved, never in core. */
  var TILT_DEG = 55;
  var DEFAULT_ZOOM_IDX = 3;   // ZOOMS[3] = 1.8 — one step in from 1.35, ~half the tiles again, NEAR tier by default
  var cam = { panX: 0, panY: 0 };
  var suppressClickUntil = 0;   // set after a real pan drag, eats its click
  function camZoom() { return ZOOMS[zoomIdx]; }
  function clampPan() {
    cam.panX = Math.max(-1200, Math.min(1200, cam.panX));
    cam.panY = Math.max(-900, Math.min(900, cam.panY));
  }
  function applyCam() {
    camDirty = false;
    var board = $('map-board');
    if (!board) return;
    board.style.transform = 'translate(-50%, -50%) translate(' + cam.panX.toFixed(1) + 'px, ' +
      cam.panY.toFixed(1) + 'px) rotateX(' + TILT_DEG + 'deg) scale(' + camZoom().toFixed(3) + ')';
    board.style.transformOrigin = '50% 50%';
    var zl = $('zoom-level');
    if (zl) zl.textContent = Math.round(camZoom() * 100) + '%';
    // Cloud parallax: the layers drift a few % of the pan, so the world
    // reads as depth when the camera moves (map34/next pattern).
    try {
      var back = document.querySelector('[data-cloud-layer="back"]');
      var front = document.querySelector('[data-cloud-layer="front"]');
      if (back) back.style.transform = 'translate(' + (cam.panX * 0.03).toFixed(1) + 'px, ' + (cam.panY * 0.02).toFixed(1) + 'px)';
      if (front) front.style.transform = 'translate(' + (cam.panX * 0.06).toFixed(1) + 'px, ' + (cam.panY * 0.04).toFixed(1) + 'px)';
    } catch (e) { /* clouds are garnish */ }
    updateWorldRect();
  }
  /* Pan drags can fire pointermove faster than the display refresh;
   * coalesce the visual write to one applyCam per animation frame
   * (camera STATE still updates synchronously in the handler). The
   * zoom/settle paths call applyCam() directly and stay synchronous —
   * they measure layout against the transform they just wrote. */
  var camDirty = false, camRafQueued = false;
  function applyCamSoon() {
    camDirty = true;
    if (camRafQueued) return;
    camRafQueued = true;
    var raf = window.requestAnimationFrame || function (fn) { return setTimeout(fn, 16); };
    raf(function () {
      camRafQueued = false;
      if (camDirty) applyCam();
    });
  }
  function flushCam() { if (camDirty) applyCam(); }
  function panBy(dx, dy) { cam.panX += dx; cam.panY += dy; clampPan(); applyCam(); }

  /* Homography between screen pixels and board-local pixels, from the
   * four probe points pinned to the board's corners (map34's solver,
   * adapted: probes sit 3px inside the board's border box). */
  function solveHomography(src, dst) {
    var A = [], b = [];
    for (var i = 0; i < 4; i++) {
      var x = src[i][0], y = src[i][1], X = dst[i][0], Y = dst[i][1];
      A.push([x, y, 1, 0, 0, 0, -X * x, -X * y]); b.push(X);
      A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y]); b.push(Y);
    }
    for (var col = 0; col < 8; col++) {
      var piv = col;
      for (var r = col + 1; r < 8; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
      if (Math.abs(A[piv][col]) < 1e-12) return null;
      var tmpA = A[col]; A[col] = A[piv]; A[piv] = tmpA;
      var tmpB = b[col]; b[col] = b[piv]; b[piv] = tmpB;
      for (var r2 = 0; r2 < 8; r2++) {
        if (r2 === col) continue;
        var f = A[r2][col] / A[col][col];
        if (!f) continue;
        for (var c2 = col; c2 < 8; c2++) A[r2][c2] -= f * A[col][c2];
        b[r2] -= f * b[col];
      }
    }
    var h = [];
    for (var i2 = 0; i2 < 8; i2++) h.push(b[i2] / A[i2][i2]);
    return [[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], 1]];
  }
  function probeFrame() {
    var board = $('map-board');
    if (!board || !board.querySelectorAll || !board.offsetWidth) return null;
    var probes = board.querySelectorAll('.pick-probe');
    if (!probes || probes.length < 4) return null;
    var W = board.offsetWidth, H = board.offsetHeight, o = 3;
    var local = [[o, o], [W - o, o], [o, H - o], [W - o, H - o]];
    var screen = [];
    for (var i = 0; i < 4; i++) {
      if (!probes[i].getBoundingClientRect) return null;
      var r = probes[i].getBoundingClientRect();
      screen.push([r.left + r.width / 2, r.top + r.height / 2]);
    }
    return { W: W, H: H, local: local, screen: screen };
  }
  function applyH(H, px, py) {
    var w = H[2][0] * px + H[2][1] * py + H[2][2];
    if (!w) return null;
    return { x: (H[0][0] * px + H[0][1] * py + H[0][2]) / w, y: (H[1][0] * px + H[1][1] * py + H[1][2]) / w };
  }
  /* Measured-frame cache (2026-11-12 lag fix): probeFrame() forces
   * layout (4 getBoundingClientRect reads) and each conversion solved
   * the 8x8 homography from scratch — per tap, and per settleAnchor
   * iteration. The frame only changes when the board transform, the
   * board size, or the window geometry changes, so memoise the frame
   * and BOTH solved matrices under that key. Any applyCam() writes a
   * new transform string, which changes the key — a stale frame can
   * never be served for a moved camera. */
  var frameCache = { key: null, frame: null, s2l: null, l2s: null };
  function measuredFrame() {
    var board = $('map-board');
    if (!board) return null;
    var key = String(board.style.transform || '') + '|' + board.offsetWidth + 'x' + board.offsetHeight +
      '|' + window.innerWidth + 'x' + window.innerHeight + '|' + (window.scrollX || 0) + ',' + (window.scrollY || 0);
    if (frameCache.key === key && frameCache.frame) return frameCache;
    var f = probeFrame(); if (!f) return null;
    var s2l = solveHomography(f.screen, f.local); if (!s2l) return null;
    var l2s = solveHomography(f.local, f.screen); if (!l2s) return null;
    frameCache = { key: key, frame: f, s2l: s2l, l2s: l2s };
    return frameCache;
  }
  function screenToLocal(cx, cy) {
    var m = measuredFrame(); if (!m) return null;
    return applyH(m.s2l, cx, cy);
  }
  function localToScreen(lx, ly) {
    var m = measuredFrame(); if (!m) return null;
    return applyH(m.l2s, lx, ly);
  }
  function gridDims() {
    var gw = 0, gh = 0;
    state.tiles.forEach(function (tt) {
      if (tt.x + 1 > gw) gw = tt.x + 1;
      if (tt.y + 1 > gh) gh = tt.y + 1;
    });
    return { gw: gw, gh: gh, g: hexGeom(gw, gh) };
  }
  /* Nearest hex centre to a board-fraction point (fx, fy in % of the
   * board). distPx is the distance measured against a board W x H px
   * box — the caller picks the box (real board px for screen picks,
   * minimap px for world-map taps). */
  function nearestTileAtFrac(fx, fy, dims, W, H) {
    var best = null, bd = Infinity;
    state.tiles.forEach(function (t) {
      var c = hexCenter(t.x, t.y, dims.g);
      var dx = (c.x - fx) / 100 * W, dy = (c.y - fy) / 100 * H;
      var d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = t; }
    });
    return best ? { tile: best, distPx: Math.sqrt(bd) } : null;
  }
  /* Geometric tile pick: nearest hex centre to the picked ground point,
   * with a forgiving radius (touch-first rule, 2026-11-03). */
  function pickTileAtClient(cx, cy) {
    if (!state) return null;
    var loc = screenToLocal(cx, cy); if (!loc) return null;
    var m = measuredFrame(); if (!m) return null;
    var dims = gridDims();
    var fx = loc.x / m.frame.W * 100, fy = loc.y / m.frame.H * 100;
    var hit = nearestTileAtFrac(fx, fy, dims, m.frame.W, m.frame.H);
    if (!hit) return null;
    if (hit.distPx > (dims.g.wPct / 100 * m.frame.W) * 0.9) return null;
    return { x: hit.tile.x, y: hit.tile.y };
  }
  function selectedScreenPoint() {
    var grid = $('map-grid');
    if (!grid || !grid.querySelector || !grid.querySelectorAll) return null;
    var el = null;
    var cells = grid.querySelectorAll('.cell');
    for (var i = 0; i < cells.length; i++) {
      if (parseInt(cells[i].dataset.x, 10) === selected.x && parseInt(cells[i].dataset.y, 10) === selected.y) { el = cells[i]; break; }
    }
    if (!el || !el.getBoundingClientRect) return null;
    var r = el.getBoundingClientRect();
    if (!r.width && !r.height) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  function viewportCenterScreen() {
    var vp = $('map-viewport');
    if (!vp || !vp.getBoundingClientRect) return null;
    var r = vp.getBoundingClientRect();
    if (!r.width && !r.height) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  /* Settle an anchor: iterate pan until the ground point `loc` sits
   * back under the screen point `pt` (perspective shifts a point by
   * pan/w, not pan, so one pass under-corrects — iterate to sub-pixel,
   * the next.js solver pattern). */
  function settleAnchor(loc, pt) {
    if (!loc || !pt) return;
    for (var i = 0; i < 10; i++) {
      var now = localToScreen(loc.x, loc.y);
      if (!now) break;
      var dx = pt.x - now.x, dy = pt.y - now.y;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) break;
      cam.panX += dx; cam.panY += dy; clampPan(); applyCam();
    }
  }
  /* The board's FAR/NEAR tier class is the ONLY render output a zoom
   * change affects (the sprite crossfade is pure CSS off this class).
   * renderMap() restates it on full renders; zoom steps sync it here
   * instead of paying a full 576-cell rebuild per step — that rebuild
   * was the pinch/wheel lag (2026-11-12 fix). */
  function syncBoardTier() {
    var board = $('map-board');
    if (board) board.className = camZoom() >= NEAR_MIN ? 'tier-near' : 'tier-far';
  }
  /* Anchored zoom step: the anchor's ground point is measured before
   * the step, then settleAnchor puts it back under the anchor screen
   * point. Anchor resolution: an explicit pointer point (wheel/pinch)
   * wins; otherwise the selected tile; otherwise the viewport centre. */
  function setZoomAnchored(newIdx, anchor) {
    newIdx = Math.max(0, Math.min(ZOOMS.length - 1, newIdx));
    if (newIdx === zoomIdx) return;
    var pt = null;
    if (anchor && anchor.mode === 'pointer') pt = { x: anchor.x, y: anchor.y };
    else if (anchor && anchor.mode === 'selection') pt = selectedScreenPoint();
    if (!pt) pt = viewportCenterScreen();
    var loc = pt ? screenToLocal(pt.x, pt.y) : null;
    zoomIdx = newIdx;
    applyCam();
    settleAnchor(loc, pt);
    syncBoardTier();
  }
  function resetCamera() {
    zoomIdx = DEFAULT_ZOOM_IDX; cam.panX = 0; cam.panY = 0;
    applyCam(); render();
  }
  /* F: focus the selection — zoom in to NEAR working range (never pull
   * back from a closer view) and glide the selected tile to centre. */
  function focusSelection() {
    var pt = selectedScreenPoint(); if (!pt) return;
    var vc = viewportCenterScreen(); if (!vc) return;
    var target = zoomIdx;
    for (var i = 0; i < ZOOMS.length; i++) if (ZOOMS[i] <= NEAR_MIN) target = i;
    target = Math.max(zoomIdx, target);
    var loc = screenToLocal(pt.x, pt.y);
    zoomIdx = target;
    applyCam();
    settleAnchor(loc, vc);
    syncBoardTier();
  }
  /* Selection entry point shared by cell clicks, apex clicks and the
   * geometric tap fallback. Selection writes NO camera state — the
   * camera is bit-identical after a tap/click (acceptance criterion 2). */
  function selectTile(x, y) {
    if (Date.now() < suppressClickUntil) return;
    selected = { x: x, y: y };
    if (C.poiAt(state, x, y)) sfx.select();
    render();
  }

  /* ---------------- World map (minimap, 2026-11-12) ------------------
   * The whole 24x24 chart at a glance in the viewport's corner:
   * charted ground in terrain colours, fog dark, charted POIs as pale
   * specks, the ship and the selection marked, and a rectangle showing
   * what the main view currently frames. Tapping a point centres the
   * main view on that tile (zoom unchanged) — the ruled mobile
   * navigation aid. The chart canvas redraws inside renderMap (state
   * changes only); during a pan only the rectangle div moves, and its
   * geometry is pure arithmetic on the flat camera — no layout reads
   * per frame. */
  var mapMetrics = { bw: 0, bh: 0, vw: 0, vh: 0 };
  function measureMapMetrics() {
    var board = $('map-board'), vp = $('map-viewport');
    if (!board || !vp) return;
    mapMetrics = { bw: board.offsetWidth || 0, bh: board.offsetHeight || 0,
      vw: vp.clientWidth || 0, vh: vp.clientHeight || 0 };
  }
  /* Fraction of the board the viewport currently frames. Flat camera:
   * screen = viewportCentre + pan + zoom * (local - boardCentre). */
  function visibleFrac() {
    var m = mapMetrics, z = camZoom();
    if (!m.bw || !m.bh || !m.vw || !m.vh || !z) return null;
    return {
      x0: 0.5 - (m.vw / 2 + cam.panX) / (z * m.bw),
      y0: 0.5 - (m.vh / 2 + cam.panY) / (z * m.bh),
      x1: 0.5 + (m.vw / 2 - cam.panX) / (z * m.bw),
      y1: 0.5 + (m.vh / 2 - cam.panY) / (z * m.bh)
    };
  }
  function updateWorldRect() {
    var rect = $('world-rect');
    if (!rect || !rect.style) return;
    var f = visibleFrac();
    if (!f) { rect.style.display = 'none'; return; }
    function cl(v) { return Math.max(0, Math.min(1, v)); }
    rect.style.display = '';
    rect.style.left = (cl(f.x0) * 100) + '%';
    rect.style.top = (cl(f.y0) * 100) + '%';
    rect.style.width = (Math.max(0, cl(f.x1) - cl(f.x0)) * 100) + '%';
    rect.style.height = (Math.max(0, cl(f.y1) - cl(f.y0)) * 100) + '%';
  }
  var WORLD_TERRAIN = { open: '#7d9a52', rough: '#8a7648', ruin: '#7a6f61', water: '#2f5676' };
  function drawWorldMap() {
    var cv = $('world-canvas');
    if (!cv || !cv.getContext || !state) return;
    var ctx2d = null;
    try { ctx2d = cv.getContext('2d'); } catch (e) { /* shim DOM has no canvas */ }
    if (!ctx2d) return;
    var S = cv.width || 116;
    var dims = gridDims(), g = dims.g;
    ctx2d.fillStyle = '#141a21';
    ctx2d.fillRect(0, 0, S, S);
    state.tiles.forEach(function (t) {
      var x = hexLeft(t.x, t.y, g) / 100 * S, y = (1.5 * t.y / g.hUnits) / 100 * S;
      var w = g.wPct / 100 * S, h = (2 / g.hUnits) / 100 * S;
      ctx2d.fillStyle = !t.discovered ? '#232b35' : (WORLD_TERRAIN[t.terrain] || '#5a6a76');
      ctx2d.fillRect(x, y, Math.max(1, w - 0.4), Math.max(1, h - 0.4));
      if (t.discovered && (t.isColony || t.isGreenZone)) {
        ctx2d.fillStyle = t.isColony ? '#daca47' : '#8fe08f';
        ctx2d.fillRect(x + w / 2 - 1, y + h / 2 - 1, 2, 2);
      }
    });
    ctx2d.fillStyle = 'rgba(232,226,210,0.85)';
    (state.pois || []).forEach(function (p) {
      var pt = C.tileAt(state, p.x, p.y);
      if (!pt || !pt.discovered) return;
      var c = hexCenter(p.x, p.y, g);
      ctx2d.fillRect(c.x / 100 * S - 1, c.y / 100 * S - 1, 2, 2);
    });
    // Selection: white frame around its hex. Ship: yellow dot, dark ring.
    ctx2d.strokeStyle = '#ffffff'; ctx2d.lineWidth = 1.4;
    ctx2d.strokeRect(hexLeft(selected.x, selected.y, g) / 100 * S + 0.5,
      (1.5 * selected.y / g.hUnits) / 100 * S + 0.5,
      g.wPct / 100 * S - 1, (2 / g.hUnits) / 100 * S - 1);
    var ac = hexCenter(state.airship.x, state.airship.y, g);
    ctx2d.beginPath();
    ctx2d.arc(ac.x / 100 * S, ac.y / 100 * S, 3.1, 0, Math.PI * 2);
    ctx2d.fillStyle = '#daca47'; ctx2d.fill();
    ctx2d.strokeStyle = '#14181d'; ctx2d.lineWidth = 1.2; ctx2d.stroke();
  }
  /* Centre the main view on a tile (world-map tap): invert the flat
   * camera for the tile's centre — pan = -zoom * (local - centre). */
  function centerOnTile(x, y) {
    if (!state) return;
    measureMapMetrics();
    var m = mapMetrics;
    if (!m.bw || !m.bh) return;
    var dims = gridDims();
    var c = hexCenter(x, y, dims.g);
    var z = camZoom();
    cam.panX = -z * (c.x / 100 * m.bw - m.bw / 2);
    cam.panY = -z * (c.y / 100 * m.bh - m.bh / 2);
    clampPan(); applyCam();
  }
  function hexGeom(cols, rows) {
    return { wPct: 100 / (cols + 0.5), hUnits: 1.5 * rows + 0.5,
      aspect: (Math.sqrt(3) * (cols + 0.5)) / (1.5 * rows + 0.5) };
  }
  function hexLeft(x, y, g) { return (x + 0.5 * (y % 2)) * g.wPct; }
  function hexCenter(x, y, g) {
    return { x: hexLeft(x, y, g) + g.wPct / 2, y: (1.5 * y + 1) / g.hUnits * 100 };
  }
  function hexBottom(x, y, g) { return (1.5 * y + 2) / g.hUnits * 100; }
  function hexNeighbors(x, y) {
    var d = (y % 2 === 1) ? [[1, 0], [1, -1], [0, -1], [-1, 0], [0, 1], [1, 1]]
                         : [[1, 0], [0, -1], [-1, -1], [-1, 0], [-1, 1], [0, 1]];
    return d.map(function (o) { return { x: x + o[0], y: y + o[1] }; });
  }
  function atlasStyle(key) {
    if (!ATLAS || !ATLAS.sprites[key]) return null;
    var s = ATLAS.sprites[key], r = s.rect;
    var bsx = ATLAS.width / r[2] * 100, bsy = ATLAS.height / r[3] * 100;
    var bpx = ATLAS.width === r[2] ? 0 : r[0] / (ATLAS.width - r[2]) * 100;
    var bpy = ATLAS.height === r[3] ? 0 : r[1] / (ATLAS.height - r[3]) * 100;
    return { entry: s, css: 'background-size:' + bsx + '% ' + bsy + '%;background-position:' + bpx + '% ' + bpy + '%;' };
  }
  /* Rule 30: the atlas's three radiation tiers, named as Nic's canon
   * maps name them. The build's radiation values ride the tiers:
   * 0 clean · 1 residual · 2 heavy contamination · 3+ severe fallout. */
  var RAD_TIERS = ['clean', 'Residual radiation', 'Heavy contamination', 'Severe fallout'];
  function radTierName(rad) { return RAD_TIERS[Math.max(0, Math.min(3, rad || 0))]; }
  function radMeter(rad) {
    var seg = '';
    for (var i = 0; i < 4; i++) seg += '<i class="' + (i < rad ? 'on' + rad : '') + '"></i>';
    return '<span class="radmeter" role="img" aria-label="Radiation ' + rad + ' of 4">' + seg + '</span>';
  }
  function poiStateClass(poi) {
    return (poi.state === 'looted' || poi.state === 'cleared' || poi.state === 'picked') ? ' worked'
      : poi.state === 'occupied' ? ' occupied' : '';
  }
  function gateHtml(gate, squadCaption) {
    var pips = '';
    for (var i = 0; i < gate.heroesNeeded; i++) {
      var lv = gate.levels[i];
      pips += '<i class="' + (lv == null ? '' : lv >= gate.levelNeeded ? 'on' : 'half') + '"></i>';
    }
    var pct = Math.min(100, Math.round(gate.things / gate.thingsNeeded * 100));
    return '<div class="gate-block"><strong class="endgame-tag">ENDGAME — CITY GATE</strong> ' +
      (gate.unlocked ? '<b style="color:#8fe08f">OPEN</b>' : '<b class="warn">SHUT</b>') +
      '<br>Squad key (' + esc(squadCaption) + '): <span class="gatepips">' + pips + '</span> ' +
      gate.heroes + '/' + gate.heroesNeeded + ' heroes' +
      (gate.levels.length ? ' · levels ' + gate.levels.join(' / ') : '') + ' (need all Lv ' + gate.levelNeeded + ')' +
      '<br>Progress key: <span class="gauge gate-gauge"><span class="gauge-fill" style="width:' + pct + '%"></span></span> ' +
      gate.things + ' / ' + gate.thingsNeeded + ' things done</div>';
  }
  var SKULL_SVG = '<svg viewBox="0 0 40 44" aria-hidden="true"><path d="M20 2c-8.8 0-15 6.6-15 15.2 0 5.4 2.4 9.3 5.6 11.8V36a3 3 0 0 0 3 3h12.8a3 3 0 0 0 3-3v-7.2C32.6 26.3 35 22.4 35 17.2 35 8.6 28.8 2 20 2z" fill="#c1272d" stroke="#5d0f13" stroke-width="1.6"/><ellipse cx="13.4" cy="18.6" rx="3.9" ry="4.6" fill="#1c1a16"/><ellipse cx="26.6" cy="18.6" rx="3.9" ry="4.6" fill="#1c1a16"/><path d="M20 24.4l-2.4 4.8h4.8z" fill="#1c1a16"/><path d="M15.4 39v-4.4M20 39.4v-4.8M24.6 39v-4.4" stroke="#5d0f13" stroke-width="1.6"/></svg>';
  /* Rule 27 (Steve, 2026-11-12): THE BOARD SHOWS PEOPLE, NOT TOKENS.
   * Ground-battle units are full humanoid FIGURES, two tiles tall
   * (~6 ft against the tile), feet anchored on their tile, Myth-style
   * grounded silhouettes — except MILITARY. Squad = modern soldiers
   * (helmet, plate carrier, pack, weapon in hand — minimal drop kit,
   * Rule 26). Hostiles are figures IN KIND: Sirens gaunt and pale,
   * glow-plants rooted, war machines boxy, human scavengers ragged.
   * The skull survives where it belongs: the MAP/minimap language
   * (apex signs, SKULL_SVG above) — not as a field token any more. */
  var SOLDIER_SVG = '<svg viewBox="0 0 48 96" aria-hidden="true">' +
    '<ellipse cx="24" cy="91" rx="15" ry="3.6" fill="rgba(0,0,0,.38)"/>' +
    '<rect x="8" y="30" width="9" height="24" rx="2.5" fill="#3f4433" stroke="#22251d" stroke-width="1.4"/>' +
    '<path d="M18 56 L16.4 84 L21.6 84 L23.4 62 Z" fill="#6f6a4e" stroke="#22251d" stroke-width="1.4"/>' +
    '<path d="M30 56 L31.6 84 L26.4 84 L24.6 62 Z" fill="#655f45" stroke="#22251d" stroke-width="1.4"/>' +
    '<path d="M15.8 84 h6.4 l.8 5 H15 Z" fill="#24231d" stroke="#12110d" stroke-width="1.2"/>' +
    '<path d="M25.8 84 h6.4 l.8 5 H25 Z" fill="#24231d" stroke="#12110d" stroke-width="1.2"/>' +
    '<path d="M13.6 27 a5 5 0 0 1 6.6 4.8 L18.6 52 a4 4 0 0 1 -7.4 -1.4 L12.4 31 a5 5 0 0 1 1.2 -4 Z" fill="#5d5942" stroke="#22251d" stroke-width="1.4"/>' +
    '<rect x="13.5" y="25" width="21" height="35" rx="4.5" fill="#57543f" stroke="#22251d" stroke-width="1.5"/>' +
    '<rect x="17" y="29.5" width="14" height="20" rx="2" fill="#2c2a24" stroke="#141310" stroke-width="1.4"/>' +
    '<rect x="19.4" y="33" width="9.2" height="3.4" fill="#454138"/><rect x="19.4" y="39" width="9.2" height="3.4" fill="#454138"/>' +
    '<path d="M33.8 28.5 L38.6 44 L34.8 46.4 L30.8 33 Z" fill="#5d5942" stroke="#22251d" stroke-width="1.4"/>' +
    '<path d="M28.5 40 L41 62" stroke="#191917" stroke-width="4.6" stroke-linecap="round"/>' +
    '<path d="M33.5 49.5 l5.4 3.4 -1.8 3.4 -5 -3.2 Z" fill="#191917"/>' +
    '<circle cx="24" cy="17" r="6.8" fill="#c9a186" stroke="#6e5138" stroke-width="1.2"/>' +
    '<path d="M15.8 17.4 a8.2 8.2 0 0 1 16.4 0 l.9 3.4 H14.9 Z" fill="#46503a" stroke="#232a1c" stroke-width="1.5"/>' +
    '<rect x="14.2" y="19.6" width="19.6" height="2.6" rx="1.3" fill="#39422e"/>' +
    '</svg>';
  function sirenSvg(flying) {
    return '<svg viewBox="0 0 48 96" aria-hidden="true">' +
      '<ellipse cx="24" cy="91" rx="14" ry="3.4" fill="rgba(0,0,0,.38)"/>' +
      (flying ? '<path d="M14 30 L2 18 L6 38 L1 40 L13 48 Z" fill="#3a3733" stroke="#191713" stroke-width="1.3"/><path d="M34 30 L46 18 L42 38 L47 40 L35 48 Z" fill="#3a3733" stroke="#191713" stroke-width="1.3"/>' : '') +
      '<path d="M19.5 54 L17 85 L21.4 85 L23 60 Z" fill="#a79d8a" stroke="#4c463c" stroke-width="1.3"/>' +
      '<path d="M28.5 54 L31.5 85 L27.2 85 L25 60 Z" fill="#9c927e" stroke="#4c463c" stroke-width="1.3"/>' +
      '<path d="M15.5 27 C13 40 11.5 52 10.8 63 L14.8 64.4 C16 53 17.4 42 18.8 32 Z" fill="#b3a893" stroke="#4c463c" stroke-width="1.3"/>' +
      '<path d="M32.5 27 C35 40 36.5 52 37.2 63 L33.2 64.4 C32 53 30.6 42 29.2 32 Z" fill="#b3a893" stroke="#4c463c" stroke-width="1.3"/>' +
      '<path d="M16.5 24 L31.5 24 L33.5 56 L29.8 51.5 L26.8 57 L24 52.4 L21.2 57 L18.2 51.5 L14.5 56 Z" fill="#847d6c" stroke="#4c463c" stroke-width="1.4"/>' +
      '<circle cx="24" cy="15.5" r="7.2" fill="#d6cfbd" stroke="#6d6455" stroke-width="1.3"/>' +
      '<path d="M17.5 12 C17 6 21 3.4 24 3.2 C27 3.4 31 6 30.5 12 L28.6 9.4 C27 7.6 21 7.6 19.4 9.4 Z" fill="#2e2a26"/>' +
      '<ellipse cx="21.2" cy="15.8" rx="1.7" ry="2.2" fill="#191713"/><ellipse cx="26.8" cy="15.8" rx="1.7" ry="2.2" fill="#191713"/>' +
      '<circle cx="21.2" cy="15.2" r=".65" fill="#ff5a3c"/><circle cx="26.8" cy="15.2" r=".65" fill="#ff5a3c"/>' +
      '<path d="M22.2 20.6 q1.8 1.4 3.6 0" stroke="#4c2320" stroke-width="1.2" fill="none"/>' +
      '</svg>';
  }
  var SIREN_SVG = sirenSvg(false);
  var SIREN_FLY_SVG = sirenSvg(true);
  var SCAV_SVG = '<svg viewBox="0 0 48 96" aria-hidden="true">' +
    '<ellipse cx="24" cy="91" rx="14" ry="3.4" fill="rgba(0,0,0,.38)"/>' +
    '<path d="M18.5 56 L16.8 84 L21.8 84 L23.4 61 Z" fill="#5c4f43" stroke="#2c251e" stroke-width="1.3"/>' +
    '<path d="M29.5 56 L31.4 84 L26.4 84 L24.6 61 Z" fill="#54483c" stroke="#2c251e" stroke-width="1.3"/>' +
    '<rect x="13.8" y="25" width="20.4" height="34" rx="4" fill="#6e5a44" stroke="#2c251e" stroke-width="1.4"/>' +
    '<path d="M14.5 30.5 L33.5 38.5 L33 44 L15 36.4 Z" fill="#8c2f26"/>' +
    '<path d="M27 41 L38.5 60" stroke="#1d1a16" stroke-width="4.2" stroke-linecap="round"/>' +
    '<circle cx="24" cy="16.5" r="6.8" fill="#b98f6e" stroke="#5f4630" stroke-width="1.2"/>' +
    '<path d="M16.8 14.6 a7.4 7.4 0 0 1 14.4 0 l-.6 2.8 H17.4 Z" fill="#7a3b2a" stroke="#472217" stroke-width="1.3"/>' +
    '</svg>';
  var PLANT_SVG = '<svg viewBox="0 0 48 96" aria-hidden="true">' +
    '<ellipse cx="24" cy="91" rx="15" ry="3.4" fill="rgba(0,0,0,.38)"/>' +
    '<path d="M24 90 C21 78 20 68 21 56 L27 56 C28 68 27 78 24 90 Z" fill="#4d6b35" stroke="#2c421e" stroke-width="1.4"/>' +
    '<path d="M21.5 66 C14 62 9.5 55 8.5 46 C15 47.5 20 53 21.8 60 Z" fill="#5d8140" stroke="#2c421e" stroke-width="1.3"/>' +
    '<path d="M26.5 66 C34 62 38.5 55 39.5 46 C33 47.5 28 53 26.2 60 Z" fill="#5d8140" stroke="#2c421e" stroke-width="1.3"/>' +
    '<path d="M24 56 C24 44 24 36 24 28" stroke="#4d6b35" stroke-width="4.6"/>' +
    '<circle cx="24" cy="21" r="10.5" fill="#79a94b" stroke="#2c421e" stroke-width="1.5"/>' +
    '<circle cx="24" cy="21" r="5.6" fill="#d7e94e"/>' +
    '<circle cx="24" cy="21" r="2.4" fill="#fff6ae"/>' +
    '<path d="M16 88 C19 85 21 86 24 89 C27 86 29 85 32 88" stroke="#2c421e" stroke-width="2" fill="none"/>' +
    '</svg>';
  /* Rule 29 (Steve, 2026-11-12 PM): THE CHESSBOARD — structures on the
   * battle board are PIECES with HEIGHT, in the same diorama family as
   * the Rule 27 figures: raised representations standing ON their
   * tiles, drawn with lit top faces and shaded fronts so height reads
   * as information from the 3/4 camera. Relative heights are the
   * legend: silo/city tallest, warehouse/barn/depot mid, houses and
   * stores lower, wrecks and crates low. Heights are % of a tile —
   * figures stand 196% (~6 ft), a silo ~3 tiles. */
  var PIECE_HEIGHTS = { silo: 300, city: 280, warehouse: 215, barn: 195, depot: 190, bunker: 120,
    house_a: 175, house_b: 175, house_c: 175, store_a: 160, store_b: 160, store_c: 160, store_d: 160,
    wreck: 88, crate: 62, debris: 55 };
  function pieceSvg(kind) {
    var top = '#a89a7c', front = '#7d6f55', side = '#5d5340', line = '#33302a', roof = '#6e4a3a';
    if (kind === 'silo') return '<svg viewBox="0 0 48 100" aria-hidden="true"><ellipse cx="24" cy="96" rx="16" ry="3.4" fill="rgba(0,0,0,.38)"/><path d="M12 34 a12 9 0 0 1 24 0 Z" fill="#8f96a0" stroke="' + line + '" stroke-width="1.4"/><rect x="12" y="34" width="24" height="60" fill="#7c8288" stroke="' + line + '" stroke-width="1.4"/><path d="M24 34 v60" stroke="rgba(0,0,0,.22)" stroke-width="5"/><path d="M12 52 h24 M12 70 h24 M12 86 h24" stroke="rgba(0,0,0,.28)" stroke-width="1.6"/></svg>';
    if (kind === 'city') return '<svg viewBox="0 0 48 100" aria-hidden="true"><ellipse cx="24" cy="96" rx="17" ry="3.4" fill="rgba(0,0,0,.4)"/><path d="M10 14 L24 7 L38 14 L38 20 L10 20 Z" fill="' + top + '" stroke="' + line + '" stroke-width="1.3"/><rect x="10" y="20" width="28" height="74" fill="' + front + '" stroke="' + line + '" stroke-width="1.4"/><path d="M24 7 v-4" stroke="' + line + '" stroke-width="2"/><g fill="#e8ddae"><rect x="15" y="28" width="4" height="5"/><rect x="22" y="28" width="4" height="5"/><rect x="29" y="28" width="4" height="5"/><rect x="15" y="40" width="4" height="5"/><rect x="29" y="40" width="4" height="5"/><rect x="18" y="52" width="4" height="5"/><rect x="26" y="52" width="4" height="5"/><rect x="15" y="64" width="4" height="5"/><rect x="22" y="64" width="4" height="5"/><rect x="29" y="64" width="4" height="5"/></g><rect x="20" y="80" width="8" height="14" fill="#4a4234"/></svg>';
    if (kind === 'warehouse') return '<svg viewBox="0 0 72 100" aria-hidden="true"><ellipse cx="36" cy="96" rx="30" ry="3.6" fill="rgba(0,0,0,.38)"/><path d="M8 34 L22 24 L64 24 L56 34 Z" fill="' + top + '" stroke="' + line + '" stroke-width="1.3"/><path d="M56 34 L64 24 L64 88 L56 94 Z" fill="' + side + '" stroke="' + line + '" stroke-width="1.3"/><rect x="8" y="34" width="48" height="60" fill="' + front + '" stroke="' + line + '" stroke-width="1.4"/><rect x="24" y="56" width="18" height="38" fill="#57503f" stroke="' + line + '" stroke-width="1.4"/><path d="M24 56 L42 94 M42 56 L24 94" stroke="rgba(0,0,0,.3)" stroke-width="1.6"/><path d="M10 44 h44" stroke="rgba(0,0,0,.25)" stroke-width="2"/></svg>';
    if (kind === 'barn') return '<svg viewBox="0 0 56 100" aria-hidden="true"><ellipse cx="28" cy="96" rx="22" ry="3.4" fill="rgba(0,0,0,.38)"/><path d="M8 40 L16 26 L28 21 L40 26 L48 40 L48 46 L8 46 Z" fill="' + roof + '" stroke="' + line + '" stroke-width="1.4"/><rect x="10" y="46" width="36" height="48" fill="#86594a" stroke="' + line + '" stroke-width="1.4"/><path d="M21 62 h14 v32 H21 Z M21 62 L35 94 M35 62 L21 94" fill="none" stroke="#3d2f28" stroke-width="1.8"/></svg>';
    if (kind === 'depot') return '<svg viewBox="0 0 56 100" aria-hidden="true"><ellipse cx="28" cy="96" rx="23" ry="3.4" fill="rgba(0,0,0,.38)"/><path d="M13 52 a15 13 0 0 1 30 0 Z" fill="#9aa2a8" stroke="' + line + '" stroke-width="1.4"/><circle cx="28" cy="41" r="2.6" fill="#d7e94e"/><rect x="8" y="52" width="40" height="42" fill="#6d6a5e" stroke="' + line + '" stroke-width="1.4"/><rect x="21" y="66" width="14" height="28" rx="6" fill="#43413a" stroke="' + line + '" stroke-width="1.3"/></svg>';
    if (kind === 'bunker') return '<svg viewBox="0 0 56 100" aria-hidden="true"><ellipse cx="28" cy="96" rx="23" ry="3.4" fill="rgba(0,0,0,.38)"/><path d="M6 78 L20 68 L50 68 L44 78 Z" fill="' + top + '" stroke="' + line + '" stroke-width="1.3"/><rect x="6" y="78" width="38" height="16" fill="' + front + '" stroke="' + line + '" stroke-width="1.4"/><rect x="19" y="80" width="12" height="14" fill="#2f2c26"/></svg>';
    if (kind === 'store') return '<svg viewBox="0 0 56 100" aria-hidden="true"><ellipse cx="28" cy="96" rx="22" ry="3.4" fill="rgba(0,0,0,.38)"/><path d="M8 36 L20 28 L48 28 L42 36 Z" fill="' + top + '" stroke="' + line + '" stroke-width="1.3"/><rect x="8" y="36" width="34" height="58" fill="' + front + '" stroke="' + line + '" stroke-width="1.4"/><rect x="8" y="36" width="34" height="11" fill="#8c2f26"/><path d="M6 52 L44 52 L40 60 L10 60 Z" fill="#b39d6b" stroke="' + line + '" stroke-width="1.2"/><rect x="14" y="66" width="9" height="12" fill="#cfe0ea"/><rect x="28" y="66" width="8" height="28" fill="#4a4234"/></svg>';
    if (kind === 'wreck') return '<svg viewBox="0 0 56 100" aria-hidden="true"><ellipse cx="28" cy="96" rx="23" ry="3.2" fill="rgba(0,0,0,.4)"/><path d="M8 94 L12 66 L22 74 L28 58 L36 70 L44 62 L48 94 Z" fill="#5c5546" stroke="' + line + '" stroke-width="1.4"/><path d="M28 58 L38 40" stroke="#3a362e" stroke-width="3.4"/><circle cx="39" cy="38" r="3" fill="#3a362e"/><path d="M14 82 h28" stroke="rgba(0,0,0,.3)" stroke-width="2"/></svg>';
    if (kind === 'crate') return '<svg viewBox="0 0 48 100" aria-hidden="true"><ellipse cx="24" cy="96" rx="17" ry="3" fill="rgba(0,0,0,.38)"/><path d="M8 66 L17 59 L40 59 L33 66 Z" fill="#9a8a68" stroke="' + line + '" stroke-width="1.3"/><rect x="8" y="66" width="25" height="28" fill="#7d6f55" stroke="' + line + '" stroke-width="1.4"/><path d="M33 66 L40 59 L40 87 L33 94 Z" fill="#5d5340" stroke="' + line + '" stroke-width="1.3"/><path d="M8 66 L33 94 M33 66 L8 94" stroke="rgba(0,0,0,.28)" stroke-width="1.6"/></svg>';
    if (kind === 'debris') return '<svg viewBox="0 0 56 100" aria-hidden="true"><ellipse cx="28" cy="96" rx="22" ry="3" fill="rgba(0,0,0,.36)"/><path d="M6 94 L16 76 L24 86 L32 72 L40 84 L46 78 L50 94 Z" fill="#6b6252" stroke="' + line + '" stroke-width="1.3"/><path d="M18 88 L34 80" stroke="#3f3a30" stroke-width="2.6"/></svg>';
    /* house (default) — ruined: pitched roof, one slope broken */
    return '<svg viewBox="0 0 56 100" aria-hidden="true"><ellipse cx="28" cy="96" rx="22" ry="3.4" fill="rgba(0,0,0,.38)"/><path d="M6 48 L28 29 L50 48 L44 48 L28 36 L13 48 Z" fill="' + roof + '" stroke="' + line + '" stroke-width="1.4"/><path d="M36 34 L44 27 L44 40 L38 42 Z" fill="#57493a"/><rect x="12" y="48" width="32" height="46" fill="' + front + '" stroke="' + line + '" stroke-width="1.4"/><rect x="23" y="68" width="10" height="26" fill="#4a4234"/><rect x="16" y="55" width="7" height="8" fill="#cfe0ea"/><path d="M33 55 l7 8 M40 55 l-7 8" stroke="#3a352c" stroke-width="1.6"/></svg>';
  }
  function structurePiece(kindKey, label, hPct) {
    var svgKind = /^store/.test(kindKey) ? 'store' : (/^house/.test(kindKey) ? 'house' : kindKey);
    return '<span class="gpiece" title="' + esc(label) + '" style="height:' + hPct + '%">' + pieceSvg(svgKind) + '</span>';
  }
  function poiPiece(poiT) {
    var pk = poiT.building || (poiT.kind === 'city' ? 'city' : poiT.kind === 'depot' ? 'depot' :
      poiT.kind === 'debris' ? 'debris' : poiT.kind === 'bunker' ? 'bunker' : 'house_a');
    return structurePiece(pk, poiT.label || pk, PIECE_HEIGHTS[pk] || 170);
  }
  var MACHINE_SVG = '<svg viewBox="0 0 48 96" aria-hidden="true">' +
    '<ellipse cx="24" cy="91" rx="16" ry="3.6" fill="rgba(0,0,0,.42)"/>' +
    '<path d="M17 58 L14.5 86 L20 86 L22.5 62 Z" fill="#565b60" stroke="#26292c" stroke-width="1.4"/>' +
    '<path d="M31 58 L33.5 86 L28 86 L25.5 62 Z" fill="#4e5357" stroke="#26292c" stroke-width="1.4"/>' +
    '<rect x="11" y="26" width="26" height="34" rx="3.5" fill="#666c71" stroke="#26292c" stroke-width="1.6"/>' +
    '<rect x="15.5" y="31" width="17" height="9" fill="#3c4043"/>' +
    '<circle cx="24" cy="35.5" r="3.1" fill="#ff3b26"/><circle cx="24" cy="35.5" r="5.4" fill="none" stroke="#c1272d" stroke-width="1.4"/>' +
    '<path d="M30 46 L45.5 39.5" stroke="#1f2123" stroke-width="4.6" stroke-linecap="round"/>' +
    '<rect x="15" y="47" width="7.5" height="8" fill="#484d51"/><rect x="25.5" y="47" width="7.5" height="8" fill="#484d51"/>' +
    '<rect x="17" y="12" width="14" height="11" rx="2" fill="#5a6064" stroke="#26292c" stroke-width="1.4"/>' +
    '<path d="M24 12 L24 5 M19 8 L21.5 12 M29 8 L26.5 12" stroke="#33373a" stroke-width="1.8"/>' +
    '</svg>';
  function apexCardHtml(a) {
    var home = null;
    (state.pois || []).forEach(function (p) { if (p.id === a.homePoiId) home = p; });
    // Intel has two tenses: pre-reveal ship knowledge, and what the silo
    // AI's testimony makes of it (core.apexIntelFor picks the tense).
    var postReveal = !!(state.campaign && state.campaign.revealSeen);
    var intelList = C.apexIntelFor ? C.apexIntelFor(state, a) : (a.intel || []);
    var intel = (intelList && intelList.length)
      ? '<br><b>Class intel — SIREN' + (postReveal ? ' (after the silo\'s testimony)' : '') + ':</b>' + intelList.map(function (t) { return '<br>· ' + esc(t); }).join('')
      : '';
    var notes = (a.notes || []).length
      ? a.notes.map(function (n) { return '<br>· ' + esc(n.text); }).join('')
      : '<br><span class="muted">No encounters logged yet.</span>';
    return '<span class="apex-title">☠ ' + (a.name ? esc(a.name) : 'APEX SIGN — UNIDENTIFIED') + '</span>' +
      '<br>Territory: ' + (home ? esc(home.label) + ' (' + a.x + ',' + a.y + ')' : '(' + a.x + ',' + a.y + ')') +
      (home ? '<br>Ground radiation: ' + radMeter(home.radiation) + ' ' + home.radiation + '/4 — the hottest ground draws the biggest ones.' : '') +
      intel +
      '<br><b>Known encounters:</b>' + notes;
  }

  function renderMap() {
    var grid = $('map-grid');
    var route = state.settlement ? routeSet() : {};
    /* Presentation only: terrain lookup so land/water edges can be tinted
       as shoreline (coast) and shallows (shore). Only DISCOVERED tiles feed
       the lookup — fog stays honest, an unrevealed neighbor tints nothing.
       No game state is derived. */
    var byKey = {};
    state.tiles.forEach(function (tt) { if (tt.discovered) byKey[tt.x + ',' + tt.y] = tt.terrain; });
    function terrainAt(x, y) { return byKey[x + ',' + y] || null; }
    $('ship-caption').textContent = 'Airship holding over (' + state.airship.x + ', ' + state.airship.y +
      ') · ship fuel ' + state.airship.fuel + '/' + state.airship.maxFuel + ' tank points';
    /* The on-map zeppelin marker hovers over the airship's current cell. */
    var gw = 0, gh = 0;
    state.tiles.forEach(function (tt) {
      if (tt.x + 1 > gw) gw = tt.x + 1;
      if (tt.y + 1 > gh) gh = tt.y + 1;
    });
    var g = hexGeom(gw, gh);
    grid.style.aspectRatio = String(g.aspect);
    /* Board zoom + tier: FAR sprites ride inside the hexes; at NEAR zoom
       the modeled sprites crossfade in on the overlay layer. The board
       transform itself is owned by applyCam() (top-down camera) —
       render only restates it; selection is never an input to it. */
    syncBoardTier();
    applyCam();
    measureMapMetrics();
    updateWorldRect();
    var marker = $('ship-marker');
    var shipC = hexCenter(state.airship.x, state.airship.y, g);
    marker.style.left = shipC.x + '%';
    marker.style.top = shipC.y + '%';
    /* Live map lookups: POIs by coordinate, the radiation field (POI hexes
       glow at their level; hot POIs throw a faint halo onto neighbor
       hexes so hot ground reads as a patch), and the map-screen gate look
       (best squad the living roster can field). */
    var poiByCoord = {}, poiTiles = {}, radField = {}, tierField = {};
    (state.pois || []).forEach(function (p) {
      poiByCoord[p.x + ',' + p.y] = p; poiTiles[p.x + ',' + p.y] = true;
      if (!p.radiation) return;
      radField[p.x + ',' + p.y] = Math.max(radField[p.x + ',' + p.y] || 0, p.radiation);
      // Act tinting (2026-11-10): the POI's zone tier colours its hex —
      // green/yellow/red reads as the campaign chapter at a glance.
      tierField[p.x + ',' + p.y] = C.poiZoneTier(p);
      if (p.radiation >= 2) hexNeighbors(p.x, p.y).forEach(function (n) {
        var k = n.x + ',' + n.y;
        if (!radField[k]) radField[k] = -1;
        if (!tierField[k]) tierField[k] = C.poiZoneTier(p);
      });
    });
    var livingByLevel = C.livingDivers(state).slice().sort(function (a, b) { return b.level - a.level; });
    var gateProxy = C.cityGate(state, livingByLevel.slice(0, C.TUNABLES.cityGateHeroes).map(function (d) { return d.id; }));
    var html = '';
    state.tiles.forEach(function (t) {
      var pres = tilePresentation(t);
      var cls;
      if (!t.discovered) { cls = 'fog'; }
      else {
        cls = t.terrain;
        var nbs = [terrainAt(t.x + 1, t.y), terrainAt(t.x - 1, t.y), terrainAt(t.x, t.y + 1), terrainAt(t.x, t.y - 1)];
        var nearWater = nbs.indexOf('water') !== -1;
        var nearLand = nbs.some(function (n) { return n && n !== 'water'; });
        if (t.terrain === 'water' && nearLand) cls += ' shore';
        else if (t.terrain !== 'water' && nearWater) cls += ' coast';
        if (t.isGreenZone) cls += ' green';
        else if (t.isColony) cls += ' colony';
        else if (t.isInterdiction) cls += ' interdiction';
        else if (t.robotSite && !t.robotSite.cleared) cls += ' robot';
        else if (t.supplySite && !t.supplySite.looted) cls += ' supply';
        else if (t.resourceType) cls += ' resource resource-' + t.resourceType.toLowerCase();
        var cellPoi = poiByCoord[t.x + ',' + t.y];
        if (cellPoi && cellPoi.group === 'stores') cls += ' street';
        else if (t.terrain !== 'water' && hexNeighbors(t.x, t.y).some(function (n) { return poiTiles[n.x + ',' + n.y]; })) cls += ' rubble';
        var rl = radField[t.x + ',' + t.y];
        if (rl) cls += rl < 0 ? ' radsoft' : ' rad' + Math.min(4, rl);
        var tf = tierField[t.x + ',' + t.y];
        if (tf) cls += ' zone-' + tf;
      }
      if (t.x === state.airship.x && t.y === state.airship.y) cls += ' ship';
      if (route[t.x + ',' + t.y]) cls += state.supply.status === 'choked' ? ' choked' : ' route';
      if (t.x === selected.x && t.y === selected.y) cls += ' selected';
      var accessible = pres.name + ' at tile ' + t.x + ',' + t.y + '. ' + pres.detail;
      var poi = t.discovered ? poiByCoord[t.x + ',' + t.y] : null;
      var far = poi ? atlasStyle((poi.building || 'city') + ':far') : null;
      var inner;
      if (poi && far) {
        var locked = poi.zone === 'city' && !gateProxy.unlocked;
        inner = '<span class="poi-far' + poiStateClass(poi) + (locked ? ' locked' : '') + '" style="' + far.css + '" aria-hidden="true"></span>';
      } else {
        inner = '<span class="tile-icon" aria-hidden="true">' + esc(pres.icon) + '</span>' +
          '<span class="tile-label">' + esc(pres.label) + '</span>';
      }
      html += '<button type="button" class="cell ' + cls + '" data-x="' + t.x + '" data-y="' + t.y + '" ' +
        'style="left:' + hexLeft(t.x, t.y, g) + '%;top:' + (1.5 * t.y / g.hUnits * 100) + '%;width:' + g.wPct + '%" ' +
        'data-tile-label="' + esc(pres.label) + '" title="' + esc(accessible) + '" aria-label="' + esc(accessible) + '">' +
        inner + '</button>';
    });
    grid.innerHTML = html;
    /* Cell clicks ride ONE delegated listener on #map-grid (bound at
       startup, below) — rebuilding 576 per-cell listeners on every
       render was a standing cost the 2026-11-12 lag fix removed. */
    /* NEAR tier: modeled sprites standing on their hexes (discovered only —
       the fog stays honest). */
    var layerHtml = '';
    (state.pois || []).forEach(function (p) {
      var pt = C.tileAt(state, p.x, p.y);
      if (!pt || !pt.discovered) return;
      var st = atlasStyle((p.building || 'city') + ':near');
      if (!st) return;
      var r = st.entry.rect;
      var wPct = (st.entry.footprintTiles ? st.entry.footprintTiles[0] : 1) * 1.32 * g.wPct;
      var c = hexCenter(p.x, p.y, g);
      var lockedN = p.zone === 'city' && !gateProxy.unlocked;
      layerHtml += '<div class="poi-sprite' + poiStateClass(p) + (lockedN ? ' locked' : '') + '" style="left:' + c.x +
        '%;top:' + hexBottom(p.x, p.y, g) + '%;width:' + wPct + '%;aspect-ratio:' + r[2] + '/' + r[3] +
        ';transform:translate(-' + (st.entry.anchor[0] * 100) + '%,-100%) rotateX(' + (-TILT_DEG) + 'deg)' +
        ';transform-origin:' + (st.entry.anchor[0] * 100) + '% 100%;' + st.css + '"></div>';
    });
    $('poi-layer').innerHTML = layerHtml;
    /* Apex markers: shown BY DEFAULT — fog, zoom and recon never gate the
       biggest ones. Hover reads the intel card; click selects the hex. */
    var apexHtml = '';
    (state.apex || []).forEach(function (a) {
      var c = hexCenter(a.x, a.y, g);
      apexHtml += '<button type="button" class="apex-marker" data-apex="' + a.id + '" style="left:' + c.x + '%;top:' + c.y +
        '%" aria-label="Apex sign at ' + a.x + ',' + a.y + ' — hover for intel">' + SKULL_SVG + '</button>';
    });
    var apexLayer = $('apex-layer');
    apexLayer.innerHTML = apexHtml;
    Array.prototype.forEach.call(apexLayer.querySelectorAll('.apex-marker'), function (el) {
      var a = (state.apex || []).filter(function (q) { return q.id === el.dataset.apex; })[0];
      if (!a) return;
      el.addEventListener('mouseenter', function () {
        var card = $('apex-card');
        card.innerHTML = apexCardHtml(a);
        card.hidden = false;
        var c = hexCenter(a.x, a.y, g);
        card.style.left = Math.min(74, c.x + 3) + '%';
        card.style.top = Math.max(1, c.y - 17) + '%';
      });
      el.addEventListener('mouseleave', function () { $('apex-card').hidden = true; });
      el.addEventListener('click', function () { selectTile(a.x, a.y); });
    });
    var t = C.tileAt(state, selected.x, selected.y);
    var selectedPres = tilePresentation(t);
    /* Campaign strip (2026-11-10): act, the chart-fragment meter, and the
       green-fuel gauge — meters, not a text log (Rule 3). */
    var camp = state.campaign || { act: 1, fragments: {} };
    var fragN = C.chartFragmentCount(state);
    var fragPips = '';
    for (var fi = 0; fi < 4; fi++) fragPips += '<i class="' + (fi < fragN ? 'on' : '') + '"></i>';
    var gf = C.remainingGreenFuel(state);
    var gfPct = Math.max(0, Math.min(100, gf.sources * 10));
    var info = '<div class="campaign-strip"><strong class="endgame-tag">CAMPAIGN — FIND THE ISLANDS</strong> ' +
      'Act ' + camp.act + ' of 4 · Chart fragments <span class="gatepips">' + fragPips + '</span> ' + fragN + ' / 4' +
      (camp.aiFound ? ' · <span class="muted">the silo AI is awake</span>' : '') +
      '<br>Green cells left in the wild: <span class="gauge gate-gauge"><span class="gauge-fill" style="width:' + gfPct + '%"></span></span> ' +
      gf.sources + ' site(s), ' + gf.cells + ' cells</div>' +
      '<strong>Tile (' + t.x + ',' + t.y + ') — ' + esc(selectedPres.name) + '</strong>' +
      '<br><span class="muted">' + esc(selectedPres.detail) + '</span>';
    if (!t.discovered) info += '<br><span class="muted">Undiscovered — fog of war. Recon or move the airship closer to reveal it.</span>';
    else {
      var known = C.knownThreat(state, t);
      info += '<br>Terrain: ' + esc(t.terrain) + (t.terrain === 'water' ? ' (no landing)' : '') +
        ' · Threat: ' + esc(known.text) + '/5' +
        ' · Recon: ' + (t.reconTier || 0) + '/3 (+' + C.TUNABLES.reconBonus[t.reconTier || 0] + ')' +
        (t.resourceType ? '<br>Resource node: ' + esc(t.resourceType) + ' (yield ' + t.resourceYield + ')' : '') +
        (t.supplySite && !t.supplySite.looted ? '<br><b>Supply cache</b> — ' + esc(t.supplySite.name) + ': ~' + t.supplySite.amount + ' ' + esc(t.supplySite.resource) + '. <span class="warn">The ground around it is lethal.</span>' : '') +
        (t.supplySite && t.supplySite.looted ? '<br><span class="muted">The supply cache here was emptied.</span>' : '') +
        (t.robotSite && !t.robotSite.cleared ? '<br><b>Robot ruin</b> — ' + esc(t.robotSite.name) + ': ~' + t.robotSite.scrap + ' SCRAP + ~' + t.robotSite.intel + ' INTEL, held by <span class="bad">sentient machine guardians</span>.' : '') +
        (t.robotSite && t.robotSite.cleared ? '<br><span class="muted">The robot ruin here has gone dark — vaults emptied.</span>' : '') +
        (t.isGreenZone ? '<br><b>GREEN ZONE</b> — a settlement can be founded here.' : '') +
        (t.isColony ? '<br>Kestrel Colony — trade partner (see Trade screen).' : '') +
        (t.isInterdiction ? '<br><b>Hostile supply cache</b> — raid it with an interdiction drop (raises retaliation, §5.4).' : '') +
        (t.hazard ? '<br><span class="warn">Hazard-marked</span> (reads fully at recon 2+).' : '') +
        '<br>Wind: ' + t.windX + ' E/W · ' + t.windY + ' N/S on descent.';
    }
    var selPoi = t.discovered ? poiByCoord[t.x + ',' + t.y] : null;
    var poiNotes = '';
    if (selPoi) {
      info += '<br><strong>' + esc(selPoi.label) + '</strong> — POI · state: <b>' + esc(selPoi.state.toUpperCase()) + '</b>' +
        '<br>Radiation: ' + radMeter(selPoi.radiation) + ' ' + selPoi.radiation + '/4 — ' + radTierName(selPoi.radiation) +
        (selPoi.radiation ? ' <span class="muted">(fauna +' + (selPoi.radiation * C.TUNABLES.radiationThreatWeight) + ' threat)</span>' : ' <span class="muted">(clean)</span>') +
        (selPoi.kind === 'depot' ? (selPoi.state === 'standing'
          ? '<br><span class="warn">Machine guardians hold this depot</span> <span class="muted">(+' + C.TUNABLES.depotGuardThreat + ' threat, fixed)</span>'
          : '<br><span class="muted">Depot emptied — its guardians are scrap.</span>') : '') +
        '<br>Zone: <b>' + esc(C.poiZoneTier(selPoi).toUpperCase()) + '</b> <span class="muted">(fall x' + C.fallSeverity(state, selPoi.x, selPoi.y).multiplier + ')</span>' +
        ((selPoi.fuelCells || 0) > 0 ? ' · Fuel cells: <b>' + selPoi.fuelCells + '</b>' : '') +
        (C.activeGuards(selPoi).length ? '<br><span class="warn">Dormant war machines:</span> ' +
          C.activeGuards(selPoi).map(function (g) { return esc(g.form) + ' (+' + g.threat + ')'; }).join(' · ') : '') +
        (selPoi.kind === 'bunker' ? '<br><b>Doors:</b> ' + (selPoi.doors || []).map(function (d) {
            return esc(d.label) + ' — ' + (d.state === 'opened' ? '<b>OPEN</b>' : 'sealed'); }).join(' · ') : '') +
        (selPoi.kind === 'communal' ? '<br><b>Floor bands worked: ' + (selPoi.workedBands || 0) + ' / ' + (selPoi.bandsTotal || C.TUNABLES.communalBands) + '</b>' +
          ' <span class="gauge gate-gauge"><span class="gauge-fill" style="width:' + Math.round((selPoi.workedBands || 0) / (selPoi.bandsTotal || C.TUNABLES.communalBands) * 100) + '%"></span></span>' : '') +
        (selPoi.zone === 'city' ? gateHtml(gateProxy, 'best squad the roster can field') : '');
      /* Secondary lore/detail collapses behind one tap (2026-11-12 text
         consolidation) — reachable, not standing on the screen. */
      poiNotes =
        (selPoi.group === 'stores' ? '<br>The strip — four storefronts on adjoining hexes. Work them store to store.' : '') +
        (selPoi.kind === 'depot' && selPoi.state === 'standing' ? '<br>Tech salvage concentrates here — an ITC vault-warehouse under its dome, held by Old World war machines: turret trucks and M3 Abrams tanks. Machines do not scale with radiation.' : '') +
        (C.activeGuards(selPoi).length ? '<br>Fixed positional threat; work the site to put them dark.' : '') +
        (selPoi.kind === 'bunker' ? '<br>One door per yielding drop. A campaign landmark, not a one-loot room.' : '') +
        (selPoi.kind === 'communal' ? '<br>A 99-floor silo under a hut on a dirt hill — worked band by band across drops. Seed bank on band ' + C.TUNABLES.communalSeedBand +
          ', the voice on band ' + C.TUNABLES.communalAiBand + ', the cryo bay on band ' + C.TUNABLES.communalCryoBand + ' (' +
          ((selPoi.cryoBay && selPoi.cryoBay.capsules) || 0) + ' capsules' + (selPoi.cryoReached ? ', bay reached' : '') + ').' : '') +
        (selPoi.kind === 'graveyard' ? '<br>Robot skeletons in rows — the machine age ended here. Searchable salvage; nothing in this field fights back.' : '');
      if (poiNotes) info += '<details class="poi-notes"><summary>Site notes</summary>' + poiNotes + '</details>';
      var selApex = (state.apex || []).filter(function (a) { return a.x === t.x && a.y === t.y; })[0];
      if (selApex) info += '<br><span style="color:#ff6a4d;font-weight:800">☠ APEX SIGN</span> <span class="muted">— one of the biggest ones is known to hold this ground. Hover its skull for intel.</span>';
    }
    info += '<br>Airship (' + state.airship.x + ',' + state.airship.y + ') · fuel ' + state.airship.fuel +
      ' · moved ' + state.airship.movedThisTurn + '/' + C.TUNABLES.moveRangePerTurn + ' — ' +
      (t.x === state.airship.x && t.y === state.airship.y
        ? '<b>Ship overhead — drop available on this tile.</b>'
        : '<span class="warn">No drop on this tile — move the airship here first.</span>');
    if (state.settlement) {
      info += '<br>Settlement: Tier ' + state.settlement.tier + ' at (' + state.settlement.x + ',' + state.settlement.y + ')' +
        ' · pop ' + state.settlement.population + ' · raid in ' +
        (state.resources.INTEL >= C.TUNABLES.raidIntelThreshold ? state.settlement.raidTimer + ' turn(s)' : '<span class="warn">unknown (need INTEL &ge; ' + C.TUNABLES.raidIntelThreshold + ')</span>');
    }
    $('map-info').innerHTML = info;
    $('btn-found').disabled = !(t.isGreenZone && t.discovered && !state.settlement);
    /* §3: the persistent objective line — one sentence, always on the map,
       driven by where the campaign actually stands. */
    var objEl = $('objective-line');
    if (objEl) {
      var jp = C.journalProgress(state);
      objEl.innerHTML = '<strong>Objective:</strong> ' + esc(objectiveText()) +
        ' <button type="button" class="small" id="btn-journal-map">📖 Journal (' + jp.found + ' of ' + jp.total + ')</button>';
      var jb = $('btn-journal-map');
      if (jb) jb.addEventListener('click', function () { toggleJournal(true); });
    }
    /* §2: GROUNDED gets a banner and a one-tap fix, not a silent refusal. */
    var gb = $('grounded-banner');
    if (gb) {
      var grounded = C.isGrounded(state);
      var lowFuel = !grounded && state.airship.fuel <= 3;
      gb.hidden = !(grounded || lowFuel);
      if (grounded || lowFuel) {
        gb.className = grounded ? 'grounded' : 'lowfuel';
        gb.innerHTML = (grounded
          ? '<strong>GROUNDED — the tank is dry.</strong> The ship cannot move or drop. '
          : '<strong>Low fuel — ' + state.airship.fuel + ' point(s) in the tank.</strong> A drop costs 2; moving costs 1 per tile. ') +
          (state.resources.FUEL > 0
            ? 'Cargo holds ' + state.resources.FUEL + ' FUEL. <button type="button" class="small" id="btn-refuel-map">Refuel from cargo</button>'
            : 'Cargo holds no FUEL — work a site with fuel cells, or trade for FUEL.');
        var rb = $('btn-refuel-map');
        if (rb) rb.addEventListener('click', function () {
          var r = C.refuelAirship(state);
          if (r.ok) playSfx('refill');
          toast(r.ok ? 'Transferred ' + r.transferred + ' FUEL to the tank.' : r.reason);
          save(); render();
        });
      }
    }
    var mv = $('btn-move');
    if (mv) {
      var md = Math.max(Math.abs(t.x - state.airship.x), Math.abs(t.y - state.airship.y));
      mv.textContent = 'Move Airship — ' + md + ' tile(s), ' + md + ' fuel';
    }
    drawWorldMap();
  }
  /* The campaign in one sentence (§3): find the islands, fragment by
   * fragment, before the green fuel runs out. */
  function objectiveText() {
    var fragN = C.chartFragmentCount(state);
    if (state.gameStatus !== 'playing') return 'The campaign is ' + state.gameStatus + ' — read the Chronicle, or start a New Game.';
    if (fragN >= 4) return 'All four chart fragments are yours — the road to the Cazadores islands is open. Push for the city gate.';
    if (!state.settlement) return 'Find the Green Zone and found the settlement — then hunt the chart fragments (' + fragN + ' of 4) to the Cazadores islands.';
    var next = ['the rumor (drop, and drop again)', 'the silo AI (work the Communal bands deep)', 'the city fragment', 'the approach'][fragN] || 'the next fragment';
    return 'Hunt the chart fragments — ' + fragN + ' of 4 in hand; next: ' + next + '. Green cells are running out; hotter ground pays better.';
  }

  /* ---------------- Crew screen ---------------- */
  function diverCard(d, opts) {
    opts = opts || {};
    var tags = d.traits.map(function (t) { return '<span class="tag">' + esc(t) + '</span>'; }).join(' ');
    var status = d.status === 'dead' ? 'DEAD' : d.status === 'downed' ? 'DOWN — Medbay (' + (d.downedTurns || 0) + ' turn(s) left)' : d.wounds > 0 ? 'wounded (' + d.wounds + ')' : d.status;
    var heroTag = '';
    if (d.hero) {
      var hDef = C.heroDef(d.hero);
      heroTag = ' <span class="tag hero-tag">★ HERO — ' + (hDef && hDef.title ? esc(hDef.title) + ' · ' : '') + esc(stationLabel(hDef ? hDef.station : '')) + '</span>';
    }
    var html = '<div class="card' + (d.status === 'dead' ? ' dead' : '') + (d.hero ? ' hero-card' : '') + '">' +
      '<div class="card-head">' + thumb(d) + '<span><strong>' + esc(d.name) + '</strong> — Lv ' + d.level + ' · ' + esc(d.origin) + ' · ' + esc(status) + ' ' + archBadge(d) + heroTag + '</span></div>' +
      (C.isGarrisoned(state, d.id) ? ' · <span class="tag">garrison</span>' : '') +
      (C.isEscorting(state, d.id) ? ' · <span class="tag">escort</span>' : '') +
      '<div>' + gearHtml(d) + '</div>' +
      '<div class="statgrid">' +
      C.STATS.map(function (s) { return '<span class="chip">' + s + ' <b>' + d.stats[s] + '</b></span>'; }).join('') +
      '<span class="chip">XP <b>' + d.xp + '</b></span><span class="chip">Drops <b>' + d.dropsSurvived + '</b></span></div>' +
      (tags ? '<div>' + tags + '</div>' : '');
    if (d.pendingLevelUps > 0 && d.status !== 'dead') {
      html += '<div>Level-up ready — pick a stat to raise (+1; a second +1 goes to the lowest stat): ' +
        C.STATS.map(function (s) { return '<button type="button" class="small" data-levelup="' + d.id + ':' + s + '">+' + s + '</button>'; }).join(' ') + '</div>';
    }
    if (d.status !== 'dead' && d.status !== 'downed') {
      html += '<div>' +
        (d.wounds > 0 ? '<button type="button" class="small" data-rest="' + d.id + '">Rest (2 FOOD, -1 wound)</button> ' : '') +
        (P ? '<button type="button" class="small" data-look="' + d.id + '">New look</button> ' : '') +
        // Heroes keep their book names and their stations: no rename,
        // no garrison, no escort — they join drops by beat or by hire.
        (d.hero ? '' :
          '<button type="button" class="small" data-rename="' + d.id + '">Rename</button> ' +
          (state.settlement ? '<button type="button" class="small" data-garrison="' + d.id + '">' +
            (C.isGarrisoned(state, d.id) ? 'Leave garrison' : 'Assign garrison') + '</button> ' : '') +
          '<button type="button" class="small" data-escort="' + d.id + '">' +
          (C.isEscorting(state, d.id) ? 'Leave escort' : 'Assign escort') + '</button>') + '</div>';
    }
    return html + '</div>';
  }
  function renderCrew() {
    var slots = state.airship.upgradeSlots.map(function (s, i) {
      return 'Slot ' + (i + 1) + ': ' + (s.filled ? esc(s.type) : '<span class="muted">empty (trade, post-slice stock)</span>');
    }).join('<br>');
    var q = state.airship.trainingQueue;
    var wq = state.airship.wakeQueue;
    var pop = state.population != null ? state.population : 0;
    var popPct = Math.max(0, Math.min(100, Math.round(pop / C.TUNABLES.populationCapDisplay * 100)));
    var cryo = C.cryoSources(state);
    // Named hero pods at the Communal: wake by name (Ship Deck + Heroes).
    C.ensureHeroes(state);
    var communalReached = (state.pois || []).some(function (p) { return p.kind === 'communal' && p.cryoReached; });
    var heroWakeHtml = '';
    if (communalReached && C.heroPods(state).length) {
      heroWakeHtml = '<br><strong>Named pods (heroes of the books):</strong> ' + C.heroPods(state).map(function (h) {
        return esc(h.name) + ' <button type="button" class="small" data-wake-hero="' + h.id + '"' + (wq ? ' disabled' : '') +
          '>Wake ' + esc(h.shortName) + '</button>';
      }).join(' · ');
    }
    $('ship-panel').innerHTML = '<strong>Airship</strong> at (' + state.airship.x + ',' + state.airship.y + ')' +
      '<br>Fuel tank: ' + state.airship.fuel + '/' + state.airship.maxFuel +
      ' <button type="button" class="small" id="btn-refuel">Refuel from cargo FUEL</button>' +
      '<br>Cargo: ' + C.cargoUsed(state) + '/' + state.airship.cargoCapacity +
      ' · Crew: ' + C.livingDivers(state).length + '/' + state.airship.crewCapacity +
      '<br><strong>Souls aboard: ' + pop + '</strong> <span class="gauge gate-gauge"><span class="gauge-fill" style="width:' + popPct + '%"></span></span>' +
      ' <span class="muted">of ' + C.TUNABLES.populationCapDisplay + ' berths — the count drifts down ' + C.TUNABLES.populationDriftPerTurn +
      '/turn; founding, farms, Tier 2 and woken sleepers push it back. Stakes, not a lose timer.</span>' +
      '<br>' + slots +
      '<br>Training slot: ' + (q ? 'trainee (' + esc(q.guaranteedStat) + ' standard), ' + q.turnsLeft + ' turn(s) left' : 'empty — see Training screen') +
      '<br>Sleeper thaw: ' + (wq ? 'a sleeper from ' + esc(wq.fromLabel) + ' is waking — ' + wq.turnsLeft + ' turn(s) left' : 'idle') +
      (cryo.length ? '<br><strong>Cryo within reach:</strong> ' + cryo.map(function (s) {
          return esc(s.label) + ' — ' + s.capsules + ' capsule(s) ' +
            '<button type="button" class="small" data-wake="' + esc(s.poiId) + '"' + (wq ? ' disabled' : '') +
            '>Wake one (' + C.TUNABLES.sleeperWakeCost.FOOD + ' FOOD + ' + C.TUNABLES.sleeperWakeCost.SCRAP + ' SCRAP, ' +
            C.TUNABLES.sleeperWakeTurns + ' turns)</button>';
        }).join('<br>') : '<br><span class="muted">No cryo within reach — the buried silos keep their sleepers until their cryo bands and doors are worked.</span>') + heroWakeHtml;
    $('roster').innerHTML = state.divers.map(function (d) { return diverCard(d); }).join('') ||
      '<p class="muted">No divers.</p>';
    var ap = $('armory-panel');
    if (ap) {
      var crewIds = C.livingDivers(state).map(function (d) { return d.id; });
      ap.innerHTML = armoryHtml(crewIds);
      bindArmory(ap, function () { render(); });
    }
    $('btn-refuel').addEventListener('click', function () {
      var r = C.refuelAirship(state); toast(r.ok ? 'Transferred ' + r.transferred + ' FUEL to the tank.' : r.reason); save(); render();
    });
    bindWakeButtons($('ship-panel'));
    bindHeroButtons($('ship-panel'));
    bindDiverButtons($('screen-crew'));
  }
  /* ---------------- Armory (§§13-15): the ship pool, loadouts, upgrades --
   * One renderer, two homes: the briefing's pre-drop ARMORY STEP and the
   * Crew screen between drops. Everything found banks here; loadouts and
   * Auto-Equip draw from here; weight checks surface HERE. */
  function armoryHtml(ids) {
    var a = C.ensureArmory(state);
    var assigned = C.assignedItemIds(state);
    var html = '<div class="panel armory-pool"><strong>Armory pool (on the ship)</strong> — ' +
      a.weapons.length + ' weapon(s), ' + a.attachments.length + ' attachment(s), tac lights ' + a.tacLights +
      '<br>Grenades in the pool: <b>' + a.throwables.frag + ' frag · ' + a.throwables.flash + ' flash · ' + a.throwables.conc + ' conc</b>' +
      ' <span class="muted">— scarce: five is a stockpile. Flares never counted.</span>' +
      '<div class="action-bar"><button type="button" class="small" data-auto-equip="' + esc(ids.join(',')) + '">Auto-Equip All (fair spread, weight-legal)</button></div></div>';
    ids.forEach(function (id) {
      var d = C.diverById(state, id);
      if (!d || d.status === 'dead') return;
      var arch = C.ensureArchetype(d);
      var wt = C.loadoutWeight(state, d), bound = C.carryBound(d);
      var over = Math.round((wt - bound) * 10) / 10;
      var lo = C.loadoutOf(d);
      function opts(slot, currentId) {
        var o = '<option value="">Default — ' + esc(slot === 'primary' ? C.gearFor(d).weapon : C.DEFAULT_SECONDARY) + '</option>';
        a.weapons.forEach(function (w) {
          if (!C.slotFits(slot, w.name)) return;
          var held = assigned[w.id] && assigned[w.id] !== id;
          o += '<option value="' + w.id + '"' + (currentId === w.id ? ' selected' : '') + (held ? ' disabled' : '') + '>' +
            esc(w.name) + (w.level ? ' +' + w.level : '') + ' (' + C.weaponWeightOf(w.name) + ' kg)' + (held ? ' — carried by ' + esc(assigned[w.id]) : '') + '</option>';
        });
        return o;
      }
      var slotType = C.TUNABLES.kitSlotType[arch];
      var pack = C.grenadePackOf(d);
      var packType = slotType === 'any' ? (pack.frag ? 'frag' : pack.flash ? 'flash' : pack.conc ? 'conc' : null) : slotType;
      html += '<div class="card armory-card"><div class="card-head">' + thumb(d) +
        '<span><strong>' + esc(d.name) + '</strong> ' + archBadge(d) + '</span></div>' +
        '<label class="pick">Primary <select data-slot="' + id + ':primary">' + opts('primary', lo.primaryItemId) + '</select></label>' +
        '<label class="pick">Secondary <select data-slot="' + id + ':secondary">' + opts('secondary', lo.secondaryItemId) + '</select></label>' +
        '<label class="pick">Armor <select data-armor="' + id + '">' +
        Object.keys(C.TUNABLES.armorTiers).map(function (k2) {
          var t2 = C.TUNABLES.armorTiers[k2];
          return '<option value="' + k2 + '"' + (C.armorOf(d).key === k2 ? ' selected' : '') + '>' + esc(t2.label) + ' (' + t2.weight + ' kg, protection ' + t2.protection + ')</option>';
        }).join('') + '</select></label>' +
        '<label class="pick"><input type="checkbox" data-taclight="' + id + '"' + (d.tacLight ? ' checked' : '') + '> Carried tac light (0.5 kg — deters Sirens close, draws them from afar)</label>' +
        '<div class="grenade-row">Grenade slot (' + (slotType === 'any' ? 'any type — explosives trade' : slotType + ' — archetype standard') + '): ' +
        (packType ? '<b>' + esc(packType) + ' × ' + pack[packType] + '</b> from the pool ' +
          '<button type="button" class="small" data-grenade="' + id + ':' + packType + ':-1">Put back</button>'
          : (slotType === 'any'
            ? ['frag', 'flash', 'conc'].map(function (gt) {
                return '<button type="button" class="small" data-grenade="' + id + ':' + gt + ':1">Draw 1 ' + gt + ' (' + a.throwables[gt] + ' in pool)</button>';
              }).join(' ')
            : '<button type="button" class="small" data-grenade="' + id + ':' + slotType + ':1">Draw 1 ' + slotType + ' (' + (a.throwables[slotType] || 0) + ' in pool)</button>')) +
        ' <span class="muted">Carry cap: 1 grenade per diver per drop.</span></div>' +
        '<div class="weight-line' + (over > 0 ? ' over' : '') + '">Loadout: <b>' + wt + ' / ' + bound + ' kg</b>' +
        (over > 0 ? ' — <b>' + over + ' kg OVER the bound. This diver cannot launch like this.</b>' : ' — within the carry bound.') + '</div></div>';
    });
    if (a.weapons.length) {
      html += '<h4>Weapons in the pool</h4>' + a.weapons.map(function (w) {
        var prof = C.upgradedProfile(w.name, w.level);
        var nxt = w.level < C.TUNABLES.maxUpgrade ? C.upgradedProfile(w.name, w.level + 1) : null;
        var cost = w.level < C.TUNABLES.maxUpgrade ? C.TUNABLES.upgradeCosts[w.level] : null;
        var fits = Object.keys(w.attachments || {}).map(function (k) { return w.attachments[k]; });
        return '<div class="card armory-weapon">' + wicon(w.name) + '<strong>' + esc(w.name) + (w.level ? ' +' + w.level : '') + '</strong>' +
          ' <span class="muted">range ' + prof.range + ' · dmg ' + prof.dmg + (prof.dcMod ? ' · aim ' + prof.dcMod : '') + ' · ' + C.weaponWeightOf(w.name) + ' kg' +
          (assigned[w.id] ? ' · carried by ' + esc(assigned[w.id]) : ' · in the pool') + '</span>' +
          (fits.length ? '<br>Fitted: ' + fits.map(function (f) {
            return esc(f) + ' <button type="button" class="small" data-unfit="' + w.id + ':' + esc(f) + '">remove</button>';
          }).join(' · ') : '') +
          (nxt ? '<br><button type="button" class="small" data-upgrade="' + w.id + '">Upgrade to +' + (w.level + 1) + ' — ' + cost + ' SCRAP (range ' + prof.range + '→' + nxt.range + ', dmg ' + prof.dmg + '→' + nxt.dmg + ', aim ' + prof.dcMod + '→' + nxt.dcMod + ')</button>' : '<br><span class="muted">Max upgrade.</span>') +
          '</div>';
      }).join('');
    }
    if (a.attachments.length) {
      html += '<h4>Attachments in the pool</h4>' + a.attachments.map(function (att) {
        return '<div class="card armory-att">' + esc(att.kind) + ' (' + C.TUNABLES.attachmentWeights[att.kind] + ' kg) ' +
          '<select data-fit-for="' + att.id + '">' + a.weapons.map(function (w) {
            return '<option value="' + w.id + '">' + esc(w.name) + (w.level ? ' +' + w.level : '') + '</option>';
          }).join('') + '</select> ' +
          '<button type="button" class="small" data-fit="' + att.id + '">Fit</button></div>';
      }).join('');
    }
    return html;
  }
  function bindArmory(root, rerender) {
    function after(r, okMsg) {
      if (r && !r.ok) { playSfx('denied'); toast(r.reason); }
      else if (okMsg) { playSfx('confirm'); toast(okMsg); }
      save(); rerender();
    }
    Array.prototype.forEach.call(root.querySelectorAll('[data-slot]'), function (sel) {
      sel.addEventListener('change', function () {
        var parts = sel.dataset.slot.split(':');
        after(C.assignWeapon(state, parts[0], parts[1], sel.value || null));
      });
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-armor]'), function (sel) {
      sel.addEventListener('change', function () { after(C.setArmor(state, sel.dataset.armor, sel.value)); });
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-taclight]'), function (cb) {
      cb.addEventListener('change', function () { after(C.assignTacLight(state, cb.dataset.taclight, cb.checked)); });
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-grenade]'), function (b) {
      b.addEventListener('click', function () {
        var parts = b.dataset.grenade.split(':');
        after(C.assignGrenade(state, parts[0], parts[1], parseInt(parts[2], 10)));
      });
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-upgrade]'), function (b) {
      b.addEventListener('click', function () {
        var r = C.upgradeWeapon(state, b.dataset.upgrade);
        after(r, r.ok ? 'Upgraded for ' + r.cost + ' SCRAP.' : null);
      });
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-fit]'), function (b) {
      b.addEventListener('click', function () {
        var sel = root.querySelector('[data-fit-for="' + b.dataset.fit + '"]');
        after(C.fitAttachment(state, sel ? sel.value : null, b.dataset.fit));
      });
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-unfit]'), function (b) {
      b.addEventListener('click', function () {
        var parts = b.dataset.unfit.split(':');
        after(C.removeAttachment(state, parts[0], parts[1]));
      });
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-auto-equip]'), function (b) {
      b.addEventListener('click', function () {
        var ids = b.dataset.autoEquip.split(',').filter(Boolean);
        var custom = ids.some(function (id) { var d = C.diverById(state, id); return d && d.customized; });
        if (custom && !window.confirm('Auto-Equip overwrites hand-customized kits for the picked squad. Go?')) return;
        var r = C.autoEquip(state, ids);
        playSfx('confirm');
        toast('Auto-Equip done — fair spread, every loadout weight-legal.');
        save(); rerender();
      });
    });
  }

  function bindDiverButtons(root) {
    Array.prototype.forEach.call(root.querySelectorAll('[data-look]'), function (b) {
      b.addEventListener('click', function () {
        var d = C.diverById(state, b.dataset.look);
        if (d) { cycleLook(d); playSfx('select'); }
        render();
      });
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-rest]'), function (b) {
      b.addEventListener('click', function () {
        var r = C.restDiver(state, b.dataset.rest); toast(r.ok ? 'Rested. Wounds left: ' + r.woundsLeft : r.reason); save(); render();
      });
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-rename]'), function (b) {
      b.addEventListener('click', function () {
        var d = C.diverById(state, b.dataset.rename);
        var name = window.prompt('Rename diver', d ? d.name : '');
        if (name) { var r = C.renameDiver(state, b.dataset.rename, name); toast(r.ok ? 'Renamed to ' + r.name : r.reason); save(); render(); }
      });
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-garrison]'), function (b) {
      b.addEventListener('click', function () {
        var on = !C.isGarrisoned(state, b.dataset.garrison);
        var r = C.assignGarrison(state, b.dataset.garrison, on); toast(r.ok ? 'Garrison updated.' : r.reason); save(); render();
      });
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-escort]'), function (b) {
      b.addEventListener('click', function () {
        var on = !C.isEscorting(state, b.dataset.escort);
        var r = C.assignEscort(state, b.dataset.escort, on); toast(r.ok ? 'Escort updated.' : r.reason); save(); render();
      });
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-levelup]'), function (b) {
      b.addEventListener('click', function () {
        var parts = b.dataset.levelup.split(':');
        var r = C.applyLevelUpChoice(state, parts[0], parts[1]);
        toast(r.ok ? r.diver + ': raised ' + r.raised.join(' and ') + '.' : r.reason); save(); render();
      });
    });
  }

  /* ---------------- Briefing screen ---------------- */
  function defaultKind(t) {
    if (t.robotSite && !t.robotSite.cleared) return 'robot';
    if (t.supplySite && !t.supplySite.looted) return 'supply';
    if (t.isInterdiction) return 'interdiction';
    if (state.supply.status === 'choked' && C.routeTiles(state).some(function (p) { return p.x === t.x && p.y === t.y; })) return 'clear-route';
    if (t.resourceType) return 'gather';
    return 'scout';
  }
  function selectedSquad() {
    return Array.prototype.map.call(document.querySelectorAll('.squad-pick:checked'), function (el) { return el.value; });
  }
  /* Heroes in the briefing: who rides this drop (free beat / first-wake /
   * hired), and hire buttons for the rest. Heroes are EXTRA — cap +1 —
   * and are never picked from the squad checkboxes. */
  var pendingHeroJoins = [];
  function heroesBriefHtml(joins) {
    C.ensureHeroes(state);
    var woken = C.HEROES.filter(function (h) { return state.heroes[h.id].woken; });
    if (!woken.length) return '';
    var joinByHero = {};
    joins.forEach(function (j) { joinByHero[j.heroId] = j; });
    var rows = woken.map(function (h) {
      var d = C.heroDiverOf(state, h.id);
      if (!d) return '';
      var j = joinByHero[h.id];
      var right;
      if (j) right = '<span class="hero-join ' + j.mode + '">' + (j.mode === 'hire' ? 'HIRED — riding this drop' : 'RIDING FREE') + '<br><span class="muted">' + esc(j.reason) + '</span></span>';
      else if (d.status === 'downed') right = '<span class="muted">Down in the Medbay — ' + (d.downedTurns || 0) + ' turn(s) left.</span>';
      else if (d.status !== 'ready' || d.wounds > 0) right = '<span class="muted">Not fit to drop — rest at the Medbay.</span>';
      else {
        var price = C.heroPriceOf(h);
        right = '<button type="button" class="small" data-hire-hero="' + h.id + '">Hire for this drop — ' + price.INTEL + ' INTEL + ' + price.SCRAP + ' SCRAP</button>';
      }
      return '<div class="card hero-card"><div class="card-head">' + thumb(d) +
        '<span><strong>★ ' + esc(d.name) + '</strong> — HERO · ' + esc(stationLabel(h.station)) + ' ' + archBadge(d) + '</span></div>' +
        '<div>' + gearHtml(d) + '</div><div>' + right + '</div></div>';
    }).join('');
    return '<h3>Heroes — extra hands from the books</h3>' + rows;
  }
  function renderBriefing() {
    var t = C.tileAt(state, selected.x, selected.y);
    var body = $('briefing-body');
    if (!t) { body.innerHTML = '<p class="muted">Pick a tile on the Map first.</p>'; return; }
    var gate = C.dropGate(state, t.x, t.y);
    var shipHere = gate.ok;
    var tier = t.reconTier || 0;
    var kind = defaultKind(t);
    // Heroes never appear in the pick list: they join by beat or by hire
    // (extra member, cap +1) — they never replace a player diver.
    var avail = C.livingDivers(state).filter(function (d) { return !d.hero && C.diverAvailable(state, d); });
    var unavailable = C.livingDivers(state).filter(function (d) { return !d.hero && !C.diverAvailable(state, d); });
    var joinPoi = C.poiAt(state, t.x, t.y);
    var joins = C.heroJoinsForDrop(state, joinPoi);
    var heroSection = heroesBriefHtml(joins);
    var sitters = avail;
    var projIds = selectedSquad();
    var proj = projIds.length ? C.projectedBand(state, projIds, t.x, t.y, tier) : null;
    var poolNow = C.squadPool(state, projIds);
    var poolMax = 0;
    avail.forEach(function (d) { poolMax += C.diverValue(d); });
    /* Live map readout on the target (2026-11-07): the POI, its state, its
       radiation gauge, and — for a city — both ENDGAME gate keys read
       against the SELECTED squad. Fog honesty: undiscovered targets show
       none of it. */
    var bPoi = t.discovered ? C.poiAt(state, t.x, t.y) : null;
    var poiHtml = '';
    var cityLocked = false;
    if (bPoi) {
      poiHtml = '<br><strong>' + esc(bPoi.label) + '</strong> — POI · state: <b>' + esc(bPoi.state.toUpperCase()) + '</b>' +
        '<br>Radiation: ' + radMeter(bPoi.radiation) + ' ' + bPoi.radiation + '/4 — ' + radTierName(bPoi.radiation) +
        (bPoi.radiation ? ' <span class="muted">(fauna +' + (bPoi.radiation * C.TUNABLES.radiationThreatWeight) + ' threat, in the projection)</span>' : ' <span class="muted">(clean)</span>') +
        (bPoi.kind === 'depot' && bPoi.state === 'standing' ? '<br><span class="warn">Machine guardians hold this depot</span> <span class="muted">(+' + C.TUNABLES.depotGuardThreat + ' threat, fixed)</span>' : '');
      poiHtml += '<br>Zone: <b>' + esc(C.poiZoneTier(bPoi).toUpperCase()) + '</b> <span class="muted">(fall x' +
        C.fallSeverity(state, bPoi.x, bPoi.y).multiplier + ')</span>' +
        ((bPoi.fuelCells || 0) > 0 ? ' · Fuel cells: <b>' + bPoi.fuelCells + '</b>' : '') +
        (C.activeGuards(bPoi).length ? '<br><span class="warn">Dormant war machines:</span> ' +
          C.activeGuards(bPoi).map(function (g) { return esc(g.form) + ' (+' + g.threat + ' fixed)'; }).join(' · ') : '') +
        (bPoi.kind === 'bunker' ? '<br><b>Bunker doors:</b> ' + (bPoi.doors || []).map(function (d) {
            return esc(d.label) + ' (' + d.state + ')'; }).join(' · ') : '') +
        (bPoi.kind === 'communal' ? '<br><b>Communal silo:</b> bands worked ' + (bPoi.workedBands || 0) + ' / ' + (bPoi.bandsTotal || C.TUNABLES.communalBands) : '');
      if (bPoi.zone === 'city') {
        var gateNow = C.cityGate(state, projIds);
        cityLocked = !gateNow.unlocked;
        poiHtml += gateHtml(gateNow, 'selected squad') +
          (cityLocked ? '<br><span class="muted">Launch stays shut until both keys read complete.</span>' : '<br><b style="color:#8fe08f">The city is open. Whatever is down there is the biggest of it.</b>');
      }
    }
    /* §5(b): the fall is a dice roll against the weather — say so, with
       the risk in plain words, BEFORE launch. */
    var sevB = C.fallSeverity(state, t.x, t.y);
    var riskWord = sevB.multiplier <= 1 ? 'LOW — calm ground; the fall rarely hurts anyone'
      : sevB.multiplier < 2 ? 'MODERATE — rough weather; expect the dice to bite sometimes'
      : 'HIGH — storm ground; injuries on the way down are likely';
    var weatherHtml = '<br><strong>Descent weather:</strong> storm x' + sevB.multiplier + ' (' + sevB.tier.toUpperCase() + '). ' +
      '<strong>Injury risk: ' + riskWord + '.</strong> <span class="muted">(GRIT save, d20 + GRIT vs 16 — the report shows the rolls.)</span>';
    /* §7/§8: site intel states the Siren mix (and any war machine) in
       plain words so the squad can be planned around it. */
    var intelHtml = '';
    if (G && t.discovered) {
      var intel = G.siteIntel(C, state, t.x, t.y);
      intelHtml = '<br><strong>Site intel:</strong> ' + esc(intel.line) +
        (intel.machineLine ? '<br><span class="warn">' + esc(intel.machineLine) + '</span>' : '');
    }
    var gateLine = shipHere
      ? '<br><b style="color:#8fe08f">Airship overhead — the drop launches from here.</b>'
      : '<br><span class="warn"><b>No drop from here.</b> ' + esc(gate.reason) + ' (The airship is at (' + state.airship.x + ',' + state.airship.y + ').)</span>';
    body.innerHTML =
      '<details class="panel drop-explainer" data-drop-explainer aria-label="What happens when you drop?">' +
      '<summary>What happens when you drop? — how a drop runs, in 6 steps</summary>' +
      '<ol class="guide-steps">' +
      '<li><strong>You start aboard the airship.</strong> The ship stays above the clouds; the picked divers go down.</li>' +
      '<li><strong>Launch costs 2 ship-fuel points</strong> and starts an 8-second descent — steer against the wind, or skip the fall (the fall itself is a dice roll against the weather, shown below).</li>' +
      '<li><strong>Kit the squad in the Armory step below.</strong> Weapons, armor, lights and grenades are set BEFORE the drop; an over-weight diver cannot launch.</li>' +
      '<li><strong>On the ground, you fight the landing.</strong> A turn-based battle: action points to move, fire, throw and work the site — doors, bands, depots, caches. Extraction is your call, any time.</li>' +
      '<li><strong>Survivors balloon the haul back up.</strong> Everything found banks into the ship Armory — nobody owns a find. A snagged balloon can lose part of the haul; if nobody survives, nothing comes back.</li>' +
      '<li><strong>Wounds are dice.</strong> Every hit is a GRIT save against the weather and the ground; the report shows the actual rolls. Death is permanent.</li>' +
      '</ol>' +
      '<button type="button" class="small" data-open-guide>Open the full Help / Guide</button>' +
      '</details>' +
      '<div class="panel"><strong>Target (' + t.x + ',' + t.y + ')</strong> — ' + esc(t.terrain) +
      (t.discovered ? '' : ' <span class="warn">(undiscovered — landing scored with what you know)</span>') +
      '<br>Threat: ' + esc(C.knownThreat(state, t).text) + '/5' +
      '<br>Mission: <strong>' + esc(kind) + '</strong>' +
      (kind === 'robot' && t.robotSite ? ' — crack ' + esc(t.robotSite.name) + ': ~' + t.robotSite.scrap + ' SCRAP + ~' + t.robotSite.intel + ' INTEL behind machine guardians. The worst ground in the sector; on a catastrophe, the point diver gets no save.' : '') +
      (kind === 'supply' && t.supplySite ? ' — grab the cache at ' + esc(t.supplySite.name) + ': ~' + t.supplySite.amount + ' ' + esc(t.supplySite.resource) + '. Rich haul, lethal ground.' : '') +
      (t.resourceType ? ' — node ' + esc(t.resourceType) + ' yield ' + t.resourceYield : '') +
      '<br>Wind: ' + t.windX + ' E/W · ' + t.windY + ' N/S push' +
      '<br>Drop cost: ' + C.TUNABLES.dropFuelCost + ' fuel (tank: ' + state.airship.fuel + ')' + gateLine + poiHtml + weatherHtml + intelHtml + '</div>' +
      '<h3>Recon (tier ' + tier + ' held)</h3>' +
      '<div>' +
      [1, 2, 3].map(function (n) {
        var cost = C.TUNABLES.reconCosts[n];
        return '<button type="button" class="small" data-recon="' + n + '"' + (n <= tier ? ' disabled' : '') + '>' +
          'Buy tier ' + n + ' (' + cost.INTEL + ' INTEL' + (cost.FUEL ? ' + ' + cost.FUEL + ' FUEL' : '') +
          (n === 3 ? ' + a diver sits out' : '') + ')</button> ';
      }).join('') + '</div>' +
      (tier < 3 ? '<label class="pick">Tier-3 sitter (sits out this turn): <select id="recon-sitter">' +
        sitters.map(function (d) { return '<option value="' + d.id + '">' + esc(d.name) + '</option>'; }).join('') + '</select></label>' : '') +
      '<h3>Squad</h3>' +
      (avail.length ? avail.map(function (d) {
        var on = projIds.indexOf(d.id) >= 0;
        return '<label class="pick squad-row' + (on ? ' on' : '') + '">' +
          '<span class="squad-head"><input type="checkbox" class="squad-pick" value="' + d.id + '"' + (on ? ' checked' : '') + '> ' +
          thumb(d) +
          '<span class="squad-name">' + esc(d.name) + '</span> ' + archBadge(d) +
          '<span class="muted">Lv ' + d.level + (d.traits.length ? ' · ' + esc(d.traits.join(', ')) : '') + '</span>' +
          '<span class="squad-val">' + C.diverValue(d) + ' pts</span></span>' +
          '<span class="statbars">' + C.STATS.map(function (s) { return statBar(s, d.stats[s]); }).join('') + '</span>' +
          gearHtml(d) +
          '</label>';
      }).join('') : '<p class="muted">No divers available (wounded, dropped, garrisoned, or escorting).</p>') +
      (unavailable.length ? '<p class="muted">Unavailable: ' + unavailable.map(function (d) { return esc(d.name); }).join(', ') + '</p>' : '') +
      heroSection +
      (avail.length ? '<div class="panel pool-panel"><div class="pool-head"><span>DROP POOL</span><span class="pool-num">' + poolNow + ' / ' + poolMax + ' pts</span></div>' +
        '<div class="gauge"><div class="gauge-fill" style="width:' + (poolMax ? Math.round(poolNow / poolMax * 100) : 0) + '%"></div></div></div>' : '') +
      (projIds.length ? '<h3>Armory — kit the picked squad</h3><div id="briefing-armory">' + armoryHtml(projIds) + '</div>' : '') +
      '<div class="panel">If you skip the ground battle, the old roll projects: ' +
      (proj ? '<span class="proj-' + proj.word + '">' + proj.word.toUpperCase() + '</span> <span class="proj-num">' + proj.expected + '</span>' +
        '<div class="riskmeter"><span class="rmz rmz-red"></span><span class="rmz rmz-amber"></span><span class="rmz rmz-green"></span>' +
        '<span class="rm-tick"></span><span class="rm-marker" style="left:' + Math.max(0, Math.min(100, proj.expected)) + '%"></span></div>' +
        '<div class="rm-ticklabel"><span>70 = success</span></div>'
            : '<span class="muted">pick a squad</span>') +
      '<br><label class="pick"><input type="checkbox" id="chk-skip-battle"' + (skipBattlePref ? ' checked' : '') + '> Skip the ground battle (reduced motion / quick resolve — the drop resolves by the roll above, exactly once)</label></div>' +
      '<div class="action-bar"><button type="button" id="btn-launch" class="primary"' +
      (projIds.length && state.airship.fuel >= C.TUNABLES.dropFuelCost && !cityLocked && shipHere ? '' : ' disabled') + '>' +
      (shipHere ? 'Launch Drop — ' + C.TUNABLES.dropFuelCost + ' fuel' : 'Drop requires the ship on this tile — move the ship here first') + '</button></div>';
    Array.prototype.forEach.call(body.querySelectorAll('[data-recon]'), function (b) {
      b.addEventListener('click', function () {
        var n = parseInt(b.dataset.recon, 10);
        var sitterEl = $('recon-sitter');
        var r = C.buyRecon(state, t.x, t.y, n, sitterEl ? sitterEl.value : null);
        if (r.ok) sfx.buy(); else sfx.denied();
        toast(r.ok ? 'Recon tier ' + r.tier + ' bought.' + (r.satOut ? ' ' + r.satOut + ' sits out.' : '') : r.reason);
        save(); render();
      });
    });
    Array.prototype.forEach.call(body.querySelectorAll('[data-open-guide]'), function (b) {
      b.addEventListener('click', function () { openGuide('drop'); });
    });
    Array.prototype.forEach.call(body.querySelectorAll('.squad-pick'), function (el) {
      el.addEventListener('change', function () {
        if (el.checked) sfx.select(); else sfx.deselect();
        renderBriefingOnly();
      });
    });
    var bArm = $('briefing-armory');
    if (bArm) bindArmory(bArm, function () { renderBriefingOnly(); });
    var skipChk = $('chk-skip-battle');
    if (skipChk) skipChk.addEventListener('change', function () { skipBattlePref = skipChk.checked; });
    bindHeroButtons(body);
    var launch = $('btn-launch');
    if (launch) launch.addEventListener('click', function () {
      // Heroes ride as EXTRA members (cap +1) on top of the picked squad.
      var squadIds = selectedSquad();
      joins.forEach(function (j) { if (squadIds.indexOf(j.diverId) < 0) squadIds.push(j.diverId); });
      // §13: weight checks surface at the Armory step — refuse HERE, with
      // the reason, before any fuel moves.
      var over = C.loadoutCheck(state, squadIds).filter(function (c) { return c.over > 0; });
      if (over.length) {
        sfx.denied();
        toast('Cannot launch: ' + over.map(function (c) { return c.name + ' is ' + c.over + ' kg over their carry bound'; }).join('; ') + ' — fix it in the Armory step.');
        return;
      }
      pendingHeroJoins = joins.slice();
      sfx.launch();
      requestDescent(t, squadIds, kind);
    });
    // The briefing DOM is rebuilt on every render; seed the gauge fill and
    // the risk needle from their last positions so they sweep, not jump.
    var gf = body.querySelector('.gauge-fill');
    if (gf) {
      var gw = gf.style.width;
      if (fxPrev.pool !== null && fxPrev.pool !== gw) {
        gf.style.width = fxPrev.pool;
        void gf.offsetWidth;
        requestAnimationFrame(function () { gf.style.width = gw; });
      }
      fxPrev.pool = gw;
    }
    var mk = body.querySelector('.rm-marker');
    if (mk) {
      var ml = mk.style.left;
      if (fxPrev.exp !== null && fxPrev.exp !== ml) {
        mk.style.left = fxPrev.exp;
        void mk.offsetWidth;
        requestAnimationFrame(function () { mk.style.left = ml; });
      }
      fxPrev.exp = ml;
    }
  }
  function renderBriefingOnly() { renderHud(); renderBriefing(); }

  /* ---------------- Ship deck (Ship Deck + Heroes, 2026-11-10) ----------
   * The ship as a place: a side-scrolling deck, six stations bow-to-stern,
   * an avatar who walks. The MAP is the sector; the DECK is the ship —
   * one toggle flips between them. The pre-drop flow routes through here:
   * kit the squad at the ARMORY station, muster and launch from DROP BAY
   * (the briefing remains the launch paperwork). Heroes from the books
   * keep one station each once woken from the Communal's named pods. */
  var DECK_W = 2080;
  var DECK_STATIONS = [
    { id: 'quarters', label: 'QUARTERS', icon: '🛏', x: 170 },
    { id: 'trophy', label: 'TROPHY ROOM', icon: '🏆', x: 345, w: 250 },
    { id: 'medbay', label: 'MEDBAY', icon: '✚', x: 520 },
    { id: 'library',     label: 'LIBRARY',     icon: '📚', x: 695, heroId: 'nick' },
    { id: 'engineering', label: 'ENGINEERING', icon: '⚙', x: 870, heroId: 'rodger' },
    { id: 'comms', label: 'COMMS', icon: '📡', x: 1220, heroId: 'magnolia' },
    { id: 'armory', label: 'ARMORY', icon: '🗄', x: 1570, heroId: 'x' },
    { id: 'dropbay', label: 'DROP BAY', icon: '🪂', x: 1920, heroId: 'tin' }
  ];
  function stationDef(id) {
    for (var i = 0; i < DECK_STATIONS.length; i++) if (DECK_STATIONS[i].id === id) return DECK_STATIONS[i];
    return null;
  }
  function stationLabel(id) { var s = stationDef(id); return s ? s.label : String(id || ''); }
  var deck = { x: DECK_STATIONS[0].x, targetX: null, targetStation: null, station: null, timer: null, keyDir: 0, camX: 0 };
  function deckAvatarDiver() { return C.livingDivers(state)[0] || null; }
  function heroTeaserOn() {
    var poi = (state.pois || []).filter(function (p) { return p.kind === 'communal'; })[0];
    return !!((poi && poi.cryoReached) || C.chartFragmentCount(state) >= 1);
  }
  function heroStatusHtml(def, d) {
    C.ensureHeroes(state);
    var rec = state.heroes[def.id];
    if (d.status === 'downed') return '<div>✚ <strong>DOWN in the Medbay</strong> — back in ' + (d.downedTurns || 0) + ' turn(s). Heroes don\'t die in this build; they heal and return.</div>';
    if (d.wounds > 0) return '<div>Wounded (' + d.wounds + ') — rest them at the MEDBAY station.</div>';
    if (d.status !== 'ready') return '<div>Away from station (' + esc(d.status) + ').</div>';
    if (rec.freeJoinPending) return '<div><strong>Rides the next drop FREE</strong> (first-wake join — the beat every hero gets once).</div>';
    if (rec.hiredNext) return '<div><strong>Hired</strong> — rides the next drop.</div>';
    var price = C.heroPriceOf(def);
    return '<div>On station. <button type="button" class="small" data-hire-hero="' + def.id + '">Hire for one drop — ' + price.INTEL + ' INTEL + ' + price.SCRAP + ' SCRAP</button> <span class="muted">…or wait for a campaign beat: heroes sometimes ride free.</span></div>';
  }
  function keeperPanelHtml(s) {
    if (!s.heroId) return '';
    var def = C.heroDef(s.heroId);
    var rec = state.heroes[s.heroId];
    var d = rec && rec.woken ? C.heroDiverOf(state, s.heroId) : null;
    if (!d) {
      return '<div class="panel keeper-panel"><strong>' + s.label + ' keeper — a hero of the books sleeps for this post</strong>' +
        (heroTeaserOn()
          ? '<br>A named cryo pod at the Communal carries this one: <strong>' + esc(def.name) + '</strong> — <em>' + esc(def.flavor) + '</em>' +
            '<br><button type="button" class="small" data-wake-hero="' + def.id + '"' + (state.airship.wakeQueue ? ' disabled' : '') +
            '>Wake ' + esc(def.shortName) + ' (' + C.TUNABLES.sleeperWakeCost.FOOD + ' FOOD + ' + C.TUNABLES.sleeperWakeCost.SCRAP + ' SCRAP, ' + C.TUNABLES.sleeperWakeTurns + ' turns)</button>'
          : '<br><span class="muted">This station is unstaffed. Somewhere below, in the Communal\'s cryo bay, named pods still sleep…</span>') +
        '<br><span class="muted">Source: ' + esc(def.source) + '</span></div>';
    }
    return '<div class="panel keeper-panel"><div class="card-head">' + thumb(d, 'keeper-thumb') +
      '<span><strong>★ ' + esc(def.title ? def.shortName + ' — ' + def.title : d.name) + '</strong> — HERO · keeper of ' + s.label + '<br><em>' + esc(def.flavor) + '</em></span></div>' +
      heroStatusHtml(def, d) +
      '<div class="muted">Source: ' + esc(def.source) + '</div></div>';
  }
  function keeperStripHtml(s) {
    if (!s.heroId) return '<div class="deck-keeper empty"><span>Unstaffed</span></div>';
    var def = C.heroDef(s.heroId);
    var rec = state.heroes[s.heroId];
    var d = rec && rec.woken ? C.heroDiverOf(state, s.heroId) : null;
    if (!d) return '<div class="deck-keeper empty"><span>' + (heroTeaserOn() ? 'A named pod sleeps below…' : 'Unstaffed') + '</span></div>';
    return '<div class="deck-keeper">' + thumb(d, 'keeper-thumb') +
      '<span class="keeper-name">★ ' + esc(def.shortName) + (d.status === 'downed' ? ' — DOWN' : '') + '</span></div>';
  }
  function bindHeroButtons(root) {
    if (!root || !root.querySelectorAll) return;
    Array.prototype.forEach.call(root.querySelectorAll('[data-wake-hero]'), function (b) {
      b.addEventListener('click', function () {
        var r = C.wakeHero(state, b.dataset.wakeHero);
        if (r.ok) sfx.buy(); else sfx.denied();
        toast(r.ok ? 'Thaw started — ' + r.from + ': the hero joins in ' + r.turnsLeft + ' turn(s).' : r.reason);
        save(); render();
      });
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-hire-hero]'), function (b) {
      b.addEventListener('click', function () {
        var r = C.hireHero(state, b.dataset.hireHero);
        if (r.ok) sfx.buy(); else sfx.denied();
        toast(r.ok ? 'Hired — they ride the next drop (extra squad member, book kit).' : r.reason);
        save(); render();
      });
    });
  }
  function bindWakeButtons(root) {
    if (!root || !root.querySelectorAll) return;
    Array.prototype.forEach.call(root.querySelectorAll('[data-wake]'), function (b) {
      b.addEventListener('click', function () {
        var r = C.wakeSleeper(state, b.dataset.wake);
        if (r.ok) sfx.buy(); else sfx.denied();
        toast(r.ok ? 'Thaw started at ' + r.from + ' — sleeper joins in ' + r.turnsLeft + ' turn(s).' : r.reason);
        save(); render();
      });
    });
  }

  /* ---- SHIP AS HOME: tier art, Trophy Room, Journal (2026-11-10) ------- */
  var STATION_PROPS = {   // distinct prop compositions per tier — the refit is SEEN
    quarters:    { 2: '🛋 📚', 3: '🛋 📚 🎵 🪴' },
    medbay:      { 2: '🛏 💉', 3: '🛏 🛏 💡 🔬' },
    engineering: { 2: '🔧 🛢', 3: '🔧 ⚙ 🔩 🛢' },
    comms:       { 2: '🖥 📻', 3: '🖥 🛰 📡' },
    library:     { 2: '📚 🕯', 3: '📚 📖 🗺' },
    armory:      { 2: '🧰 🎯', 3: '🧰 🎯 🔭' },
    dropbay:     { 2: '💡 🧭', 3: '💡 🧭 🚀' }
  };
  function trophyGlyph(kind) {
    return { 'apex-skull': '💀', fragment: '🗺', act: '◆', hero: '★', find: '✦' }[kind] || '✦';
  }
  function stationArtHtml(s) {
    if (s.id === 'trophy') {
      C.ensureTrophies(state);
      var cells = C.TROPHY_SLOTS.map(function (slot) {
        var tid = state.trophies.placed[slot.id];
        var t = tid ? C.trophyById(state, tid) : null;
        return '<span class="tslot-mini' + (t ? ' filled' : '') + '" title="' + esc(slot.label) + (t ? ': ' + esc(t.name) : ' — empty') + '">' + (t ? trophyGlyph(t.kind) : '·') + '</span>';
      }).join('');
      return '<div class="deck-trophies">' + cells + '</div>';
    }
    var tier = C.stationTier(state, s.id);
    var props = (STATION_PROPS[s.id] || {})[tier];
    return (tier > 1 ? '<div class="deck-tier-badge">T' + tier + ' · ' + esc(C.stationTierName(state, s.id)) + '</div>' : '') +
      (props ? '<div class="deck-props">' + props + '</div>' : '');
  }
  function stationHookText(stationId, nextTier) {
    if (stationId === 'engineering') return 'Tank max +5.';
    if (stationId === 'medbay') return nextTier >= 3
      ? 'One rest (2 FOOD) clears ALL wounds; downed heroes recover a turn sooner.'
      : 'Rest costs 1 FOOD per wound (from 2).';
    if (stationId === 'armory') return nextTier >= 3
      ? 'The master bench raises the weapon upgrade cap to +4.'
      : 'Visual refit — and it readies the bench: tier 3 raises the weapon upgrade cap to +4.';
    if (stationId === 'quarters') return 'Visual only — a warmer room to come home to.';
    if (stationId === 'comms') return 'Visual only — same sky, better chair.';
    if (stationId === 'library') return 'Visual only — the record, kept and cited.';
    if (stationId === 'dropbay') return 'Visual only — the bay the squad falls out of, dressed.';
    return '';
  }
  function stationUpgradeHtml(s) {
    if (s.id === 'trophy') return '';
    var tier = C.stationTier(state, s.id);
    var head = '<div class="panel station-tier"><strong>' + s.label + ' — ' + esc(C.stationTierName(state, s.id)) + '</strong> (tier ' + tier + ' of 3)';
    if (tier >= 3) return head + '<br><span class="muted">Fully fitted. This is the best room the ship can build.</span></div>';
    var cost = C.TUNABLES.stationTierCosts[tier - 1];
    var nextName = (C.TUNABLES.stationTierNames[s.id] || [])[tier - 1];
    return head + '<br>Next: <strong>' + esc(nextName || ('Tier ' + (tier + 1))) + '</strong> — ' + esc(stationHookText(s.id, tier + 1)) +
      ' The refit is visible on the deck the moment it lands.' +
      '<br><button type="button" class="small" data-upgrade-station="' + s.id + '"' + (state.resources.SCRAP < cost ? ' disabled' : '') +
      '>Upgrade ' + s.label + ' — ' + cost + ' SCRAP</button>' +
      (state.resources.SCRAP < cost ? ' <span class="muted">(you have ' + state.resources.SCRAP + ' SCRAP)</span>' : '') + '</div>';
  }
  function bindUpgradeButtons(root) {
    if (!root || !root.querySelectorAll) return;
    Array.prototype.forEach.call(root.querySelectorAll('[data-upgrade-station]'), function (b) {
      b.addEventListener('click', function () {
        var r = C.upgradeStation(state, b.dataset.upgradeStation);
        if (r.ok) sfx.buy(); else sfx.denied();
        toast(r.ok ? r.name + ' fitted — ' + r.note : r.reason);
        save(); render();
      });
    });
  }
  function trophyRoomHtml() {
    C.ensureTrophies(state);
    var earned = state.trophies.earned;
    var placedIds = {};
    Object.keys(state.trophies.placed).forEach(function (k) { placedIds[state.trophies.placed[k]] = true; });
    var unplaced = earned.filter(function (t) { return !placedIds[t.id]; });
    var html = '<h3>🏆 Trophy Room — what the ground gave back</h3>';
    if (!earned.length) {
      html += '<div class="panel trophy-empty">Nothing here yet. The world is full of things worth taking.<br>' +
        '<span class="muted">Apex skulls, chart fragments, the marks of finished acts, a woken hero\'s keepsake, and the rare find that is not scrap — earned below, hung here. Trophies are earned, never bought.</span></div>';
      return html;
    }
    html += C.TROPHY_SLOTS.map(function (slot) {
      var tid = state.trophies.placed[slot.id];
      var t = tid ? C.trophyById(state, tid) : null;
      if (t) {
        return '<div class="panel trophy-slot filled"><span class="trophy-glyph">' + trophyGlyph(t.kind) + '</span> <strong>' + esc(slot.label) + '</strong> — ' + esc(t.name) +
          '<br><span class="muted">' + esc(t.story) + '</span>' +
          '<br><button type="button" class="small" data-unplace-trophy="' + slot.id + '">Take down</button></div>';
      }
      return '<div class="panel trophy-slot"><strong>' + esc(slot.label) + '</strong> — bare.' +
        (unplaced.length ? '<br>' + unplaced.map(function (u) {
          return '<button type="button" class="small" data-place-trophy="' + u.id + ':' + slot.id + '">Hang ' + trophyGlyph(u.kind) + ' ' + esc(u.name) + '</button>';
        }).join(' ') : ' <span class="muted">Nothing earned is waiting for this slot.</span>') + '</div>';
    }).join('');
    if (unplaced.length) {
      html += '<div class="panel"><strong>On the floor, waiting:</strong> ' + unplaced.map(function (u) {
        return trophyGlyph(u.kind) + ' ' + esc(u.name);
      }).join(' · ') + '<br><span class="muted">Pick a bare slot above to hang one. Rearranging is free, forever.</span></div>';
    }
    return html;
  }
  function bindTrophyButtons(root) {
    if (!root || !root.querySelectorAll) return;
    Array.prototype.forEach.call(root.querySelectorAll('[data-place-trophy]'), function (b) {
      b.addEventListener('click', function () {
        var parts = b.dataset.placeTrophy.split(':');
        var r = C.placeTrophy(state, parts[0], parts[1]);
        if (r.ok) sfx.buy(); else sfx.denied();
        toast(r.ok ? 'Hung: ' + r.trophy.name : r.reason);
        save(); render();
      });
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-unplace-trophy]'), function (b) {
      b.addEventListener('click', function () {
        var r = C.unplaceTrophy(state, b.dataset.unplaceTrophy);
        toast(r.ok ? 'Taken down — it waits on the floor.' : r.reason);
        save(); render();
      });
    });
  }
  /* The Journal: verbatim book quotes, collected on the ground, grouped
   * by subject. Found = quote + source + where found. Region known but
   * unfound = a silhouette with a hint. Unknown = not listed at all. */
  function journalHtml() {
    var view = C.journalView(state);
    var prog = C.journalProgress(state);
    var html = '<h3>📖 The Journal — voices from the books (' + prog.found + ' of ' + prog.total + ')</h3>' +
      '<p class="muted">Every page is a verbatim line from the record, with its source — nothing here is paraphrased, nothing invented. Pages lie on the ground where their subject lives: Sirens at their nests and apexes, heroes at the pods, the ship among the wreckage.</p>';
    view.forEach(function (g) {
      var visible = g.entries.filter(function (e) { return e.state !== 'hidden'; });
      html += '<div class="panel journal-group"><strong>' + esc(g.group) + '</strong>';
      if (!visible.length) html += '<br><span class="muted">No pages known yet — that country is still dark.</span>';
      visible.forEach(function (e) {
        if (e.state === 'found') {
          html += '<div class="journal-entry found">“' + esc(e.def.text) + '”<br><span class="muted">— ' + esc(e.def.source) + ' · Found at ' + esc(e.place) + ', turn ' + e.turn + '.</span></div>';
        } else {
          html += '<div class="journal-entry hint"><span class="journal-sil">▒▒▒▒▒▒▒▒</span><br><span class="muted">' + esc(e.def.hint) + '</span></div>';
        }
      });
      html += '</div>';
    });
    return html;
  }
  var journalOverlayOn = false;
  function toggleJournal(on) {
    journalOverlayOn = on != null ? on : !journalOverlayOn;
    var ov = $('journal-overlay');
    if (!ov) return;
    ov.hidden = !journalOverlayOn;
    if (journalOverlayOn) {
      ov.innerHTML = journalHtml() + '<div class="action-bar"><button type="button" class="primary" id="btn-journal-close">Close the Journal</button></div>';
      var cb = $('btn-journal-close');
      if (cb) cb.addEventListener('click', function () { toggleJournal(false); });
    }
  }

  function renderShip() {
    C.ensureHeroes(state);
    if (!deck.station && state.deck && state.deck.station && stationDef(state.deck.station)) {
      deck.station = state.deck.station;
      deck.x = stationDef(deck.station).x;
    }
    var obj = $('deck-objective');
    if (obj) obj.innerHTML = '<strong>OBJECTIVE:</strong> ' + esc(objectiveText());
    renderDeckStrip();
    renderDeckNav();
    renderDeckPanel();
    startDeckWalk();
  }
  function renderDeckStrip() {
    var strip = $('deck-strip');
    if (!strip) return;
    var av = deckAvatarDiver();
    var html = '<div class="deck-layer deck-stars"></div><div class="deck-layer deck-hull"></div><div class="deck-floor"></div>';
    DECK_STATIONS.forEach(function (s) {
      var w = s.w || 300;
      var tierCls = s.id === 'trophy' ? ' tier-room' : ' tier-' + C.stationTier(state, s.id);
      html += '<div class="deck-station' + tierCls + (deck.station === s.id ? ' open' : '') + '" data-station="' + s.id + '" style="left:' + (s.x - w / 2) + 'px;width:' + w + 'px">' +
        '<div class="deck-sign">' + s.icon + ' ' + s.label + '</div>' +
        '<div class="deck-door"></div>' + stationArtHtml(s) + keeperStripHtml(s) + '</div>';
    });
    html += '<div id="deck-avatar" style="left:' + (deck.x - 26) + 'px">' +
      (av ? thumb(av, 'deck-thumb') + '<span class="deck-avname">' + esc(av.name) + '</span>' : '<span class="deck-avname">—</span>') + '</div>';
    strip.innerHTML = html;
    strip.style.width = DECK_W + 'px';
    Array.prototype.forEach.call(strip.querySelectorAll('[data-station]'), function (el) {
      el.addEventListener('click', function () { walkToStation(el.dataset.station); });
    });
    positionDeckCamera();
  }
  function positionDeckCamera() {
    var vp = $('deck-viewport');
    var strip = $('deck-strip');
    if (!vp || !strip) return;
    var vw = vp.clientWidth || 360;
    deck.camX = Math.max(0, Math.min(DECK_W - vw, deck.x - vw / 2));
    strip.style.transform = 'translateX(' + (-deck.camX) + 'px)';
  }
  function paintDeckAvatar() {
    var av = $('deck-avatar');
    if (av) av.style.left = (deck.x - 26) + 'px';
    positionDeckCamera();
  }
  function renderDeckNav() {
    var nav = $('deck-strip-nav');
    if (!nav) return;
    nav.innerHTML = DECK_STATIONS.map(function (s) {
      return '<button type="button" class="small' + (deck.station === s.id ? ' active' : '') + '" data-nav-station="' + s.id + '">' + s.icon + ' ' + s.label + '</button>';
    }).join(' ');
    Array.prototype.forEach.call(nav.querySelectorAll('[data-nav-station]'), function (b) {
      b.addEventListener('click', function () { walkToStation(b.dataset.navStation); });
    });
  }
  function walkToStation(id) {
    var s = stationDef(id);
    if (!s) return;
    if (Math.abs(deck.x - s.x) <= 18) { arriveStation(id); return; }
    deck.targetX = s.x; deck.targetStation = id;
    startDeckWalk();
  }
  function arriveStation(id) {
    var s = stationDef(id);
    if (!s) return;
    deck.x = s.x; deck.station = id; deck.targetX = null; deck.targetStation = null;
    C.setDeckStation(state, id);
    save();
    if (currentScreen === 'ship') renderShip();
  }
  function startDeckWalk() {
    if (deck.timer || typeof setInterval !== 'function') return;
    deck.timer = setInterval(deckStep, 30);
  }
  function stopDeckWalk() {
    if (deck.timer) { clearInterval(deck.timer); deck.timer = null; }
    deck.keyDir = 0; deck.targetX = null; deck.targetStation = null;
  }
  function deckStep() {
    if (currentScreen !== 'ship') { stopDeckWalk(); return; }
    if (deck.keyDir) {
      deck.x = Math.max(46, Math.min(DECK_W - 46, deck.x + deck.keyDir * 15));
      deck.targetX = null; deck.targetStation = null;
      paintDeckAvatar();
      return;
    }
    if (deck.targetX != null) {
      var dx = deck.targetX - deck.x;
      if (Math.abs(dx) <= 17) { var st = deck.targetStation; arriveStation(st); return; }
      deck.x += dx > 0 ? 17 : -17;
      paintDeckAvatar();
    }
  }
  function deckKey(key) {
    if (key === 'ArrowLeft' || key === 'a' || key === 'A') { deck.keyDir = -1; deck.targetX = null; startDeckWalk(); deckStep(); return true; }
    if (key === 'ArrowRight' || key === 'd' || key === 'D') { deck.keyDir = 1; deck.targetX = null; startDeckWalk(); deckStep(); return true; }
    if (key === 'Enter') {
      var best = null, bd = 1e9;
      DECK_STATIONS.forEach(function (s) { var dd = Math.abs(s.x - deck.x); if (dd < bd) { bd = dd; best = s; } });
      if (best) { if (bd <= 190) arriveStation(best.id); else walkToStation(best.id); }
      return true;
    }
    return false;
  }
  function deckKeyUp(key) {
    if (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'a' || key === 'A' || key === 'd' || key === 'D') deck.keyDir = 0;
  }
  function renderDeckPanel() {
    var panel = $('deck-panel');
    if (!panel) return;
    var s = stationDef(deck.station);
    if (!s) {
      panel.innerHTML = '<div class="panel"><strong>The deck.</strong> Eight spaces, bow to stern: Quarters, the Trophy Room, Medbay, the Library, Engineering, Comms, Armory, Drop Bay. ' +
        'Tap a station to walk there. Woken heroes keep their stations — the named pods at the Communal cryo bay hold the rest. ' +
        'Stations upgrade in tiers for SCRAP — every tier changes how the room looks, and some change how the ship runs.</div>';
      return;
    }
    if (s.id === 'trophy') {
      panel.innerHTML = trophyRoomHtml();
      bindTrophyButtons(panel);
    } else if (s.id === 'quarters') {
      var jp2 = C.journalProgress(state);
      panel.innerHTML = stationUpgradeHtml(s) +
        '<h3>🛏 Quarters — the roster</h3>' +
        '<div class="panel">The commander\'s nook holds <button type="button" class="small" id="btn-journal-quarters">📖 the Journal (' + jp2.found + ' of ' + jp2.total + ' pages)</button> — verbatim voices from the books, collected on the ground.</div>' +
        (state.divers.map(function (d) { return diverCard(d); }).join('') || '<p class="muted">No divers.</p>');
      bindDiverButtons(panel);
      bindUpgradeButtons(panel);
      var jq = $('btn-journal-quarters');
      if (jq) jq.addEventListener('click', function () { toggleJournal(true); });
    } else if (s.id === 'medbay') {
      var cases = state.divers.filter(function (d) { return d.status !== 'dead' && (d.wounds > 0 || d.status === 'downed' || d.status === 'wounded'); });
      var mbTier = C.stationTier(state, 'medbay');
      panel.innerHTML = stationUpgradeHtml(s) +
        '<h3>✚ Medbay</h3>' +
        '<p class="muted">' + (mbTier >= 3 ? 'The full ward: one rest (2 FOOD) clears ALL of a diver\'s wounds.' : mbTier >= 2 ? 'Sterile ward: rest heals one wound for 1 FOOD.' : 'Rest heals one wound for 2 FOOD.') +
        ' Downed heroes recover here on the turn beat' + (mbTier > 1 ? ' — a fitted Medbay shortens it' : ' — ' + C.TUNABLES.heroDownedTurns + ' turns') + ', then back on their feet. Heroes do not die in this build.</p>' +
        (cases.length ? cases.map(function (d) { return diverCard(d); }).join('') : '<p class="muted">No one is hurt. The Medbay is quiet.</p>');
      bindDiverButtons(panel);
      bindUpgradeButtons(panel);
    } else if (s.id === 'engineering') {
      panel.innerHTML = keeperPanelHtml(s) + stationUpgradeHtml(s) +
        '<h3>⚙ Engineering — the ship\'s heart</h3><div class="panel">' +
        'Fuel tank: <strong>' + state.airship.fuel + '/' + state.airship.maxFuel + '</strong>' +
        ' <button type="button" class="small" id="btn-deck-refuel">Refuel from cargo FUEL</button>' +
        (C.isGrounded(state) ? '<br><span class="warn"><strong>GROUNDED</strong> — the tank is dry. Refuel from cargo or the ship does not fly.</span>' : '') +
        '<br>Cargo: ' + C.cargoUsed(state) + '/' + state.airship.cargoCapacity +
        ' · Crew: ' + C.livingDivers(state).length + '/' + state.airship.crewCapacity +
        '<br>Souls aboard: <strong>' + (state.population != null ? state.population : 0) + '</strong>' +
        '<br>Move: ' + C.TUNABLES.moveFuelPerTiles + ' fuel/tile · Drop: ' + C.TUNABLES.dropFuelCost + ' fuel</div>';
      var rf = $('btn-deck-refuel');
      if (rf) rf.addEventListener('click', function () {
        var r = C.refuelAirship(state); toast(r.ok ? 'Transferred ' + r.transferred + ' FUEL to the tank.' : r.reason); save(); render();
      });
      bindHeroButtons(panel);
      bindUpgradeButtons(panel);
    } else if (s.id === 'comms') {
      var cryo = C.cryoSources(state);
      var wq = state.airship.wakeQueue;
      var jp3 = C.journalProgress(state);
      panel.innerHTML = keeperPanelHtml(s) + stationUpgradeHtml(s) +
        '<h3>📡 Comms — the long ear</h3><div class="panel">' +
        '<strong>Objective:</strong> ' + esc(objectiveText()) +
        '<br>Chart fragments: <strong>' + C.chartFragmentCount(state) + ' of 4</strong>' +
        '<br><button type="button" class="small" id="btn-journal-comms">📖 Open the Journal (' + jp3.found + ' of ' + jp3.total + ' pages)</button>' +
        '<br>Sleeper thaw: ' + (wq ? 'a sleeper from ' + esc(wq.fromLabel) + ' is waking — ' + wq.turnsLeft + ' turn(s) left' : 'idle') +
        (cryo.length ? '<br><strong>Cryo within reach:</strong> ' + cryo.map(function (cs) {
            return esc(cs.label) + ' — ' + cs.capsules + ' capsule(s) ' +
              '<button type="button" class="small" data-wake="' + esc(cs.poiId) + '"' + (wq ? ' disabled' : '') +
              '>Wake one (' + C.TUNABLES.sleeperWakeCost.FOOD + ' FOOD + ' + C.TUNABLES.sleeperWakeCost.SCRAP + ' SCRAP)</button>';
          }).join('<br>') : '<br><span class="muted">No cryo within reach yet.</span>') +
        '<br><strong>Named pods (heroes):</strong> ' + C.HEROES.map(function (h) {
            var rec = state.heroes[h.id];
            if (rec.woken) return esc(h.shortName) + ' — AWAKE, keeps ' + stationLabel(h.station);
            return esc(h.shortName) + ' — asleep' + (heroTeaserOn() ? ' <button type="button" class="small" data-wake-hero="' + h.id + '"' + (wq ? ' disabled' : '') + '>Wake ' + esc(h.shortName) + '</button>' : ' (undiscovered)');
          }).join(' · ') + '</div>';
      bindWakeButtons(panel);
      bindHeroButtons(panel);
      bindUpgradeButtons(panel);
      var jc = $('btn-journal-comms');
      if (jc) jc.addEventListener('click', function () { toggleJournal(true); });
    } else if (s.id === 'library') {
      var jpl = C.journalProgress(state);
      panel.innerHTML = keeperPanelHtml(s) + stationUpgradeHtml(s) +
        '<h3>📚 Library — the record</h3><div class="panel">' +
        'The Journal lives here — verbatim voices from the books, collected page by page on the ground.' +
        '<br><button type="button" class="small" id="btn-journal-library">📖 Open the Journal (' + jpl.found + ' of ' + jpl.total + ' pages)</button>' +
        (state.heroes.nick && state.heroes.nick.woken
          ? '<br>The Architect keeps the shelves: every page filed with its source cite intact.'
          : '<br><span class="muted">The shelves keep themselves for now. A named pod sleeps below for this post.</span>') +
        '</div>';
      bindHeroButtons(panel);
      bindUpgradeButtons(panel);
      var jl = $('btn-journal-library');
      if (jl) jl.addEventListener('click', function () { toggleJournal(true); });
    } else if (s.id === 'armory') {
      var crewIds = C.livingDivers(state).map(function (d) { return d.id; });
      panel.innerHTML = keeperPanelHtml(s) + stationUpgradeHtml(s) +
        '<h3>🗄 Armory — the ship pool</h3><div id="deck-armory">' + armoryHtml(crewIds) + '</div>';
      var da = $('deck-armory');
      if (da) bindArmory(da, function () { render(); });
      bindHeroButtons(panel);
      bindUpgradeButtons(panel);
    } else if (s.id === 'dropbay') {
      var t = C.tileAt(state, selected.x, selected.y);
      var poi = t ? C.poiAt(state, t.x, t.y) : null;
      var joins = C.heroJoinsForDrop(state, poi);
      var picked = selectedSquad();
      panel.innerHTML = keeperPanelHtml(s) + stationUpgradeHtml(s) +
        '<h3>🪂 Drop Bay — muster and launch</h3><div class="panel">' +
        '<strong>The flow:</strong> pick the target + squad on the Map (Drop briefing) → kit them at the ARMORY station → launch from the briefing. Heroes join from here — free at campaign beats, or hired for one drop.' +
        (t ? '<br><strong>Target:</strong> (' + t.x + ',' + t.y + ') ' + esc(t.terrain) + (poi ? ' — ' + esc(poi.label) : '') +
          '<br><strong>Squad picked:</strong> ' + (picked.length ? picked.map(function (id) { var d = C.diverById(state, id); return d ? esc(d.name) : id; }).join(', ') : 'none yet') +
          '<br><strong>Heroes riding:</strong> ' + (joins.length ? joins.map(function (j) {
              var hd = C.diverById(state, j.diverId);
              return '★ ' + esc(hd ? hd.name : j.heroId) + ' (' + (j.mode === 'hire' ? 'HIRED' : 'FREE') + ' — ' + esc(j.reason) + ')';
            }).join('<br>') : 'none — hire one at their station, or catch a beat') : '<br><span class="muted">No target picked yet.</span>') +
        '<div class="action-bar"><button type="button" class="primary" id="btn-deck-briefing">Plan the drop — open briefing</button></div></div>';
      var bb = $('btn-deck-briefing');
      if (bb) bb.addEventListener('click', function () { show('briefing'); });
      bindHeroButtons(panel);
      bindUpgradeButtons(panel);
    }
  }

  /* ---------------- Descent (the steer moment, §5.3) ---------------------- */
  function startDescent(tile, squadIds, kind) {
    // The drop is truly launched now: spend the hero joins (hire flags,
    // first-wake joins, beat cooldowns) exactly once.
    if (pendingHeroJoins.length) { C.commitHeroJoins(state, pendingHeroJoins); pendingHeroJoins = []; save(); }
    var field = $('descent-field');
    var W = 13; // window of tiles shown, centered on target
    var sev = C.fallSeverity(state, tile.x, tile.y);
    descent = {
      tile: tile, squadIds: squadIds, kind: kind, W: W,
      mx: tile.x, my: tile.y, vx: 0, vy: 0,
      start: performance.now(), seconds: C.TUNABLES.descentSeconds,
      keys: {}, dragging: false, done: false, raf: 0, severity: sev, hits: []
    };
    /* §5(b): the fall is a dice roll against the weather. Hits are
       scheduled now (presentation dice — the GRIT saves themselves roll
       on core's seeded RNG at touchdown) and played as AV moments. */
    var hitChance = 0.10 + (sev.multiplier - 1) * 0.45;
    if (Math.random() < hitChance) {
      descent.hits.push({ at: 1.2 + Math.random() * 4.5, label: sev.multiplier >= 2 ? 'Lightning strike on the descent' : 'Brutal landing', fired: false });
      if (sev.multiplier >= 2 && Math.random() < 0.3) {
        descent.hits.push({ at: 4.5 + Math.random() * 2.5, label: 'Brutal landing', fired: false });
      }
    }
    var injEl = $('descent-injury'); if (injEl) injEl.hidden = true;
    var skipBtn = $('btn-descent-skip');
    if (skipBtn) skipBtn.onclick = function () { finishDescent(); };
    if (SFX) SFX.ambience('descent-loop');
    $('descent-overlay').hidden = false;
    $('descent-wind').textContent = 'Wind drift: ' + tile.windX + ', ' + tile.windY +
      (tile.reconTier >= 1 ? ' (revealed by recon)' : ' (unrevealed — no recon)') +
      ' · Storm severity x' + sev.multiplier + ' (' + sev.tier.toUpperCase() + ' ground — zone tier drives the sky)';
    // Static tile layer for the window.
    var html = '';
    var best = C.findBestTile(state, tile.x, tile.y);
    for (var dy = -6; dy <= 6; dy++) {
      for (var dx = -6; dx <= 6; dx++) {
        var tt = C.tileAt(state, tile.x + dx, tile.y + dy);
        if (!tt) continue;
        var cls = 'dtile ' + tt.terrain;
        if (tt.hazard && tile.reconTier >= 2) cls += ' hazard';
        if (best && tt.x === best.x && tt.y === best.y && tile.reconTier >= 2) cls += ' best';
        if (dx === 0 && dy === 0) cls += ' target';
        html += '<div class="' + cls + '" data-dx="' + dx + '" data-dy="' + dy + '">' +
          (tt.terrain === 'water' ? 'W' : tt.threat > 0 ? tt.threat : '') + '</div>';
      }
    }
    html += '<div id="descent-marker">V</div>';
    field.innerHTML = html;
    layoutDescent();
    window.addEventListener('resize', layoutDescent);
    field.onpointerdown = function (e) { descent.dragging = true; steerToPointer(e); };
    field.onpointermove = function (e) { if (descent && descent.dragging) steerToPointer(e); };
    field.onpointerup = field.onpointercancel = function () { if (descent) descent.dragging = false; };
    document.onkeydown = function (e) { if (descent) descent.keys[e.key.toLowerCase()] = true; };
    document.onkeyup = function (e) { if (descent) descent.keys[e.key.toLowerCase()] = false; };
    descent.raf = requestAnimationFrame(descentTick);
  }
  function steerToPointer(e) {
    var field = $('descent-field');
    var rect = field.getBoundingClientRect();
    var cellW = rect.width / descent.W, cellH = rect.height / descent.W;
    var px = (e.clientX - rect.left) / cellW - descent.W / 2 + descent.tile.x;
    var py = (e.clientY - rect.top) / cellH - descent.W / 2 + descent.tile.y;
    descent.mx = px; descent.my = py;
  }
  function layoutDescent() {
    if (!descent) return;
    var field = $('descent-field');
    var rect = field.getBoundingClientRect();
    var cellW = rect.width / descent.W, cellH = rect.height / descent.W;
    Array.prototype.forEach.call(field.querySelectorAll('.dtile'), function (el) {
      var dx = parseInt(el.dataset.dx, 10), dy = parseInt(el.dataset.dy, 10);
      el.style.left = ((dx + descent.W / 2) * cellW) + 'px';
      el.style.top = ((dy + descent.W / 2) * cellH) + 'px';
      el.style.width = cellW + 'px'; el.style.height = cellH + 'px';
    });
    positionMarker();
  }
  function positionMarker() {
    var field = $('descent-field');
    var marker = $('descent-marker');
    if (!marker || !descent) return;
    var rect = field.getBoundingClientRect();
    var cellW = rect.width / descent.W, cellH = rect.height / descent.W;
    marker.style.left = ((descent.mx - descent.tile.x + descent.W / 2) * cellW) + 'px';
    marker.style.top = ((descent.my - descent.tile.y + descent.W / 2) * cellH) + 'px';
  }
  function descentTick(now) {
    if (!descent || descent.done) return;
    var elapsed = (now - descent.start) / 1000;
    var dt = Math.min(0.05, elapsed - (descent.lastElapsed || 0));
    descent.lastElapsed = elapsed;
    var remain = Math.max(0, descent.seconds - elapsed);
    $('descent-timer').textContent = remain.toFixed(1) + 's';
    // Wind drift (§5.3): pushes the marker by the tile wind vector over the
    // descent, scaled by the drop hex's zone-tier storm severity (2026-11-10).
    var sevMult = descent.severity ? descent.severity.multiplier : 1;
    descent.mx += (descent.tile.windX / descent.seconds) * dt * 2 * sevMult;
    descent.my += (descent.tile.windY / descent.seconds) * dt * 2 * sevMult;
    // Keyboard steer.
    var speed = 3.2; // tiles per second
    if (descent.keys['arrowleft'] || descent.keys['a']) descent.mx -= speed * dt;
    if (descent.keys['arrowright'] || descent.keys['d']) descent.mx += speed * dt;
    if (descent.keys['arrowup'] || descent.keys['w']) descent.my -= speed * dt;
    if (descent.keys['arrowdown'] || descent.keys['s']) descent.my += speed * dt;
    descent.mx = Math.max(descent.tile.x - 6, Math.min(descent.tile.x + 6, descent.mx));
    descent.my = Math.max(descent.tile.y - 6, Math.min(descent.tile.y + 6, descent.my));
    positionMarker();
    // §5(b): play scheduled fall injuries as they happen — sound, flash,
    // and a plain-words callout. The save itself rolls at touchdown.
    descent.hits.forEach(function (h) {
      if (h.fired || elapsed < h.at) return;
      h.fired = true;
      playSfx('thunder');
      fxMark('fx-lightning');
      var field = $('descent-field');
      if (field) {
        field.classList.add('fx-shake');
        setTimeout(function () { field.classList.remove('fx-shake'); }, 450);
      }
      var inj = $('descent-injury');
      if (inj) {
        inj.hidden = false;
        inj.textContent = '⚡ ' + h.label + ' — someone may be hurt (GRIT save rolls at touchdown; the report shows the dice).';
      }
    });
    if (elapsed >= descent.seconds) { finishDescent(); return; }
    descent.raf = requestAnimationFrame(descentTick);
  }
  function finishDescent() {
    if (!descent || descent.done) return;
    descent.done = true;
    cancelAnimationFrame(descent.raf);
    document.onkeydown = document.onkeyup = null;
    window.removeEventListener('resize', layoutDescent);
    if (SFX) SFX.stopAmbience();
    var fx = Math.round(descent.mx), fy = Math.round(descent.my);
    var tile = descent.tile, squadIds = descent.squadIds, kind = descent.kind;
    var landing = C.computeLanding(state, tile.x, tile.y, fx, fy, tile.reconTier || 0);
    lastLanding = landing;
    $('descent-overlay').hidden = true;
    var hitLabels = descent.hits.map(function (h) { return h.label; });
    var sevNow = descent.severity;
    descent = null;
    playSfx('touchdown');
    /* §1: a played drop lands in the GROUND BATTLE — the turn-based
       fight replaces the instant roll. The old band math runs only on
       the labeled skip-battle path (or a water landing, where there is
       no ground to fight on), and exactly once either way. */
    if (G && !skipBattlePref && landing.land > 0) {
      var exp = G.createExpedition(C, state, {
        squadIds: squadIds, targetX: tile.x, targetY: tile.y,
        landX: fx, landY: fy, land: landing.land, kind: kind,
        descentHits: hitLabels, storm: Math.max(0, sevNow.multiplier - 1)
      });
      if (exp && exp.ok) {
        expedition = exp;
        groundTargetId = null;
        save();
        drainGroundEvents();
        show('ground');
        return;
      }
      if (exp && !exp.ok) { toast(exp.reason); show('briefing'); return; }
    }
    var report = C.resolveDrop(state, { diverIds: squadIds, x: tile.x, y: tile.y, land: landing.land, kind: kind });
    save();
    if (!report.ok) { toast(report.reason); show('briefing'); return; }
    show('report');
  }

  /* ---------------- Ground screen (§1: the battle when you land) ------- */
  var GROUND_EVENT_SFX = {
    loot: 'loot', coin: 'coin', door: 'door', device: 'device', fragment: 'fanfare', snippet: 'device',
    fire: 'fire', firehit: 'firehit', firemiss: 'firemiss', explosion: 'explosion',
    flare: 'flare', flash: 'flash', plant: 'plant', shriek: 'shriek', wingbeat: 'wingbeat',
    'siren-attack': 'siren-attack', punch: 'punch', raid: 'raid', select: 'select', kill: 'siren-death'
  };
  function drainGroundEvents() {
    if (!expedition) return;
    var evs = expedition.events.splice(0, expedition.events.length);
    evs.forEach(function (e) {
      var base = e.split(':')[0];
      if (base === 'wound') { playSfx('wound'); fxMark('fx-wound'); }
      else if (base === 'death') { playSfx('death'); fxMark('fx-death'); }
      else if (base === 'save') { playSfx('success'); }
      else if (base === 'kill') {
        var kind = e.split(':')[1];
        playSfx(kind === 'guardian' || kind === 'turret' ? 'touchdown' : 'siren-death');
        fxMark('fx-kill');
      }
      else if (GROUND_EVENT_SFX[e]) { playSfx(GROUND_EVENT_SFX[e]); fxMark('fx-' + e); }
      if (e === 'explosion' || e === 'flash') fxMark('fx-shake');
    });
  }
  function groundAfter() { drainGroundEvents(); save(); renderGround(); }
  /* The encounter block, in the player's language. The engine's bare
   * "Resolve the encounter first." never reaches the player on loop: the
   * pinned encounter card carries the why, and a blocked tap earns ONE
   * short pointer toast per encounter. Other refusals keep their words. */
  function toastGroundBlock(r) {
    if (!r || r.ok) return;
    if (expedition && expedition.encounter && r.reason === 'Resolve the encounter first.') {
      if (groundEncToastFor !== expedition.encounter) {
        groundEncToastFor = expedition.encounter;
        toast('↑ The encounter needs a choice — your squad is stopped until you pick.');
      }
      return;
    }
    toast(r.reason);
  }
  function pointerToast() {
    if (expedition && expedition.encounter && groundEncToastFor !== expedition.encounter) {
      groundEncToastFor = expedition.encounter;
      toast('↑ The encounter needs a choice — your squad is stopped until you pick.');
    }
  }
  function doExtract() {
    if (!expedition) return;
    var rep = G.extract(C, state, expedition);
    if (rep && rep.ok === false) { toastGroundBlock(rep); renderGround(); return; }
    expedition = null;
    groundTargetId = null;
    playSfx(rep && rep.band === 'Flawless' ? 'fanfare' : 'success');
    save();
    show('report');
  }
  /* Rule 27: hostiles on the FIELD are figures in kind (fig, below) —
   * Sirens, rooted glow-plants, war machines, ragged scavengers, two
   * tiles tall like the squad. The skull keeps the MAP/minimap only.
   * (Was, Rule 24: hostiles wear the map's own mark: the red SKULL_SVG (the apex sign),
   * so the ground grid and the map read as one system. The skull is the
   * read; type rides on the name (tap to target) plus one tiny tag only
   * where it changes how you fight: FLY crosses water, PLANT never moves,
   * MACH/TURRET are C4 work, APEX is the marked one. */
  function hostileGlyph(h) {
    var apex = /APEX/.test(h.name || '') ? 'APEX' : '';
    if (h.kind === 'plant') return { cls: 'hg-plant', label: h.name, tag: 'PLANT', fig: PLANT_SVG };
    if (h.kind === 'guardian') return { cls: 'hg-machine', label: h.name, tag: 'MACH', fig: MACHINE_SVG };
    if (h.kind === 'turret') return { cls: 'hg-machine', label: h.name, tag: 'TURRET', fig: MACHINE_SVG };
    if (h.kind === 'scavenger') return { cls: 'hg-human', label: h.name, tag: apex, fig: SCAV_SVG };
    if (h.cls === 'flying') return { cls: 'hg-flying', label: h.name, tag: 'FLY', fig: SIREN_FLY_SVG };
    if (h.cls === 'ranged') return { cls: 'hg-ranged', label: h.name, tag: apex, fig: SIREN_SVG };
    return { cls: 'hg-melee', label: h.name, tag: apex, fig: SIREN_SVG };
  }
  // "2× Siren rusher · 1× carnivorous glow-plant" — names, never glyphs.
  function hostileCounts(exp) {
    var order = [], byName = {};
    exp.hostiles.forEach(function (h) {
      if (!byName[h.name]) { byName[h.name] = 0; order.push(h.name); }
      byName[h.name] += 1;
    });
    return order.map(function (n) { return byName[n] + '× ' + n; }).join(' · ');
  }
  function renderGround() {
    var body = $('ground-body');
    if (!G || !expedition) {
      body.innerHTML = '<div class="panel">No expedition on the ground. Drops land here: plan one from the <strong>Drop</strong> briefing — after the descent, the squad fights the landing as a turn-based battle (unless the skip-battle option is set).</div>' +
        '<div class="action-bar"><button type="button" class="primary" data-goto="map">Back to Map</button></div>';
      bindGroundNav(body);
      return;
    }
    var exp = expedition;
    if (exp.encounter && exp.wantExtract) { doExtract(); return; }
    var am = G.activeMember(C, state, exp);
    var ad = am ? C.diverById(state, am.id) : null;
    var targetPoi = C.poiAt(state, exp.target.x, exp.target.y);
    var site = am ? G.siteAt(C, state, exp, am) : null;
    var siteLabel = { cache: 'Work the cache', ruin: 'Rush the ruin vault', door: 'Open the next door', band: 'Work the next floor band', depot: 'Work the Tech Depot', graveyard: 'Search the graveyard', building: 'Work the site', snippet: '✒ Read the page' };
    var carried = Object.keys(exp.carried).map(function (k) { return '+' + exp.carried[k] + ' ' + k; }).join(' · ') || 'nothing yet';
    // A new encounter resets the pointer-toast budget and clears any
    // stale choice outcome — the card below is the whole story now.
    if (exp.encounter && exp.encounter !== groundEncSeen) { groundEncToastFor = null; groundOutcome = null; }
    groundEncSeen = exp.encounter || null;
    var encOn = !!exp.encounter;
    var html = '<div class="panel ground-head"><strong>' + (targetPoi ? esc(targetPoi.label) : 'Open ground') + '</strong> — ground turn ' + exp.turn +
      ' · LAND ' + exp.land + '<br><span class="muted">' + esc(exp.ecology ? exp.ecology.line : '') + (exp.dark ? ' It is dark in here — lights matter.' : '') + '</span>' +
      '<br>Carried: <b>' + esc(carried) + '</b> · Hostiles: ' + (exp.hostiles.length ? esc(hostileCounts(exp)) : 'none') +
      (exp.charges > 0 ? ' · C4 charges: ' + exp.charges : '') + ' · Flares in the bag: ' + ((am ? (am.kitThrows.flare || 0) : 0) + (exp.shipFlares || 0)) +
      '<br><span class="muted">Select a diver — card or figure. Each diver moves and acts on their own AP; lit tiles are within the selected diver\'s reach. Tap an enemy figure to target it, then FIRE. EXTRACT ends the drop — carried loot banks, finds go to the Armory.</span></div>';
    // THE ENCOUNTER CARD — pinned at the top of the screen while one is
    // pending. It says what happened, why the squad is stopped, and what
    // the choices are. It cannot sit below the fold behind the grid.
    if (encOn) {
      var enc = exp.encounter;
      html += '<div class="panel encounter-panel pinned" id="encounter-card"><h3>' + esc(enc.title) + '</h3>' +
        '<p class="enc-why">⏸ Your squad is stopped — deal with this first. Nothing else moves until you choose.</p>' +
        '<p>' + esc(enc.text) + '</p>' +
        enc.choices.map(function (ch) {
          return '<button type="button" class="small gchoice" data-gchoice="' + ch.id + '">' + esc(ch.label) + (ch.sub ? ' <span class="muted">— ' + esc(ch.sub) + '</span>' : '') + '</button>';
        }).join(' ') + '</div>';
    }
    // THE ENEMY PHASE, shown after it resolves: what the hostiles did on
    // the end-turn you just took, in their own lines.
    if (exp.lastEnemyPhase && exp.lastEnemyPhase.turn === exp.turn - 1 && exp.lastEnemyPhase.lines.length) {
      html += '<div class="turn-banner enemy"><strong>ENEMY MOVES</strong> — ' + exp.lastEnemyPhase.lines.map(esc).join(' ') + '</div>';
    }
    // WHO GOES, ALWAYS: your divers act on their own AP; the enemy acts
    // only when you end the turn. The selected diver is named with their AP.
    html += '<div class="turn-banner' + (exp.lastEnemyPhase && exp.lastEnemyPhase.turn === exp.turn - 1 ? ' refreshed' : '') + '">' +
      '<strong>YOUR MOVE</strong> — ground turn ' + exp.turn + ' · each diver acts on their own AP' +
      (am && ad ? ' · Selected: <strong>' + esc(ad.name) + '</strong> — ' + am.ap + '/' + (am.apMax || 4) + ' AP left' : '') +
      (exp.lastEnemyPhase && exp.lastEnemyPhase.turn === exp.turn - 1 ? ' · AP refreshed' : '') +
      '. <span class="muted">End Turn hands the ground to the enemy.</span></div>';
    // What the last encounter choice DID, in plain words, while it is fresh.
    if (groundOutcome && groundOutcome.length) {
      html += '<div class="panel ground-outcome"><strong>What happened:</strong> ' + groundOutcome.map(esc).join(' ') + '</div>';
    }
    // Unit cards
    html += '<div class="unit-row">' + exp.members.map(function (m) {
      var d = C.diverById(state, m.id);
      if (!d) return '';
      var dead = d.status === 'dead';
      var prof = C.effectiveProfile(state, d, m.slot || 'primary');
      var pips = '';
      for (var i = 0; i < (m.apMax || 4); i++) pips += i < m.ap ? '●' : '○';
      return '<button type="button" class="unit-card' + (am && am.id === m.id ? ' active' : '') + (dead ? ' dead' : '') + '" data-gmember="' + m.id + '">' +
        thumb(d) + '<span class="unit-name">' + esc(d.name) + (dead ? ' ☠' : '') + '</span>' +
        '<span class="unit-ap">AP ' + pips + '</span>' +
        '<span class="unit-wpn">' + wicon(prof.weapon) + esc(prof.weapon) + ' <span class="muted">(' + (m.slot || 'primary') + ')</span></span>' +
        (d.wounds ? '<span class="unit-wounds">wounds ' + d.wounds + '</span>' : '') +
        (m.hasLight ? '<span class="unit-light">light ' + (m.lightOn ? 'ON' : 'off') + '</span>' : '') +
        '</button>';
    }).join('') + '</div>';
    // The 13x13 ground window. Reach: every tile the SELECTED diver can
    // walk to on their remaining AP is lit (one Dijkstra, engine-side).
    var reach = am ? G.reachableMap(C, state, exp, am) : null;
    html += '<div class="ground-wrap"><div class="ground-grid">';
    for (var gy = exp.win.y0; gy < exp.win.y0 + 13; gy++) {
      for (var gx = exp.win.x0; gx < exp.win.x0 + 13; gx++) {
        var t = C.tileAt(state, gx, gy);
        var k = gx + ',' + gy;
        var seen = !!exp.seen[k], mapped = !!exp.mapped[k];
        var cls = 'gcell ' + (t ? t.terrain : 'open') + (seen ? ' seen' : mapped ? ' mapped' : ' fogged');
        if (reach && reach[k] != null && reach[k] > 0 && reach[k] <= am.ap) cls += ' reach';
        if (exp.flares.some(function (f) { return Math.abs(f.x - gx) + Math.abs(f.y - gy) <= 1; })) cls += ' burning';
        var inner = '';
        var poiT = C.poiAt(state, gx, gy);
        if (poiT && mapped) inner = poiPiece(poiT);
        if (exp.drift[k] && seen) inner = '<span class="gdrift">✦</span>';
        if (exp.snippetSites && mapped && exp.snippetSites.some(function (sn) { return sn.x === gx && sn.y === gy; })) inner = '<span class="gsnip" title="A page from the books — stand here and INTERACT">✒</span>';
        if (t && t.supplySite && !t.supplySite.looted && seen) inner = structurePiece('crate', 'Supply crate — the heavy kit comes down in crates', PIECE_HEIGHTS.crate);
        if (t && t.robotSite && !t.robotSite.cleared && seen) inner = structurePiece('wreck', 'Dormant war machine — a wreck until it wakes', PIECE_HEIGHTS.wreck);
        exp.members.forEach(function (m) {
          if (m.x === gx && m.y === gy) {
            var md = C.diverById(state, m.id);
            inner = '<span class="gfigure squad' + (am && am.id === m.id ? ' selected' : '') + (md && md.status === 'dead' ? ' dead' : '') + '" title="' + (md ? esc(md.name) : 'Diver') + '">' + SOLDIER_SVG + '<span class="ftag">' + (md ? esc(md.name.split(' ').map(function (w2) { return w2[0]; }).join('')) : '?') + '</span></span>';
          }
        });
        exp.hostiles.forEach(function (h) {
          if (h.x === gx && h.y === gy && seen) {
            var gl = hostileGlyph(h);
            inner = '<span class="gfigure hostile ghost ' + gl.cls + (groundTargetId === h.id ? ' targeted' : '') + '" title="' + esc(gl.label) + ' — ' + h.hp + '/' + h.maxHp + ' hp' + (h.stunTurns ? ' · staggered' : '') + '">' + gl.fig + (gl.tag ? '<span class="htag">' + gl.tag + '</span>' : '') + '</span>';
          }
        });
        html += '<button type="button" class="' + cls + '" data-gx="' + gx + '" data-gy="' + gy + '" aria-label="Ground tile ' + gx + ',' + gy + '">' + inner + '</button>';
      }
    }
    html += '</div></div>';
    var tgt = groundTargetId ? exp.hostiles.filter(function (h) { return h.id === groundTargetId; })[0] : null;
    html += '<div class="panel ground-target">' + (tgt
      ? 'Target: <strong>' + esc(tgt.name) + '</strong> — ' + tgt.hp + '/' + tgt.maxHp + ' hp' + (tgt.stunTurns ? ' · staggered' : '')
      : (exp.hostiles.length ? 'No target — tap an enemy figure to target it.' : 'No hostiles on this ground.')) +
      (exp.hostiles.length ? '<div class="hkey"><span class="hkey-fig">' + SIREN_SVG + '</span><span>= enemy — on this ground: ' + esc(hostileCounts(exp)) + '</span></div>' : '') + '</div>';
    // Actions — while an encounter is pending every one of these defers
    // to the pinned card (disabled, not bouncing): the card is the game.
    var throwTypes = [['frag', 'Frag'], ['flash', 'Flashbang'], ['conc', 'Concussion'], ['flare', 'Flare']];
    html += '<div class="ground-actions">' +
      '<button type="button" class="gact primary" data-gact="fire"' + (encOn ? ' disabled' : '') + '>' + (ad ? wicon(C.effectiveProfile(state, ad, am.slot || 'primary').weapon) : '') + 'FIRE (2 AP)</button>' +
      throwTypes.map(function (tt) {
        var n = am ? G.throwStock(C, state, exp, am, tt[0]) : 0;
        return '<button type="button" class="gact" data-gthrow="' + tt[0] + '"' + (n <= 0 || encOn ? ' disabled' : '') + '>Throw ' + tt[1] + ' (' + n + ')</button>';
      }).join('') +
      '<button type="button" class="gact" data-gact="interact"' + (site && !encOn ? '' : ' disabled') + '>' + (site ? esc(siteLabel[site.type] || 'Work the site') : 'INTERACT — nothing here') + '</button>' +
      (exp.charges > 0 ? '<button type="button" class="gact" data-gact="c4"' + (encOn ? ' disabled' : '') + '>Plant C4 (' + exp.charges + ')</button>' : '') +
      (ad && C.ensureArchetype(ad) === 'ENGINEER' ? '<button type="button" class="gact" data-gact="support"' + (encOn ? ' disabled' : '') + '>Support +2 AP</button>' : '') +
      '<button type="button" class="gact" data-gact="swap"' + (encOn ? ' disabled' : '') + '>Swap weapon</button>' +
      (am && am.hasLight ? '<button type="button" class="gact" data-gact="light"' + (encOn ? ' disabled' : '') + '>Light ' + (am.lightOn ? 'OFF' : 'ON') + '</button>' : '') +
      '<button type="button" class="gact" data-gact="endturn"' + (encOn ? ' disabled' : '') + '>End Turn — enemies move</button>' +
      '<button type="button" class="gact extract" data-gact="extract"' + (encOn ? ' disabled' : '') + '>⬆ EXTRACT</button></div>';
    html += '<div class="lines ground-log">' + exp.log.slice(-16).map(esc).join('\n') + '</div>';
    body.innerHTML = html;
    if (encOn) {
      var encEl = body.querySelector ? body.querySelector('#encounter-card') : null;
      if (encEl && encEl.scrollIntoView) { try { encEl.scrollIntoView({ block: 'start' }); } catch (e) { /* shim DOM */ } }
    }
    bindGround(body);
  }
  function bindGroundNav(root) {
    Array.prototype.forEach.call(root.querySelectorAll('[data-goto]'), function (b) {
      b.addEventListener('click', function () { show(b.dataset.goto); });
    });
  }
  function bindGround(root) {
    var exp = expedition;
    if (!exp) return;
    Array.prototype.forEach.call(root.querySelectorAll('[data-gmember]'), function (b) {
      b.addEventListener('click', function () {
        if (G.setActive(exp, b.dataset.gmember)) { playSfx('select'); groundAfter(); }
      });
    });
    Array.prototype.forEach.call(root.querySelectorAll('.gcell'), function (el) {
      el.addEventListener('click', function () {
        var gx = parseInt(el.dataset.gx, 10), gy = parseInt(el.dataset.gy, 10);
        var hostile = exp.hostiles.filter(function (h) { return h.x === gx && h.y === gy; })[0];
        if (hostile) { groundTargetId = hostile.id; groundTargetTile = { x: gx, y: gy }; playSfx('select'); renderGround(); return; }
        var mem = exp.members.filter(function (m) { return m.x === gx && m.y === gy; })[0];
        if (mem) { G.setActive(exp, mem.id); playSfx('select'); groundAfter(); return; }
        groundTargetTile = { x: gx, y: gy };
        groundOutcome = null; exp.lastEnemyPhase = null;
        var r = G.moveActive(C, state, exp, gx, gy);
        if (!r.ok) { playSfx('denied'); toastGroundBlock(r); renderGround(); return; }
        var guardSteps = 0;
        while (exp.pendingPath && !exp.encounter && guardSteps++ < 14) {
          var sr = G.stepAlong(C, state, exp);
          if (!sr.moved) break;
        }
        playSfx('step');
        groundAfter();
      });
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-gchoice]'), function (b) {
      b.addEventListener('click', function () {
        var logMark = exp.log.length;
        var r = G.choose(C, state, exp, b.dataset.gchoice);
        if (!r.ok) { playSfx('denied'); toast(r.reason); renderGround(); return; }
        playSfx('confirm');
        if (r.extract) { doExtract(); return; }
        // The choice's result, in the engine's own plain words, pinned
        // under the banner by renderGround until the next action.
        groundOutcome = exp.log.slice(logMark).filter(function (l) { return !!l; });
        if (!groundOutcome.length) groundOutcome = null;
        groundAfter();
      });
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-gthrow]'), function (b) {
      b.addEventListener('click', function () {
        var tt = groundTargetTile || (groundTargetId && exp.hostiles.filter(function (h) { return h.id === groundTargetId; })[0]);
        if (!tt) { toast('Tap a target tile first, then throw.'); return; }
        groundOutcome = null; exp.lastEnemyPhase = null;
        var r = G.throwAt(C, state, exp, b.dataset.gthrow, tt.x, tt.y);
        if (!r.ok) { playSfx('denied'); toastGroundBlock(r); }
        groundAfter();
      });
    });
    Array.prototype.forEach.call(root.querySelectorAll('[data-gact]'), function (b) {
      b.addEventListener('click', function () {
        var act = b.dataset.gact;
        var r = null;
        if (act !== 'endturn' && act !== 'extract') { groundOutcome = null; exp.lastEnemyPhase = null; }
        if (act === 'fire') {
          var tid = groundTargetId;
          if (!tid) {
            var am2 = G.activeMember(C, state, exp);
            var near = exp.hostiles.slice().sort(function (a, b2) {
              return (Math.abs(a.x - am2.x) + Math.abs(a.y - am2.y)) - (Math.abs(b2.x - am2.x) + Math.abs(b2.y - am2.y));
            })[0];
            tid = near ? near.id : null;
          }
          if (!tid) { toast('No hostiles on this ground.'); return; }
          r = G.fireAt(C, state, exp, tid);
        } else if (act === 'interact') {
          r = G.interact(C, state, exp);
        } else if (act === 'swap') {
          r = G.swapWeapon(C, state, exp);
        } else if (act === 'light') {
          r = G.toggleLight(C, state, exp, exp.activeId);
        } else if (act === 'support') {
          var other = exp.members.filter(function (m) { return m.id !== exp.activeId; })[0];
          r = other ? G.supportAction(C, state, exp, other.id) : { ok: false, reason: 'No one else to support.' };
        } else if (act === 'c4') {
          var t2 = groundTargetId ? exp.hostiles.filter(function (h) { return h.id === groundTargetId; })[0] : null;
          if (t2 && ['guardian', 'turret', 'plant'].indexOf(t2.kind) >= 0) r = G.plantCharge(C, state, exp, t2.id);
          else r = G.plantCharge(C, state, exp, 'site');
        } else if (act === 'endturn') {
          r = G.endTurn(C, state, exp);
          playSfx('whoosh');
          if (r && r.wiped) { groundAfter(); doExtract(); return; }
        } else if (act === 'extract') {
          if (exp.encounter) { pointerToast(); renderGround(); return; }
          doExtract(); return;
        }
        if (r && !r.ok) { playSfx('denied'); toastGroundBlock(r); }
        groundAfter();
      });
    });
  }
  var groundTargetTile = null;

  /* ---------------- Report screen ---------------- */
  function renderReport() {
    var rep = state.lastReports[state.lastReports.length - 1];
    var body = $('report-body');
    if (!rep) { body.innerHTML = '<p class="muted">No drop report yet. Plan a drop from the Map.</p>'; return; }
    if (rep.kind === 'expedition') { renderExpeditionReport(rep, body); return; }
    var bandClass = rep.band.split(' ')[0];
    var html = '<div class="band ' + bandClass + '">' + esc(rep.band) + '</div>' +
      '<p>Mission: ' + esc(rep.kind) + ' at (' + rep.x + ',' + rep.y + ') · Turn ' + rep.turn + '</p>' +
      (rep.reveal ? '<div class="panel reveal-panel"><h3>THE REVEAL — what the silo kept</h3>' +
        '<p>Deep in the silo, the facility\'s intelligence is still running. It wears its dead keeper\'s shape, and it has waited a long time to say this plainly:</p>' +
        '<p><strong>The things on the surface are not wildlife. They were people</strong> — modified, engineered in silos like this one to survive the hostile ground, meant to sleep five hundred years. <strong>They were woken centuries early.</strong></p>' +
        '<p>Every apex skull on the map now carries the new intel — the AI\'s testimony, marked as testimony. What the squad has been killing is the rescue plan.</p>' +
        '<p class="muted">Chart fragment earned: the AI\'s — ' + (rep.chartFragments || 0) + ' of 4. The hunt for the islands has a voice now.</p></div>' : '') +
      (!rep.reveal && rep.fragmentEarned ? '<div class="panel"><strong>Chart fragment earned: ' + esc(rep.fragmentEarned) + '</strong> — ' +
        (rep.chartFragments || 0) + ' of 4 toward the islands. The campaign strip on the Map tracks the hunt.</div>' : '') +
      '<h3>Why the landing scored ' + rep.land + '</h3><div class="lines">' +
      (lastLanding ? lastLanding.reasons.map(esc).join('\n') : 'Landing detail unavailable.') + '</div>' +
      '<h3>Roll breakdown (§5.1)</h3><table class="breakdown">' +
      '<tr><th>Term</th><th>Value</th></tr>' +
      '<tr><td>SQUAD x4</td><td>' + (rep.squad * 4).toFixed(1) + ' (squad ' + rep.squad + ')</td></tr>' +
      '<tr><td>LAND modifier</td><td>' + (rep.landMod >= 0 ? '+' : '') + rep.landMod + ' (LAND ' + rep.land + ' mapped to -20..+20)</td></tr>' +
      '<tr><td>RECON</td><td>+' + rep.reconBonus + ' (tier ' + rep.reconTier + ')</td></tr>' +
      '<tr><td>ROLL 2d20</td><td>' + rep.rollTotal + ' [' + rep.dice.join(' + ') + ']</td></tr>' +
      '<tr><td>THREAT</td><td>-' + rep.threatPts + ' (threat ' + rep.threat + ' x8)</td></tr>' +
      '<tr><td>OUTCOME</td><td><strong>' + rep.outcome + '</strong> -> ' + esc(rep.band) + '</td></tr></table>' +
      (Object.keys(rep.yield || {}).length ? '<p>Yield delivered: ' + esc(JSON.stringify(rep.yield)) + '</p>' : '') +
      (rep.ascent ? '<p>Balloon lift: ' + (rep.ascent.trimFraction > 0
        ? 'snagged — lifted ' + esc(JSON.stringify(rep.ascent.delivered)) + ' of ' + esc(JSON.stringify(rep.ascent.groundYield)) + ' gathered (lost ' + esc(JSON.stringify(rep.ascent.trimmed)) + ')'
        : 'clean — the caches floated home whole.') + '</p>' : '') +
      (rep.wounded && rep.wounded.length ? '<p class="warn">Wounded: ' + rep.wounded.map(esc).join(', ') + '</p>' : '') +
      (rep.deaths && rep.deaths.length ? '<p class="bad">KILLED: ' + rep.deaths.map(esc).join(', ') + ' — see Memorial.</p>' : '') +
      '<h3>Line by line</h3><div class="lines">' + rep.lines.map(esc).join('\n') + '</div>';
    body.innerHTML = html;
  }

  /* Expedition reports (§§1/3/5b): plain lines, the squad with faces,
   * the actual dice for every injury, what banked into the Armory and
   * what was left behind. No unexplained numbers. */
  function renderExpeditionReport(rep, body) {
    var bandClass = rep.band.split(' ')[0];
    var chips = (rep.diverIds || []).map(function (id) {
      var d = C.diverById(state, id);
      if (!d) return '';
      var dead = rep.deaths.indexOf(d.name) >= 0;
      return '<span class="report-chip' + (dead ? ' dead' : '') + '">' + thumb(d) +
        '<span>' + esc(d.name) + (dead ? ' ☠' : d.wounds ? ' · wounds ' + d.wounds : ' · whole') + '</span></span>';
    }).join('');
    var html = '<div class="band ' + bandClass + '">' + esc(rep.band) + '</div>' +
      '<p>Ground battle at (' + rep.x + ',' + rep.y + ') · Turn ' + rep.turn + ' — ' + esc(rep.outcome) + '</p>' +
      (rep.ecology ? '<p class="muted">Ground truth: ' + esc(rep.ecology.line) + '</p>' : '') +
      '<div class="report-squad">' + chips + '</div>' +
      (lastLanding ? '<h3>Why the landing scored ' + rep.land + '</h3><div class="lines">' + lastLanding.reasons.map(esc).join('\n') + '</div>' : '') +
      (rep.fragmentEarned ? '<div class="panel"><strong>Chart fragment earned: ' + esc(rep.fragmentEarned) + '</strong> — ' + (rep.chartFragments || 0) + ' of 4 toward the islands.</div>' : '') +
      (rep.injuries && rep.injuries.length ? '<h3>The dice — every injury roll</h3><div class="lines">' +
        rep.injuries.map(function (inj) {
          return esc(inj.name) + ' — ' + esc(inj.label) + ': GRIT save rolled ' + (inj.roll + inj.grit) + ' (d20 ' + inj.roll + ' + GRIT ' + inj.grit + '), needed ' + inj.dc + ' — ' + (inj.success ? 'shrugged it off' : 'WOUNDED');
        }).join('\n') + '</div>' : '<p>No injury rolls this drop — nobody was hit on the fall or the ground.</p>') +
      (Object.keys(rep.yield || {}).length ? '<p>Delivered to cargo: ' + esc(JSON.stringify(rep.yield)) + '</p>' : '<p>Nothing reached cargo.</p>') +
      (rep.ascent ? '<p>Balloon lift: ' + (rep.ascent.trimFraction > 0
        ? 'snagged — lifted ' + esc(JSON.stringify(rep.ascent.delivered)) + ' of ' + esc(JSON.stringify(rep.ascent.groundYield)) + ' gathered (lost ' + esc(JSON.stringify(rep.ascent.trimmed)) + ')'
        : 'clean — the caches floated home whole.') + '</p>' : '') +
      (rep.armoryBanked && (rep.armoryBanked.weapons.length || rep.armoryBanked.attachments.length)
        ? '<p><strong>Banked into the Armory:</strong> ' + rep.armoryBanked.weapons.map(esc).join(', ') +
          (rep.armoryBanked.attachments.length ? ' · attachments: ' + rep.armoryBanked.attachments.map(esc).join(', ') : '') +
          ' <span class="muted">— the ship pool; fit and draw it from the Armory step.</span></p>' : '') +
      (rep.leftBehind && rep.leftBehind.length ? '<p class="warn">Left behind (never reached the Armory): ' + rep.leftBehind.map(esc).join('; ') + '</p>' : '') +
      (rep.wounded && rep.wounded.length ? '<p class="warn">Wounded: ' + rep.wounded.map(esc).join(', ') + '</p>' : '') +
      (rep.deaths && rep.deaths.length ? '<p class="bad">KILLED: ' + rep.deaths.map(esc).join(', ') + ' — see Memorial.</p>' : '') +
      '<h3>Line by line</h3><div class="lines">' + rep.lines.map(esc).join('\n') + '</div>';
    body.innerHTML = html;
  }

  /* ---------------- Settlement screen ---------------- */
  function renderSettlement() {
    var body = $('settlement-body');
    var s = state.settlement;
    if (!s) {
      var gz = C.tileAt(state, state.greenZone.x, state.greenZone.y);
      body.innerHTML = '<div class="panel">No settlement yet. Find the hidden green zone ' +
        '(currently ' + (gz.discovered ? 'DISCOVERED at (' + gz.x + ',' + gz.y + ')' : 'undiscovered — explore or recon') +
        '), then found for ' + esc(JSON.stringify(C.TUNABLES.foundCost)) + '.</div>' +
        '<div class="action-bar"><button type="button" id="btn-found2" class="primary"' +
        (gz.discovered ? '' : ' disabled') + '>Found Settlement on Green Zone</button></div>';
      var b = $('btn-found2');
      if (b) b.addEventListener('click', doFound);
      return;
    }
    var bd = C.defenseBreakdown(state);
    var slots = C.structureSlots(state);
    var raidText = state.resources.INTEL >= C.TUNABLES.raidIntelThreshold
      ? s.raidTimer + ' turn(s)' : 'unknown — INTEL below ' + C.TUNABLES.raidIntelThreshold + ' (warning is information)';
    body.innerHTML =
      '<div class="panel"><strong>Tier ' + s.tier + (s.tier === 1 ? ' Outpost' : ' Town') + '</strong> at (' + s.x + ',' + s.y + ')' +
      '<br>Population: ' + s.population +
      '<br>Structure slots: ' + s.structures.length + '/' + slots +
      '<br>Raid in: ' + raidText +
      '<br>Defense (§5.2): <strong>' + bd.defense + '</strong> = wall soak ' + bd.wallSoak +
      ' + turret suppression ' + bd.turretSuppressionPerWave + '/wave + garrison ' + bd.garrisonPower +
      '<br>Next raid force if it hit now: ~' + C.raidForceForTurn(state.turn) + '</div>' +
      (state.lastUpkeep ? '<div class="panel"><strong>Upkeep ledger (last turn)</strong><br>' +
        'Produced ' + state.lastUpkeep.foodProduced + ' FOOD · ate ' + state.lastUpkeep.foodEaten +
        ' (crew rations ' + state.lastUpkeep.rationNeed + ' + settlement mouths ' + state.lastUpkeep.settlementNeed + ')' +
        (state.lastUpkeep.foodShortfall
          ? '<br><span class="bad">Short ' + state.lastUpkeep.foodShortfall + ' FOOD — starvation streak ' + state.lastUpkeep.starvationStreak + '.</span>'
          : '<br>Fed. The loop holds while production + trade cover the mouths.') +
        (state.lastUpkeep.starvationConsequence ? '<br>' + esc(state.lastUpkeep.starvationConsequence) : '') + '</div>' : '') +
      '<h3>Structures</h3>' +
      (s.structures.length ? s.structures.map(function (st) {
        return '<div class="card">' + esc(st.type) + ' (hp ' + st.hp + ') — ' + esc(C.STRUCTURE_DEFS[st.type].label) + '</div>';
      }).join('') : '<p class="muted">Nothing built. An undefended settlement falls.</p>') +
      '<div>' + Object.keys(C.STRUCTURE_DEFS).map(function (k) {
        var def = C.STRUCTURE_DEFS[k];
        return '<button type="button" class="small" data-build="' + k + '"' +
          (s.structures.length >= slots ? ' disabled' : '') + '>Build ' + k + ' (' + esc(JSON.stringify(def.cost)) + ')</button> ';
      }).join('') + '</div>' +
      '<h3>Garrison</h3><p class="muted">Garrisoned divers add (GRIT + level) x2 to defense and do not drop. Assign from the Crew screen.</p>' +
      '<p>' + (s.garrison.length ? s.garrison.map(function (id) {
        var d = C.diverById(state, id); return d ? esc(d.name) : id;
      }).join(', ') : 'No garrison assigned.') + '</p>' +
      (s.tier < 2 ? '<div class="action-bar"><button type="button" id="btn-upgrade" class="primary">Upgrade to Tier 2 (' +
        esc(JSON.stringify(C.TUNABLES.upgradeTier2Cost)) + ')</button></div>' : '<p>Tier 2 reached (slice cap). Survive a raid at Tier 2 to win.</p>');
    Array.prototype.forEach.call(body.querySelectorAll('[data-build]'), function (b) {
      b.addEventListener('click', function () {
        var r = C.buildStructure(state, b.dataset.build); toast(r.ok ? 'Built ' + b.dataset.build + '.' : r.reason); save(); render();
      });
    });
    var up = $('btn-upgrade');
    if (up) up.addEventListener('click', function () {
      var r = C.upgradeSettlement(state); toast(r.ok ? 'Settlement is now Tier 2.' : r.reason); save(); render();
    });
  }
  function doFound() {
    var r = C.foundSettlement(state);
    toast(r.ok ? 'Settlement founded at Tier 1. The supply line to Kestrel Colony is open.' : r.reason);
    save(); render();
  }

  /* ---------------- Defense screen ---------------- */
  function renderDefense() {
    var body = $('defense-body');
    var rep = state.lastRaidReport;
    if (!rep) {
      body.innerHTML = '<div class="panel">No raid has hit yet. Raids resolve in the World Response phase ' +
        'when the settlement raid timer reaches zero. Your decisions — structures and garrison — are made ' +
        'beforehand on the Settlement and Crew screens. The math is fixed at raid start; here you watch it land.</div>';
      return;
    }
    body.innerHTML = '<div class="panel">Raid on turn ' + rep.turn + ': force ' + rep.totalForce +
      ' vs DEFENSE ' + rep.defense + ' — outcome: <strong>' + esc(rep.outcome) + '</strong></div>' +
      '<div id="defense-waves">' + rep.waves.map(function (w, i) {
        return '<div class="wave" data-wave="' + i + '" style="display:none"><strong>Wave ' + w.wave + '</strong>: ' +
          'force ' + w.waveForce + ' -> damage ' + w.damage + ', walls absorb ' + w.absorbedByWall +
          ', overflow ' + w.overflow + '.</div>';
      }).join('') + '</div>' +
      '<div id="defense-lines" class="lines" style="display:none">' + rep.lines.map(esc).join('\n') + '</div>';
    var waves = body.querySelectorAll('.wave');
    var delay = defenseSpeed > 1 ? 120 : 900;
    waves.forEach(function (el, i) {
      setTimeout(function () { el.style.display = 'block'; }, delay * (i + 1));
    });
    setTimeout(function () {
      var l = $('defense-lines'); if (l) l.style.display = 'block';
    }, delay * (waves.length + 1));
  }

  /* ---------------- Trade screen ---------------- */
  function dealCard(deal) {
    var inner = '<div class="card"><strong>' + esc(deal.label) + '</strong>' +
      '<br>Wants: ' + esc(JSON.stringify(deal.wants)) +
      (deal.kind === 'diver' ? '' : '<br>Gives: ' + esc(JSON.stringify(deal.gives)));
    if (deal.kind === 'diver' && deal.diverOffered) {
      var d = deal.diverOffered;
      inner += '<br>Offered diver: <strong>' + esc(d.name) + '</strong> Lv ' + d.level + ' (' + esc(d.origin) + ')' +
        '<div class="statgrid">' + C.STATS.map(function (s) {
          return '<span class="chip">' + s + ' <b>' + d.stats[s] + '</b></span>';
        }).join('') + '</div>Traits: ' + (d.traits.join(', ') || 'none') + ' — full card, no mystery boxes (§4.1).';
    }
    inner += '<div><button type="button" class="small" data-deal="' + deal.id + '">Accept Deal</button></div></div>';
    return inner;
  }
  function renderTrade() {
    var body = $('trade-body');
    var col = state.colony;
    var html = '<div class="panel"><strong>Kestrel Colony</strong> (on the map, SE corner) — reputation: ' + col.reputation +
      ' (range -2..+2; fulfilled deals raise it)<br>Deal table refreshes every ' + C.TUNABLES.dealRefreshTurns +
      ' turns. Supply route: ' + esc(state.supply.status) +
      (state.settlement ? ' · cadence every ' + C.TUNABLES.supplyCadence + ' turns · exposure ' +
        Math.round(C.routeExposure(state) * 100) + '%' : ' · found a settlement to open the route') +
      '<br>Escorts: ' + (state.supply.escort.length ? state.supply.escort.map(function (id) {
        var d = C.diverById(state, id); return d ? esc(d.name) : id;
      }).join(', ') : 'none (assign on Crew screen)') + '</div><h3>Kestrel deals</h3>';
    if (!col.deals.length) html += '<p class="muted">No deals on the table. Wait for the refresh.</p>';
    html += col.deals.map(dealCard).join('');
    html += '<h3>Off-map settlements — by radio</h3>' +
      '<p class="muted">These settlements lie beyond the sector and never appear on the map. You raise them on the wireless and trade sight-unseen — this menu is the whole relationship. Their tables refresh every ' +
      C.TUNABLES.marketRefreshTurns + ' turns.</p>';
    (state.markets || []).forEach(function (m) {
      html += '<div class="panel"><strong>' + esc(m.name) + '</strong> — reputation: ' + m.reputation +
        '<br><span class="muted">' + esc(m.blurb) + '</span></div>';
      if (!m.deals.length) html += '<p class="muted">No deals on ' + esc(m.name) + '&rsquo;s table. Wait for the refresh.</p>';
      html += m.deals.map(dealCard).join('');
    });
    body.innerHTML = html;
    Array.prototype.forEach.call(body.querySelectorAll('[data-deal]'), function (b) {
      b.addEventListener('click', function () {
        var r = C.acceptDeal(state, b.dataset.deal);
        toast(r.ok ? 'Deal fulfilled. Reputation now ' + r.reputation + '.' : r.reason);
        save(); render();
      });
    });
  }

  /* ---------------- Training screen ---------------- */
  function renderTraining() {
    var body = $('training-body');
    var q = state.airship.trainingQueue;
    var html = '<div class="panel">Training aboard the airship: costs ' + esc(JSON.stringify(C.TUNABLES.trainingCost)) +
      ', takes ' + C.TUNABLES.trainingTurns + ' turns, produces a level-1 diver with stats 2-5 and one guaranteed stat at 5 — ' +
      'your standard. Slow and shaped, versus trade: instant and as-is (§4.2).</div>';
    if (q) {
      html += '<div class="card">Trainee in the slot: guaranteed <strong>' + esc(q.guaranteedStat) + '</strong>' +
        (q.name ? ' (' + esc(q.name) + ')' : '') + ' — ' + q.turnsLeft + ' turn(s) left.' +
        '<div><button type="button" class="small" id="btn-cancel-training">Cancel (no refund)</button></div></div>';
    } else {
      html += '<label class="pick">Guaranteed stat (your standard): <select id="train-stat">' +
        C.STATS.map(function (s) { return '<option>' + s + '</option>'; }).join('') + '</select></label>' +
        '<label class="pick">Trainee name (optional): <input type="text" id="train-name" maxlength="32"></label>' +
        '<div class="action-bar"><button type="button" id="btn-enlist" class="primary">Enlist Trainee</button></div>';
    }
    body.innerHTML = html;
    var enlist = $('btn-enlist');
    if (enlist) enlist.addEventListener('click', function () {
      var name = $('train-name').value.trim();
      var r = C.enqueueTraining(state, $('train-stat').value, name || null);
      toast(r.ok ? 'Trainee enlisted. ' + C.TUNABLES.trainingTurns + ' turns to graduation.' : r.reason);
      save(); render();
    });
    var cancel = $('btn-cancel-training');
    if (cancel) cancel.addEventListener('click', function () {
      var r = C.cancelTraining(state); toast(r.ok ? 'Training cancelled.' : r.reason); save(); render();
    });
  }

  /* ---------------- Memorial + Chronicle ---------------- */
  function renderMemorial() {
    var body = $('memorial-body');
    if (!state.tombstones.length) {
      body.innerHTML = '<p class="muted">No one has died. Keep it that way if you can.</p>';
      return;
    }
    body.innerHTML = state.tombstones.map(function (t) {
      return '<div class="card tombstone"><strong>' + esc(t.name) + '</strong> — Lv ' + t.level + ', ' +
        t.dropsSurvived + ' drops survived<br>Died turn ' + t.turn + ' at ' + esc(t.place) + '<br>' + esc(t.cause) + '</div>';
    }).join('');
  }
  function renderChronicle() {
    var body = $('chronicle-body');
    if (!state.chronicle.length) {
      body.innerHTML = '<p class="muted">The chronicle is empty. End a turn to write its first entry.</p>';
      return;
    }
    body.innerHTML = state.chronicle.slice().reverse().map(function (entry) {
      return '<div class="card"><strong>Turn ' + entry.turn + '</strong><div class="lines">' +
        (entry.lines.length ? entry.lines.map(esc).join('\n') : 'A quiet turn.') + '</div></div>';
    }).join('');
  }

  /* ---------------- Screen switching / render ---------------- */
  var RENDERERS = {
    map: renderMap, ship: renderShip, crew: renderCrew, briefing: renderBriefing, report: renderReport,
    ground: renderGround,
    settlement: renderSettlement, defense: renderDefense, trade: renderTrade,
    training: renderTraining, memorial: renderMemorial, chronicle: renderChronicle
  };
  function show(name) {
    currentScreen = name;
    if (name !== 'ship') stopDeckWalk();
    Object.keys(RENDERERS).forEach(function (k) {
      $('screen-' + k).hidden = k !== name;
    });
    Array.prototype.forEach.call(document.querySelectorAll('#tabbar button'), function (b) {
      b.classList.toggle('active', b.dataset.screen === name);
    });
    render();
  }
  function render() { renderHud(); RENDERERS[currentScreen](); }

  /* ---------------- Global actions ---------------- */
  function doEndTurn() {
    var prevTurn = state.turn;
    var r = C.endTurn(state);
    if (!r.ok) { toast(r.reason); return; }
    save();
    var raidHappened = state.lastRaidReport && state.lastRaidReport.turn === prevTurn;
    var ambushHappened = state.lastAmbushReport && state.lastAmbushReport.turn === prevTurn;
    if (state.gameStatus !== 'playing') {
      toast((state.gameStatus === 'won' ? 'WON: ' : 'LOST: ') + (state.endReason || ''));
      show('chronicle');
    } else if (raidHappened) {
      toast('RAID on the settlement — watch the defense.');
      show('defense');
    } else {
      if (ambushHappened) toast('Caravan ambush on the supply route — see Chronicle.');
      show('chronicle');
    }
  }

  var btnSound = $('btn-sound');
  if (btnSound) {
    btnSound.textContent = soundOn ? 'Sound: On' : 'Sound: Off';
    // Sync the audio engine with the stored pref BEFORE anything plays —
    // the toggle below is the other sync point (plus playSfx's per-call
    // belt-and-braces). Mute law (2026-11-12): SFX.setEnabled drives the
    // one master gain + context suspend, so OFF silences loops too.
    if (SFX) SFX.setEnabled(soundOn);
    btnSound.addEventListener('click', function () {
      soundOn = !soundOn;
      try { localStorage.setItem(SOUND_KEY, soundOn ? 'on' : 'off'); } catch (e) { /* ignore */ }
      btnSound.textContent = soundOn ? 'Sound: On' : 'Sound: Off';
      if (SFX) SFX.setEnabled(soundOn);
      if (soundOn) sfx.select();
    });
  }
  /* MAP ⇄ DECK: the one clear toggle between the sector and the ship. */
  var goShip = $('btn-gotoship');
  if (goShip) goShip.addEventListener('click', function () { sfx.select(); show('ship'); });
  var goMap = $('btn-deck-map');
  if (goMap) goMap.addEventListener('click', function () { sfx.select(); show('map'); });
  /* Deck keyboard: arrows / A,D walk the avatar, Enter opens the nearest
   * station. Inert off the deck screen, while typing, or during descent. */
  document.addEventListener('keydown', function (e) {
    if (currentScreen !== 'ship' || descent) return;
    var tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (deckKey(e.key)) e.preventDefault();
  });
  document.addEventListener('keyup', function (e) {
    if (currentScreen !== 'ship') return;
    deckKeyUp(e.key);
  });
  $('btn-guide').addEventListener('click', function () { openGuide(); });
  $('btn-guide-close').addEventListener('click', closeGuide);
  $('guide-overlay').addEventListener('click', function (e) { if (e.target === $('guide-overlay')) closeGuide(); });
  $('btn-first-drop-back').addEventListener('click', function () { dismissFirstDropGuide(false); });
  $('btn-first-drop-start').addEventListener('click', function () { dismissFirstDropGuide(true); });
  $('hud-turn').addEventListener('click', function () { openGuide('numbers'); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (!$('guide-overlay').hidden) closeGuide();
      if (!$('first-drop-overlay').hidden) dismissFirstDropGuide(false);
    }
  });
  /* Live map camera wiring (2026-11-10 fix). Buttons/keys zoom on the
     selected tile; the wheel zooms on the pointer. All of it is
     presentation state only — never saved, never in core. */
  $('zoom-in').addEventListener('click', function () { sfx.select(); setZoomAnchored(zoomIdx + 1, { mode: 'selection' }); });
  $('zoom-out').addEventListener('click', function () { sfx.select(); setZoomAnchored(zoomIdx - 1, { mode: 'selection' }); });
  $('zoom-reset').addEventListener('click', function () { sfx.select(); resetCamera(); });
  /* Cell clicks: ONE delegated listener for the whole hex field. The
     cells are rebuilt by renderMap; the grid element is not, so this
     binding survives every render (2026-11-12 lag fix — the old code
     attached 576 fresh listeners per render). Behaviour is identical:
     a click on a cell (or its icon/label spans) selects its tile, and
     selectTile itself honours the post-drag suppression window. */
  $('map-grid').addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target.closest('.cell') : null;
    if (!el || !el.dataset) return;
    selectTile(parseInt(el.dataset.x, 10), parseInt(el.dataset.y, 10));
  });
  /* World map: a tap centres the main view on the tapped chart point.
     The handlers stopPropagation at every phase so a world-map touch
     can never reach the scene's camera pointers, and the element also
     carries touch-action:none (styles.css). */
  var worldEl = $('world-map');
  if (worldEl) {
    var worldTap = function (e) {
      e.stopPropagation();
      if (e.cancelable !== false) e.preventDefault();
      if (currentScreen !== 'map' || !state) return;
      var r = worldEl.getBoundingClientRect();
      if (!r.width || !r.height) return;
      var fx = (e.clientX - r.left) / r.width * 100, fy = (e.clientY - r.top) / r.height * 100;
      var hit = nearestTileAtFrac(fx, fy, gridDims(), r.width, r.height);
      if (hit) { sfx.select(); centerOnTile(hit.tile.x, hit.tile.y); }
    };
    worldEl.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    worldEl.addEventListener('pointerup', worldTap);
    worldEl.addEventListener('click', function (e) { e.stopPropagation(); e.preventDefault(); });
  }
  /* The map owns touch (2026-11-12): a drag that starts on the scene
   * must never scroll the page or pinch-zoom the browser. CSS carries
   * touch-action:none + overscroll-behavior:none; these non-passive
   * listeners are the belt-and-braces for browsers that still hand the
   * gesture to the page (older iOS Safari). Scoped to the map screen
   * so other screens keep their normal scroll. */
  var sceneLockEl = $('map-scene');
  if (sceneLockEl) {
    sceneLockEl.addEventListener('touchmove', function (e) {
      if (currentScreen === 'map' && e.cancelable !== false) e.preventDefault();
    }, { passive: false });
    sceneLockEl.addEventListener('gesturestart', function (e) {
      if (currentScreen === 'map' && e.cancelable !== false) e.preventDefault();
    }, { passive: false });
  }
  if (window.addEventListener) window.addEventListener('resize', function () {
    if (currentScreen === 'map') { measureMapMetrics(); updateWorldRect(); }
  });
  $('map-scene').addEventListener('wheel', function (e) {
    if (currentScreen !== 'map') return;
    e.preventDefault();
    setZoomAnchored(zoomIdx + (e.deltaY < 0 ? 1 : -1), { mode: 'pointer', x: e.clientX, y: e.clientY });
  }, { passive: false });

  /* Pointer layer: tap vs drag is decided by a ~7px threshold
   * (map34/next pattern). Only RULED inputs pan: one-finger touch drag
   * and middle-mouse drag. A left-mouse drag moves nothing — its
   * trailing click is suppressed so a drag can never become a select
   * on a tile the player did not tap. Taps that land in a preserve-3d
   * dead band (target is not a cell) fall back to the homography pick;
   * taps on a cell ride the cell's own click handler. */
  var camPointers = {};
  var panDrag = null;
  var pinchState = null;
  var sceneEl = $('map-scene');
  function pointerCount() { return Object.keys(camPointers).length; }
  function handleTapFallback(e) {
    var el = e.target;
    if (el && el.closest && (el.closest('.cell') || el.closest('.apex-marker') || el.closest('.map-zoom') || el.closest('#world-map') ||
        el.closest('button') || el.closest('a') || el.closest('input') || el.closest('select') || el.closest('label'))) return;
    var pick = pickTileAtClient(e.clientX, e.clientY);
    if (pick) selectTile(pick.x, pick.y);
  }
  sceneEl.addEventListener('pointerdown', function (e) {
    if (currentScreen !== 'map') return;
    camPointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    if (pointerCount() === 2) {
      var pts = Object.keys(camPointers).map(function (k) { return camPointers[k]; });
      var mid0 = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      pinchState = {
        d: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
        mid: mid0,
        // The ground point under the starting midpoint: the gesture's
        // anchor. Intermediate steps anchor on the live midpoint (which
        // pointer events report one finger at a time); when the pinch
        // ends, settleAnchor re-seats this point exactly under the
        // final midpoint.
        loc: screenToLocal(mid0.x, mid0.y)
      };
      panDrag = null;
      return;
    }
    var isTouch = e.pointerType === 'touch' || e.pointerType === 'pen';
    var isMiddle = e.pointerType === 'mouse' && e.button === 1;
    if (isMiddle) e.preventDefault();   // no autoscroll marquee
    panDrag = {
      id: e.pointerId, x: e.clientX, y: e.clientY,
      panX: cam.panX, panY: cam.panY, moved: false,
      eligible: isTouch || isMiddle
    };
  });
  sceneEl.addEventListener('mousedown', function (e) { if (e.button === 1) e.preventDefault(); });
  sceneEl.addEventListener('pointermove', function (e) {
    if (camPointers[e.pointerId]) camPointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    if (pinchState && pointerCount() === 2) {
      var pts = Object.keys(camPointers).map(function (k) { return camPointers[k]; });
      var d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      var mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      if (pinchState.d > 0 && (d / pinchState.d > 1.18 || d / pinchState.d < 0.85)) {
        setZoomAnchored(zoomIdx + (d > pinchState.d ? 1 : -1), { mode: 'pointer', x: mid.x, y: mid.y });
        pinchState.d = d;
      }
      pinchState.mid = mid;
      return;
    }
    /* Edge pan (PC, classic RTS 2026-11-03): the mouse resting at the
       scene's border pans — but never while a drag is in progress, and
       only over the viewport itself (hovering the zoom buttons, which
       sit at the scene's corner, must not pan the world away). */
    if (e.pointerType === 'mouse' && currentScreen === 'map' && !panDrag &&
        e.target && e.target.closest && e.target.closest('#map-viewport')) {
      var sr = sceneEl.getBoundingClientRect();
      var m = 20, step = 16;
      var ex = e.clientX - sr.left, ey = e.clientY - sr.top;
      if (ex >= 0 && ey >= 0 && ex <= sr.width && ey <= sr.height) {
        if (ex < m) panBy(step, 0); else if (ex > sr.width - m) panBy(-step, 0);
        if (ey < m) panBy(0, step); else if (ey > sr.height - m) panBy(0, -step);
      }
    }
    if (!panDrag || panDrag.id !== e.pointerId) return;
    var dx = e.clientX - panDrag.x, dy = e.clientY - panDrag.y;
    if (!panDrag.moved && Math.hypot(dx, dy) < 7) return;
    panDrag.moved = true;
    if (!panDrag.eligible) return;   // left-mouse drag: measured, never pans
    cam.panX = panDrag.panX + dx; cam.panY = panDrag.panY + dy;
    clampPan(); applyCamSoon();   // visual write coalesced to the next frame
  });
  function endCamPointer(e) {
    flushCam();   // land any coalesced pan frame before tap/settle logic reads layout
    delete camPointers[e.pointerId];
    if (pointerCount() < 2 && pinchState) {
      // Pinch over: seat the gesture's ground anchor exactly under the
      // final midpoint (see the pinchState note in the pointerdown
      // handler) — the zoom the player ends with is anchored, not the
      // last half-reported midpoint.
      if (e.type !== 'pointercancel') settleAnchor(pinchState.loc, pinchState.mid);
      pinchState = null;
    }
    if (!panDrag || panDrag.id !== e.pointerId) return;
    var was = panDrag; panDrag = null;
    if (e.type === 'pointercancel') return;
    if (was.moved) { suppressClickUntil = Date.now() + 400; return; }
    handleTapFallback(e);
  }
  sceneEl.addEventListener('pointerup', endCamPointer);
  sceneEl.addEventListener('pointercancel', endCamPointer);
  // A click that trails a real pan drag (any button) is not a tap.
  sceneEl.addEventListener('click', function (e) {
    if (Date.now() < suppressClickUntil) { e.stopPropagation(); e.preventDefault(); }
  }, true);

  /* Keyboard camera (PC): arrows pan, + / - zoom on the selection,
   * 0 resets, F focuses the selection. Inert while typing, while an
   * overlay is up, during the descent, or off the map screen. */
  document.addEventListener('keydown', function (e) {
    if (currentScreen !== 'map' || descent) return;
    var tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (!$('guide-overlay').hidden || !$('first-drop-overlay').hidden) return;
    var step = 56;
    switch (e.key) {
      case 'ArrowLeft': e.preventDefault(); panBy(step, 0); break;
      case 'ArrowRight': e.preventDefault(); panBy(-step, 0); break;
      case 'ArrowUp': e.preventDefault(); panBy(0, step); break;
      case 'ArrowDown': e.preventDefault(); panBy(0, -step); break;
      case '+': case '=': setZoomAnchored(zoomIdx + 1, { mode: 'selection' }); break;
      case '-': case '_': setZoomAnchored(zoomIdx - 1, { mode: 'selection' }); break;
      case '0': resetCamera(); break;
      case 'f': case 'F': focusSelection(); break;
    }
  });

  /* Test/debug handle: lets the headless camera suite drive and assert
   * real camera state (same pattern as DropZoneMap34). */
  window.DropZoneUI = {
    getCam: function () {
      var board = $('map-board');
      return {
        zoom: camZoom(), zoomIdx: zoomIdx, panX: cam.panX, panY: cam.panY, tilt: TILT_DEG,
        transform: board ? board.style.transform : '', origin: board ? board.style.transformOrigin : ''
      };
    },
    getSelected: function () { return { x: selected.x, y: selected.y }; },
    pickTileAtClient: pickTileAtClient,
    screenToLocal: screenToLocal,
    localToScreen: localToScreen,
    focusSelection: focusSelection,
    resetCamera: resetCamera,
    centerOnTile: centerOnTile,
    visibleFrac: visibleFrac,
    /* Ship deck test hooks (same pattern as the camera hooks above). */
    showScreen: show,
    getState: function () { return state; },
    getDeck: function () { return { x: deck.x, station: deck.station, camX: deck.camX, stations: DECK_STATIONS.map(function (s) { return s.id; }) }; },
    walkToStation: walkToStation,
    deckArrive: function () {
      if (deck.targetStation) {
        var st = deck.targetStation;
        deck.targetX = null; deck.targetStation = null;
        arriveStation(st);
      }
    },
    deckKey: deckKey,
    deckKeyUp: deckKeyUp
  };
  $('btn-move').addEventListener('click', function () {
    var r = C.moveAirship(state, selected.x, selected.y);
    toast(r.ok ? 'Airship moved (' + r.distance + ' tiles, ' + r.cost + ' fuel).' : r.reason);
    save(); render();
  });
  $('btn-drop').addEventListener('click', function () { show('briefing'); });
  $('btn-found').addEventListener('click', doFound);
  $('btn-endturn').addEventListener('click', doEndTurn);
  $('btn-report-continue').addEventListener('click', function () { show('map'); });
  $('btn-defense-speed').addEventListener('click', function () {
    defenseSpeed = defenseSpeed > 1 ? 1 : 4;
    $('btn-defense-speed').textContent = defenseSpeed > 1 ? 'Speed: fast (tap for normal)' : 'Speed-up';
    renderDefense();
  });
  $('btn-newgame').addEventListener('click', function () {
    var seed = window.prompt('New game seed (same seed + same actions = same outcomes):', 'dropzone-1');
    if (seed !== null) newGame(seed || undefined);
  });
  $('btn-export').addEventListener('click', function () {
    var blob = new Blob([C.serialize(state)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'drop-zone-save-turn-' + state.turn + '.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  });
  $('file-import').addEventListener('change', function (e) {
    var file = e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        state = C.deserialize(String(reader.result));
        selected = { x: state.airship.x, y: state.airship.y };
        firstDropGuideAcknowledged = state.totalDrops > 0;
        pendingDrop = null;
        save(); show('map'); toast('Save imported (turn ' + state.turn + ').');
      } catch (err) { toast('Import failed: ' + err.message); }
    };
    reader.readAsText(file);
  });
  Array.prototype.forEach.call(document.querySelectorAll('#tabbar button'), function (b) {
    b.addEventListener('click', function () { show(b.dataset.screen); });
  });

  /* ---------------- Boot ---------------- */
  if (!load()) { state = C.createGame('dropzone-1'); save(); }
  firstDropGuideAcknowledged = state.totalDrops > 0;
  selected = { x: state.airship.x, y: state.airship.y };
  show('map');
  /* §5(a) title/intro layer: first load only, remembered, and Continue
     always works — an existing save is never trapped behind it. */
  (function introBoot() {
    var overlay = $('intro-overlay');
    if (!overlay) return;
    var seen = false;
    try { seen = localStorage.getItem('dropzone-intro-seen-v1') === '1'; } catch (e) { /* show it */ }
    if (seen) { overlay.hidden = true; return; }
    overlay.hidden = false;
    function dismiss() {
      try { localStorage.setItem('dropzone-intro-seen-v1', '1'); } catch (e) { /* ignore */ }
      overlay.hidden = true;
      playSfx('confirm');
    }
    var cont = $('btn-intro-continue');
    if (cont) cont.addEventListener('click', dismiss);
    var nw = $('btn-intro-new');
    if (nw) nw.addEventListener('click', function () { dismiss(); newGame('dz-' + Date.now()); });
  })();
  if (SFX) SFX.ambience('map-ambience');
})();
