/*
 * DROP ZONE — EXPEDITION ENGINE (the ground phase of a drop).
 * Steve's design, ruled Nov 3 2026 (playtest notes #16–#23):
 *  - After touchdown the drop is a TURN-BASED RPG on the local ground:
 *    each diver has ACTION POINTS per ground turn, spent on moving,
 *    firing, and interacting (loot / talk / trade). Chalice-simple:
 *    one pool per character, three verbs, no subsystem sprawl.
 *  - Loot is FOUND by exploring (real sector content + seeded drift
 *    caches inside the 13x13 ground window), never auto-yielded.
 *  - Random encounters fire as the squad explores: dangers from the
 *    world's own threat, finds, and CHARACTERS — TIPSTERS who sell
 *    intel and BLACK-MARKET TRADERS with shady-rate wares.
 *  - The phase ends when the player calls the balloon lift (extract).
 * Pure JS, no DOM (UMD like core.js): the UI renders from this state
 * and calls intents. Deterministic: a dedicated expedition RNG seeded
 * from (game seed, drop number, landing tile) + core's own seeded RNG
 * for GRIT saves — same seed + same choices = same expedition.
 * Canon (per lore/BESTIARY-AND-LORE.md, mined from the game's own files
 * 2026-11-03): the machine guardians are the world's one named monster;
 * the ground hostile is the spec's ONE hostile type, the "ground swarm"
 * (canon as a class — the record names no species, and that GAP stays a
 * gap: no fauna species are invented here); rival raiding parties are a
 * canon concept (concept doc: "encounters are random"); Harborlight
 * Anchorage, Cinder Hollow and The Vigil are canon radio-market trade
 * partners. Steve named the character TYPES — TIPSTERS, BLACK-MARKET
 * TRADERS (playtest #16); the individual names/personas below are
 * WORKING connective tissue, labeled as such, awaiting his word.
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
    fireRange: 6,              // tiles, Euclidean
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

  // WORKING names (not canon) — flavor pools for characters + creatures.
  var TIPSTER_NAMES = ['Wren', 'Old Sallow', 'Pell the Listener', 'Auntie Static', 'Low Tom'];
  var TRADER_NAMES = ['Mother Ledger', 'Cousin Vane', 'The Smiling Factor', 'Baba Crumb'];
  var SURVIVOR_NAMES = ['a downed courier', 'a cache-runner', 'a lost colony kid', 'a signal-watcher'];
  var HOSTILE_NAMES = { swarm: 'ground swarm', guardian: 'machine guardian', scavenger: 'rival raider' };

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  // core does not export rngChance — same draw via the exported rngNext.
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
    state.airship.fuel -= T.dropFuelCost;
    state.totalDrops += 1;
    tile.discovered = true;

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
      members: [],           // {id, x, y, ap}
      activeId: members[0].id,
      carried: {},           // gathered on the ground; cargo only after the lift
      drift: {},             // 'x,y' -> {resource, amount} seeded salvage
      seen: {},              // 'x,y' -> true (currently lit by someone's sight)
      mapped: {},            // 'x,y' -> true (ever seen; also writes tile.discovered)
      hostiles: [],          // {id, kind, x, y, hp, maxHp, menace, name}
      nextHostileSeq: 0,
      encounter: null,       // pending {kind, title, text, choices:[{id,label,sub,cost}]}
      counts: { tipster: 0, trader: 0, survivor: 0, scavengers: 0, weather: 0, danger: 0, guardian: 0 },
      intelSites: false,     // tipster reveal: all sites/nodes marked
      intelThreats: false,   // tipster reveal: exact threats known in window
      decoy: null,           // a tipster lie marker {x, y}
      suppressed: 0, woundsTaken: 0, deaths: [], chronicleDeaths: [],
      cachesLooted: 0, nodesHarvested: 0,
      log: [],
      finished: false, report: null
    };

    // Squad touches down in formation around the landing tile.
    var spots = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1], [0, 2]];
    members.forEach(function (d, i) {
      var sx = opts.landX, sy = opts.landY;
      for (var s = 0; s < spots.length; s++) {
        var cx = clamp(opts.landX + spots[(i + s) % spots.length][0], wx0, wx0 + 12);
        var cy = clamp(opts.landY + spots[(i + s) % spots.length][1], wy0, wy0 + 12);
        if (!exp.members.some(function (m) { return m.x === cx && m.y === cy; })) { sx = cx; sy = cy; break; }
      }
      exp.members.push({ id: d.id, x: sx, y: sy, ap: TUN.apPerTurn });
    });

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

    reveal(C, state, exp);
    exp.log.push('Touchdown at ' + tileLabel(C, opts.landX, opts.landY) + ' — LAND ' + opts.land + '. The squad is on the ground. ' +
      'Ground turn 1: explore, gather, and call the lift when you have enough — or when you have had enough.');

    // Descent wounds (lightning hits during the fall, ruled Nov 3):
    // each hit is a GRIT save for the most exposed diver at touchdown.
    var hits = opts.descentHits || 0;
    for (var h = 0; h < hits; h++) {
      var exposed = members.slice().sort(function (a, b) { return a.stats.GRIT - b.stats.GRIT; })[0];
      if (exposed && exposed.status !== 'dead') {
        woundMember(C, state, exp, exposed, 'Lightning strike on the descent');
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
    return exp.members.filter(function (m) { var d = C.diverById(state, m.id); return d && d.status !== 'dead'; });
  }
  function activeMember(C, state, exp) {
    var m = memberOf(exp, exp.activeId);
    if (m) { var d = C.diverById(state, m.id); if (d && d.status !== 'dead') return m; }
    var liv = livingMembers(C, state, exp);
    if (liv.length) { exp.activeId = liv[0].id; return liv[0]; }
    return null;
  }
  function setActive(exp, id) {
    if (memberOf(exp, id)) { exp.activeId = id; return true; }
    return false;
  }
  function sightRadius(exp) { return Math.max(1, TUN.sight - exp.sightPenalty); }

  function reveal(C, state, exp) {
    exp.seen = {};
    var r = sightRadius(exp);
    exp.members.forEach(function (m) {
      var d = C.diverById(state, m.id);
      if (!d || d.status === 'dead') return;
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
    // Anything actively engaging the squad is lit — you know where the
    // thing that is coming at you is, even at the murk's edge.
    exp.hostiles.forEach(function (h) { exp.seen[key(h.x, h.y)] = true; });
  }

  /* ---------------- wounds & death (core's own pieces) ------------------ */
  function woundMember(C, state, exp, diver, label) {
    var lines = exp.log;
    var save = C.makeGritSave(state, diver, 0);
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
        C.recordDeath(state, diver, 'tile (' + exp.landing.x + ',' + exp.landing.y + ')',
          'bled out on the ground — the third wound was one too many', exp.chronicleDeaths);
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
    // The course is plotted even when it costs more than one turn's AP:
    // the squad walks it over as many ground turns as it takes.
    exp.pendingPath = route.path.slice(1); // tiles after the current one
    exp.pathCost = route.cost;
    return stepAlong(C, state, exp);
  }
  function stepAlong(C, state, exp) {
    var m = activeMember(C, state, exp);
    if (!m || !exp.pendingPath || !exp.pendingPath.length) { exp.pendingPath = null; return { ok: true, moved: false }; }
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
      if (enc) { exp.encounter = enc; exp.pendingPath = null; events.push('encounter:' + enc.kind); }
    }
    if (!exp.pendingPath || !exp.pendingPath.length) exp.pendingPath = null;
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

  /* ---------------- interact: caches & ruins (1 AP) --------------------- */
  function siteAt(C, state, exp, m) {
    var t = C.tileAt(state, m.x, m.y);
    if (!t) return null;
    if (t.supplySite && !t.supplySite.looted) return { type: 'cache', tile: t };
    if (t.robotSite && !t.robotSite.cleared) return { type: 'ruin', tile: t };
    return null;
  }
  function interact(C, state, exp) {
    if (exp.finished) return { ok: false, reason: 'The expedition is over.' };
    if (exp.encounter) return { ok: false, reason: 'Resolve the encounter first.' };
    var m = activeMember(C, state, exp);
    if (!m) return { ok: false, reason: 'No living diver.' };
    var site = siteAt(C, state, exp, m);
    if (!site) return { ok: false, reason: 'Nothing here to work — caches (▣) and ruins (▦) are worked from their own tile.' };
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
      return { ok: true, looted: 'ruin' };
    }
    exp.log.push(d.name + ' rushes ' + t.robotSite.name + ' and is driven back (AIM roll ' + rroll + '+' + d.stats.AIM + ' vs ' + TUN.ruinDC + ').');
    woundMember(C, state, exp, d, 'Ruin defenses at ' + t.robotSite.name);
    return { ok: true, looted: null };
  }

  /* ---------------- fire: weapons in the turn structure (2 AP) ---------- */
  function fireAt(C, state, exp, hostileId) {
    if (exp.finished) return { ok: false, reason: 'The expedition is over.' };
    if (exp.encounter) return { ok: false, reason: 'Resolve the encounter first.' };
    var m = activeMember(C, state, exp);
    if (!m) return { ok: false, reason: 'No living diver.' };
    var h = exp.hostiles.filter(function (x) { return x.id === hostileId; })[0];
    if (!h) return { ok: false, reason: 'No such target.' };
    if (m.ap < TUN.costFire) return { ok: false, reason: 'Firing costs ' + TUN.costFire + ' AP.' };
    var dist = Math.hypot(h.x - m.x, h.y - m.y);
    if (dist > TUN.fireRange) return { ok: false, reason: 'Out of range (' + dist.toFixed(1) + ' > ' + TUN.fireRange + ').' };
    if (!exp.seen[key(h.x, h.y)]) return { ok: false, reason: 'No line of sight — it is outside the squad\'s sight.' };
    var d = C.diverById(state, m.id);
    m.ap -= TUN.costFire;
    var roll = C.rngInt(exp.rng, 1, 20);
    var total = roll + d.stats.AIM;
    var dc = TUN.fireDCBase + h.menace;
    if (roll === 20 || total >= dc) {
      var dmg = roll === 20 ? 2 : 1;
      h.hp -= dmg;
      if (h.hp <= 0) {
        exp.hostiles = exp.hostiles.filter(function (x) { return x !== h; });
        exp.suppressed += 1;
        exp.log.push(d.name + ' drops the ' + h.name + (roll === 20 ? ' with a perfect shot' : '') + ' (AIM roll ' + roll + '+' + d.stats.AIM + ' vs ' + dc + ').');
        return { ok: true, hit: true, killed: true };
      }
      exp.log.push(d.name + ' hits the ' + h.name + ' (AIM roll ' + roll + '+' + d.stats.AIM + ' vs ' + dc + ') — it staggers (' + h.hp + ' hp left).');
      return { ok: true, hit: true, killed: false };
    }
    exp.log.push(d.name + ' fires and misses the ' + h.name + ' (AIM roll ' + roll + '+' + d.stats.AIM + ' vs ' + dc + ').');
    return { ok: true, hit: false, killed: false };
  }

  /* ---------------- encounters ------------------------------------------ */
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
        x: spot.x, y: spot.y, hp: 2 + menace, maxHp: 2 + menace, menace: menace
      };
      exp.hostiles.push(h);
      made.push(h);
    }
    return made;
  }

  function rollEncounter(C, state, exp, x, y) {
    if (exp.steps <= TUN.graceSteps) return null;
    var t = C.tileAt(state, x, y);
    var threat = t ? t.threat : 0;
    var p = TUN.encounterBase + TUN.encounterPerThreat * threat + TUN.encounterPerStep * exp.exposure + exp.dangerPlus;
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
      exp.log.push('CONTACT: the ground swarm boils up — ' + made.length + ' strong — weapons free. They move when your turn ends.');
      return {
        kind: 'danger', title: '⚔ CONTACT — the ground swarm',
        text: 'The tile\'s threat, made real: ' + made.length + ' of the ground swarm boil out of the ground cover at the squad — fast and many. FIRE costs ' + TUN.costFire + ' AP; they close in and bite when the ground turn ends.',
        choices: [{ id: 'fight', label: 'Weapons free', sub: 'Fight it out in the turn structure', cost: 0 }]
      };
    }
    if (kindW === 'guardian') {
      exp.counts.guardian += 1;
      var made2 = spawnHostiles(C, state, exp, 'guardian', ruinNear.x, ruinNear.y, 1 + (chance(C, rng, 0.4) ? 1 : 0), 1);
      exp.log.push('CONTACT: the machine guardians of ' + ruinNear.name + ' stir — sentient robots, the thing that burned the world. They do not negotiate.');
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
          { id: 'tip-threats', label: 'Ask what is hunting here', sub: 'Free if the active diver\'s NERVE carries it · exact threats, whole ground', cost: TUN.costTalk },
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
        text: tname + ' sells off a hand-cart under a tarpaulin, running goods between Harborlight Anchorage, Cinder Hollow and The Vigil — the radio markets, at ground level. Shady rates — but the goods are real, and walking away is always free. Goods land in the carried haul; payment comes off what the squad carries first, then the ship\'s stores.',
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
          // The lie: a marked spot with nothing under it.
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
              exp.log.push(enc.name + ' marks a wrecker\'s stash at ' + tileLabel(C, rx, ry) + ' — a rich one. The word is good.');
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
      // They map the ground: a wide reveal + every site in it marked.
      exp.members.forEach(function (mm) { mm.ap = mm.ap; });
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

  /* ---------------- end of ground turn: the world acts ------------------ */
  function endTurn(C, state, exp) {
    if (exp.finished) return { ok: false, reason: 'The expedition is over.' };
    if (exp.encounter) return { ok: false, reason: 'Resolve the encounter first.' };
    // A plotted course survives the turn boundary — the walk continues.
    // Hostiles act: close in, then bite what they can reach.
    exp.hostiles.slice().forEach(function (h) {
      var liv = livingMembers(C, state, exp);
      if (!liv.length) return;
      var nearest = null, nd = Infinity;
      liv.forEach(function (m) {
        var dd = Math.abs(m.x - h.x) + Math.abs(m.y - h.y);
        if (dd < nd) { nd = dd; nearest = m; }
      });
      if (!nearest) return;
      if (nd <= 1) {
        var victim = C.diverById(state, nearest.id);
        woundMember(C, state, exp, victim, 'The ' + h.name + ' mauls');
      } else {
        var speed = h.kind === 'guardian' ? 2 : 3;
        for (var s = 0; s < speed; s++) {
          var dx = Math.sign(nearest.x - h.x), dy = Math.sign(nearest.y - h.y);
          var options = [];
          if (dx) options.push([h.x + dx, h.y]);
          if (dy) options.push([h.x, h.y + dy]);
          var moved = false;
          for (var oi = 0; oi < options.length; oi++) {
            var nx = options[oi][0], ny = options[oi][1];
            var nt = C.tileAt(state, nx, ny);
            if (nt && nt.terrain !== 'water' && inWindow(exp, nx, ny) &&
              !exp.hostiles.some(function (o) { return o !== h && o.x === nx && o.y === ny; })) {
              h.x = nx; h.y = ny; moved = true; break;
            }
          }
          if (!moved) break;
          if (Math.abs(nearest.x - h.x) + Math.abs(nearest.y - h.y) <= 1) break;
        }
      }
    });
    exp.turn += 1;
    exp.exposure += 2;
    exp.members.forEach(function (m) { m.ap = TUN.apPerTurn; });
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
    { kind: 'danger', weight: '26 + 4×tile threat', driver: 'tile threat where you stand', summary: '2–4 of the ground swarm (the spec\'s one hostile type; no species named in the record — GAP kept) spawn at sight\'s edge — positional combat in the AP structure' },
    { kind: 'guardian', weight: '20 when within 3 of an uncleared ruin', driver: 'proximity to a robot ruin', summary: 'machine guardians (core canon) — clear them to work the ruin vault' },
    { kind: 'glint', weight: '14', driver: 'flat', summary: 'instant minor find, never pauses the walk' },
    { kind: 'tipster', weight: '13 (max 2/dive)', driver: 'flat', summary: 'CHARACTER: sells site intel / threat picture / one rich spot (20% of rich-spot tips are lies)' },
    { kind: 'trader', weight: '11 (max 1/dive)', driver: 'flat', summary: 'CHARACTER: black-market wares at shady rates, haggle via NERVE, walking away free' },
    { kind: 'survivor', weight: '9 (max 1/dive)', driver: 'flat', summary: 'CHARACTER: feed them 3 FOOD and they map the ground around the landing' },
    { kind: 'scavengers', weight: '9 (max 2/dive)', driver: 'flat', summary: 'CHARACTERS: a rival raiding party (canon concept) — parley (NERVE) / drive off (AIM) / walk wide — failures turn hostile' },
    { kind: 'weather', weight: '7 (max 1/dive)', driver: 'only when the drop\'s storm sample > 0.2', summary: 'push on half-blind (sight −1, danger up) or extract now' }
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
    if (enc) { exp.encounter = enc; exp.pendingPath = null; }
    return enc;
  }

  var api = {
    TUN: TUN, TABLE: TABLE,
    createExpedition: createExpedition,
    forceEncounter: forceEncounter,
    memberOf: memberOf, livingMembers: livingMembers, activeMember: activeMember, setActive: setActive,
    findPath: findPath, moveActive: moveActive, stepAlong: stepAlong, continueMove: continueMove,
    siteAt: siteAt, interact: interact, fireAt: fireAt,
    choose: choose, endTurn: endTurn, extract: extract, reveal: reveal,
    canPay: canPay, fmtCost: fmtCost, tileLabel: tileLabel,
    spawnHostiles: spawnHostiles // exposed for tests / dev hooks
  };
  global.DropZoneEncounters = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
