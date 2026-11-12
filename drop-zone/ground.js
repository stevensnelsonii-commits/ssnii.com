/*
 * DROP ZONE — GROUND ENGINE (the battle phase of a drop).
 * Integrated into the LIVE root build by the fix-it-all job (Steve,
 * 2026-11-10) from the Nov 3 expedition engine (next/encounters.js),
 * running against the CURRENT Act 1-2 root core.js.
 *  - After touchdown the drop is a TURN-BASED RPG on the local ground:
 *    each diver has ACTION POINTS per ground turn, spent on moving,
 *    firing, throwing, and interacting (loot / doors / bands / depots).
 *  - Loot is FOUND by exploring (real sector content + seeded drift
 *    caches inside the 13x13 ground window), never auto-yielded. Finds
 *    bank into the ship's ARMORY on extraction (§13 pool rule) — nothing
 *    is owned by the finder; what the lift leaves behind is reported.
 *  - Canon (§§7-8): the fauna hostile class is SIRENS in three battle
 *    classes — MELEE rushers, RANGED shriekers (range 2-3), FLYING
 *    variants — mixed by a site-archetype x weather ecology; carnivorous
 *    glow-plants root at overgrown sites; machine guardians are DORMANT
 *    war machines (turret trucks, M3 Abrams); humans may crew their own
 *    turret truck; rival raiders stay human hostiles.
 *  - POI objectives are PLAYED here: bunker doors, Communal floor bands,
 *    the depot, the graveyard, fuel-cell stock, POI guards — and every
 *    outcome reconciles exactly with core state (wounds, permadeath,
 *    cargo, site worked-state, campaign fragments), exactly once.
 * Pure JS, no DOM (UMD like core.js). Deterministic: a dedicated
 * expedition RNG seeded from (game seed, drop number, landing tile) +
 * core's own seeded RNG for GRIT saves.
 */
(function (global) {
  'use strict';

  var TUN = {
    apPerTurn: 4,              // one pool per diver per ground turn
    costMoveTile: 1,           // per tile (water costs 2 — wading)
    costMoveWater: 2,
    costFire: 2,
    costInteract: 1,
    costTalk: 1,
    sight: 2,                  // Manhattan sight radius per diver
    fireRange: 6,              // legacy ceiling; weapon profiles rule (§9)
    fireDCBase: 11,            // d20 + AIM vs 11 + hostile menace
    cacheDCBase: 12,           // d20 + GRIT vs 12 + tile threat
    ruinDC: 14,                // d20 + AIM to rush a ruin vault
    nerveDC: 12,               // tipster / parley / haggle checks
    driftCaches: 3,            // seeded minor salvage spots per window
    encounterBase: 0.13,       // per-step encounter chance before mods
    encounterPerThreat: 0.02,
    encounterPerStep: 0.004,   // the longer you stay, the more finds you
    graceSteps: 2,             // no encounters in the first steps
    maxGroundTurns: 99         // no hard cap — pressure is the clock below
  };

  // WORKING names (not canon) — flavor pools for characters.
  var TIPSTER_NAMES = ['Wren', 'Old Sallow', 'Pell the Listener', 'Auntie Static', 'Low Tom'];
  var TRADER_NAMES = ['Mother Ledger', 'Cousin Vane', 'The Smiling Factor', 'Baba Crumb'];
  var SURVIVOR_NAMES = ['a downed courier', 'a cache-runner', 'a lost colony kid', 'a signal-watcher'];
  var HOSTILE_NAMES = { swarm: 'Siren', guardian: 'dormant machine guardian', scavenger: 'rival raider' };
  var SIREN_CLASS_NAMES = { melee: 'Siren rusher', ranged: 'Siren shrieker', flying: 'Siren flier' };

  /* ---- Siren ecology (brief §7 + environment extension, Steve 18:11) --
   * FLYING deadliest in the open, blunted indoors and in storms; RANGED
   * (shriek) deadliest enclosed, weaker in open wind; MELEE deadliest in
   * dense cover, weakest seen coming in the open. Radiation scaling
   * (Rule 10) applies on top via menace. */
  var SIREN_ECOLOGY = {
    open:     { weights: { melee: 0.30, ranged: 0.20, flying: 0.50 }, gate: { melee: 0.45, ranged: 0.40, flying: 0.60 }, label: 'open ground' },
    interior: { weights: { melee: 0.35, ranged: 0.50, flying: 0.15 }, gate: { melee: 0.50, ranged: 0.65, flying: 0.40 }, label: 'enclosed halls' },
    cover:    { weights: { melee: 0.55, ranged: 0.25, flying: 0.20 }, gate: { melee: 0.65, ranged: 0.50, flying: 0.50 }, label: 'dense cover' }
  };
  function siteArchetype(C, state, x, y) {
    var poi = C.poiAt(state, x, y);
    if (poi && (poi.kind === 'bunker' || poi.kind === 'communal')) return 'interior';
    var t = C.tileAt(state, x, y);
    if (t && (t.terrain === 'ruin' || t.terrain === 'rough')) return 'cover';
    return 'open';
  }
  function sirenClassSpeed(cls, archetype, storm) {
    if (cls === 'flying') return archetype === 'interior' ? 2 : (storm ? 3 : 4);
    if (cls === 'ranged') return 2;
    return 3; // melee rushers
  }
  function sirenGate(cls, archetype, storm) {
    var g = SIREN_ECOLOGY[archetype].gate[cls];
    if (cls === 'flying' && storm) g = Math.min(g, 0.40); // storms blunt the fliers
    return g;
  }
  function siteIntel(C, state, x, y) {
    var archetype = siteArchetype(C, state, x, y);
    var sev = C.fallSeverity(state, x, y);
    var storm = sev.multiplier >= 1.5;
    var w = SIREN_ECOLOGY[archetype].weights;
    var dom = 'melee';
    if (w.ranged >= w[dom]) dom = 'ranged';
    if (w.flying >= w[dom]) dom = 'flying';
    var domWord = { melee: 'rushers', ranged: 'shriekers', flying: 'fliers' }[dom];
    var why = {
      open: 'open ground favors wings; shrieks scatter in the wind',
      interior: 'enclosed halls carry the shriek; wings are blunted indoors',
      cover: 'dense cover is ambush ground — you will see the rushers late'
    }[archetype];
    var line = 'Sirens here run mostly ' + domWord + ' — ' + why + '.' +
      (storm ? ' Storm weather grounds the fliers some.' : '');
    var machineLine = sev.tier === 'red' ? 'Raiders on this ground field a crewed turret truck — armored.' :
      sev.tier === 'yellow' ? 'Raiders here may field a turret truck.' : null;
    return { archetype: archetype, storm: storm, weights: w, dominant: dom, tier: sev.tier, line: line, machineLine: machineLine };
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function chance(C, rng, p) { return C.rngNext(rng) < p; }
  function key(x, y) { return x + ',' + y; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /* ---------------- expedition creation -------------------------------- */
  // Bookkeeping mirrors core.resolveDrop's opening (fuel, drop count,
  // landing tile discovered) — the rest of the drop is played, not rolled.
  function createExpedition(C, state, opts) {
    var T = C.TUNABLES;
    var tile = C.tileAt(state, opts.landX, opts.landY);
    if (!tile) return { ok: false, reason: 'Landed off the sector map.' };
    var members = opts.squadIds.map(function (id) { return C.diverById(state, id); }).filter(Boolean);
    if (!members.length) return { ok: false, reason: 'No squad on the ground.' };
    // Loadout law (§13): an over-bound squad cannot launch. Checked BEFORE
    // fuel is charged so a refused launch costs nothing.
    var overBound = C.loadoutCheck(state, opts.squadIds).filter(function (c) { return c.over > 0; });
    if (overBound.length) {
      return { ok: false, reason: overBound.map(function (c) {
        return c.name + ' is ' + c.over + ' kg over their carry bound';
      }).join('; ') + ' — drop something at the Armory.' };
    }
    state.airship.fuel -= T.dropFuelCost;
    state.totalDrops += 1;
    tile.discovered = true;
    if (!state.mapProgress) state.mapProgress = { things: 0 };
    state.mapProgress.things += 1; // the drop itself (mirrors core countThing)

    var rng = C.createRng(String(state.seed) + ':expedition:' + state.totalDrops + ':' + opts.landX + ',' + opts.landY);
    var wx0 = clamp(opts.targetX - 6, 0, T.gridW - 13);
    var wy0 = clamp(opts.targetY - 6, 0, T.gridH - 13);

    var exp = {
      ok: true,
      rng: rng,
      target: { x: opts.targetX, y: opts.targetY },
      landing: { x: opts.landX, y: opts.landY },
      land: opts.land, kind: opts.kind || 'generic',
      win: { x0: wx0, y0: wy0, w: 13, h: 13 },
      turn: 1, steps: 0, exposure: 0,
      storm: opts.storm || 0, sightPenalty: 0, dangerPlus: 0,
      members: [],           // {id, x, y, ap, apMax, slot, kitThrows, pack, hasLight, lightOn}
      activeId: members[0].id,
      carried: {},           // gathered on the ground; cargo only after the lift
      drift: {},             // 'x,y' -> {resource, amount} seeded salvage
      seen: {},              // 'x,y' -> true (currently lit by someone's sight)
      mapped: {},            // 'x,y' -> true (ever seen; also writes tile.discovered)
      hostiles: [],          // {id, kind, cls, x, y, hp, maxHp, menace, name, speed, stunTurns}
      nextHostileSeq: 0,
      encounter: null,       // pending {kind, title, text, choices:[{id,label,sub,cost}]}
      pendingPathFor: null,  // member id the plotted course (pendingPath) belongs to
      lastEnemyPhase: null,  // {turn, lines[]} — what the hostiles did on the last endTurn (turn banner)
      counts: { tipster: 0, trader: 0, survivor: 0, scavengers: 0, weather: 0, danger: 0, guardian: 0 },
      intelSites: false,     // tipster reveal: all sites/nodes marked
      intelThreats: false,   // tipster reveal: exact threats known in window
      decoy: null,           // a tipster lie marker {x, y}
      suppressed: 0, woundsTaken: 0, deaths: [], chronicleDeaths: [],
      cachesLooted: 0, nodesHarvested: 0,
      events: [],            // feedback event ids for the UI (drained per action)
      injuries: [],          // structured GRIT rolls for the report (§5b)
      poiWorked: false, depotDone: false, siteWorked: {},
      cryoFound: null, fragmentEarned: null, ecology: null,
      charges: 0,            // C4, carried by the explosives experts (§9)
      turretSpawned: false, plantEligible: false,
      foundGear: [],         // weapons/attachments found — banked at the lift (§13)
      leftBehind: [],        // finds the squad had no backs for (reported)
      foundStock: null,      // leftover found grenades return to the Armory pool
      flares: [],            // burning flare zones {x, y, turns}
      dark: false,           // §15-ext: interior archetypes are dark inside
      log: [],
      finished: false, report: null
    };
    exp.ecology = siteIntel(C, state, opts.targetX, opts.targetY);
    exp.dark = exp.ecology.archetype === 'interior';

    // Squad touches down in formation around the landing tile.
    var spots = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1], [0, 2]];
    members.forEach(function (d, i) {
      var sx = opts.landX, sy = opts.landY;
      for (var s = 0; s < spots.length; s++) {
        var cx = clamp(opts.landX + spots[(i + s) % spots.length][0], wx0, wx0 + 12);
        var cy = clamp(opts.landY + spots[(i + s) % spots.length][1], wy0, wy0 + 12);
        if (!exp.members.some(function (m) { return m.x === cx && m.y === cy; })) { sx = cx; sy = cy; break; }
      }
      var arch = C.ensureArchetype(d);
      var apMax = TUN.apPerTurn + (arch === 'BLITZER' ? 1 : 0); // Blitzer: fast (§9)
      var prof = C.effectiveProfile(state, d, 'primary');
      var hasLight = !!prof.hasLight || !!d.tacLight;           // §15-ext light sources
      exp.members.push({
        id: d.id, x: sx, y: sy, ap: apMax, apMax: apMax, slot: 'primary',
        kitThrows: clone(C.kitThrowsFor(arch)),                  // free kit (flares only, §10 calibration)
        pack: clone(C.grenadePackOf(d)),                         // pool grenades drawn at the Armory
        hasLight: hasLight, lightOn: hasLight && exp.dark        // lights burn in the dark by default
      });
    });
    // C4 charges ride with the explosives experts (§9) — class kit, not pool.
    exp.charges = members.reduce(function (a, d) {
      return a + (C.ensureArchetype(d) === 'EXPLOSIVES' ? T.c4ChargesPerExpert : 0);
    }, 0);
    // Found grenades are squad-shared stock on top of packs (§13 pool):
    // the Armory's found-throwable counts ride along and leftovers return.
    exp.foundStock = { frag: 0, flash: 0, conc: 0 };
    // Ship-standard flares: two loose in every drop bag (never pooled).
    exp.shipFlares = 2;

    // POI guards go on the ground as dormant machine hostiles (§1): kill
    // them in the fight and the POI's guards go dark in core state.
    var targetPoi0 = C.poiAt(state, opts.targetX, opts.targetY);
    if (targetPoi0 && C.activeGuards(targetPoi0).length) {
      var guards0 = C.activeGuards(targetPoi0);
      guards0.forEach(function (g, gi) {
        exp.nextHostileSeq += 1;
        var gang = (gi / Math.max(1, guards0.length)) * Math.PI * 2;
        var gx = clamp(opts.targetX + Math.round(Math.cos(gang) * 2), wx0, wx0 + 12);
        var gy = clamp(opts.targetY + Math.round(Math.sin(gang) * 2), wy0, wy0 + 12);
        exp.hostiles.push({
          id: 'hostile-' + exp.nextHostileSeq, kind: 'guardian', cls: null,
          name: g.form === 'abrams' ? 'dormant M3 Abrams' : 'dormant turret truck',
          x: gx, y: gy, hp: g.form === 'abrams' ? 4 : 3, maxHp: g.form === 'abrams' ? 4 : 3,
          menace: g.form === 'abrams' ? 3 : 2, speed: 2, guardRef: g, poiLabel: targetPoi0.label
        });
      });
      exp.log.push('Dormant machines hold ' + targetPoi0.label + ' — ' +
        guards0.map(function (g) { return g.form; }).join(' + ') +
        '. They wake when you work the site. Clear them or leave them sleeping.');
    }
    // Standing fauna pressure by radiation tier (Rule 10 on top of ecology).
    var tierCount = { green: 1, yellow: 3, red: 4 }[exp.ecology.tier] || 1;
    if (chance(C, rng, 0.5)) tierCount += 1;
    if (tierCount > 0) {
      var sirens = spawnHostiles(C, state, exp, 'swarm', opts.targetX, opts.targetY, tierCount, exp.ecology.tier === 'red' ? 1 : 0);
      if (sirens.length) exp.log.push('Sirens are already on this ground (' + sirens.length + ') — ' + exp.ecology.line);
    }
    // Carnivorous glow-plants (§8): lush sites only, never interiors.
    exp.plantEligible = exp.ecology.archetype !== 'interior' &&
      (exp.ecology.tier === 'green' || exp.ecology.tier === 'yellow');
    if (exp.plantEligible && chance(C, rng, 0.55)) {
      var plants = spawnHostiles(C, state, exp, 'plant', opts.targetX, opts.targetY, 1 + (chance(C, rng, 0.4) ? 1 : 0), 0);
      if (plants.length) exp.log.push('Glow-plants root the ground here (' + plants.length + ') — carnivorous, tentacle reach two tiles. They cannot move. Burn them or walk wide.');
    }

    // Seeded drift caches: minor salvage the wind and the years left behind.
    var placed = 0, guard = 0;
    while (placed < TUN.driftCaches && guard++ < 300) {
      var dx = wx0 + C.rngInt(rng, 0, 12), dy = wy0 + C.rngInt(rng, 0, 12);
      var dt = C.tileAt(state, dx, dy);
      if (!dt || dt.terrain === 'water' || dt.supplySite || dt.robotSite || dt.resourceType) continue;
      if (Math.abs(dx - opts.landX) + Math.abs(dy - opts.landY) <= 2) continue;
      if (exp.drift[key(dx, dy)]) continue;
      var res = ['SCRAP', 'FOOD', 'FUEL', 'INTEL'][C.rngInt(rng, 0, 3)];
      var amt = res === 'INTEL' ? C.rngInt(rng, 1, 3) : C.rngInt(rng, 2, 6);
      exp.drift[key(dx, dy)] = { resource: res, amount: amt };
      placed += 1;
    }

    // SHIP AS HOME: THE APEX, on its home ground. A marked apex (Rule 12)
    // whose record sits on the target tile fields ONE apex hostile in the
    // fight. Kill it and get the squad home: the skull comes back with you
    // (settled at the lift, core.awardApexSkull).
    exp.apexId = null; exp.apexKilled = null; exp.trophyFinds = [];
    var apexRec = (state.apex || []).filter(function (a) {
      return a.x === opts.targetX && a.y === opts.targetY && !a.dead;
    })[0];
    if (apexRec) {
      var apexMade = spawnHostiles(C, state, exp, 'swarm', opts.targetX, opts.targetY, 1, 3);
      if (apexMade.length) {
        var ah = apexMade[0];
        ah.apexId = apexRec.id;
        ah.hp = ah.maxHp = C.TUNABLES.apexHostileHp;
        ah.name = ah.name.replace(' (apex)', '') + ' — APEX';
        exp.apexId = apexRec.id;
        exp.log.push('Something marked holds this ground: ' + (apexRec.name || 'an unnamed apex') +
          ' — an APEX Siren (' + C.TUNABLES.apexHostileHp + ' hp). Drop it and bring the skull home; the Trophy Room is waiting.');
      }
    }
    // SHIP AS HOME: JOURNAL PAGES seeded by subject. Uncollected snippets
    // whose placement matches this ground appear as page markers (✒) —
    // walk onto one and INTERACT to read it into the Journal.
    exp.snippetSites = [];
    var snipCtx = {
      poiKind: targetPoi0 ? targetPoi0.kind : null,
      radiation: targetPoi0 ? (targetPoi0.radiation || 0) : (tile ? tile.threat : 0),
      isApex: !!apexRec,
      hasMachine: false, machineTile: null
    };
    for (var wy = wy0; wy < wy0 + 13 && !snipCtx.machineTile; wy++) {
      for (var wx = wx0; wx < wx0 + 13; wx++) {
        var mt = C.tileAt(state, wx, wy);
        if (mt && mt.robotSite && !mt.robotSite.cleared) { snipCtx.hasMachine = true; snipCtx.machineTile = { x: wx, y: wy }; break; }
      }
    }
    function snipSpot(def) {
      var cands = [];
      if (def.site === 'machine' && snipCtx.machineTile) cands.push(snipCtx.machineTile);
      cands.push({ x: opts.targetX + 1, y: opts.targetY }, { x: opts.targetX, y: opts.targetY + 1 },
        { x: opts.landX + 1, y: opts.landY }, { x: opts.landX, y: opts.landY + 1 }, { x: opts.targetX, y: opts.targetY });
      // Ring search around the target: first free walkable tile wins —
      // pages must survive map edges and crowded landing formations.
      for (var rad = 1; rad <= 3; rad++) {
        for (var ry = -rad; ry <= rad; ry++) {
          for (var rx = -rad; rx <= rad; rx++) {
            if (Math.max(Math.abs(rx), Math.abs(ry)) === rad) cands.push({ x: opts.targetX + rx, y: opts.targetY + ry });
          }
        }
      }
      for (var ci = 0; ci < cands.length; ci++) {
        var cx = cands[ci].x, cy = cands[ci].y;
        if (cx < wx0 || cx > wx0 + 12 || cy < wy0 || cy > wy0 + 12) continue;
        var ct = C.tileAt(state, cx, cy);
        if (!ct || ct.terrain === 'water') continue;
        if (exp.members.some(function (m) { return m.x === cx && m.y === cy; })) continue;
        if (exp.hostiles.some(function (h) { return h.x === cx && h.y === cy; })) continue;
        if (exp.snippetSites.some(function (s) { return s.x === cx && s.y === cy; })) continue;
        return { x: cx, y: cy };
      }
      return null;
    }
    C.SNIPPETS.forEach(function (def) {
      if (exp.snippetSites.length >= C.TUNABLES.snippetMarkersPerDrop) return;
      if (C.snippetFound(state, def.id)) return;
      if (!C.snippetSiteMatches(def, snipCtx)) return;
      var spot = snipSpot(def);
      if (spot) exp.snippetSites.push({ id: def.id, x: spot.x, y: spot.y });
    });
    if (exp.snippetSites.length) {
      exp.log.push('A page from the books lies on this ground (✒) — stand on it and INTERACT to file it in the Journal.');
    }

    reveal(C, state, exp);
    exp.log.push('Touchdown at ' + tileLabel(C, opts.landX, opts.landY) + ' — LAND ' + opts.land + '. The squad is on the ground. ' +
      'Ground turn 1: explore, gather, and call the lift when you have enough — or when you have had enough.');

    // Descent wounds (lightning hits / brutal landings during the fall):
    // each hit is a GRIT save for the most exposed diver at touchdown.
    var hits = opts.descentHits || 0;
    var hitList = Array.isArray(hits) ? hits : [];
    var hitCount = Array.isArray(hits) ? hits.length : hits;
    for (var h = 0; h < hitCount; h++) {
      var exposed = members.slice().sort(function (a, b) { return a.stats.GRIT - b.stats.GRIT; })[0];
      if (exposed && exposed.status !== 'dead') {
        woundMember(C, state, exp, exposed, hitList[h] || 'Lightning strike on the descent');
      }
    }
    return exp;
  }

  function tileLabel(C, x, y) { return String.fromCharCode(65 + x) + (y + 1); }
  function memberOf(exp, id) {
    for (var i = 0; i < exp.members.length; i++) if (exp.members[i].id === id) return exp.members[i];
    return null;
  }
  function livingMembers(C, state, exp) {
    // 'downed' = a hero evac'd mid-battle: out of the fight, not dead.
    return exp.members.filter(function (m) { var d = C.diverById(state, m.id); return d && d.status !== 'dead' && d.status !== 'downed'; });
  }
  function activeMember(C, state, exp) {
    var m = memberOf(exp, exp.activeId);
    if (m) { var d = C.diverById(state, m.id); if (d && d.status !== 'dead' && d.status !== 'downed') return m; }
    var liv = livingMembers(C, state, exp);
    if (liv.length) { exp.activeId = liv[0].id; return liv[0]; }
    return null;
  }
  function setActive(exp, id) {
    if (memberOf(exp, id)) { exp.activeId = id; return true; }
    return false;
  }
  function sightRadius(exp) { return Math.max(1, TUN.sight - exp.sightPenalty); }
  // §15-ext: a member sheds light if they carry a source and it is ON,
  // or they stand in a burning flare zone.
  function memberLit(exp, m) {
    if (m.hasLight && m.lightOn) return true;
    return exp.flares.some(function (f) { return Math.abs(f.x - m.x) + Math.abs(f.y - m.y) <= 1; });
  }
  function tileBurning(exp, x, y) {
    return exp.flares.some(function (f) { return Math.abs(f.x - x) + Math.abs(f.y - y) <= 1; });
  }

  function reveal(C, state, exp) {
    exp.seen = {};
    exp.members.forEach(function (m) {
      var d = C.diverById(state, m.id);
      if (!d || d.status === 'dead' || d.status === 'downed') return;
      // Darkness (§15-ext): unlit divers in a dark interior see 1 tile;
      // light — carried, fitted, or a burning flare — restores full sight.
      var r = sightRadius(exp);
      if (exp.dark && !memberLit(exp, m)) r = 1;
      for (var y = m.y - r - 1; y <= m.y + r + 1; y++) {
        for (var x = m.x - r - 1; x <= m.x + r + 1; x++) {
          var dist = Math.abs(x - m.x) + Math.abs(y - m.y);
          var t = C.tileAt(state, x, y);
          if (!t) continue;
          if (dist <= r) exp.seen[key(x, y)] = true;
          if (dist <= r + 1) {
            if (!exp.mapped[key(x, y)]) { exp.mapped[key(x, y)] = true; t.discovered = true; }
          }
        }
      }
    });
    // Flare zones light their own ground.
    exp.flares.forEach(function (f) {
      for (var fy = f.y - 2; fy <= f.y + 2; fy++) {
        for (var fx = f.x - 2; fx <= f.x + 2; fx++) {
          if (Math.abs(fx - f.x) + Math.abs(fy - f.y) <= 2 && C.tileAt(state, fx, fy)) {
            exp.seen[key(fx, fy)] = true; exp.mapped[key(fx, fy)] = true;
          }
        }
      }
    });
    // Anything actively engaging the squad is lit.
    exp.hostiles.forEach(function (h) { exp.seen[key(h.x, h.y)] = true; });
  }

  /* ---------------- wounds & death (core's own pieces) ------------------ */
  function woundMember(C, state, exp, diver, label) {
    var lines = exp.log;
    var save = C.makeGritSave(state, diver, 0);
    exp.injuries.push({ name: diver.name, label: label, roll: save.roll, grit: save.grit, dc: save.dc, success: save.success });
    exp.events.push(save.success ? 'save:' + diver.id : 'wound:' + diver.id);
    if (!save.success) {
      // Armor (§15): a plate can take the hit — protection steps by tier.
      var prot = C.armorProtection(diver);
      if (prot > 0 && chance(C, exp.rng, prot === 2 ? 0.45 : 0.25)) {
        lines.push(label + ': the plate of ' + diver.name + ' takes the hit — no wound (armor).');
        return 'shrugged';
      }
    }
    if (save.success) {
      lines.push(label + ': ' + diver.name + ' shrugs it off (GRIT save ' + save.roll + '+' + save.grit + ' vs ' + save.dc + ').');
      return 'shrugged';
    }
    diver.wounds += 1;
    diver.status = 'wounded';
    exp.woundsTaken += 1;
    lines.push(label + ': ' + diver.name + ' is wounded (GRIT save ' + save.roll + '+' + save.grit + ' vs ' + save.dc + ' failed).');
    if (diver.wounds >= 3) {
      var last = C.makeGritSave(state, diver, 0);
      if (!last.success) {
        exp.injuries.push({ name: diver.name, label: 'Bleed-out save', roll: last.roll, grit: last.grit, dc: last.dc, success: false });
        var rd = C.recordDeath(state, diver, 'tile (' + exp.landing.x + ',' + exp.landing.y + ')',
          'bled out on the ground — the third wound was one too many', exp.chronicleDeaths);
        if (rd && rd.heroDowned) {
          exp.events.push('downed:' + diver.id);
          lines.push('✚ ' + diver.name + ' goes down on the third wound — but a hero does not die down here: the balloon crew winches them out. Evac\'d to the Medbay, out for ' + rd.downedTurns + ' turns.');
          return 'downed';
        }
        exp.events.push('death:' + diver.id);
        exp.deaths.push(diver.name);
        lines.push('☠ ' + diver.name + ' bleeds out — the third wound was one too many.');
        return 'dead';
      }
      lines.push(diver.name + ' refuses to die (GRIT save ' + last.roll + '+' + last.grit + ' vs ' + last.dc + ') — barely standing.');
    }
    return 'wounded';
  }

  /* ---------------- movement (AP-priced pathing) ------------------------ */
  function inWindow(exp, x, y) {
    return x >= exp.win.x0 && x < exp.win.x0 + exp.win.w && y >= exp.win.y0 && y < exp.win.y0 + exp.win.h;
  }
  function tileMoveCost(C, state, x, y) {
    var t = C.tileAt(state, x, y);
    if (!t) return Infinity;
    return t.terrain === 'water' ? TUN.costMoveWater : TUN.costMoveTile;
  }
  // Dijkstra over the 13x13 window; AP-priced. Returns {path, cost} or null.
  function findPath(C, state, exp, fromX, fromY, toX, toY) {
    if (!inWindow(exp, toX, toY)) return null;
    var dist = {}, prev = {}, done = {};
    dist[key(fromX, fromY)] = 0;
    var pq = [{ x: fromX, y: fromY, d: 0 }];
    while (pq.length) {
      pq.sort(function (a, b) { return a.d - b.d; });
      var cur = pq.shift();
      var ck = key(cur.x, cur.y);
      if (done[ck]) continue;
      done[ck] = true;
      if (cur.x === toX && cur.y === toY) break;
      var dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for (var i = 0; i < 4; i++) {
        var nx = cur.x + dirs[i][0], ny = cur.y + dirs[i][1];
        if (!inWindow(exp, nx, ny)) continue;
        var stepCost = tileMoveCost(C, state, nx, ny);
        if (!isFinite(stepCost)) continue;
        var nd = cur.d + stepCost;
        var nk = key(nx, ny);
        if (dist[nk] == null || nd < dist[nk]) {
          dist[nk] = nd; prev[nk] = ck;
          pq.push({ x: nx, y: ny, d: nd });
        }
      }
    }
    var tk = key(toX, toY);
    if (dist[tk] == null) return null;
    var path = [];
    var c = tk;
    while (c) {
      var parts = c.split(',');
      path.unshift({ x: +parts[0], y: +parts[1] });
      if (c === key(fromX, fromY)) break;
      c = prev[c];
    }
    return { path: path, cost: dist[tk] };
  }
  // One Dijkstra from a member across the whole window: { 'x,y': cost }.
  // The UI lights every tile whose cost fits the member's remaining AP —
  // the selected diver's real reach this turn, not a guess.
  function reachableMap(C, state, exp, m) {
    var dist = {}, done = {};
    dist[key(m.x, m.y)] = 0;
    var pq = [{ x: m.x, y: m.y, d: 0 }];
    while (pq.length) {
      pq.sort(function (a, b) { return a.d - b.d; });
      var cur = pq.shift();
      var ck = key(cur.x, cur.y);
      if (done[ck]) continue;
      done[ck] = true;
      var dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for (var i = 0; i < 4; i++) {
        var nx = cur.x + dirs[i][0], ny = cur.y + dirs[i][1];
        if (!inWindow(exp, nx, ny)) continue;
        var stepCost = tileMoveCost(C, state, nx, ny);
        if (!isFinite(stepCost)) continue;
        var nd = cur.d + stepCost, nk = key(nx, ny);
        if (dist[nk] == null || nd < dist[nk]) { dist[nk] = nd; pq.push({ x: nx, y: ny, d: nd }); }
      }
    }
    return dist;
  }

  function gainCarried(exp, resource, amount) {
    if (amount <= 0) return;
    exp.carried[resource] = (exp.carried[resource] || 0) + amount;
  }

  // Step the active member ONE tile along a precomputed path. Movement is
  // issued stepwise so encounters interrupt the walk — the heart of the RPG.
  function moveActive(C, state, exp, toX, toY) {
    if (exp.finished) return { ok: false, reason: 'The expedition is over.' };
    if (exp.encounter) return { ok: false, reason: 'Resolve the encounter first.' };
    var m = activeMember(C, state, exp);
    if (!m) return { ok: false, reason: 'No living diver on the ground.' };
    if (m.x === toX && m.y === toY) return { ok: false, reason: 'Already there.' };
    var route = findPath(C, state, exp, m.x, m.y, toX, toY);
    if (!route) return { ok: false, reason: 'No route there.' };
    if (m.ap <= 0) {
      return { ok: false, reason: C.diverById(state, m.id).name + ' is spent — end the ground turn to refresh AP.', cost: route.cost };
    }
    exp.pendingPath = route.path.slice(1); // tiles after the current one
    exp.pendingPathFor = m.id;             // the course belongs to THIS diver
    exp.pathCost = route.cost;
    return stepAlong(C, state, exp);
  }
  function stepAlong(C, state, exp) {
    var m = activeMember(C, state, exp);
    if (!m || !exp.pendingPath || !exp.pendingPath.length) { exp.pendingPath = null; exp.pendingPathFor = null; return { ok: true, moved: false }; }
    // Per-member courses: a course plotted by one diver is never walked by
    // another. Switching the selected diver shelves their course, it does
    // not hand it over — reselect the owner and the course is still theirs.
    if (exp.pendingPathFor && exp.pendingPathFor !== m.id) { return { ok: true, moved: false, stopped: 'owner' }; }
    var next = exp.pendingPath[0];
    var cost = tileMoveCost(C, state, next.x, next.y);
    if (cost > m.ap) { return { ok: true, moved: false, stopped: 'ap' }; } // course kept — end the turn and walk on
    exp.pendingPath.shift();
    m.ap -= cost;
    m.x = next.x; m.y = next.y;
    exp.steps += 1; exp.exposure += 1;
    var d = C.diverById(state, m.id);
    var events = [];
    arriveAt(C, state, exp, m, d, events);
    reveal(C, state, exp);
    if (!exp.encounter && livingMembers(C, state, exp).length) {
      var enc = rollEncounter(C, state, exp, next.x, next.y);
      if (enc) { exp.encounter = enc; exp.pendingPath = null; exp.pendingPathFor = null; events.push('encounter:' + enc.kind); }
    }
    if (!exp.pendingPath || !exp.pendingPath.length) { exp.pendingPath = null; exp.pendingPathFor = null; }
    return { ok: true, moved: true, events: events, encounter: exp.encounter ? exp.encounter.kind : null };
  }
  function continueMove(C, state, exp) {
    if (!exp.pendingPath || !exp.pendingPath.length) return { ok: true, moved: false };
    return stepAlong(C, state, exp);
  }

  // What happens when a diver steps onto a tile: finds are gathered by
  // being there — never handed over without the walk.
  function arriveAt(C, state, exp, m, d, events) {
    var t = C.tileAt(state, m.x, m.y);
    if (!t) return;
    var k = key(m.x, m.y);
    if (exp.decoy && exp.decoy.x === m.x && exp.decoy.y === m.y) {
      exp.decoy = null;
      exp.log.push(d.name + ' digs where the tipster pointed — mud, worms, nothing. The tip was a lie.');
      events.push('decoy');
    }
    if (exp.drift[k]) {
      var dr = exp.drift[k];
      delete exp.drift[k];
      gainCarried(exp, dr.resource, dr.amount);
      exp.log.push(d.name + ' finds drift salvage: +' + dr.amount + ' ' + dr.resource + ' (carried).');
      events.push('drift');
      exp.events.push('loot');
    }
    var poiHere = C.poiAt(state, m.x, m.y);
    if (poiHere && (poiHere.fuelCells || 0) > 0 &&
      (poiHere.kind === 'building' || poiHere.kind === 'depot' || poiHere.kind === 'bunker' || poiHere.kind === 'communal')) {
      var cells = poiHere.fuelCells;
      poiHere.fuelCells = 0;
      gainCarried(exp, 'FUEL', cells);
      exp.log.push(d.name + ' lifts the cell stock at ' + poiHere.label + ': +' + cells + ' FUEL cells (carried — cargo when the lift lands). The site is picked clean.');
      events.push('cell');
      exp.events.push('coin');
    }
    if (t.resourceType && t.resourceYield > 0) {
      var haul = t.resourceYield + Math.floor(d.stats.HAUL / 2);
      gainCarried(exp, t.resourceType, haul);
      exp.log.push(d.name + ' works the ' + t.resourceType + ' node: +' + haul + ' ' + t.resourceType + ' (node ' + t.resourceYield + ' + HAUL bonus).');
      t.resourceType = null; t.resourceYield = 0;
      exp.nodesHarvested += 1;
      events.push('node');
    }
  }

  /* ---------------- interact: caches, ruins & POI objectives (1 AP) ----- */
  function poiNear(C, state, exp, m) {
    // POI objectives are worked from the POI tile or right beside it —
    // landing drift should never strand the objective one tile away.
    var spots = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];
    for (var i = 0; i < spots.length; i++) {
      var p = C.poiAt(state, m.x + spots[i][0], m.y + spots[i][1]);
      if (p) return p;
    }
    return null;
  }
  function poiGuardsAlive(exp, poi) {
    return exp.hostiles.some(function (h) { return h.kind === 'guardian' && h.poiLabel === poi.label; });
  }
  function siteAt(C, state, exp, m) {
    var t = C.tileAt(state, m.x, m.y);
    if (!t) return null;
    if (t.supplySite && !t.supplySite.looted) return { type: 'cache', tile: t };
    if (t.robotSite && !t.robotSite.cleared) return { type: 'ruin', tile: t };
    // SHIP AS HOME: a Journal page under the diver's boots outranks POI
    // work from THIS tile (step one tile over to work the site instead) —
    // otherwise pages seeded at POIs would hide behind unworked bands.
    var snipHere = (exp.snippetSites || []).filter(function (s) { return s.x === m.x && s.y === m.y; })[0];
    if (snipHere) return { type: 'snippet', snippetId: snipHere.id, tile: t };
    var poi = poiNear(C, state, exp, m);
    if (poi) {
      if (poi.kind === 'bunker' && (poi.doors || []).some(function (dr) { return dr.state === 'sealed'; })) return { type: 'door', poi: poi };
      if (poi.kind === 'communal' && (poi.workedBands || 0) < (poi.bandsTotal || C.TUNABLES.communalBands)) return { type: 'band', poi: poi };
      if (poi.kind === 'depot' && poi.state === 'standing' && !exp.depotDone) return { type: 'depot', poi: poi };
      if (poi.kind === 'graveyard' && poi.state === 'unsearched') return { type: 'graveyard', poi: poi };
      if (poi.kind === 'building' && !exp.siteWorked[poi.id]) return { type: 'building', poi: poi };
    }
    return null;
  }
  function countThingGround(state) {
    if (!state.mapProgress) state.mapProgress = { things: 0 };
    state.mapProgress.things += 1;
  }
  // Haul capacity (§13): the squad's backs. Found gear beyond the free
  // capacity (sum of living members' bound minus loadout weight) is left.
  function haulRoom(C, state, exp) {
    var room = 0;
    livingMembers(C, state, exp).forEach(function (m) {
      var d = C.diverById(state, m.id);
      if (d) room += Math.max(0, C.carryBound(d) - C.loadoutWeight(state, d));
    });
    exp.foundGear.forEach(function (f) { room -= f.kind === 'weapon' ? C.weaponWeightOf(f.name) : 0.5; });
    return room;
  }
  // Finds (§§9-10, §15): weapons climb the site-tier pools; attachments
  // skew to bunkers/Communal/vault; grenades are RARE finds, flares common.
  function maybeFindGear(C, state, exp, finder, siteTier) {
    var T = C.TUNABLES;
    var foundSomething = false;
    if (chance(C, exp.rng, T.weaponFindChance)) {
      var pool = T.weaponFindPools[siteTier] || T.weaponFindPools[2];
      var name = pool[C.rngInt(exp.rng, 0, pool.length - 1)];
      if (haulRoom(C, state, exp) >= C.weaponWeightOf(name)) {
        exp.foundGear.push({ kind: 'weapon', name: name });
        exp.log.push('WEAPON FOUND: ' + name + ' — it rides up with the lift and banks into the ship Armory.');
        exp.events.push('loot');
      } else {
        exp.leftBehind.push(name + ' (no backs for it)');
        exp.log.push('WEAPON FOUND: ' + name + ' — but the squad has no backs for it. It stays on the ground.');
      }
      foundSomething = true;
    } else if (chance(C, exp.rng, T.attachmentFindChance)) {
      var kinds = T.attachmentKinds;
      var kind = kinds[C.rngInt(exp.rng, 0, kinds.length - 1)];
      exp.foundGear.push({ kind: 'attachment', name: kind });
      exp.log.push('ATTACHMENT FOUND: ' + kind + ' — banks into the Armory for fitting.');
      exp.events.push('loot');
      foundSomething = true;
    }
    // SHIP AS HOME: trophy-class finds — rare, small, and worth a wall.
    if (chance(C, exp.rng, T.trophyFindChance)) {
      var trophyPool = ['a brass ITC key, heavy as sin', 'a pre-Collapse admiral\'s compass', 'a child\'s tin rocket, unrusted by the years', 'a sealed jar of real coffee, older than the ship'];
      var tname = trophyPool[C.rngInt(exp.rng, 0, trophyPool.length - 1)];
      exp.trophyFinds.push(tname);
      exp.log.push('TROPHY FOUND: ' + tname + ' — not scrap, not stores. This belongs on a wall (banks at the lift).');
      exp.events.push('loot');
      foundSomething = true;
    }
    if (chance(C, exp.rng, T.grenadeFindChance)) {
      var gtype = ['frag', 'flash', 'conc'][C.rngInt(exp.rng, 0, 2)];
      exp.foundStock[gtype] = (exp.foundStock[gtype] || 0) + 1;
      exp.log.push('GRENADE FOUND: +1 ' + gtype + ' — scarce gold. It banks into the Armory pool at the lift if it survives the walk.');
      foundSomething = true;
    } else if (chance(C, exp.rng, T.flareFindChance)) {
      exp.shipFlares += 1;
      exp.log.push('FLARES FOUND: +1 flare for the drop bag (ship-standard, always welcome).');
      foundSomething = true;
    }
    return foundSomething;
  }
  function workPoi(C, state, exp, m, d, site, cost) {
    var T = C.TUNABLES;
    var poi = site.poi;
    if ((site.type === 'door' || site.type === 'band' || site.type === 'depot') && poiGuardsAlive(exp, poi)) {
      return { ok: false, reason: 'The dormant machines still hold ' + poi.label + ' — clear them first (FIRE), or leave them sleeping and walk away.' };
    }
    m.ap -= (cost == null ? TUN.costInteract : cost);
    if (site.type === 'door') {
      var door = poi.doors.filter(function (dr) { return dr.state === 'sealed'; })[0];
      door.state = 'opened';
      Object.keys(door.yield || {}).forEach(function (k) { gainCarried(exp, k, door.yield[k]); });
      exp.log.push(d.name + ' opens the ' + door.label + ' door at ' + poi.label + '.' +
        (Object.keys(door.yield || {}).length ? ' Inside, for the balloons: ' + JSON.stringify(door.yield) + '.' : ''));
      if (door.key === 'cryo') {
        exp.cryoFound = { label: poi.label, capsules: door.capsules || 0 };
        exp.log.push('CRYO: ' + (door.capsules || 0) + ' capsules still cold behind the cryogenics door — their sleepers can be woken from the Crew screen.');
      }
      exp.events.push('door');
      exp.cachesLooted += 1; exp.poiWorked = true;
      countThingGround(state);
      maybeFindGear(C, state, exp, d, 2);
      return { ok: true, looted: 'door' };
    }
    if (site.type === 'band') {
      poi.workedBands = (poi.workedBands || 0) + 1;
      var bandNo = poi.workedBands;
      gainCarried(exp, 'SCRAP', T.communalBandScrap);
      gainCarried(exp, 'INTEL', T.communalBandIntel);
      exp.log.push(d.name + ' works floor band ' + bandNo + ' of ' + (poi.bandsTotal || T.communalBands) + ' at ' + poi.label +
        ': +' + T.communalBandScrap + ' SCRAP, +' + T.communalBandIntel + ' INTEL carried. The silo goes down and down.');
      if (bandNo === T.communalSeedBand && !poi.seedBankTaken) {
        poi.seedBankTaken = true;
        gainCarried(exp, 'FOOD', T.communalSeedFood);
        exp.log.push('SEED BANK: the silo seed bank, intact — +' + T.communalSeedFood + ' FOOD carried.');
      }
      if (bandNo === T.communalAiBand && !state.campaign.aiFound) {
        state.campaign.aiFound = true;
        state.campaign.fragments.ai = true;
        state.campaign.revealSeen = true;
        exp.fragmentEarned = 'ai';
        exp.events.push('fragment');
        exp.log.push('THE VOICE IN THE SILO: the facility intelligence is still running — and it has been waiting to tell someone what the things on the surface ARE. (Chart fragment: the AI fragment.)');
      }
      if (bandNo === T.communalCryoBand && !poi.cryoReached) {
        poi.cryoReached = true;
        exp.cryoFound = { label: poi.label, capsules: (poi.cryoBay && poi.cryoBay.capsules) || 0 };
        exp.log.push('CRYO BAY: ' + exp.cryoFound.capsules + ' capsules still functioning in the loading bay — sleepers can be woken from the Crew screen.');
      }
      exp.events.push('device');
      exp.cachesLooted += 1; exp.poiWorked = true;
      countThingGround(state);
      maybeFindGear(C, state, exp, d, bandNo >= T.communalAiBand ? 3 : 2);
      return { ok: true, looted: 'band' };
    }
    if (site.type === 'depot') {
      var meanHaul = exp.members.reduce(function (a, mm) { var dd = C.diverById(state, mm.id); return a + (dd ? dd.stats.HAUL : 0); }, 0) / Math.max(1, exp.members.length);
      var dFull = 10 + Math.floor(meanHaul / 2);
      gainCarried(exp, 'SCRAP', dFull);
      gainCarried(exp, 'INTEL', 4);
      exp.depotDone = true;
      exp.log.push(d.name + ' works the Tech Depot: +' + dFull + ' SCRAP and pre-Burn tech (+4 INTEL) for the balloons.');
      exp.events.push('loot');
      exp.cachesLooted += 1; exp.poiWorked = true;
      countThingGround(state);
      maybeFindGear(C, state, exp, d, 4); // the ITC vault tier
      return { ok: true, looted: 'depot' };
    }
    if (site.type === 'graveyard') {
      poi.state = 'searched';
      gainCarried(exp, 'SCRAP', T.graveyardScrap);
      exp.log.push(d.name + ' picks the graveyard at ' + poi.label + ': +' + T.graveyardScrap + ' SCRAP from the remains. Nothing in this field fights back.');
      exp.events.push('loot');
      exp.cachesLooted += 1; exp.poiWorked = true;
      return { ok: true, looted: 'graveyard' };
    }
    // building: work the standing site itself (salvage + any cell stock was
    // already lifted on arrival by walking the tile).
    exp.siteWorked[poi.id] = true;
    var scrap = C.rngInt(exp.rng, 3, 6);
    gainCarried(exp, 'SCRAP', scrap);
    exp.log.push(d.name + ' works ' + poi.label + ': +' + scrap + ' SCRAP of standing salvage carried.');
    exp.events.push('loot');
    exp.cachesLooted += 1; exp.poiWorked = true;
    countThingGround(state);
    return { ok: true, looted: 'building' };
  }
  function interact(C, state, exp) {
    if (exp.finished) return { ok: false, reason: 'The expedition is over.' };
    if (exp.encounter) return { ok: false, reason: 'Resolve the encounter first.' };
    var m = activeMember(C, state, exp);
    if (!m) return { ok: false, reason: 'No living diver.' };
    var site = siteAt(C, state, exp, m);
    if (!site) return { ok: false, reason: 'Nothing here to work — caches, ruins and site objectives (doors, bands, depots) are worked from their tile or right beside it.' };
    if (site.type === 'snippet') {
      // SHIP AS HOME: read the page into the Journal — verbatim, sourced.
      if (m.ap < 1) return { ok: false, reason: 'Reading the page costs 1 AP.' };
      m.ap -= 1;
      var sdef = C.snippetDef(site.snippetId);
      var placePoi = C.poiAt(state, exp.target.x, exp.target.y);
      var got = C.collectSnippet(state, site.snippetId, placePoi ? placePoi.label : 'open ground');
      exp.snippetSites = exp.snippetSites.filter(function (s) { return s.id !== site.snippetId; });
      if (got.ok) {
        var prog = C.journalProgress(state);
        exp.log.push('JOURNAL — ' + sdef.group + ': "' + sdef.text + '" (' + sdef.source + '). Filed — ' + prog.found + ' of ' + prog.total + ' pages.');
        exp.events.push('snippet');
      }
      return { ok: true, looted: 'snippet', snippet: sdef ? sdef.id : null };
    }
    if (site.poi) {
      var dd = C.diverById(state, m.id);
      var cost = C.ensureArchetype(dd) === 'ENGINEER' ? 0 : TUN.costInteract; // Engineer: systems are their trade (§9)
      if (m.ap < cost) return { ok: false, reason: 'Working the site costs ' + cost + ' AP.' };
      return workPoi(C, state, exp, m, dd, site, cost);
    }
    if (m.ap < TUN.costInteract) return { ok: false, reason: 'Working the site costs ' + TUN.costInteract + ' AP.' };
    var d = C.diverById(state, m.id);
    var t = site.tile;
    if (site.type === 'ruin' && exp.hostiles.some(function (h) { return h.kind === 'guardian'; })) {
      return { ok: false, reason: 'The machine guardians still hold ' + t.robotSite.name + ' — clear them first (FIRE).' };
    }
    m.ap -= TUN.costInteract;
    if (site.type === 'cache') {
      var roll = C.rngInt(exp.rng, 1, 20);
      var total = roll + d.stats.GRIT;
      var dc = TUN.cacheDCBase + t.threat;
      if (total >= dc) {
        var amt = t.supplySite.amount + Math.floor(d.stats.HAUL / 2);
        gainCarried(exp, t.supplySite.resource, amt);
        exp.log.push(d.name + ' cracks ' + t.supplySite.name + ' (GRIT roll ' + roll + '+' + d.stats.GRIT + ' vs ' + dc + '): +' + amt + ' ' + t.supplySite.resource + ' carried. The cache is emptied.');
        t.supplySite.looted = true;
        exp.cachesLooted += 1;
        return { ok: true, looted: 'cache' };
      }
      exp.log.push(d.name + ' works ' + t.supplySite.name + ' and the ground answers (GRIT roll ' + roll + '+' + d.stats.GRIT + ' vs ' + dc + ' — short).');
      woundMember(C, state, exp, d, 'Cache guard at ' + t.supplySite.name);
      return { ok: true, looted: null };
    }
    // ruin vault (guardians already cleared)
    var rroll = C.rngInt(exp.rng, 1, 20);
    var rtotal = rroll + d.stats.AIM;
    if (rtotal >= TUN.ruinDC) {
      gainCarried(exp, 'SCRAP', t.robotSite.scrap);
      gainCarried(exp, 'INTEL', t.robotSite.intel);
      exp.log.push(d.name + ' rushes the vault of ' + t.robotSite.name + ' (AIM roll ' + rroll + '+' + d.stats.AIM + ' vs ' + TUN.ruinDC + '): +' +
        t.robotSite.scrap + ' SCRAP, +' + t.robotSite.intel + ' INTEL — pre-Burn machine tech, the richest haul in the sector.');
      t.robotSite.cleared = true;
      exp.cachesLooted += 1;
      maybeFindGear(C, state, exp, d, 3);
      return { ok: true, looted: 'ruin' };
    }
    exp.log.push(d.name + ' rushes ' + t.robotSite.name + ' and is driven back (AIM roll ' + rroll + '+' + d.stats.AIM + ' vs ' + TUN.ruinDC + ').');
    woundMember(C, state, exp, d, 'Ruin defenses at ' + t.robotSite.name);
    return { ok: true, looted: null };
  }

  /* ---------------- fire: weapons in the turn structure ----------------- */
  function damageHostile(C, state, exp, h, dmg, killerName, how) {
    h.hp -= dmg;
    if (h.hp <= 0) {
      exp.hostiles = exp.hostiles.filter(function (x) { return x !== h; });
      exp.suppressed += 1;
      exp.events.push('kill:' + (h.cls || h.kind));
      if (h.guardRef) {
        h.guardRef.active = false;
        exp.log.push('MACHINES DOWN: the ' + h.name + ' guarding ' + (h.poiLabel || 'the site') + ' goes dark for good.');
        exp.events.push('door');
      }
      if (h.apexId) {
        // SHIP AS HOME: the apex falls — its skull is claimed at the lift.
        exp.apexKilled = h.apexId;
        exp.log.push('THE APEX FALLS: ' + killerName + ' brings down the marked apex. Its skull is the squad\'s now — get it to the lift.');
        exp.events.push('fragment');
      }
      exp.log.push(killerName + ' destroys the ' + h.name + (how ? ' (' + how + ')' : '') + '.');
      return true;
    }
    exp.log.push('The ' + h.name + ' takes the hit (' + h.hp + ' hp left).');
    return false;
  }
  function fireAt(C, state, exp, hostileId) {
    if (exp.finished) return { ok: false, reason: 'The expedition is over.' };
    if (exp.encounter) return { ok: false, reason: 'Resolve the encounter first.' };
    var m = activeMember(C, state, exp);
    if (!m) return { ok: false, reason: 'No living diver.' };
    var h = exp.hostiles.filter(function (x) { return x.id === hostileId; })[0];
    if (!h) return { ok: false, reason: 'No such target.' };
    var d = C.diverById(state, m.id);
    var arch = C.ensureArchetype(d);
    var apCost = arch === 'SNIPER' ? C.TUNABLES.sniperFireApCost : TUN.costFire; // §11 set-up beat
    if (m.ap < apCost) return { ok: false, reason: 'Firing costs ' + apCost + ' AP for ' + d.name + '.' };
    var dist = Math.hypot(h.x - m.x, h.y - m.y);
    var prof = C.effectiveProfile(state, d, m.slot || 'primary', dist);
    if (dist > prof.range) return { ok: false, reason: 'Out of range for the ' + prof.weapon + ' (' + dist.toFixed(1) + ' > ' + prof.range + ') — close in or switch shooters.' };
    if (!exp.seen[key(h.x, h.y)]) return { ok: false, reason: 'No line of sight — it is outside the squad sight.' };
    m.ap -= apCost;
    var roll = C.rngInt(exp.rng, 1, 20);
    var total = roll + d.stats.AIM;
    var dc = TUN.fireDCBase + h.menace + (prof.dcMod || 0);
    if (exp.dark && !memberLit(exp, m) && dist > 2) dc += 2;      // §15-ext: shooting blind in the dark
    if (arch === 'SNIPER' && exp.ecology.archetype === 'interior') dc += 2; // §11: snipers suffer indoors
    exp.events.push('fire');
    if (roll === 20 || total >= dc) {
      var dmg = prof.dmg + (arch === 'SNIPER' ? C.TUNABLES.sniperDmgBonus : 0) + (roll === 20 ? 1 : 0);
      var killed = damageHostile(C, state, exp, h, dmg,
        d.name + ' fires the ' + prof.weapon + (roll === 20 ? ' — a perfect shot' : '') +
        ' (AIM roll ' + roll + '+' + d.stats.AIM + ' vs ' + dc + ')', dmg + ' damage');
      exp.events.push(killed ? 'kill' : 'firehit');
      return { ok: true, hit: true, killed: killed, weapon: prof.weapon };
    }
    exp.log.push(d.name + ' fires the ' + prof.weapon + ' and misses the ' + h.name + ' (AIM roll ' + roll + '+' + d.stats.AIM + ' vs ' + dc + ').');
    exp.events.push('firemiss');
    return { ok: true, hit: false, killed: false, weapon: prof.weapon };
  }
  function swapWeapon(C, state, exp) {
    var m = activeMember(C, state, exp);
    if (!m) return { ok: false, reason: 'No living diver.' };
    if (m.ap < 1) return { ok: false, reason: 'Swapping weapons costs 1 AP.' };
    m.ap -= 1;
    m.slot = m.slot === 'secondary' ? 'primary' : 'secondary';
    var d = C.diverById(state, m.id);
    var w = C.effectiveWeapon(state, d, m.slot);
    exp.log.push(d.name + ' swaps to the ' + w.name + ' (' + m.slot + ').');
    exp.events.push('select');
    return { ok: true, slot: m.slot, weapon: w.name };
  }
  // §15-ext: per-diver light toggle — free, instant, the trade is yours.
  function toggleLight(C, state, exp, id) {
    var m = memberOf(exp, id || exp.activeId);
    if (!m) return { ok: false, reason: 'No such diver.' };
    if (!m.hasLight) return { ok: false, reason: C.diverById(state, m.id).name + ' carries no light source (fit a weapon light at the Armory, or assign a tac light).' };
    m.lightOn = !m.lightOn;
    reveal(C, state, exp);
    exp.log.push(C.diverById(state, m.id).name + ' switches their light ' + (m.lightOn ? 'ON — sight restored, but light draws Sirens' : 'OFF — dark and quiet') + '.');
    exp.events.push('select');
    return { ok: true, lightOn: m.lightOn };
  }
  // Throw stock for a member: their pool pack first (scarce), then kit
  // flares / ship flares. Grenade types never come from kit (§10 calib.).
  function throwStock(C, state, exp, m, type) {
    if (type === 'flare') {
      return (m.kitThrows.flare || 0) + (exp.shipFlares || 0);
    }
    return (m.pack[type] || 0) + (exp.foundStock[type] || 0);
  }
  function consumeThrow(C, state, exp, m, type) {
    if (type === 'flare') {
      if ((m.kitThrows.flare || 0) > 0) { m.kitThrows.flare -= 1; return 'kit'; }
      exp.shipFlares -= 1; return 'ship';
    }
    if ((m.pack[type] || 0) > 0) { m.pack[type] -= 1; return 'pack'; }
    exp.foundStock[type] -= 1; return 'found';
  }
  /* ---------------- THROW (§10): frag / flash / concussion / flare ------ */
  function throwAt(C, state, exp, type, toX, toY) {
    if (exp.finished) return { ok: false, reason: 'The expedition is over.' };
    if (exp.encounter) return { ok: false, reason: 'Resolve the encounter first.' };
    var m = activeMember(C, state, exp);
    if (!m) return { ok: false, reason: 'No living diver.' };
    var d = C.diverById(state, m.id);
    var arch = C.ensureArchetype(d);
    if (throwStock(C, state, exp, m, type) <= 0) {
      return { ok: false, reason: d.name + ' has no ' + type + ' left — grenades come from the Armory pool (scarce), flares are ship-standard.' };
    }
    if (m.ap < C.TUNABLES.throwApCost) return { ok: false, reason: 'Throwing costs ' + C.TUNABLES.throwApCost + ' AP.' };
    var range = arch === 'EXPLOSIVES' ? C.TUNABLES.throwRangeExplosives : C.TUNABLES.throwRange;
    var dist = Math.hypot(toX - m.x, toY - m.y);
    if (dist > range) return { ok: false, reason: 'Too far to throw (' + dist.toFixed(1) + ' > ' + range + ').' };
    if (!inWindow(exp, toX, toY)) return { ok: false, reason: 'Outside the ground window.' };
    m.ap -= C.TUNABLES.throwApCost;
    var source = consumeThrow(C, state, exp, m, type);
    var hitList = [];
    function inRadius(h, r) { return Math.abs(h.x - toX) + Math.abs(h.y - toY) <= r; }
    if (type === 'flare') {
      exp.flares.push({ x: toX, y: toY, turns: C.TUNABLES.flareTurns });
      exp.log.push(d.name + ' pops a flare at ' + tileLabel(C, toX, toY) + ' — burning light. Sirens will not enter it (flare-shy, book-canon); it burns ' + C.TUNABLES.flareTurns + ' ground turns.');
      exp.events.push('flare');
      reveal(C, state, exp);
      return { ok: true, thrown: 'flare', source: source };
    }
    if (type === 'frag') {
      exp.events.push('explosion');
      exp.hostiles.slice().forEach(function (h) {
        if (inRadius(h, 1)) { hitList.push(h.name); damageHostile(C, state, exp, h, C.TUNABLES.fragDamage, d.name + ' frags', 'frag grenade, ' + C.TUNABLES.fragDamage + ' damage'); }
      });
      exp.log.push(d.name + ' throws a frag into ' + tileLabel(C, toX, toY) + (hitList.length ? ' — it lands among: ' + hitList.join(', ') + '.' : ' — empty ground. A scarce grenade, spent on dirt.'));
      return { ok: true, thrown: 'frag', source: source, hits: hitList.length };
    }
    if (type === 'flash') {
      exp.events.push('flash');
      exp.hostiles.slice().forEach(function (h) {
        if (!inRadius(h, 2)) return;
        hitList.push(h.name);
        if (h.kind === 'swarm') {
          // Deterrent logic weaponized: Sirens break and fall back.
          h.stunTurns = Math.max(h.stunTurns || 0, 1);
          var dx = Math.sign(h.x - toX), dy = Math.sign(h.y - toY);
          for (var s = 0; s < 2; s++) {
            var nx = h.x + dx, ny = h.y + dy;
            var nt = C.tileAt(state, nx, ny);
            if (nt && nt.terrain !== 'water' && inWindow(exp, nx, ny)) { h.x = nx; h.y = ny; }
          }
        } else if (h.kind === 'scavenger' || h.kind === 'turret') {
          h.stunTurns = Math.max(h.stunTurns || 0, 1); // human eyes and ears
        }
      });
      exp.log.push(d.name + ' throws a flashbang — light and sound as a weapon. ' + (hitList.length ? 'Caught: ' + hitList.join(', ') + ' (Sirens driven back, stunned).' : 'Nothing in the burst.'));
      return { ok: true, thrown: 'flash', source: source, hits: hitList.length };
    }
    // concussion: stagger + damage; echo bonus in interiors (§7 logic).
    exp.events.push('explosion');
    var interior = exp.ecology.archetype === 'interior';
    var radius = interior ? 2 : 1;
    var dmg = interior ? 2 : 1;
    exp.hostiles.slice().forEach(function (h) {
      if (!inRadius(h, radius)) return;
      hitList.push(h.name);
      h.stunTurns = Math.max(h.stunTurns || 0, 1);
      damageHostile(C, state, exp, h, dmg, d.name + ' concusses', 'concussion grenade' + (interior ? ' — the halls double it' : ''));
    });
    exp.log.push(d.name + ' throws a concussion grenade' + (interior ? ' — indoors, the echo makes it twice the weapon.' : '.') + (hitList.length ? ' Staggered: ' + hitList.join(', ') + '.' : ' Empty ground.'));
    return { ok: true, thrown: 'conc', source: source, hits: hitList.length, interiorBonus: interior };
  }

  /* ---------------- hostile spawning ------------------------------------ */
  function spawnHostiles(C, state, exp, kind, cx, cy, n, menaceBonus) {
    var made = [];
    for (var i = 0; i < n; i++) {
      var spot = null;
      for (var tries = 0; tries < 24 && !spot; tries++) {
        var ang = C.rngNext(exp.rng) * Math.PI * 2;
        var rad = 2 + C.rngInt(exp.rng, 0, 1);
        var hx = clamp(Math.round(cx + Math.cos(ang) * rad), exp.win.x0, exp.win.x0 + 12);
        var hy = clamp(Math.round(cy + Math.sin(ang) * rad), exp.win.y0, exp.win.y0 + 12);
        var ht = C.tileAt(state, hx, hy);
        if (ht && ht.terrain !== 'water' && !exp.hostiles.some(function (o) { return o.x === hx && o.y === hy; })) spot = { x: hx, y: hy };
      }
      if (!spot) spot = { x: cx, y: cy };
      var tile = C.tileAt(state, spot.x, spot.y);
      var menace = clamp((tile ? tile.threat : 2) - 2 + (menaceBonus || 0), 0, 3);
      exp.nextHostileSeq += 1;
      var h = {
        id: 'hostile-' + exp.nextHostileSeq, kind: kind, name: HOSTILE_NAMES[kind] || kind,
        x: spot.x, y: spot.y, hp: 2 + menace, maxHp: 2 + menace, menace: menace, stunTurns: 0
      };
      if (kind === 'plant') {
        h.cls = null; h.name = 'carnivorous glow-plant';
        h.hp = h.maxHp = 3; h.menace = 1; h.speed = 0; // rooted (§8)
      } else if (kind === 'swarm') {
        var eco = exp.ecology || { archetype: 'open', storm: false, weights: SIREN_ECOLOGY.open.weights };
        var draw = C.rngNext(exp.rng);
        var cls = draw < eco.weights.melee ? 'melee' : (draw < eco.weights.melee + eco.weights.ranged ? 'ranged' : 'flying');
        h.cls = cls;
        h.name = SIREN_CLASS_NAMES[cls] + (exp.ecology && exp.ecology.tier === 'red' && menaceBonus ? ' (apex)' : '');
        h.hp = h.maxHp = cls === 'melee' ? 2 + menace : 1 + menace; // shriekers and fliers are frailer
        h.speed = sirenClassSpeed(cls, eco.archetype, eco.storm);
      } else {
        h.cls = null;
        h.speed = kind === 'guardian' ? 2 : 3;
      }
      exp.hostiles.push(h);
      made.push(h);
    }
    // Humans employ war machines (§8): a raider force above the threat
    // threshold can field a crewed turret truck — never at guardian POIs.
    if (kind === 'scavenger' && made.length && !exp.turretSpawned) {
      var tier = exp.ecology ? exp.ecology.tier : 'green';
      if (tier === 'red' || (tier === 'yellow' && chance(C, exp.rng, 0.5))) {
        exp.turretSpawned = true;
        exp.nextHostileSeq += 1;
        var th = {
          id: 'hostile-' + exp.nextHostileSeq, kind: 'turret', cls: null, name: 'crewed turret truck',
          x: cx, y: cy, hp: 6, maxHp: 6, menace: 3, speed: 1, stunTurns: 0
        };
        exp.hostiles.push(th);
        made.push(th);
        exp.log.push('The raiders roll up a crewed turret truck — armored, heavy guns, the anchor of their force.');
        exp.events.push('raid');
      }
    }
    return made;
  }

  /* ---------------- encounters ------------------------------------------ */
  function rollEncounter(C, state, exp, x, y) {
    if (exp.steps <= TUN.graceSteps) return null;
    var t = C.tileAt(state, x, y);
    var threat = t ? t.threat : 0;
    var p = TUN.encounterBase + TUN.encounterPerThreat * threat + TUN.encounterPerStep * exp.exposure + exp.dangerPlus;
    // §15-ext THE TRADE: burning lights draw Sirens from beyond sight
    // (they hunt energy signatures); a suppressed weapon walks quieter.
    var litCount = exp.members.filter(function (m) { return memberLit(exp, m); }).length;
    p += 0.03 * litCount;
    var am = activeMember(C, state, exp);
    if (am) {
      var ad = C.diverById(state, am.id);
      if (ad && C.effectiveProfile(state, ad, am.slot || 'primary').suppressed) p *= 0.7;
    }
    if (!chance(C, exp.rng, p)) return null;
    // Proximity law: near an uncleared ruin, the guardians stir — often.
    var ruinNear = null;
    for (var wy = exp.win.y0; wy < exp.win.y0 + 13 && !ruinNear; wy++) {
      for (var wx = exp.win.x0; wx < exp.win.x0 + 13; wx++) {
        var rt = C.tileAt(state, wx, wy);
        if (rt && rt.robotSite && !rt.robotSite.cleared && Math.abs(wx - x) + Math.abs(wy - y) <= 3) { ruinNear = rt; break; }
      }
    }
    var table = [];
    function add(kindW, w) { if (w > 0) table.push({ kind: kindW, w: w }); }
    add('danger', 26 + 4 * threat);
    add('glint', 14);
    if (exp.counts.tipster < 2) add('tipster', 13);
    if (exp.counts.trader < 1) add('trader', 11);
    if (exp.counts.survivor < 1) add('survivor', 9);
    if (exp.counts.scavengers < 2) add('scavengers', 9);
    if (exp.storm > 0.2 && exp.counts.weather < 1) add('weather', 7);
    if (ruinNear) add('guardian', 20);
    var totalW = table.reduce(function (a, e) { return a + e.w; }, 0);
    var pick = C.rngNext(exp.rng) * totalW, kindW = table[0].kind;
    for (var i = 0; i < table.length; i++) { pick -= table[i].w; if (pick <= 0) { kindW = table[i].kind; break; } }
    return buildEncounter(C, state, exp, kindW, x, y, ruinNear);
  }

  function buildEncounter(C, state, exp, kindW, x, y, ruinNear) {
    var rng = exp.rng;
    if (kindW === 'danger') {
      exp.counts.danger += 1;
      var n = 2 + (chance(C, rng, 0.45) ? 1 : 0) + (chance(C, rng, 0.3) ? 1 : 0);
      var made = spawnHostiles(C, state, exp, 'swarm', x, y, n, 0);
      exp.log.push('CONTACT: Sirens boil up — ' + made.length + ' strong — weapons free. They move when your turn ends.');
      exp.events.push('siren-attack');
      return {
        kind: 'danger', title: '⚔ CONTACT — SIRENS',
        text: 'The threat of this ground, made real: ' + made.length + ' Sirens boil out of cover at the squad — rushers close and bite, shriekers hang back and scream, fliers stoop from above. ' + (exp.ecology ? exp.ecology.line + ' ' : '') + 'FIRE costs AP by weapon; they act when the ground turn ends.',
        choices: [{ id: 'fight', label: 'Weapons free', sub: 'Fight it out in the turn structure', cost: 0 }]
      };
    }
    if (kindW === 'guardian') {
      exp.counts.guardian += 1;
      var made2 = spawnHostiles(C, state, exp, 'guardian', ruinNear.x, ruinNear.y, 1 + (chance(C, rng, 0.4) ? 1 : 0), 1);
      exp.log.push('CONTACT: the dormant machine guardians of ' + ruinNear.name + ' stir — war machines left armed by a dead world. They do not negotiate.');
      return {
        kind: 'guardian', title: '⚔ THE GUARDIANS STIR — ' + ruinNear.name,
        text: made2.length + ' machine guardian' + (made2.length > 1 ? 's' : '') + ' unfold from the ruin, weapons hot. Clear them and the vault can be worked (INTERACT on the ruin tile).',
        choices: [{ id: 'fight', label: 'Weapons free', sub: 'Fight it out in the turn structure', cost: 0 }]
      };
    }
    if (kindW === 'glint') {
      var res = ['SCRAP', 'FOOD', 'FUEL', 'INTEL'][C.rngInt(rng, 0, 3)];
      var amt = res === 'INTEL' ? C.rngInt(rng, 1, 2) : C.rngInt(rng, 2, 5);
      gainCarried(exp, res, amt);
      exp.log.push('A glint in the mud: +' + amt + ' ' + res + ' carried. The ground provides, sometimes.');
      return null; // instant find — never pauses the walk
    }
    if (kindW === 'tipster') {
      exp.counts.tipster += 1;
      var name = TIPSTER_NAMES[C.rngInt(rng, 0, TIPSTER_NAMES.length - 1)];
      var lie = chance(C, rng, 0.2);
      exp.log.push('A figure peels out of the murk: ' + name + ', who sells what they hear.');
      return {
        kind: 'tipster', title: '🕯 A TIPSTER — ' + name, name: name, lie: lie,
        text: name + ' trades in what the murk whispers. Talking costs the active diver ' + TUN.costTalk + ' AP per deal. The ship wires payment from stores.',
        choices: [
          { id: 'tip-sites', label: 'Buy the good word — where is everything?', sub: '4 SCRAP · marks every cache, node and ruin in this ground', cost: TUN.costTalk, price: { SCRAP: 4 } },
          { id: 'tip-threats', label: 'Ask what is hunting here', sub: 'Free if the active diver NERVE carries it · exact threats, whole ground', cost: TUN.costTalk },
          { id: 'tip-rich', label: 'Where is the ONE rich spot?', sub: '3 SCRAP · a marked spot — tipsters have been known to lie', cost: TUN.costTalk, price: { SCRAP: 3 } },
          { id: 'leave', label: 'Walk away', sub: 'No charge', cost: 0 }
        ]
      };
    }
    if (kindW === 'trader') {
      exp.counts.trader += 1;
      var tname = TRADER_NAMES[C.rngInt(rng, 0, TRADER_NAMES.length - 1)];
      var wares = buildWares(C, exp);
      exp.log.push('A lantern bobs closer: ' + tname + ', black-market, cash-and-carry, no questions.');
      return {
        kind: 'trader', title: '🏮 BLACK-MARKET — ' + tname, name: tname, wares: wares, haggled: false,
        text: tname + ' sells off a hand-cart under a tarpaulin, running goods between Harborlight Anchorage, Cinder Hollow and The Vigil — the radio markets, at ground level. Shady rates — but the goods are real, and walking away is always free. Goods land in the carried haul; payment comes off what the squad carries first, then the ship stores.',
        choices: wares.map(function (w, i) {
          return { id: 'buy-' + i, label: w.label, sub: 'Pay ' + fmtCost(w.want) + ' → ' + fmtCost(w.give) + (w.heal ? ' (field aid)' : ''), cost: TUN.costTalk, ware: i };
        }).concat([
          { id: 'haggle', label: 'Haggle', sub: 'NERVE check · success: prices drop a quarter', cost: TUN.costTalk },
          { id: 'leave', label: 'Walk away', sub: 'No charge', cost: 0 }
        ])
      };
    }
    if (kindW === 'survivor') {
      exp.counts.survivor += 1;
      var who = SURVIVOR_NAMES[C.rngInt(rng, 0, SURVIVOR_NAMES.length - 1)];
      exp.log.push('A voice from a ditch: ' + who + ', alive, hungry, and full of local knowledge.');
      return {
        kind: 'survivor', title: '✋ A SURVIVOR — ' + who, who: who,
        text: who + ' has been living off this ground and knows where its teeth are. Feed them and they will talk.',
        choices: [
          { id: 'feed', label: 'Share rations', sub: '3 FOOD · they map the ground around you (sight +marks)', cost: TUN.costTalk, price: { FOOD: 3 } },
          { id: 'leave', label: 'Leave them to the murk', sub: 'No charge · the ground feels longer after', cost: 0 }
        ]
      };
    }
    if (kindW === 'scavengers') {
      exp.counts.scavengers += 1;
      exp.log.push('A rival raiding party steps out of the murk, hands near their gear. This ground is not big enough for everyone — and out here, nothing is scripted.');
      return {
        kind: 'scavengers', title: '⚖ A RIVAL RAIDING PARTY',
        text: 'Another raiding party, working the same ground unscripted, deciding what you are. Talk, posture, or walk wide — talking costs the active diver ' + TUN.costTalk + ' AP.',
        choices: [
          { id: 'parley', label: 'Parley', sub: 'NERVE check · success: they mark a cache for you', cost: TUN.costTalk },
          { id: 'driveoff', label: 'Drive them off', sub: 'AIM check · success: they drop loot and run', cost: TUN.costTalk },
          { id: 'leave', label: 'Walk wide', sub: 'No charge', cost: 0 }
        ]
      };
    }
    if (kindW === 'weather') {
      exp.counts.weather += 1;
      exp.log.push('The weather closes in — the same storm system that rules the map, now at ground level.');
      return {
        kind: 'weather', title: '⛈ THE WEATHER CLOSES IN',
        text: 'Rain hammers the murk flat and the light goes. Push on half-blind, or call the lift while the ship can still find you.',
        choices: [
          { id: 'pushon', label: 'Push on through it', sub: 'Sight −1 for the rest of the expedition · the ground gets meaner', cost: 0 },
          { id: 'extract-now', label: 'Call the lift NOW', sub: 'End the expedition with what you carry', cost: 0 }
        ]
      };
    }
    return null;
  }

  var WARE_POOL = [
    { label: 'A drum of real fuel', give: { FUEL: 6 }, want: { SCRAP: 8 } },
    { label: 'Ration crates, colony-sealed', give: { FOOD: 8 }, want: { SCRAP: 6 } },
    { label: 'Salvage bundle, unsorted', give: { SCRAP: 9 }, want: { FOOD: 6 } },
    { label: 'A pre-Burn medkit', give: {}, want: { SCRAP: 6 }, heal: 1 },
    { label: 'Charts of the old roads (INTEL)', give: { INTEL: 4 }, want: { FOOD: 5 } },
    { label: 'Sell your spare fuel', give: { SCRAP: 10 }, want: { FUEL: 6 } }
  ];
  function buildWares(C, exp) {
    var a = C.rngInt(exp.rng, 0, WARE_POOL.length - 1);
    var b = (a + 1 + C.rngInt(exp.rng, 0, WARE_POOL.length - 2)) % WARE_POOL.length;
    return [clone(WARE_POOL[a]), clone(WARE_POOL[b])];
  }
  function fmtCost(c) {
    return Object.keys(c).map(function (k) { return c[k] + ' ' + k; }).join(' + ') || 'nothing';
  }
  // Pay from the carried haul first, then ship stores (state.resources).
  function canPay(C, state, exp, price) {
    for (var k in price) {
      if ((exp.carried[k] || 0) + state.resources[k] < price[k]) return false;
    }
    return true;
  }
  function payPools(C, state, exp, price) {
    for (var k in price) {
      var fromCarried = Math.min(exp.carried[k] || 0, price[k]);
      exp.carried[k] = (exp.carried[k] || 0) - fromCarried;
      if (exp.carried[k] <= 0) delete exp.carried[k];
      state.resources[k] -= (price[k] - fromCarried);
    }
  }
  function bestStat(C, state, exp, stat) {
    var best = 0;
    livingMembers(C, state, exp).forEach(function (m) {
      var d = C.diverById(state, m.id);
      if (d) best = Math.max(best, d.stats[stat]);
    });
    return best;
  }

  // Resolve a choice on the pending encounter. Choices are the game —
  // never pre-rolled report lines.
  function choose(C, state, exp, choiceId) {
    var enc = exp.encounter;
    if (!enc) return { ok: false, reason: 'No encounter is waiting.' };
    var choice = enc.choices.filter(function (c) { return c.id === choiceId; })[0];
    if (!choice) return { ok: false, reason: 'No such choice.' };
    var m = activeMember(C, state, exp);
    var d = m ? C.diverById(state, m.id) : null;
    if (choice.cost > 0) {
      if (!m) return { ok: false, reason: 'No living diver to act.' };
      if (m.ap < choice.cost) return { ok: false, reason: d.name + ' needs ' + choice.cost + ' AP to do that (' + m.ap + ' left). Pick someone fresher or end the turn.' };
    }
    if (choice.price && !canPay(C, state, exp, choice.price)) {
      return { ok: false, reason: 'Cannot cover ' + fmtCost(choice.price) + ' from the haul + stores.' };
    }
    if (choice.cost > 0) m.ap -= choice.cost;
    var rng = exp.rng;

    function close(result) {
      exp.encounter = null;
      reveal(C, state, exp);
      return Object.assign({ ok: true }, result || {});
    }

    if (choice.id === 'leave' || choice.id === 'fight') {
      if (choice.id === 'leave' && enc.kind === 'survivor') exp.log.push('The squad walks on. The voice does not call after them.');
      if (choice.id === 'leave' && enc.kind === 'scavengers') exp.log.push('Both crews back off into the murk, watching each other go.');
      return close();
    }
    if (enc.kind === 'tipster') {
      if (choice.id === 'tip-sites') {
        payPools(C, state, exp, choice.price);
        exp.intelSites = true;
        exp.log.push(enc.name + ' talks for an hour in nine minutes: every cache, node and ruin in this ground, marked. (Payment: ' + fmtCost(choice.price) + '.)');
        return close();
      }
      if (choice.id === 'tip-threats') {
        var roll = C.rngInt(rng, 1, 20);
        var tot = roll + d.stats.NERVE;
        if (tot >= TUN.nerveDC) {
          exp.intelThreats = true;
          exp.log.push(d.name + ' trades story for story (NERVE roll ' + roll + '+' + d.stats.NERVE + ' vs ' + TUN.nerveDC + ') — ' + enc.name + ' gives up the threat picture of the whole ground, free.');
        } else {
          exp.log.push(d.name + ' makes small talk (NERVE roll ' + roll + '+' + d.stats.NERVE + ' vs ' + TUN.nerveDC + ' — short). ' + enc.name + ' shrugs: "Buy, or bye."');
        }
        return close();
      }
      if (choice.id === 'tip-rich') {
        payPools(C, state, exp, choice.price);
        if (enc.lie) {
          var lx = clamp(exp.landing.x + C.rngInt(rng, -4, 4), exp.win.x0, exp.win.x0 + 12);
          var ly = clamp(exp.landing.y + C.rngInt(rng, -4, 4), exp.win.y0, exp.win.y0 + 12);
          exp.decoy = { x: lx, y: ly };
          exp.log.push(enc.name + ' marks a spot with great confidence: ' + tileLabel(C, lx, ly) + '. "Rich," they say. "Barely guarded."');
        } else {
          var best = null;
          for (var wy2 = exp.win.y0; wy2 < exp.win.y0 + 13; wy2++) {
            for (var wx2 = exp.win.x0; wx2 < exp.win.x0 + 13; wx2++) {
              var st = C.tileAt(state, wx2, wy2);
              if (st && st.supplySite && !st.supplySite.looted) best = st;
            }
          }
          if (best) {
            exp.intelSites = true;
            exp.log.push(enc.name + ' marks the real thing: ' + best.supplySite.name + ' at ' + tileLabel(C, best.x, best.y) + '. The word is good.');
          } else {
            var rx = clamp(exp.landing.x + C.rngInt(rng, -3, 3), exp.win.x0, exp.win.x0 + 12);
            var ry = clamp(exp.landing.y + C.rngInt(rng, -3, 3), exp.win.y0, exp.win.y0 + 12);
            var rt = C.tileAt(state, rx, ry);
            if (rt && rt.terrain !== 'water' && !exp.drift[key(rx, ry)]) {
              exp.drift[key(rx, ry)] = { resource: 'SCRAP', amount: C.rngInt(rng, 8, 12) };
              exp.intelSites = true;
              exp.log.push(enc.name + ' marks a wrecker stash at ' + tileLabel(C, rx, ry) + ' — a rich one. The word is good.');
            } else {
              exp.intelThreats = true;
              exp.log.push(enc.name + ' has no cache to sell, so the threat picture comes instead — a fair trade.');
            }
          }
        }
        return close();
      }
    }
    if (enc.kind === 'trader') {
      if (choice.id === 'haggle') {
        if (enc.haggled) { exp.log.push(enc.name + ' smiles: "Price is the price, friend."'); return close(); }
        enc.haggled = true;
        var hroll = C.rngInt(rng, 1, 20);
        var htot = hroll + d.stats.NERVE;
        if (htot >= TUN.nerveDC) {
          enc.wares.forEach(function (w) {
            for (var k in w.want) w.want[k] = Math.max(1, Math.floor(w.want[k] * 0.75));
          });
          enc.choices.forEach(function (c) {
            if (c.ware != null) {
              var w = enc.wares[c.ware];
              c.sub = 'Pay ' + fmtCost(w.want) + ' → ' + fmtCost(w.give) + (w.heal ? ' (field aid)' : '') + ' · haggled down';
            }
          });
          exp.log.push(d.name + ' haggles like a local (NERVE roll ' + hroll + '+' + d.stats.NERVE + ' vs ' + TUN.nerveDC + ') — ' + enc.name + ' knocks a quarter off, laughing.');
          return { ok: true, stayOpen: true }; // trader stays — buy at the new prices
        }
        exp.log.push(d.name + ' tries to haggle (NERVE roll ' + hroll + '+' + d.stats.NERVE + ' vs ' + TUN.nerveDC + ' — short). ' + enc.name + ': "Price is the price, friend."');
        return close();
      }
      if (choice.ware != null) {
        var ware = enc.wares[choice.ware];
        if (!canPay(C, state, exp, ware.want)) return { ok: false, reason: 'Cannot cover ' + fmtCost(ware.want) + '.' };
        payPools(C, state, exp, ware.want);
        if (ware.heal) {
          var wounded = livingMembers(C, state, exp).map(function (mm) { return C.diverById(state, mm.id); })
            .filter(function (dd) { return dd && dd.wounds > 0; })
            .sort(function (a, b) { return b.wounds - a.wounds; })[0];
          if (wounded) {
            wounded.wounds -= 1;
            if (wounded.wounds === 0 && wounded.status === 'wounded') wounded.status = 'ready';
            exp.log.push('The pre-Burn medkit goes to work on ' + wounded.name + ' — one wound closed, clean as a hospital. (Paid ' + fmtCost(ware.want) + '.)');
          } else {
            gainCarried(exp, 'FOOD', 3);
            exp.log.push('Nobody is bleeding, so the medkit trades as supplies instead: +3 FOOD carried. (Paid ' + fmtCost(ware.want) + '.)');
          }
        } else {
          for (var gk in ware.give) gainCarried(exp, gk, ware.give[gk]);
          exp.log.push('Traded with ' + enc.name + ': −' + fmtCost(ware.want) + ' → +' + fmtCost(ware.give) + ' in the carried haul.');
        }
        return close();
      }
    }
    if (enc.kind === 'survivor' && choice.id === 'feed') {
      payPools(C, state, exp, choice.price);
      var rr = 5;
      for (var yy = exp.landing.y - rr; yy <= exp.landing.y + rr; yy++) {
        for (var xx = exp.landing.x - rr; xx <= exp.landing.x + rr; xx++) {
          var tt = C.tileAt(state, xx, yy);
          if (tt && Math.abs(xx - exp.landing.x) + Math.abs(yy - exp.landing.y) <= rr + 1) {
            exp.mapped[key(xx, yy)] = true; tt.discovered = true;
            if (inWindow(exp, xx, yy)) exp.seen[key(xx, yy)] = true;
          }
        }
      }
      exp.intelSites = true;
      exp.log.push('Fed, ' + enc.who + ' repays in the local currency: knowledge. The ground around the landing is mapped, sites and all.');
      return close();
    }
    if (enc.kind === 'scavengers') {
      if (choice.id === 'parley') {
        var proll = C.rngInt(rng, 1, 20);
        var ptot = proll + bestStat(C, state, exp, 'NERVE');
        if (ptot >= TUN.nerveDC) {
          var px = clamp(exp.landing.x + C.rngInt(rng, -4, 4), exp.win.x0, exp.win.x0 + 12);
          var py = clamp(exp.landing.y + C.rngInt(rng, -4, 4), exp.win.y0, exp.win.y0 + 12);
          var pt = C.tileAt(state, px, py);
          if (pt && pt.terrain !== 'water' && !exp.drift[key(px, py)]) {
            exp.drift[key(px, py)] = { resource: 'SCRAP', amount: C.rngInt(rng, 5, 8) };
          }
          exp.intelSites = true;
          exp.log.push('Parley holds (best NERVE roll ' + proll + '+' + bestStat(C, state, exp, 'NERVE') + ' vs ' + TUN.nerveDC + '). Professionals split the ground: they mark a stash at ' + tileLabel(C, px, py) + ' and fade.');
        } else {
          exp.log.push('Parley sours (best NERVE roll ' + proll + ' vs ' + TUN.nerveDC + '). Hands stop being near gear and start being on it.');
          spawnHostiles(C, state, exp, 'scavenger', exp.landing.x, exp.landing.y, 2, 0);
        }
        return close();
      }
      if (choice.id === 'driveoff') {
        var aroll = C.rngInt(rng, 1, 20);
        var atot = aroll + bestStat(C, state, exp, 'AIM');
        if (atot >= TUN.nerveDC) {
          var dropAmt = C.rngInt(rng, 3, 6);
          gainCarried(exp, 'SCRAP', dropAmt);
          exp.log.push('A show of aim (best AIM roll ' + aroll + '+' + bestStat(C, state, exp, 'AIM') + ' vs ' + TUN.nerveDC + ') sends them running — they drop +' + dropAmt + ' SCRAP getting clear.');
        } else {
          exp.log.push('They call the bluff (best AIM roll ' + aroll + ' vs ' + TUN.nerveDC + ') and come on shooting.');
          spawnHostiles(C, state, exp, 'scavenger', exp.landing.x, exp.landing.y, 2, 0);
        }
        return close();
      }
    }
    if (enc.kind === 'weather') {
      if (choice.id === 'pushon') {
        exp.sightPenalty = 1;
        exp.dangerPlus = 0.03;
        exp.log.push('The squad pushes on through the hammering rain — sight short, tempers shorter, the ground meaner.');
        reveal(C, state, exp);
        return close();
      }
      if (choice.id === 'extract-now') {
        exp.wantExtract = true;
        return close({ extract: true });
      }
    }
    return close();
  }

  /* ---------------- C4 + engineer support (§9) --------------------------- */
  function plantCharge(C, state, exp, targetRef) {
    if (exp.finished) return { ok: false, reason: 'The expedition is over.' };
    if (exp.encounter) return { ok: false, reason: 'Resolve the encounter first.' };
    var m = activeMember(C, state, exp);
    if (!m) return { ok: false, reason: 'No living diver.' };
    var d = C.diverById(state, m.id);
    if (C.ensureArchetype(d) !== 'EXPLOSIVES') return { ok: false, reason: d.name + ' is no explosives expert — C4 rides with the explosives expert of the squad.' };
    if ((exp.charges || 0) <= 0) return { ok: false, reason: 'No C4 charges left this drop.' };
    if (m.ap < 2) return { ok: false, reason: 'Planting a charge costs 2 AP.' };
    if (targetRef === 'site') {
      var site = siteAt(C, state, exp, m);
      if (!site || site.type !== 'door') return { ok: false, reason: 'No sealed door here to blow.' };
      m.ap -= 2; exp.charges -= 1;
      var poi = site.poi;
      var door = poi.doors.filter(function (dr) { return dr.state === 'sealed'; })[0];
      door.state = 'opened';
      Object.keys(door.yield || {}).forEach(function (k) { gainCarried(exp, k, door.yield[k]); });
      exp.log.push('💥 ' + d.name + ' blows the ' + door.label + ' door at ' + poi.label + ' with C4 — the hatch comes off its hinges.' +
        (Object.keys(door.yield || {}).length ? ' Inside, for the balloons: ' + JSON.stringify(door.yield) + '.' : ''));
      if (door.key === 'cryo') { exp.cryoFound = { label: poi.label, capsules: door.capsules || 0 }; exp.log.push('CRYO: ' + (door.capsules || 0) + ' capsules still cold behind the blown door — wake them from the Crew screen.'); }
      exp.events.push('explosion');
      exp.cachesLooted += 1; exp.poiWorked = true;
      countThingGround(state);
      maybeFindGear(C, state, exp, d, 2);
      return { ok: true, charged: 'door' };
    }
    var h = exp.hostiles.filter(function (x) { return x.id === targetRef; })[0];
    if (!h) return { ok: false, reason: 'No such target.' };
    if (['guardian', 'turret', 'plant'].indexOf(h.kind) < 0) return { ok: false, reason: 'C4 is for machines, plants and doors — Sirens get bullets.' };
    if (Math.abs(h.x - m.x) + Math.abs(h.y - m.y) > 2) return { ok: false, reason: 'Too far to plant — get within 2 tiles of the ' + h.name + '.' };
    m.ap -= 2; exp.charges -= 1;
    exp.events.push('explosion');
    var killed = damageHostile(C, state, exp, h, C.TUNABLES.c4Damage, d.name + ' plants C4 on', 'C4 charge, ' + C.TUNABLES.c4Damage + ' damage');
    exp.log.push('💥 C4 on the ' + h.name + ' — ' + C.TUNABLES.c4Damage + ' damage (' + exp.charges + ' charge(s) left).');
    return { ok: true, charged: 'hostile', killed: killed };
  }
  function supportAction(C, state, exp, targetId) {
    if (exp.finished) return { ok: false, reason: 'The expedition is over.' };
    var m = activeMember(C, state, exp);
    if (!m) return { ok: false, reason: 'No living diver.' };
    var d = C.diverById(state, m.id);
    if (C.ensureArchetype(d) !== 'ENGINEER') return { ok: false, reason: d.name + ' is no engineer — support actions ride with the engineer of the squad.' };
    if (m.supportTurn === exp.turn) return { ok: false, reason: d.name + ' has already supported this ground turn.' };
    if (m.ap < 2) return { ok: false, reason: 'A support action costs 2 AP.' };
    var t = memberOf(exp, targetId);
    if (!t || t === m) return { ok: false, reason: 'Pick another squad member to support.' };
    m.ap -= 2; m.supportTurn = exp.turn;
    t.ap += 2;
    exp.log.push(d.name + ' works the systems for ' + C.diverById(state, t.id).name + ' — +2 AP (rigged lights, cleared jam, hot-swapped cell).');
    exp.events.push('device');
    return { ok: true };
  }

  /* ---------------- end of ground turn: the world acts ------------------ */
  function endTurn(C, state, exp) {
    if (exp.finished) return { ok: false, reason: 'The expedition is over.' };
    if (exp.encounter) return { ok: false, reason: 'Resolve the encounter first.' };
    var endedTurn = exp.turn, logMark = exp.log.length;
    exp.hostiles.slice().forEach(function (h) {
      var liv = livingMembers(C, state, exp);
      if (!liv.length) return;
      if (h.stunTurns > 0) { h.stunTurns -= 1; exp.log.push('The ' + h.name + ' is staggered — it loses its turn.'); return; }
      var nearest = null, nd = Infinity;
      liv.forEach(function (m) {
        var dd = Math.abs(m.x - h.x) + Math.abs(m.y - h.y);
        if (dd < nd) { nd = dd; nearest = m; }
      });
      if (!nearest) return;
      var eco = exp.ecology || { archetype: 'open', storm: false };
      function stepToward(stopDist) {
        var speed = h.speed || 3;
        for (var s = 0; s < speed; s++) {
          var cur = Math.abs(nearest.x - h.x) + Math.abs(nearest.y - h.y);
          if (cur <= stopDist) break;
          var dx = Math.sign(nearest.x - h.x), dy = Math.sign(nearest.y - h.y);
          var options = [];
          if (dx) options.push([h.x + dx, h.y]);
          if (dy) options.push([h.x, h.y + dy]);
          var moved = false;
          for (var oi = 0; oi < options.length; oi++) {
            var nx = options[oi][0], ny = options[oi][1];
            var nt = C.tileAt(state, nx, ny);
            var canStand = nt && (nt.terrain !== 'water' || h.cls === 'flying') && inWindow(exp, nx, ny) &&
              !exp.hostiles.some(function (o) { return o !== h && o.x === nx && o.y === ny; });
            // Sirens will not enter burning flare light or a lit diver's
            // circle (§10-ext / §15-ext) — they spend their turn at its edge.
            if (canStand && h.kind === 'swarm' && (tileBurning(exp, nx, ny) ||
              liv.some(function (lm) { return memberLit(exp, lm) && Math.abs(lm.x - nx) + Math.abs(lm.y - ny) <= 1; }))) {
              canStand = false;
            }
            if (canStand) { h.x = nx; h.y = ny; moved = true; break; }
          }
          if (!moved) break;
        }
        return Math.abs(nearest.x - h.x) + Math.abs(nearest.y - h.y);
      }
      function attack(label, gate, sfxId) {
        var victim = C.diverById(state, nearest.id);
        exp.events.push(sfxId);
        // §11: a sniper caught in melee suffers for it.
        var g = gate;
        if (h.kind === 'swarm' && h.cls === 'melee' && C.ensureArchetype(victim) === 'SNIPER') g += 0.15;
        if (chance(C, exp.rng, g)) {
          woundMember(C, state, exp, victim, label);
        } else {
          exp.log.push(label + ': ' + victim.name + ' twists clear — no wound.');
        }
      }
      if (h.kind === 'plant') {
        if (nd <= 2) attack('Glow-plant tentacles rake', 0.5, 'plant'); // rooted: reach 1-2, never moves (§8)
        return;
      }
      if (h.kind === 'turret') {
        if (nd > 6) nd = stepToward(6);
        if (nd <= 6) attack('Turret-truck fire rakes', 0.5, 'firehit');
        return;
      }
      if (h.kind === 'swarm' && h.cls === 'ranged') {
        if (nd === 1) {
          var away = [[h.x + Math.sign(h.x - nearest.x), h.y], [h.x, h.y + Math.sign(h.y - nearest.y)]];
          for (var ai = 0; ai < away.length; ai++) {
            var at = C.tileAt(state, away[ai][0], away[ai][1]);
            if (at && at.terrain !== 'water' && inWindow(exp, away[ai][0], away[ai][1])) { h.x = away[ai][0]; h.y = away[ai][1]; nd = 2; break; }
          }
        }
        if (nd > 3) nd = stepToward(3);
        if (nd >= 2 && nd <= 3) attack('A Siren shriek tears at', sirenGate('ranged', eco.archetype, eco.storm), 'shriek');
        else if (nd <= 1) attack('A Siren shrieker claws at', 0.35, 'siren-attack');
        return;
      }
      if (h.kind === 'swarm' && h.cls === 'flying') {
        if (nd > 1) { nd = stepToward(1); exp.events.push('wingbeat'); }
        if (nd <= 1) attack('A Siren stoops from above on', sirenGate('flying', eco.archetype, eco.storm), 'wingbeat');
        return;
      }
      if (nd <= 1) {
        if (h.kind === 'swarm') attack('A Siren bite finds', sirenGate('melee', eco.archetype, eco.storm), 'siren-attack');
        else attack('The ' + h.name + ' mauls', 0.55, 'punch');
      } else {
        stepToward(1);
      }
    });
    // Flares burn down.
    exp.flares = exp.flares.filter(function (f) { f.turns -= 1; return f.turns > 0; });
    // The enemy phase, on the record: everything the hostiles just did,
    // so the UI can show the phase instead of leaving the player to guess
    // who went. (The '— Ground turn N' line is pushed after this.)
    exp.lastEnemyPhase = {
      turn: endedTurn,
      lines: exp.log.slice(logMark).filter(function (l) { return l.indexOf('— Ground turn') !== 0; })
    };
    exp.turn += 1;
    exp.exposure += 2;
    exp.members.forEach(function (m) { m.ap = m.apMax || TUN.apPerTurn; });
    var liv2 = livingMembers(C, state, exp);
    if (!liv2.length) { exp.finished = 'wiped'; return { ok: true, wiped: true }; }
    if (exp.activeId && !liv2.some(function (m) { return m.id === exp.activeId; })) exp.activeId = liv2[0].id;
    reveal(C, state, exp);
    exp.log.push('— Ground turn ' + exp.turn + '. AP refreshed. ' +
      (exp.hostiles.length ? exp.hostiles.length + ' hostile(s) still out there.' : 'The murk is quiet, for now.'));
    return { ok: true, turn: exp.turn };
  }

  /* ---------------- extraction: the balloon lift home ------------------- */
  function cargoAdd(C, state, gains) {
    var lost = 0, delivered = {};
    for (var k in gains) {
      var room = state.airship.cargoCapacity - C.cargoUsed(state);
      var add = Math.min(gains[k], Math.max(0, room));
      lost += gains[k] - add;
      if (add > 0) { state.resources[k] += add; delivered[k] = add; }
    }
    return { delivered: delivered, lost: lost };
  }

  function extract(C, state, exp, opts) {
    opts = opts || {};
    if (exp.finished) return exp.report;
    if (exp.encounter && !opts.force) return { ok: false, reason: 'Resolve the encounter first.' };
    exp.encounter = null;
    exp.pendingPath = null;
    exp.pendingPathFor = null;
    var T = C.TUNABLES;
    var liv = livingMembers(C, state, exp);
    var groundYield = clone(exp.carried);
    var trimmed = {}, trimFraction = 0;
    var hasty = exp.hostiles.some(function (h) {
      return liv.some(function (m) { return Math.abs(m.x - h.x) + Math.abs(m.y - h.y) <= 3; });
    });
    var ascentRisk = liv.length && (exp.woundsTaken > 0 || exp.storm > 0.45 || hasty);
    if (!liv.length) {
      trimFraction = 1;
      exp.log.push('BALLOON LIFT: no diver left alive to fly the caches — the whole haul stays on the ground.');
    } else if (ascentRisk && chance(C, exp.rng, T.balloonSnagChance)) {
      trimFraction = T.balloonSnagTrimFraction;
      exp.log.push('BALLOON LIFT: a cache balloon snags on the ascent and tears — part of the haul is lost to the wind.');
    } else {
      exp.log.push('BALLOON LIFT: caches away — the balloons rise through the murk and the ship reels the squad home.');
    }
    var afterTrim = {};
    Object.keys(groundYield).forEach(function (k) {
      var keep = Math.floor(groundYield[k] * (1 - trimFraction));
      if (keep < groundYield[k]) trimmed[k] = groundYield[k] - keep;
      if (keep > 0) afterTrim[k] = keep;
    });
    var res = cargoAdd(C, state, afterTrim);
    if (res.lost > 0) exp.log.push('Cargo full: ' + res.lost + ' unit(s) of the haul could not be carried (cargo cap ' + state.airship.cargoCapacity + ').');
    var delivered = res.delivered;

    // §13 POOL RULE: finds bank into the ship Armory — nothing is owned
    // by the finder. A snagged lift leaves a share of the finds behind.
    var banked = { weapons: [], attachments: [], tacLights: 0 };
    var gearKept = exp.foundGear;
    if (trimFraction > 0 && exp.foundGear.length) {
      var dropN = Math.ceil(exp.foundGear.length * trimFraction);
      var droppedGear = gearKept.slice(0, dropN);
      gearKept = gearKept.slice(dropN);
      droppedGear.forEach(function (f) { exp.leftBehind.push(f.name + ' (lost on the ascent)'); });
    }
    if (liv.length) {
      var armory = C.ensureArmory(state);
      gearKept.forEach(function (f) {
        if (f.kind === 'weapon') { C.armoryAddWeapon(state, f.name); banked.weapons.push(f.name); }
        else if (f.kind === 'attachment') { C.armoryAddAttachment(state, f.name); banked.attachments.push(f.name); }
      });
      // Leftover found grenades return to the pool; used ones are gone.
      ['frag', 'flash', 'conc'].forEach(function (gt) {
        if (exp.foundStock[gt] > 0) { armory.throwables[gt] += exp.foundStock[gt]; }
      });
      // Unused pack grenades stay in each diver's pack (their loadout).
      exp.members.forEach(function (m) {
        var d = C.diverById(state, m.id);
        if (d) d.grenadePack = clone(m.pack);
      });
      if (banked.weapons.length) exp.log.push('ARMORY: banked ' + banked.weapons.join(', ') + ' — the ship pool grows; nobody owns a find.');
      if (banked.attachments.length) exp.log.push('ARMORY: banked attachments — ' + banked.attachments.join(', ') + '.');
    } else {
      exp.foundGear.forEach(function (f) { exp.leftBehind.push(f.name + ' (no one came home)'); });
    }
    if (exp.leftBehind.length) {
      exp.log.push('LEFT BEHIND: ' + exp.leftBehind.join('; ') + ' — finds that never reach the Armory.');
    }

    // XP for survivors (§2.2 shape): survived + suppression + flawless.
    var xpEvents = [];
    var deliveredValue = Object.keys(delivered).reduce(function (a, k) { return a + delivered[k]; }, 0);
    liv.forEach(function (m) {
      var d = C.diverById(state, m.id);
      if (!d || d.status === 'dead') return;
      d.dropsSurvived += 1;
      if (d.status !== 'wounded') d.status = 'dropped';
      var xp = T.xpPerDropSurvived + exp.suppressed * T.xpPerHostileSuppressed +
        (exp.woundsTaken === 0 && exp.deaths.length === 0 && deliveredValue > 0 ? T.xpFlawlessBonus : 0);
      C.gainXp(state, d, xp, xpEvents);
      exp.log.push(d.name + ' earned ' + xp + ' XP (10 drop + ' + (exp.suppressed * 5) + ' suppression' +
        (xp > T.xpPerDropSurvived + exp.suppressed * T.xpPerHostileSuppressed ? ' + 25 clean-run bonus' : '') + ').');
    });
    xpEvents.forEach(function (e) { exp.log.push(e); });

    var woundedNames = liv.map(function (m) { return C.diverById(state, m.id); })
      .filter(function (d) { return d && d.wounds > 0; }).map(function (d) { return d.name; });
    // Campaign settle (mirrors core.resolveDrop exactly once): the rumor
    // fragment surfaces after the tuned drop count; acts derive after.
    if (!exp.fragmentEarned && state.totalDrops >= T.midnightFragmentDrops && state.campaign && !state.campaign.fragments.rumor) {
      state.campaign.fragments.rumor = true;
      exp.fragmentEarned = 'rumor';
      exp.events.push('fragment');
      exp.log.push('CHART FRAGMENT: word from the Midnight recordings — a rumor of the Cazadores chart surfaces. (Chart fragment: the rumor — ' + C.chartFragmentCount(state) + ' of 4.)');
    }
    var actBefore = state.campaign ? state.campaign.act : 1;
    C.deriveAct(state);
    if (state.campaign && state.campaign.act > actBefore) {
      exp.log.push('ACT ' + state.campaign.act + ' — THE BURIED WORLD: the squad has worked yellow ground. What is buried down there is older, richer, and less dead than the towns.');
    }
    // SHIP AS HOME settle: the apex skull and trophy-class finds bank only
    // if someone lives to carry them up; then the campaign sweep lands any
    // fragment/act/hero trophies this drop earned.
    var trophiesWon = [];
    if (liv.length) {
      if (exp.apexKilled) {
        var poiHome = C.poiAt(state, exp.target.x, exp.target.y);
        var skull = C.awardApexSkull(state, exp.apexKilled, poiHome ? poiHome.label : 'open ground');
        if (skull) { trophiesWon.push(skull.name); exp.log.push('TROPHY ROOM: the apex skull rides up with the lift — "' + skull.name + '". The apex record reads: skull on your wall.'); }
      }
      (exp.trophyFinds || []).forEach(function (fname, fi) {
        var ft = C.awardTrophy(state, {
          id: 'find-' + state.turn + '-' + state.totalDrops + '-' + fi, kind: 'find', name: fname,
          story: 'Found on the ground, turn ' + state.turn + ' — carried up by hand and kept, because some things are not scrap.'
        });
        if (ft) { trophiesWon.push(ft.name); exp.log.push('TROPHY ROOM: banked — ' + ft.name + '.'); }
      });
    } else {
      if (exp.apexKilled) exp.log.push('The apex fell, but no one came home — its skull stays on the ground.');
      (exp.trophyFinds || []).forEach(function (fname) { exp.leftBehind.push(fname + ' (no one came home)'); });
    }
    C.syncCampaignTrophies(state).forEach(function (t) {
      trophiesWon.push(t.name);
      exp.log.push('TROPHY ROOM: earned — ' + t.name + '. It waits in the room, ready to hang.');
    });
    var band;
    if (exp.deaths.length >= 2) band = 'Catastrophe';
    else if (exp.deaths.length === 1) band = 'Failure';
    else if (exp.woundsTaken >= 2) band = 'Costly success';
    else if (deliveredValue > 0 && exp.woundsTaken === 0 && (exp.suppressed > 0 || exp.cachesLooted > 0)) band = 'Flawless';
    else if (deliveredValue > 0) band = 'Success';
    else if (!liv.length) band = 'Catastrophe';
    else band = 'Failure';
    var outcome = 'Expedition: ' + exp.cachesLooted + ' site(s) cracked, ' + exp.nodesHarvested + ' node(s) worked, ' +
      exp.suppressed + ' hostile(s) down, ' + (exp.counts.tipster + exp.counts.trader + exp.counts.survivor + exp.counts.scavengers) +
      ' character(s) met over ' + exp.turn + ' ground turn(s).';
    var report = {
      ok: true, kind: 'expedition', turn: state.turn, x: exp.target.x, y: exp.target.y,
      land: exp.land, band: band, outcome: outcome,
      diverIds: exp.members.map(function (mm) { return mm.id; }),
      injuries: exp.injuries.slice(),
      fragmentEarned: exp.fragmentEarned, chartFragments: C.chartFragmentCount(state),
      act: state.campaign ? state.campaign.act : 1,
      ecology: exp.ecology ? { archetype: exp.ecology.archetype, dominant: exp.ecology.dominant, line: exp.ecology.line } : null,
      armoryBanked: banked, leftBehind: exp.leftBehind.slice(),
      trophiesWon: trophiesWon, apexKilled: exp.apexKilled || null,
      yield: delivered,
      ascent: { band: band, trimFraction: trimFraction, groundYield: groundYield, delivered: clone(delivered), trimmed: trimmed },
      deaths: exp.deaths.slice(), wounded: woundedNames,
      lines: exp.log.slice(), chronicleDeaths: exp.chronicleDeaths.slice(),
      expedition: {
        steps: exp.steps, groundTurns: exp.turn, suppressed: exp.suppressed,
        counts: clone(exp.counts), cachesLooted: exp.cachesLooted, nodesHarvested: exp.nodesHarvested
      }
    };
    state.lastReports.push(report);
    C.checkWinLose(state);
    exp.finished = true;
    exp.report = report;
    return report;
  }

  /* ---------------- the encounter table (for the report / tuning) ------- */
  var TABLE = [
    { kind: 'danger', weight: '26 + 4×tile threat', driver: 'tile threat where you stand', summary: '2–4 Sirens (melee rushers / ranged shriekers / flying variants, mixed by the site ecology) spawn at sight edge — positional combat in the AP structure' },
    { kind: 'guardian', weight: '20 when within 3 of an uncleared ruin', driver: 'proximity to a robot ruin', summary: 'dormant machine guardians — clear them to work the ruin vault' },
    { kind: 'glint', weight: '14', driver: 'flat', summary: 'instant minor find, never pauses the walk' },
    { kind: 'tipster', weight: '13 (max 2/dive)', driver: 'flat', summary: 'CHARACTER: sells site intel / threat picture / one rich spot (20% of rich-spot tips are lies)' },
    { kind: 'trader', weight: '11 (max 1/dive)', driver: 'flat', summary: 'CHARACTER: black-market wares at shady rates, haggle via NERVE, walking away free' },
    { kind: 'survivor', weight: '9 (max 1/dive)', driver: 'flat', summary: 'CHARACTER: feed them 3 FOOD and they map the ground around the landing' },
    { kind: 'scavengers', weight: '9 (max 2/dive)', driver: 'flat', summary: 'CHARACTERS: a rival raiding party — parley (NERVE) / drive off (AIM) / walk wide — failures turn hostile, and above the threat threshold they field a crewed turret truck' },
    { kind: 'weather', weight: '7 (max 1/dive)', driver: 'only when the drop storm sample > 0.2', summary: 'push on half-blind (sight −1, danger up) or extract now' }
  ];

  // Dev/test hook: force a table encounter at the active member, exactly
  // as if the walk had rolled it (same builder, same counts, same RNG).
  function forceEncounter(C, state, exp, kindW) {
    var m = activeMember(C, state, exp);
    if (!m || exp.encounter) return null;
    var ruinNear = null;
    for (var wy = exp.win.y0; wy < exp.win.y0 + 13 && !ruinNear; wy++) {
      for (var wx = exp.win.x0; wx < exp.win.x0 + 13; wx++) {
        var rt = C.tileAt(state, wx, wy);
        if (rt && rt.robotSite && !rt.robotSite.cleared) { ruinNear = rt; break; }
      }
    }
    var enc = buildEncounter(C, state, exp, kindW, m.x, m.y, ruinNear);
    if (enc) { exp.encounter = enc; exp.pendingPath = null; exp.pendingPathFor = null; }
    return enc;
  }

  var api = {
    TUN: TUN, TABLE: TABLE,
    createExpedition: createExpedition,
    forceEncounter: forceEncounter,
    memberOf: memberOf, livingMembers: livingMembers, activeMember: activeMember, setActive: setActive,
    findPath: findPath, reachableMap: reachableMap, moveActive: moveActive, stepAlong: stepAlong, continueMove: continueMove,
    siteAt: siteAt, interact: interact, fireAt: fireAt, swapWeapon: swapWeapon,
    toggleLight: toggleLight, throwAt: throwAt, throwStock: throwStock,
    plantCharge: plantCharge, supportAction: supportAction,
    choose: choose, endTurn: endTurn, extract: extract, reveal: reveal,
    canPay: canPay, fmtCost: fmtCost, tileLabel: tileLabel,
    siteIntel: siteIntel, SIREN_ECOLOGY: SIREN_ECOLOGY, sirenClassSpeed: sirenClassSpeed,
    poiNear: poiNear, memberLit: memberLit, haulRoom: haulRoom,
    spawnHostiles: spawnHostiles // exposed for tests / dev hooks
  };
  global.DropZoneGround = api;
  global.DropZoneEncounters = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
