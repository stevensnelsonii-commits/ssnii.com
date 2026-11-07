/*
 * DROP ZONE — vertical slice core (pure JS, no DOM).
 * Implements prototype spec 2026-10-26 + the 2026-10-30 design amendment
 * (logic pass v2: risky supply caches, robot-guarded tech ruins, economy
 * upkeep loop, off-map radio trade markets, balloon-lift returns).
 * Every number marked tunable (TUNABLES)
 * carries the spec's placeholder value. See README / smoke test for the list of
 * spec gaps that had to be interpreted.
 * UMD-style export guard: works as a browser <script> (window.DropZoneCore)
 * and in Node via require().
 */
(function (global) {
  'use strict';

  var SAVE_VERSION = 1;
  var PACK_ID = 'slice-base';        // §8.2 content-pack pinning stub
  var CONTENT_VERSION = 2;           // v2: sites, markets, economy ledger (additive)

  /* ---------------- Tunables (all values from the spec, marked ⟳ there) --- */
  var TUNABLES = {
    gridW: 24, gridH: 24,                       // §1 / §3.2: 24x24 sector
    crewCapacity: 10,                            // §3.1
    cargoCapacity: 100,                          // §3.1
    upgradeSlots: 4,                             // §3.1
    maxLevel: 10,                                // §2.2
    maxTraits: 2,                                // §2.1
    xpPerDropSurvived: 10,                       // §2.2
    xpPerHostileSuppressed: 5,                   // §2.2
    xpFlawlessBonus: 25,                         // §2.2
    levelCurveBase: 40,                          // §2.2: XP to next = 40 * level^1.5
    levelCurveExp: 1.5,
    settlementTierCap: 2,                        // §3.4 (slice)
    tier1Slots: 3, tier2Slots: 5,                // §3.4
    supplyCadence: 3,                            // §3.5: shipment every 3 turns
    dealRefreshTurns: 5,                         // §4.1
    dealsOffered: 3,                             // §4.1
    reputationMin: -2, reputationMax: 2,         // §4.1
    trainingTurns: 4,                            // §4.2
    trainingCost: { FOOD: 5, SCRAP: 5 },         // §4.2 (cost exists; amounts tunable interp.)
    traineeStatMin: 2, traineeStatMax: 5,        // §4.2
    traineeGuaranteedStat: 5,                    // §4.2
    reconCosts: [                                // §4.3
      { INTEL: 0, FUEL: 0 },
      { INTEL: 1, FUEL: 0 },
      { INTEL: 3, FUEL: 1 },
      { INTEL: 6, FUEL: 0 }                      // tier 3 also costs a diver sitting out
    ],
    reconBonus: [0, 5, 10, 15],                  // §5.1 RECON by tier
    threatWeight: 8,                             // §5.1 THREAT = threat * 8
    landMapMin: -20, landMapMax: 20,             // §5.1 LAND 0-100 -> -20..+20
    hazardPenalty: 15,                           // §5.3 -15 hazard, recon < 2
    descentSeconds: 8,                           // §5.3
    maxDrift: 6,                                 // §5.3 max_drift in tiles (interp. scale)
    failureLeftBehindChance: 0.10,               // §5.1 Failure band 10%
    costlyYieldFraction: 0.5,                    // §5.1 Costly = 50% yield
    defenseWaves: 3,                             // §5.2
    settlementFallFraction: 0.5,                 // §5.2 falls if DEFENSE < 50% raid force
    ambushLostFraction: 0.5,                     // §5.4 shipment lost if escort < 50% ambush
    // --- Interpretation tunables (spec names the system, not the number) ---
    airshipStartFuel: 12,
    airshipMaxFuel: 20,
    moveRangePerTurn: 6,                         // tiles per Orders phase
    moveFuelPerTiles: 3,                         // 1 fuel per 3 tiles moved (ceil)
    dropFuelCost: 1,                             // §6.1 drops burn fuel
    foodPerDiverPerTurn: 1,                      // §3.3 upkeep: roster eats per turn
    startResources: { SCRAP: 36, FUEL: 12, FOOD: 30, INTEL: 8 },
    foundCost: { SCRAP: 20, FOOD: 10 },          // founding cost (spec: "full cost", no number)
    upgradeTier2Cost: { SCRAP: 30, FOOD: 20 },
    settlementFoodOutput: { 1: 3, 2: 6 },        // §3.4 FOOD output by tier
    populationGrowthFed: 2,
    raidTimerStart: 6,
    raidTimerReset: 6,
    raidIntelThreshold: 5,                       // §3.4 raid warning visible if INTEL >= this
    gritSaveDC: 16,                              // GRIT save: d20 + GRIT >= DC (interp.)
    shipmentGoods: { FOOD: 4, SCRAP: 4 },        // colony goods in transit (§3.5)
    exposureBase: 0.20,
    exposurePerRouteThreat: 0.04,
    exposurePerInterdiction: 0.05,
    exposureCap: 0.85,
    routePrepBonus: 5,                           // §5.4 "route prep" when >=1 escort assigned
    // --- Amendment 2026-10-30 (logic pass v2; all numbers interp. tunables) ---
    supplySiteMin: 4, supplySiteMax: 6,          // risky caches scattered on the sector
    supplyThreatBonus: 5, supplyOutcomePenalty: 8,   // cache dives resolve meaner than salvage
    robotSiteMin: 1, robotSiteMax: 2,            // robot-guarded high-tech ruins
    robotThreatBonus: 10, robotOutcomePenalty: 12,   // machines are the worst ground in the sector
    balloonSnagChance: 0.35,                     // ascent snag roll on Costly bands
    balloonSnagTrimFraction: 0.25,               // ...tears away this fraction of the haul
    settlementFoodDivisor: 5,                    // settlement eats 1 FOOD per 5 population per turn
    starvationConsequenceStreak: 2,              // straight starving turns before hunger wounds/kills
    marketRefreshTurns: 7                        // off-map deal tables refresh slower than Kestrel's
  };

  var STRUCTURE_DEFS = {                          // §3.4 buildable list
    WALL:   { cost: { SCRAP: 10 }, soak: 20, suppression: 0, label: 'Wall' },
    TURRET: { cost: { SCRAP: 15 }, soak: 0,  suppression: 8, label: 'Turret' },
    FARM:   { cost: { SCRAP: 8 },  soak: 0,  suppression: 0, foodPerTurn: 5, label: 'Farm' },
    BUNKER: { cost: { SCRAP: 12 }, soak: 0,  suppression: 0, label: 'Bunker' }
  };

  var TRAITS = ['Steady', 'Reckless', 'Medic'];   // §2.1 slice trait pool
  var STATS = ['GRIT', 'AIM', 'NERVE', 'HAUL'];

  var STARTER_NAMES = [
    'Mara Voss', 'Jace Keller', 'Ines Duarte', 'Tom Okafor',
    'Riley Chen', 'Sara Lindqvist', 'Dex Marlowe', 'June Park'
  ];
  var TRAINEE_NAMES = [
    'Ash Rivera', 'Noor Haddad', 'Piotr Walczak', 'Emi Tanaka',
    'Cole Bennett', 'Lena Fischer', 'Omar Sayed', 'Ruth Adler',
    'Hugo Meyer', 'Tessa Grant', 'Ivan Petrov', 'Maya Lindgren'
  ];

  /* ---------------- Deterministic RNG: seed + counter (§8.1) -------------- */
  function hashSeed(seed) {
    var h = 2166136261 >>> 0;
    var s = String(seed);
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function createRng(seed) {
    return { seed: seed, counter: 0, state: hashSeed(seed) || 1 };
  }
  // splitmix32 step; counter increments on every draw so a save's
  // (seed, counter, state) fully reproduces the stream.
  function rngNext(rng) {
    rng.counter += 1;
    var z = (rng.state + 0x9E3779B9) >>> 0;
    rng.state = z;
    z = Math.imul(z ^ (z >>> 16), 0x21F0AAAD);
    z = Math.imul(z ^ (z >>> 15), 0x735A2D97);
    z = (z ^ (z >>> 15)) >>> 0;
    return z / 4294967296;
  }
  function rngFloat(rng, min, max) { return min + rngNext(rng) * (max - min); }
  function rngInt(rng, min, max) { return min + Math.floor(rngNext(rng) * (max - min + 1)); }
  function rngD20(rng) { return rngInt(rng, 1, 20); }
  function roll2d20(rng) { var a = rngD20(rng), b = rngD20(rng); return { dice: [a, b], total: a + b }; }
  function rngPick(rng, arr) { return arr[Math.floor(rngNext(rng) * arr.length)]; }
  function rngChance(rng, p) { return rngNext(rng) < p; }

  /* ---------------- Small helpers ----------------------------------------- */
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function key(x, y) { return x + ',' + y; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function tileAt(state, x, y) {
    if (x < 0 || y < 0 || x >= TUNABLES.gridW || y >= TUNABLES.gridH) return null;
    return state.tiles[y * TUNABLES.gridW + x];
  }
  function livingDivers(state) { return state.divers.filter(function (d) { return d.status !== 'dead'; }); }
  function diverById(state, id) {
    for (var i = 0; i < state.divers.length; i++) if (state.divers[i].id === id) return state.divers[i];
    return null;
  }
  function cargoUsed(state) {
    var r = state.resources;
    return r.SCRAP + r.FUEL + r.FOOD + r.INTEL;
  }
  function canAfford(state, cost) {
    for (var k in cost) if (state.resources[k] < cost[k]) return false;
    return true;
  }
  function payCost(state, cost) {
    for (var k in cost) state.resources[k] -= cost[k];
  }
  // Add resources respecting the shared cargo cap (§3.1). Returns amount lost to overflow.
  function addResources(state, gains) {
    var lost = 0;
    for (var k in gains) {
      var room = state.airship.cargoCapacity - cargoUsed(state);
      var add = Math.min(gains[k], Math.max(0, room));
      lost += gains[k] - add;
      state.resources[k] += add;
    }
    return lost;
  }
  function isGarrisoned(state, id) {
    return !!(state.settlement && state.settlement.garrison.indexOf(id) >= 0);
  }
  function isEscorting(state, id) { return state.supply.escort.indexOf(id) >= 0; }
  function diverAvailable(state, d) {
    return d && d.status === 'ready' && d.wounds === 0 &&
      !isGarrisoned(state, d.id) && !isEscorting(state, d.id);
  }

  /* ---------------- XP / levels (§2.2) ------------------------------------ */
  function xpToNextLevel(level) { return Math.round(TUNABLES.levelCurveBase * Math.pow(level, TUNABLES.levelCurveExp)); }
  // Cumulative XP required to *reach* `level` (level 1 = 0).
  function xpThresholdForLevel(level) {
    var total = 0;
    for (var l = 1; l < level; l++) total += xpToNextLevel(l);
    return total;
  }
  function gainXp(state, diver, amount, events) {
    if (diver.status === 'dead' || amount <= 0) return;
    diver.xp += amount;
    while (diver.level < TUNABLES.maxLevel && diver.xp >= xpThresholdForLevel(diver.level + 1)) {
      diver.level += 1;
      diver.pendingLevelUps += 1;
      if (events) events.push(diver.name + ' reached level ' + diver.level + ' (level-up choice pending).');
    }
  }
  // §2.2: +1 to two stats — player picks one, system picks second from lowest; +1 max composure.
  function applyLevelUpChoice(state, diverId, chosenStat) {
    var d = diverById(state, diverId);
    if (!d || d.pendingLevelUps <= 0) return { ok: false, reason: 'No pending level-up.' };
    if (STATS.indexOf(chosenStat) < 0) return { ok: false, reason: 'Unknown stat.' };
    d.pendingLevelUps -= 1;
    d.stats[chosenStat] = clamp(d.stats[chosenStat] + 1, 1, 10);
    var lowest = STATS.filter(function (s) { return s !== chosenStat; })[0];
    for (var i = 0; i < STATS.length; i++) {
      if (STATS[i] !== chosenStat && d.stats[STATS[i]] < d.stats[lowest]) lowest = STATS[i];
    }
    d.stats[lowest] = clamp(d.stats[lowest] + 1, 1, 10);
    d.maxComposure += 1;
    return { ok: true, diver: d.name, raised: [chosenStat, lowest] };
  }

  /* ---------------- GRIT saves (§5.1) ------------------------------------- */
  // Interp.: a GRIT save is d20 + GRIT >= gritSaveDC. Medic in squad: DC -2 for others.
  function makeGritSave(state, diver, contextDcModifier) {
    var roll = rngD20(state.rng);
    var dc = TUNABLES.gritSaveDC + (contextDcModifier || 0);
    return { roll: roll, grit: diver.stats.GRIT, dc: dc, success: roll + diver.stats.GRIT >= dc };
  }
  // Record a permadeath: diver leaves roster records, tombstone written (§8.1/§6.1 Chronicle beat).
  function recordDeath(state, diver, place, cause, chronicleLines) {
    diver.status = 'dead';
    diver.wounds = 0;
    // Remove from any assignment.
    if (state.settlement) {
      state.settlement.garrison = state.settlement.garrison.filter(function (id) { return id !== diver.id; });
    }
    state.supply.escort = state.supply.escort.filter(function (id) { return id !== diver.id; });
    var tomb = {
      id: diver.id, name: diver.name, level: diver.level, xp: diver.xp,
      dropsSurvived: diver.dropsSurvived, turn: state.turn, place: place, cause: cause,
      origin: diver.origin, traits: diver.traits.slice(),
      pack_id: PACK_ID, content_version: CONTENT_VERSION
    };
    state.tombstones.push(tomb);
    if (chronicleLines) chronicleLines.push(diver.name + ' died — ' + cause + ' (' + place + '). Memorial entry written.');
    return tomb;
  }
  // Apply a wound; GRIT save may shrug it (§5.1 Costly band). Returns outcome string.
  function applyWoundCheck(state, diver, lines, label) {
    var save = makeGritSave(state, diver, 0);
    if (save.success) {
      lines.push(label + ': ' + diver.name + ' shrugs off a wound (GRIT save ' + save.roll + '+' + save.grit + ' vs ' + save.dc + ').');
      return 'shrugged';
    }
    diver.wounds += 1;
    diver.status = 'wounded';
    lines.push(label + ': ' + diver.name + ' is wounded (GRIT save ' + save.roll + '+' + save.grit + ' vs ' + save.dc + ' failed).');
    return 'wounded';
  }

  /* ---------------- Sector generation (§3.2) ---------------------------- */
  function makeDiver(state, name, origin, statSpread, traitCount) {
    state.nextDiverSeq += 1;
    var stats = {};
    STATS.forEach(function (s) { stats[s] = rngInt(state.rng, statSpread[0], statSpread[1]); });
    var traits = [];
    var pool = TRAITS.slice();
    for (var i = 0; i < (traitCount || 0) && pool.length; i++) {
      var idx = Math.floor(rngNext(state.rng) * pool.length);
      traits.push(pool.splice(idx, 1)[0]);
    }
    return {
      id: 'diver-' + state.nextDiverSeq, name: name, level: 1, xp: 0,
      stats: stats, traits: traits, status: 'ready', wounds: 0,
      dropsSurvived: 0, origin: origin, maxComposure: 10, pendingLevelUps: 0,
      pack_id: PACK_ID, content_version: CONTENT_VERSION
    };
  }

  function generateSector(state) {
    var rng = state.rng, tiles = [];
    var gx = rngInt(rng, 8, 18), gy = rngInt(rng, 8, 18);       // the one green zone
    var colonyX = 21, colonyY = 21;                              // fixed colony corner
    var interX = rngInt(rng, 10, 20), interY = rngInt(rng, 2, 8); // interdiction cache
    if (interX === gx && interY === gy) interY = (interY + 3) % TUNABLES.gridH;
    // A few water blobs.
    var blobs = [];
    for (var b = 0; b < 4; b++) blobs.push({ x: rngInt(rng, 2, 21), y: rngInt(rng, 2, 21), r: rngInt(rng, 1, 2) });
    for (var y = 0; y < TUNABLES.gridH; y++) {
      for (var x = 0; x < TUNABLES.gridW; x++) {
        var terrain = 'open';
        var roll = rngNext(rng);
        if (roll < 0.18) terrain = 'rough'; else if (roll < 0.30) terrain = 'ruin';
        for (var bi = 0; bi < blobs.length; bi++) {
          if (Math.abs(blobs[bi].x - x) + Math.abs(blobs[bi].y - y) <= blobs[bi].r) terrain = 'water';
        }
        var distEdge = Math.min(x, y, TUNABLES.gridW - 1 - x, TUNABLES.gridH - 1 - y);
        var threatBase = terrain === 'ruin' ? 2 : terrain === 'rough' ? 1 : 0;
        var threat = clamp(threatBase + rngInt(rng, 0, 2) + (distEdge > 6 ? 1 : 0), 0, 5);
        if (terrain === 'water') threat = 0;
        var resourceType = null, resourceYield = 0;
        var nodeRoll = rngNext(rng);
        if (terrain === 'ruin' && nodeRoll < 0.45) { resourceType = 'SCRAP'; resourceYield = rngInt(rng, 6, 12); }
        else if (terrain !== 'water' && nodeRoll < 0.10) { resourceType = 'FUEL'; resourceYield = rngInt(rng, 5, 10); }
        else if (terrain !== 'water' && nodeRoll > 0.93) { resourceType = 'INTEL'; resourceYield = rngInt(rng, 3, 6); }
        tiles.push({
          x: x, y: y, terrain: terrain, threat: threat,
          resourceType: resourceType, resourceYield: resourceYield,
          discovered: false, isGreenZone: false, isColony: false, isInterdiction: false,
          hazard: rngChance(rng, 0.12),
          windX: rngInt(rng, -2, 2), windY: rngInt(rng, -2, 2),
          pack_id: PACK_ID, content_version: CONTENT_VERSION
        });
      }
    }
    state.tiles = tiles;
    var green = tileAt(state, gx, gy);
    green.isGreenZone = true; green.terrain = 'open'; green.threat = clamp(green.threat, 0, 2);
    green.resourceType = null; green.resourceYield = 0; green.hazard = false;
    state.greenZone = { x: gx, y: gy };
    var colony = tileAt(state, colonyX, colonyY);
    colony.isColony = true; colony.terrain = 'open'; colony.threat = 0; colony.discovered = true;
    colony.resourceType = null; colony.resourceYield = 0;
    state.colonyTile = { x: colonyX, y: colonyY };
    var inter = tileAt(state, interX, interY);
    inter.isInterdiction = true; inter.threat = clamp(Math.max(inter.threat, 3), 0, 5);
    if (inter.terrain === 'water') inter.terrain = 'ruin';
    state.interdictionTile = { x: interX, y: interY };
    // --- Amendment sites: risky supply caches + robot-guarded tech ruins.
    // Hidden like everything else on the sector: they surface only when a
    // tile is discovered (recon / airship proximity / a dive). NOT green
    // zones — the sector still holds exactly one of those.
    var taken = {};
    taken[key(gx, gy)] = true; taken[key(colonyX, colonyY)] = true; taken[key(interX, interY)] = true;
    taken[key(state.airship.x, state.airship.y)] = true;
    function siteFree(t) {
      return !taken[key(t.x, t.y)] && t.terrain !== 'water' && !t.isGreenZone && !t.isColony && !t.isInterdiction &&
        Math.abs(t.x - state.airship.x) + Math.abs(t.y - state.airship.y) > 4;
    }
    var supplyNames = ['a pre-Burn ration vault', 'a ditched fuel bowser', 'a collapsed quartermaster depot',
      'a buried cargo pod', 'a wrecker\'s hoard', 'a flooded commissary'];
    var supplyKinds = ['FOOD', 'FUEL', 'SCRAP'];
    var supplyCount = rngInt(rng, TUNABLES.supplySiteMin, TUNABLES.supplySiteMax);
    var placedSupply = 0, guard = 0;
    while (placedSupply < supplyCount && guard++ < 400) {
      var cand = tiles[rngInt(rng, 0, tiles.length - 1)];
      if (!siteFree(cand) || cand.supplySite || cand.robotSite) continue;
      var res = supplyKinds[placedSupply % supplyKinds.length];
      var amount = res === 'FOOD' ? rngInt(rng, 12, 18) : res === 'FUEL' ? rngInt(rng, 10, 14) : rngInt(rng, 12, 16);
      cand.supplySite = {
        resource: res, amount: amount, name: supplyNames[placedSupply % supplyNames.length], looted: false,
        pack_id: PACK_ID, content_version: CONTENT_VERSION
      };
      cand.threat = clamp(Math.max(cand.threat, 3), 0, 5);   // rich ground is hungry ground
      taken[key(cand.x, cand.y)] = true;
      placedSupply += 1;
    }
    var robotNames = ['the Meridian Array', 'Foundry Nine'];
    var robotCount = rngInt(rng, TUNABLES.robotSiteMin, TUNABLES.robotSiteMax);
    var placedRobot = 0; guard = 0;
    while (placedRobot < robotCount && guard++ < 400) {
      var rcand = tiles[rngInt(rng, 0, tiles.length - 1)];
      if (!siteFree(rcand) || rcand.supplySite || rcand.robotSite) continue;
      rcand.robotSite = {
        name: robotNames[placedRobot % robotNames.length],
        scrap: rngInt(rng, 14, 20), intel: rngInt(rng, 8, 12), cleared: false,
        pack_id: PACK_ID, content_version: CONTENT_VERSION
      };
      rcand.threat = 5;                                     // the worst ground in the sector
      taken[key(rcand.x, rcand.y)] = true;
      placedRobot += 1;
    }
    // Reveal around airship start.
    revealRadius(state, state.airship.x, state.airship.y, 2);
  }
  function revealRadius(state, cx, cy, r) {
    for (var y = cy - r; y <= cy + r; y++) {
      for (var x = cx - r; x <= cx + r; x++) {
        var t = tileAt(state, x, y);
        if (t && Math.abs(x - cx) + Math.abs(y - cy) <= r + 1) t.discovered = true;
      }
    }
  }

  /* ---------------- Colony deals (§4.1) ----------------------------------- */
  function generateDeals(state) {
    var rng = state.rng;
    var swaps = [
      { id: 'deal-swap-1', kind: 'resources', label: 'Colony wants SCRAP, offers FUEL',
        gives: { FUEL: 8 }, wants: { SCRAP: 10 } },
      { id: 'deal-swap-2', kind: 'resources', label: 'Colony wants FOOD, offers INTEL',
        gives: { INTEL: 5 }, wants: { FOOD: 8 } },
      { id: 'deal-swap-3', kind: 'resources', label: 'Colony wants FUEL, offers SCRAP',
        gives: { SCRAP: 12 }, wants: { FUEL: 6 } },
      { id: 'deal-swap-4', kind: 'resources', label: 'Colony wants SCRAP, offers FOOD',
        gives: { FOOD: 10 }, wants: { SCRAP: 8 } }
    ];
    // Pick 2 distinct swaps deterministically + 1 diver deal = 3 deals (§4.1).
    var a = Math.floor(rngNext(rng) * swaps.length);
    var b = (a + 1 + Math.floor(rngNext(rng) * (swaps.length - 1))) % swaps.length;
    var offered = makeDiver(state, rngPick(rng, TRAINEE_NAMES), 'traded', [2, 6], 1);
    offered.level = rngInt(rng, 1, 3);                            // §4.1 offered diver level 1-3
    offered.xp = xpThresholdForLevel(offered.level);
    var deals = [clone(swaps[a]), clone(swaps[b]), {
      id: 'deal-diver-1', kind: 'diver',
      label: 'Colony offers a diver: ' + offered.name + ' (Lv ' + offered.level + ')',
      gives: {}, wants: { SCRAP: 12, FOOD: 6 }, diverOffered: offered
    }];
    deals.forEach(function (d) { d.pack_id = PACK_ID; d.content_version = CONTENT_VERSION; });
    return deals;
  }

  /* ------------- Off-map trade settlements (amendment 2026-10-30) --------- */
  // Steve: other settlements exist that never appear on the sector map —
  // you raise them on the radio and trade in a separate menu. Each keeps
  // its own deal table + reputation; tables refresh on their own cadence.
  var MARKET_SWAPS = {
    'market-harborlight': [
      { kind: 'resources', label: 'Harborlight wants SCRAP, offers FOOD', gives: { FOOD: 12 }, wants: { SCRAP: 8 } },
      { kind: 'resources', label: 'Harborlight wants FOOD, offers FUEL', gives: { FUEL: 8 }, wants: { FOOD: 10 } },
      { kind: 'resources', label: 'Harborlight wants INTEL, offers FUEL', gives: { FUEL: 10 }, wants: { INTEL: 5 } }
    ],
    'market-cinder': [
      { kind: 'resources', label: 'Cinder Hollow wants FOOD, offers SCRAP', gives: { SCRAP: 14 }, wants: { FOOD: 8 } },
      { kind: 'resources', label: 'Cinder Hollow wants FUEL, offers SCRAP', gives: { SCRAP: 10 }, wants: { FUEL: 5 } },
      { kind: 'resources', label: 'Cinder Hollow wants SCRAP, offers FUEL', gives: { FUEL: 9 }, wants: { SCRAP: 10 } }
    ],
    'market-vigil': [
      { kind: 'resources', label: 'The Vigil wants FOOD, offers INTEL', gives: { INTEL: 7 }, wants: { FOOD: 8 } },
      { kind: 'resources', label: 'The Vigil wants SCRAP, offers INTEL', gives: { INTEL: 6 }, wants: { SCRAP: 9 } }
    ]
  };
  function refreshMarketDeals(state, market) {
    var deals = (MARKET_SWAPS[market.id] || []).map(function (s, i) {
      var d = clone(s); d.id = market.id + '-deal-' + i; return d;
    });
    if (market.id === 'market-vigil') {
      var offered = makeDiver(state, rngPick(state.rng, TRAINEE_NAMES), 'traded', [2, 6], 1);
      offered.level = rngInt(state.rng, 1, 3);
      offered.xp = xpThresholdForLevel(offered.level);
      deals.push({
        id: 'market-vigil-deal-diver', kind: 'diver',
        label: 'The Vigil offers a diver: ' + offered.name + ' (Lv ' + offered.level + ')',
        gives: {}, wants: { INTEL: 6, FOOD: 4 }, diverOffered: offered
      });
    }
    deals.forEach(function (d) { d.pack_id = PACK_ID; d.content_version = CONTENT_VERSION; });
    market.deals = deals;
  }
  function generateTradeMarkets(state) {
    var defs = [
      { id: 'market-harborlight', name: 'Harborlight Anchorage',
        blurb: 'A harbor town strung along a drowned coast, far beyond the sector edge. They answer the radio, eventually.' },
      { id: 'market-cinder', name: 'Cinder Hollow',
        blurb: 'A forge-town in the ash country. Off every chart you own; their prices travel by wireless only.' },
      { id: 'market-vigil', name: 'The Vigil',
        blurb: 'Keepers of a pre-Burn archive spire. Nobody has ever seen the place. The signal is always clear.' }
    ];
    state.markets = defs.map(function (def) {
      return {
        id: def.id, name: def.name, blurb: def.blurb, reputation: 0, deals: [],
        lastRefreshTurn: state.turn || 1, pack_id: PACK_ID, content_version: CONTENT_VERSION
      };
    });
    state.markets.forEach(function (m) { refreshMarketDeals(state, m); });
    return state.markets;
  }

  /* ---------------- New game ---------------------------------------------- */
  function createGame(seed) {
    var state = {
      version: SAVE_VERSION, pack_id: PACK_ID, content_version: CONTENT_VERSION,
      seed: seed, rng: createRng(seed),
      turn: 1, phase: 'orders',
      divers: [], tombstones: [], nextDiverSeq: 0,
      airship: {
        x: 2, y: 2, fuel: TUNABLES.airshipStartFuel, maxFuel: TUNABLES.airshipMaxFuel,
        crewCapacity: TUNABLES.crewCapacity, cargoCapacity: TUNABLES.cargoCapacity,
        upgradeSlots: [
          { type: 'training', filled: true },                    // §3.1: 1 pre-filled (training)
          { type: null, filled: false }, { type: null, filled: false }, { type: null, filled: false }
        ],
        trainingQueue: null, movedThisTurn: 0
      },
      resources: clone(TUNABLES.startResources),
      tiles: [], greenZone: null, colonyTile: null, interdictionTile: null,
      settlement: null,
      colony: { name: 'Kestrel Colony', reputation: 0, deals: [], lastRefreshTurn: 1 },
      supply: { escort: [], status: 'inactive', cadenceCounter: 0, shipmentsCompleted: 0, interdictions: 0 },
      chronicle: [], lastReports: [], lastRaidReport: null, lastAmbushReport: null,
      starving: false, starvationStreak: 0, lastUpkeep: null, markets: [],
      gameStatus: 'playing', endReason: null,
      raidsSurvived: 0, raidsSurvivedAtTier2: 0, totalDrops: 0
    };
    for (var i = 0; i < STARTER_NAMES.length; i++) {
      state.divers.push(makeDiver(state, STARTER_NAMES[i], 'starter', [3, 8], i % 3 === 0 ? 2 : 1));
    }
    generateSector(state);
    state.colony.deals = generateDeals(state);
    generateTradeMarkets(state);
    return state;
  }

  /* ---------------- Orders-phase actions ---------------------------------- */
  function moveAirship(state, x, y) {
    var dist = Math.abs(x - state.airship.x) + Math.abs(y - state.airship.y);
    if (dist === 0) return { ok: false, reason: 'Already there.' };
    if (state.airship.movedThisTurn + dist > TUNABLES.moveRangePerTurn) {
      return { ok: false, reason: 'Move exceeds this turn\'s range (' + TUNABLES.moveRangePerTurn + ' tiles).' };
    }
    var cost = Math.ceil(dist / TUNABLES.moveFuelPerTiles);
    if (state.airship.fuel < cost) return { ok: false, reason: 'Not enough airship fuel (need ' + cost + ').' };
    state.airship.fuel -= cost; state.airship.movedThisTurn += dist;
    state.airship.x = x; state.airship.y = y;
    revealRadius(state, x, y, 2);
    return { ok: true, cost: cost, distance: dist };
  }
  function refuelAirship(state) {
    var need = state.airship.maxFuel - state.airship.fuel;
    var use = Math.min(need, state.resources.FUEL);
    if (use <= 0) return { ok: false, reason: 'No FUEL in cargo or tank already full.' };
    state.resources.FUEL -= use; state.airship.fuel += use;
    return { ok: true, transferred: use };
  }
  function renameDiver(state, diverId, newName) {
    var d = diverById(state, diverId);
    if (!d || d.status === 'dead') return { ok: false, reason: 'No such living diver.' };
    d.name = String(newName).slice(0, 32) || d.name;
    return { ok: true, name: d.name };
  }
  function restDiver(state, diverId) {
    var d = diverById(state, diverId);
    if (!d || d.status === 'dead') return { ok: false, reason: 'No such diver.' };
    if (d.wounds <= 0) return { ok: false, reason: d.name + ' is not wounded.' };
    if (state.resources.FOOD < 2) return { ok: false, reason: 'Rest costs 2 FOOD (interp. tunable).' };
    state.resources.FOOD -= 2; d.wounds -= 1;
    if (d.wounds === 0 && d.status === 'wounded') d.status = 'ready';
    return { ok: true, woundsLeft: d.wounds };
  }

  /* ---------------- Recon (§4.3) ------------------------------------------ */
  function buyRecon(state, x, y, tier, sitOutDiverId) {
    var tile = tileAt(state, x, y);
    if (!tile) return { ok: false, reason: 'No such tile.' };
    tier = clamp(tier | 0, 0, 3);
    var current = tile.reconTier || 0;
    if (tier <= current) return { ok: false, reason: 'Recon tier ' + current + ' already held for this tile.' };
    var totalCost = { INTEL: 0, FUEL: 0 };
    for (var t = current + 1; t <= tier; t++) {
      totalCost.INTEL += TUNABLES.reconCosts[t].INTEL;
      totalCost.FUEL += TUNABLES.reconCosts[t].FUEL;
    }
    if (!canAfford(state, totalCost)) return { ok: false, reason: 'Cannot afford recon (needs ' + JSON.stringify(totalCost) + ').' };
    var sitter = null;
    if (tier >= 3) {
      sitter = diverById(state, sitOutDiverId);
      if (!sitter || !diverAvailable(state, sitter)) {
        return { ok: false, reason: 'Tier 3 recon needs an available diver to sit out the turn.' };
      }
    }
    payCost(state, totalCost);
    tile.reconTier = tier;
    tile.discovered = true;
    revealRadius(state, x, y, tier >= 2 ? 2 : 1);
    if (sitter) { sitter.status = 'dropped'; }  // sits out the turn (§4.3)
    return { ok: true, tier: tier, cost: totalCost, satOut: sitter ? sitter.name : null };
  }
  function knownThreat(state, tile) {
    var tier = tile.reconTier || 0;
    if (tier === 0 && !tile.discovered) return { known: false, text: 'unknown' };
    if (tier === 0) return { known: true, value: tile.threat, approx: true, text: 'threat ~' + tile.threat + ' (tile type only)' };
    if (tier === 1) {
      var lo = clamp(tile.threat - 1, 0, 5), hi = clamp(tile.threat + 1, 0, 5);
      return { known: true, value: tile.threat, approx: true, text: 'threat ' + lo + '-' + hi };
    }
    return { known: true, value: tile.threat, approx: false, text: 'threat ' + tile.threat + ' (exact)' };
  }

  /* ---------------- Landing quality (§5.3) -------------------------------- */
  var TERRAIN_BASE = { open: 100, rough: 75, ruin: 60, water: -1 };  // ruin: worse landing, +cover (flavor)
  function tileLandingBase(tile) { return TERRAIN_BASE[tile.terrain]; }
  function dropZoneTiles(state, cx, cy, radius) {
    var out = [];
    for (var y = cy - radius; y <= cy + radius; y++) {
      for (var x = cx - radius; x <= cx + radius; x++) {
        var t = tileAt(state, x, y);
        if (t) out.push(t);
      }
    }
    return out;
  }
  // Best reachable tile: highest base quality, threat proximity subtracts, water invalid.
  function tileQualityScore(tile) {
    if (tile.terrain === 'water') return -Infinity;
    return TERRAIN_BASE[tile.terrain] - tile.threat * 5 - (tile.hazard ? 10 : 0);
  }
  function findBestTile(state, cx, cy) {
    var zone = dropZoneTiles(state, cx, cy, 2);
    var best = null, bestScore = -Infinity;
    zone.forEach(function (t) {
      var s = tileQualityScore(t);
      if (s > bestScore) { bestScore = s; best = t; }
    });
    return best;
  }
  // LAND = 100 * (1 - distance_from_best / max_drift); -15 if hazard & recon < 2 (§5.3).
  // finalTile may be an {x,y} coord; reasons always explain the score.
  function computeLanding(state, targetX, targetY, finalX, finalY, reconTier) {
    var reasons = [];
    var finalTile = tileAt(state, finalX, finalY);
    var best = findBestTile(state, targetX, targetY);
    if (!finalTile) return { land: 0, best: null, finalTile: null, reasons: ['Landed off the sector map.'] };
    if (finalTile.terrain === 'water') {
      return { land: 0, best: best, finalTile: finalTile, reasons: ['Final tile is water — invalid landing, LAND 0.'] };
    }
    var dist = Math.sqrt(Math.pow(finalX - best.x, 2) + Math.pow(finalY - best.y, 2));
    var land = 100 * (1 - dist / TUNABLES.maxDrift);
    reasons.push('Best reachable tile: (' + best.x + ',' + best.y + ') ' + best.terrain +
      ' (base ' + TERRAIN_BASE[best.terrain] + ', threat ' + best.threat + ').');
    reasons.push('Final tile: (' + finalX + ',' + finalY + ') ' + finalTile.terrain +
      ', distance from best ' + dist.toFixed(2) + ' of max drift ' + TUNABLES.maxDrift + '.');
    reasons.push('Distance score: 100 x (1 - ' + dist.toFixed(2) + '/' + TUNABLES.maxDrift + ') = ' + Math.max(0, land).toFixed(1) + '.');
    if (finalTile.hazard) {
      if (reconTier < 2) {
        land -= TUNABLES.hazardPenalty;
        reasons.push('Final tile is hazard-marked and recon tier ' + reconTier + ' < 2 could not reveal it: -' + TUNABLES.hazardPenalty + '.');
      } else {
        reasons.push('Final tile is hazard-marked but recon tier ' + reconTier + ' revealed it in advance: no penalty.');
      }
    } else {
      reasons.push('Final tile is not hazard-marked: no hazard adjustment.');
    }
    if (finalTile.terrain === 'ruin') reasons.push('Ruin landing: rougher touchdown but +cover (flavor note, §5.3).');
    land = clamp(Math.round(land), 0, 100);
    reasons.push('LAND = ' + land + '.');
    return { land: land, best: best, finalTile: finalTile, distance: dist, reasons: reasons };
  }
  function landToModifier(land) {
    return Math.round(TUNABLES.landMapMin + (land / 100) * (TUNABLES.landMapMax - TUNABLES.landMapMin));
  }

  /* ---------------- Projected band in words (§6.2 Briefing) --------------- */
  function squadScore(state, divers) {
    var sum = 0, lvlBonus = 0;
    divers.forEach(function (d) {
      sum += (d.stats.AIM + d.stats.GRIT) / 2;
      lvlBonus += (d.level - 1);
    });
    var score = sum / divers.length + lvlBonus / divers.length;   // §5.1: +1 per level above 1, averaged
    if (state.starving) score -= 1;                                // starvation NERVE penalty (§3.3, interp. as squad penalty)
    // Trait interp.: Steady steadies the squad, Reckless adds punch, Medic protects (wound DC handled in saves).
    if (divers.some(function (d) { return d.traits.indexOf('Steady') >= 0; })) score += 0.5;
    if (divers.some(function (d) { return d.traits.indexOf('Reckless') >= 0; })) score += 0.5;
    return score;
  }
  function projectedBand(state, diverIds, x, y, reconTier) {
    var tile = tileAt(state, x, y);
    var divers = diverIds.map(function (id) { return diverById(state, id); }).filter(Boolean);
    if (!tile || !divers.length) return { word: 'risky', expected: 0 };
    var expectedLandMod = 5;  // assumes an average steer (LAND ~62)
    var expected = squadScore(state, divers) * 4 + expectedLandMod +
      TUNABLES.reconBonus[reconTier] + 21 /* average 2d20 */ - tile.threat * TUNABLES.threatWeight;
    if (tile.robotSite && !tile.robotSite.cleared) expected -= TUNABLES.robotThreatBonus + TUNABLES.robotOutcomePenalty;
    if (tile.supplySite && !tile.supplySite.looted) expected -= TUNABLES.supplyThreatBonus + TUNABLES.supplyOutcomePenalty;
    var word = expected >= 65 ? 'favorable' : expected >= 35 ? 'risky' : 'suicidal';
    return { word: word, expected: Math.round(expected) };
  }
  function bandForOutcome(outcome) {
    if (outcome >= 95) return 'Flawless';
    if (outcome >= 70) return 'Success';
    if (outcome >= 45) return 'Costly success';
    if (outcome >= 25) return 'Failure';
    return 'Catastrophe';
  }

  /* ---------------- Drop resolution (§5.1 / §5.4 interdiction) ------------ */
  // opts: { diverIds, x, y, land (0-100), kind: 'gather'|'scout'|'interdiction'|'clear-route'|'generic' }
  function resolveDrop(state, opts) {
    var tile = tileAt(state, opts.x, opts.y);
    if (!tile) return { ok: false, reason: 'No such tile.' };
    var divers = opts.diverIds.map(function (id) { return diverById(state, id); }).filter(Boolean);
    if (!divers.length) return { ok: false, reason: 'No squad selected.' };
    for (var i = 0; i < divers.length; i++) {
      if (!diverAvailable(state, divers[i])) return { ok: false, reason: divers[i].name + ' is not available to drop.' };
    }
    if (state.airship.fuel < TUNABLES.dropFuelCost) {
      return { ok: false, reason: isGrounded(state)
        ? 'Airship is GROUNDED — the tank is dry. Refuel from cargo FUEL (Crew screen) or trade for FUEL; a grounded ship drops no one.'
        : 'Not enough airship fuel for a drop.' };
    }
    var kind = opts.kind || (tile.robotSite && !tile.robotSite.cleared ? 'robot'
      : tile.supplySite && !tile.supplySite.looted ? 'supply'
      : tile.resourceType ? 'gather' : 'generic');
    var reconTier = tile.reconTier || 0;
    state.airship.fuel -= TUNABLES.dropFuelCost;
    state.totalDrops += 1;
    tile.discovered = true;

    var squad = squadScore(state, divers);
    var landMod = landToModifier(opts.land);
    var recon = TUNABLES.reconBonus[reconTier];
    var roll = roll2d20(state.rng);
    var threatPts = tile.threat * TUNABLES.threatWeight;
    if (kind === 'robot') threatPts += TUNABLES.robotThreatBonus;
    if (kind === 'supply') threatPts += TUNABLES.supplyThreatBonus;
    var outcome = Math.round(squad * 4 + landMod + recon + roll.total - threatPts);
    // Amendment: cache and robot dives carry a worse catastrophe weighting —
    // same dice, meaner table. The haul is pitched rich because the ground is.
    if (kind === 'robot') outcome -= TUNABLES.robotOutcomePenalty;
    if (kind === 'supply') outcome -= TUNABLES.supplyOutcomePenalty;
    var band = bandForOutcome(outcome);
    var lines = [];
    lines.push('SQUAD ' + squad.toFixed(2) + ' x4 = ' + (squad * 4).toFixed(1) +
      ' | LAND ' + opts.land + ' -> ' + (landMod >= 0 ? '+' : '') + landMod +
      ' | RECON tier ' + reconTier + ' -> +' + recon +
      ' | ROLL 2d20 [' + roll.dice.join('+') + '] = ' + roll.total +
      ' | THREAT ' + tile.threat + ' x8 = -' + threatPts +
      ' | OUTCOME = ' + outcome + ' -> ' + band + '.');

    if (kind === 'robot') {
      lines.push('CONTACT: machine guardians — sentient robots holding the ruin. They ended the world once; they do not negotiate, and they do not miss.');
    } else if (kind === 'supply') {
      lines.push('CACHE RUN: a rich salvage cache under bad ground — worth the dive, and the ground around it is hungry.');
    }

    var suppressed = band === 'Flawless' || band === 'Success' ? tile.threat
      : band === 'Costly success' ? Math.ceil(tile.threat / 2) : 0;
    var yieldGains = {};
    var baseYield = tile.resourceYield || 0;
    var meanHaul = divers.reduce(function (a, d) { return a + d.stats.HAUL; }, 0) / divers.length;
    if (kind === 'gather' && tile.resourceType && baseYield > 0) {
      var full = baseYield + Math.floor(meanHaul / 2);
      if (band === 'Flawless') yieldGains[tile.resourceType] = full + 4;
      else if (band === 'Success') yieldGains[tile.resourceType] = full;
      else if (band === 'Costly success') yieldGains[tile.resourceType] = Math.floor(full * TUNABLES.costlyYieldFraction);
      if (yieldGains[tile.resourceType]) {
        lines.push('Yield: ' + yieldGains[tile.resourceType] + ' ' + tile.resourceType +
          ' (node ' + baseYield + ' + HAUL bonus ' + Math.floor(meanHaul / 2) + (band === 'Flawless' ? ' + flawless bonus 4' : '') +
          (band === 'Costly success' ? ', halved for costly success' : '') + ').');
        tile.resourceYield = 0; tile.resourceType = null;   // node harvested
      }
    } else if (kind === 'scout') {
      if (band === 'Flawless' || band === 'Success') yieldGains.INTEL = 3;
      else if (band === 'Costly success') yieldGains.INTEL = 1;
      if (yieldGains.INTEL) lines.push('Scout yield: +' + yieldGains.INTEL + ' INTEL.');
      revealRadius(state, opts.x, opts.y, 2);
    } else if (kind === 'interdiction') {
      // §5.4: reward is seized cargo from the hostile table, not salvage.
      if (band === 'Flawless' || band === 'Success' || band === 'Costly success') {
        var seized = { SCRAP: rngInt(state.rng, 4, 10), FUEL: rngInt(state.rng, 2, 6), FOOD: rngInt(state.rng, 0, 4) };
        if (band === 'Costly success') { seized.SCRAP = Math.floor(seized.SCRAP / 2); seized.FUEL = Math.floor(seized.FUEL / 2); seized.FOOD = Math.floor(seized.FOOD / 2); }
        yieldGains = seized;
        state.supply.interdictions += 1;
        if (state.settlement) state.settlement.raidTimer = Math.max(1, state.settlement.raidTimer - 1);
        lines.push('Interdiction seized cargo: ' + JSON.stringify(seized) +
          '. Retaliation: supply exposure rises and the settlement raid timer ticks down (§5.4).');
        tile.isInterdiction = false; tile.threat = clamp(tile.threat - 1, 0, 5);
      }
    } else if (kind === 'clear-route') {
      if (band === 'Flawless' || band === 'Success' || band === 'Costly success') {
        state.supply.status = state.settlement ? 'open' : 'inactive';
        lines.push('Route cleared — supply line is open again.');
      }
    } else if (kind === 'supply' && tile.supplySite) {
      // Amendment: the risky cache. Yield pitched rich (a case-haul, not a
      // node trickle); the meaner table above is the price of reaching it.
      var site = tile.supplySite;
      if (site.looted) {
        lines.push('The cache at ' + site.name + ' was already emptied.');
      } else {
        var sFull = site.amount + Math.floor(meanHaul / 2);
        if (band === 'Flawless') yieldGains[site.resource] = sFull + 4;
        else if (band === 'Success') yieldGains[site.resource] = sFull;
        else if (band === 'Costly success') yieldGains[site.resource] = Math.floor(sFull * TUNABLES.costlyYieldFraction);
        if (yieldGains[site.resource]) {
          lines.push('Cache yield: ' + yieldGains[site.resource] + ' ' + site.resource + ' from ' + site.name +
            ' (cache ' + site.amount + ' + HAUL bonus ' + Math.floor(meanHaul / 2) +
            (band === 'Flawless' ? ' + flawless bonus 4' : '') +
            (band === 'Costly success' ? ', halved for costly success' : '') + '). The cache is emptied.');
          site.looted = true;
        } else {
          lines.push('The squad never reached the cache at ' + site.name + ' — it stays buried. So might the next squad.');
        }
      }
    } else if (kind === 'robot' && tile.robotSite) {
      // Amendment: the tech ruin. Best SCRAP + INTEL in the sector, behind
      // the machines that burned the world. Cleared ruins go dark for good.
      var ruin = tile.robotSite;
      if (ruin.cleared) {
        lines.push(ruin.name + ' has already gone dark — its vaults are empty.');
      } else {
        if (band === 'Flawless') { yieldGains.SCRAP = ruin.scrap + 4; yieldGains.INTEL = ruin.intel; }
        else if (band === 'Success') { yieldGains.SCRAP = ruin.scrap; yieldGains.INTEL = ruin.intel; }
        else if (band === 'Costly success') {
          yieldGains.SCRAP = Math.floor(ruin.scrap * TUNABLES.costlyYieldFraction);
          yieldGains.INTEL = Math.floor(ruin.intel * TUNABLES.costlyYieldFraction);
        }
        if (yieldGains.SCRAP || yieldGains.INTEL) {
          lines.push('Tech salvage: the ruin\'s vaults give up ' + JSON.stringify(yieldGains) +
            ' — pre-Burn machine tech, the richest haul in the sector. The guardians go dark.');
          ruin.cleared = true;
        } else {
          lines.push('The machine guardians hold ' + ruin.name + '. The tech stays behind their guns.');
        }
      }
    }
    // NOTE: yield is NOT banked yet — it is gathered on the ground. It only
    // becomes cargo after the balloon-lift return below (amendment beat).

    // Wounds / deaths per band (§5.1).
    var deaths = [], wounded = [];
    var chronicleDeaths = [];
    if (band === 'Costly success') {
      var lowest = divers.slice().sort(function (a, b) { return a.stats.GRIT - b.stats.GRIT; })[0];
      if (applyWoundCheck(state, lowest, lines, 'Costly success wound') === 'wounded') wounded.push(lowest.name);
    } else if (band === 'Failure') {
      var nW = rngInt(state.rng, 1, 2);
      var sorted = divers.slice().sort(function (a, b) { return a.stats.GRIT - b.stats.GRIT; });
      for (var w = 0; w < Math.min(nW, sorted.length); w++) {
        if (applyWoundCheck(state, sorted[w], lines, 'Failure wound') === 'wounded') wounded.push(sorted[w].name);
      }
      if (rngChance(state.rng, TUNABLES.failureLeftBehindChance)) {
        var left = sorted[0];
        if (left.status !== 'dead') {
          recordDeath(state, left, 'tile (' + opts.x + ',' + opts.y + ')', 'left behind on a failed drop', chronicleDeaths);
          deaths.push(left.name);
          lines.push('DISASTER: ' + left.name + ' was left behind and is dead (10% failure-band risk, §5.1).');
        }
      }
    } else if (band === 'Catastrophe') {
      if (kind === 'robot') {
        // Machines do not miss: against the guardians there is no GRIT save
        // for the point diver. Everyone else still rolls.
        var machineVictim = divers.slice().sort(function (a, b) { return a.stats.GRIT - b.stats.GRIT; })[0];
        recordDeath(state, machineVictim, 'robot ruin at (' + opts.x + ',' + opts.y + ')',
          'cut down by the ruin\'s machine guardians — sentient robots, the thing that burned the world; no GRIT save against machines', chronicleDeaths);
        deaths.push(machineVictim.name);
        lines.push('CATASTROPHE: the machine guardians do not miss — ' + machineVictim.name + ' is cut down with no save.');
        divers = divers.filter(function (d) { return d !== machineVictim; });
      }
      divers.forEach(function (d) {
        var save = makeGritSave(state, d, 0);
        if (!save.success) {
          recordDeath(state, d, 'tile (' + opts.x + ',' + opts.y + ')', 'catastrophe on drop — failed GRIT save (' + save.roll + '+' + save.grit + ' vs ' + save.dc + ')', chronicleDeaths);
          deaths.push(d.name);
          lines.push('CATASTROPHE: ' + d.name + ' failed the GRIT save (' + save.roll + '+' + save.grit + ' vs ' + save.dc + ') and died.');
        } else {
          d.wounds += 1; d.status = 'wounded'; wounded.push(d.name);
          lines.push('CATASTROPHE: ' + d.name + ' survived the GRIT save (' + save.roll + '+' + save.grit + ' vs ' + save.dc + ') but is wounded.');
        }
      });
    }

    // Balloon-lift return (amendment, the Hell Divers beat): the squad fills
    // the caches on the ground, flies them on balloons, and the ship reels
    // them in. Only what survives the ascent becomes cargo. The airship
    // itself never descends and never fights — it waits above the clouds.
    var ascent = null;
    if (Object.keys(yieldGains).length) {
      var aliveAfter = divers.filter(function (d) { return d.status !== 'dead'; });
      var groundYield = clone(yieldGains);
      var trimFraction = 0, trimmed = {};
      if (!aliveAfter.length) {
        trimFraction = 1;
        lines.push('BALLOON LIFT: no diver left alive to fly the caches — the whole haul stays on the ground.');
      } else if (band === 'Costly success' && rngChance(state.rng, TUNABLES.balloonSnagChance)) {
        trimFraction = TUNABLES.balloonSnagTrimFraction;
        lines.push('BALLOON LIFT: a cache balloon snags on the ascent and tears — part of the haul is lost to the wind.');
      } else {
        lines.push('BALLOON LIFT: caches away clean — the balloons rise through the murk and the ship reels in the full haul.');
      }
      if (trimFraction > 0) {
        Object.keys(yieldGains).forEach(function (k) {
          var keep = Math.floor(yieldGains[k] * (1 - trimFraction));
          if (keep < yieldGains[k]) trimmed[k] = yieldGains[k] - keep;
          yieldGains[k] = keep;
        });
        Object.keys(yieldGains).forEach(function (k) { if (yieldGains[k] <= 0) delete yieldGains[k]; });
        if (Object.keys(trimmed).length) {
          lines.push('Balloon lift delivered ' + JSON.stringify(yieldGains) + ' of ' + JSON.stringify(groundYield) +
            ' gathered (lost ' + JSON.stringify(trimmed) + ').');
        }
      }
      ascent = { band: band, trimFraction: trimFraction, groundYield: groundYield, delivered: clone(yieldGains), trimmed: trimmed };
      var overflow = addResources(state, yieldGains);
      if (overflow > 0) lines.push('Cargo full: ' + overflow + ' unit(s) of the delivered haul could not be carried (cargo cap ' + state.airship.cargoCapacity + ').');
    }

    // XP for survivors (§2.2).
    var xpEvents = [];
    divers.forEach(function (d) {
      if (d.status === 'dead') return;
      d.dropsSurvived += 1;
      if (d.status !== 'wounded') d.status = 'dropped';
      var xp = TUNABLES.xpPerDropSurvived + suppressed * TUNABLES.xpPerHostileSuppressed +
        (band === 'Flawless' ? TUNABLES.xpFlawlessBonus : 0);
      gainXp(state, d, xp, xpEvents);
      lines.push(d.name + ' earned ' + xp + ' XP (10 drop + ' + (suppressed * 5) + ' suppression' +
        (band === 'Flawless' ? ' + 25 flawless' : '') + ').');
    });
    xpEvents.forEach(function (e) { lines.push(e); });

    var report = {
      ok: true, kind: kind, turn: state.turn, x: opts.x, y: opts.y, land: opts.land,
      squad: Math.round(squad * 100) / 100, landMod: landMod, reconTier: reconTier, reconBonus: recon,
      dice: roll.dice, rollTotal: roll.total, threat: tile.threat, threatPts: threatPts,
      outcome: outcome, band: band, yield: yieldGains, ascent: ascent, deaths: deaths, wounded: wounded,
      lines: lines, chronicleDeaths: chronicleDeaths
    };
    state.lastReports.push(report);
    checkWinLose(state);
    return report;
  }

  /* ---------------- Settlement (§3.4) ------------------------------------- */
  function foundSettlement(state) {
    if (state.settlement) return { ok: false, reason: 'A settlement already exists in the slice.' };
    var green = tileAt(state, state.greenZone.x, state.greenZone.y);
    if (!green.discovered) return { ok: false, reason: 'The green zone has not been discovered yet.' };
    if (!canAfford(state, TUNABLES.foundCost)) return { ok: false, reason: 'Founding costs ' + JSON.stringify(TUNABLES.foundCost) + '.' };
    payCost(state, TUNABLES.foundCost);
    state.settlement = {
      x: green.x, y: green.y, tier: 1, population: 10, structures: [], garrison: [],
      raidTimer: TUNABLES.raidTimerStart, fallen: false,
      pack_id: PACK_ID, content_version: CONTENT_VERSION
    };
    state.supply.status = 'open';
    return { ok: true, settlement: state.settlement };
  }
  function structureSlots(state) {
    if (!state.settlement) return 0;
    return state.settlement.tier === 1 ? TUNABLES.tier1Slots : TUNABLES.tier2Slots;
  }
  function buildStructure(state, type) {
    var def = STRUCTURE_DEFS[type];
    if (!state.settlement) return { ok: false, reason: 'No settlement.' };
    if (!def) return { ok: false, reason: 'Unknown structure.' };
    if (state.settlement.structures.length >= structureSlots(state)) return { ok: false, reason: 'No free structure slots.' };
    if (!canAfford(state, def.cost)) return { ok: false, reason: 'Cannot afford ' + type + ' (' + JSON.stringify(def.cost) + ').' };
    payCost(state, def.cost);
    state.settlement.structures.push({ type: type, hp: 20, pack_id: PACK_ID, content_version: CONTENT_VERSION });
    return { ok: true, structures: state.settlement.structures.length };
  }
  function upgradeSettlement(state) {
    if (!state.settlement) return { ok: false, reason: 'No settlement.' };
    if (state.settlement.tier >= TUNABLES.settlementTierCap) return { ok: false, reason: 'Slice caps settlements at Tier 2.' };
    if (!canAfford(state, TUNABLES.upgradeTier2Cost)) return { ok: false, reason: 'Upgrade costs ' + JSON.stringify(TUNABLES.upgradeTier2Cost) + '.' };
    payCost(state, TUNABLES.upgradeTier2Cost);
    state.settlement.tier = 2;
    checkWinLose(state);
    return { ok: true, tier: 2 };
  }
  function assignGarrison(state, diverId, on) {
    if (!state.settlement) return { ok: false, reason: 'No settlement.' };
    var d = diverById(state, diverId);
    if (!d || d.status === 'dead') return { ok: false, reason: 'No such diver.' };
    var idx = state.settlement.garrison.indexOf(diverId);
    if (on && idx < 0) {
      if (isEscorting(state, diverId)) return { ok: false, reason: d.name + ' is escorting the supply route.' };
      state.settlement.garrison.push(diverId);
    } else if (!on && idx >= 0) state.settlement.garrison.splice(idx, 1);
    return { ok: true, garrison: state.settlement.garrison.slice() };
  }
  function assignEscort(state, diverId, on) {
    var d = diverById(state, diverId);
    if (!d || d.status === 'dead') return { ok: false, reason: 'No such diver.' };
    var idx = state.supply.escort.indexOf(diverId);
    if (on && idx < 0) {
      if (isGarrisoned(state, diverId)) return { ok: false, reason: d.name + ' is garrisoned.' };
      state.supply.escort.push(diverId);
    } else if (!on && idx >= 0) state.supply.escort.splice(idx, 1);
    return { ok: true, escort: state.supply.escort.slice() };
  }
  function defenseBreakdown(state) {
    var s = state.settlement;
    if (!s) return null;
    var wallSoak = 0, turretSuppression = 0;
    s.structures.forEach(function (st) {
      wallSoak += STRUCTURE_DEFS[st.type].soak;
      turretSuppression += STRUCTURE_DEFS[st.type].suppression;
    });
    var garrisonPower = 0;
    s.garrison.forEach(function (id) {
      var d = diverById(state, id);
      if (d && d.status !== 'dead') {
        garrisonPower += (d.stats.GRIT + d.level) * 2;         // §5.2 garrison term
        var bunker = s.structures.some(function (st) { return st.type === 'BUNKER'; });
        if (bunker) garrisonPower += d.stats.GRIT;            // §3.4 BUNKER: garrison adds GRIT
      }
    });
    // §5.2 formula: DEFENSE = structures (soak + suppression) + garrison term.
    var defense = wallSoak + turretSuppression * TUNABLES.defenseWaves + garrisonPower;
    return { wallSoak: wallSoak, turretSuppressionPerWave: turretSuppression, garrisonPower: garrisonPower, defense: defense };
  }
  function raidForceForTurn(turn) { return 20 + turn * 2; }   // §5.2 scaled by turns survived (interp. slope)

  /* ---------------- Defense resolution (§5.2): 3 waves -------------------- */
  function resolveRaid(state, forceOverride) {
    var s = state.settlement;
    if (!s) return { ok: false, reason: 'No settlement to raid.' };
    var totalForce = forceOverride != null ? forceOverride : raidForceForTurn(state.turn);
    var bd = defenseBreakdown(state);
    var waveForce = totalForce / TUNABLES.defenseWaves;
    var soakLeft = bd.wallSoak;
    var waves = [], lines = [];
    var totalDamage = 0;
    lines.push('RAID: force ' + totalForce + ' in ' + TUNABLES.defenseWaves + ' waves vs DEFENSE ' + bd.defense +
      ' (wall soak ' + bd.wallSoak + ', turret suppression ' + bd.turretSuppressionPerWave + '/wave, garrison ' + bd.garrisonPower + ').');
    for (var w = 1; w <= TUNABLES.defenseWaves; w++) {
      var dmg = Math.max(0, Math.round(waveForce - bd.turretSuppressionPerWave));
      var absorbed = Math.min(soakLeft, dmg);
      soakLeft -= absorbed;
      var overflow = dmg - absorbed;
      totalDamage += overflow;
      waves.push({ wave: w, waveForce: Math.round(waveForce * 10) / 10, damage: dmg, absorbedByWall: absorbed, overflow: overflow });
      lines.push('Wave ' + w + ': force ' + waveForce.toFixed(1) + ' - turret suppression ' + bd.turretSuppressionPerWave +
        ' = ' + dmg + ' damage; walls absorb ' + absorbed + '; overflow ' + overflow + '.');
    }
    var outcome, chronicleDeaths = [];
    if (bd.defense < totalForce * TUNABLES.settlementFallFraction) {
      outcome = 'fallen';
      lines.push('DEFENSE was under 50% of raid force — the settlement FALLS.');
      // Garrison extraction saves (§5.2).
      s.garrison.slice().forEach(function (id) {
        var d = diverById(state, id);
        if (!d || d.status === 'dead') return;
        var save = makeGritSave(state, d, 0);
        if (!save.success) {
          recordDeath(state, d, 'settlement defense', 'settlement fell — failed extraction GRIT save (' + save.roll + '+' + save.grit + ' vs ' + save.dc + ')', chronicleDeaths);
          lines.push(d.name + ' did not make it out (extraction save failed).');
        } else { d.wounds += 1; d.status = 'wounded'; lines.push(d.name + ' extracted, wounded.'); }
      });
      s.structures = []; s.population = 0; s.garrison = []; s.fallen = true;
      state.settlement = null;                       // tile reverts to hostile green zone (§5.2)
      var green = tileAt(state, state.greenZone.x, state.greenZone.y);
      if (green) green.threat = clamp(green.threat + 2, 0, 5);
      state.supply.status = 'inactive';
    } else if (totalDamage > 0) {
      outcome = 'held-damaged';
      // Overflow damages structures first, then population (§5.2).
      var dmgLeft = totalDamage;
      while (dmgLeft >= 20 && s.structures.length) {
        var destroyed = s.structures.pop();
        dmgLeft -= 20;
        lines.push('Structure destroyed by overflow damage: ' + destroyed.type + '.');
      }
      if (dmgLeft > 0 && s.structures.length) {
        s.structures[s.structures.length - 1].hp -= dmgLeft;
        lines.push('Structure damaged: ' + s.structures[s.structures.length - 1].type + ' (-' + dmgLeft + ' hp).');
        dmgLeft = 0;
      }
      if (dmgLeft <= 0 && totalDamage >= 10) {
        var popLoss = Math.min(s.population, Math.floor(totalDamage / 5));
        s.population -= popLoss;
        lines.push('Population loss: ' + popLoss + ' (now ' + s.population + ').');
      }
      // Garrison wound checks on overflow (§5.2).
      if (totalDamage >= 15) {
        s.garrison.slice().forEach(function (id) {
          var d = diverById(state, id);
          if (d && d.status !== 'dead') applyWoundCheck(state, d, lines, 'Raid garrison check');
        });
      }
      state.raidsSurvived += 1;
      if (s.tier === 2) state.raidsSurvivedAtTier2 += 1;
      s.raidTimer = TUNABLES.raidTimerReset + rngInt(state.rng, 0, 2);
    } else {
      outcome = 'held';
      lines.push('Held with structures intact.');
      state.raidsSurvived += 1;
      if (s.tier === 2) state.raidsSurvivedAtTier2 += 1;
      if (state.settlement) state.settlement.raidTimer = TUNABLES.raidTimerReset + rngInt(state.rng, 0, 2);
    }
    var report = { ok: true, turn: state.turn, totalForce: totalForce, defense: bd.defense, waves: waves, outcome: outcome, lines: lines, chronicleDeaths: chronicleDeaths };
    state.lastRaidReport = report;
    checkWinLose(state);
    return report;
  }

  /* ---------------- Supply line (§3.5 / §5.4) ----------------------------- */
  function routeTiles(state) {
    // Manhattan path settlement -> colony (row-first), deterministic.
    if (!state.settlement) return [];
    var pts = [], x = state.settlement.x, y = state.settlement.y;
    pts.push({ x: x, y: y });
    while (x !== state.colonyTile.x) { x += Math.sign(state.colonyTile.x - x); pts.push({ x: x, y: y }); }
    while (y !== state.colonyTile.y) { y += Math.sign(state.colonyTile.y - y); pts.push({ x: x, y: y }); }
    return pts;
  }
  function routeExposure(state) {
    var pts = routeTiles(state);
    if (!pts.length) return 0;
    var avg = pts.reduce(function (a, p) { var t = tileAt(state, p.x, p.y); return a + (t ? t.threat : 0); }, 0) / pts.length;
    return clamp(TUNABLES.exposureBase + avg * TUNABLES.exposurePerRouteThreat +
      state.supply.interdictions * TUNABLES.exposurePerInterdiction, 0, TUNABLES.exposureCap);
  }
  function resolveAmbush(state, ambushForceOverride) {
    var escorts = state.supply.escort.map(function (id) { return diverById(state, id); }).filter(function (d) { return d && d.status !== 'dead'; });
    var escortPower = escorts.reduce(function (a, d) { return a + (d.stats.GRIT + d.level) * 2; }, 0) +
      (escorts.length ? TUNABLES.routePrepBonus : 0);
    var pts = routeTiles(state);
    var avgThreat = pts.length ? pts.reduce(function (a, p) { var t = tileAt(state, p.x, p.y); return a + (t ? t.threat : 0); }, 0) / pts.length : 0;
    var ambushForce = ambushForceOverride != null ? ambushForceOverride : Math.round(10 + avgThreat * 4 + rngInt(state.rng, 0, 8));
    var lines = [], chronicleDeaths = [], outcome;
    lines.push('AMBUSH: escort power ' + escortPower + ' vs ambush force ' + ambushForce + '.');
    if (escortPower >= ambushForce) {
      outcome = 'arrived';
      addResources(state, clone(TUNABLES.shipmentGoods));
      state.supply.shipmentsCompleted += 1;
      escorts.forEach(function (d) { gainXp(state, d, 10, lines); });
      lines.push('Shipment arrives in full; escorts gain 10 XP each.');
    } else if (escortPower >= ambushForce * TUNABLES.ambushLostFraction) {
      outcome = 'arrived-reduced';
      var half = {}; Object.keys(TUNABLES.shipmentGoods).forEach(function (k) { half[k] = Math.floor(TUNABLES.shipmentGoods[k] / 2); });
      addResources(state, half);
      state.supply.shipmentsCompleted += 1;
      escorts.forEach(function (d) { applyWoundCheck(state, d, lines, 'Ambush escort check'); });
      lines.push('Shipment arrives reduced (50%): ' + JSON.stringify(half) + '.');
    } else {
      outcome = 'lost';
      state.supply.status = 'choked';
      escorts.forEach(function (d) {
        var save = makeGritSave(state, d, 0);
        if (!save.success) {
          recordDeath(state, d, 'supply route', 'caravan ambush — failed GRIT save (' + save.roll + '+' + save.grit + ' vs ' + save.dc + ')', chronicleDeaths);
          lines.push(d.name + ' died in the ambush (GRIT save failed).');
        } else { d.wounds += 1; d.status = 'wounded'; lines.push(d.name + ' survived the ambush, wounded.'); }
      });
      lines.push('Shipment lost — route is CHOKED until a drop clears a route tile.');
    }
    var report = { ok: true, turn: state.turn, escortPower: escortPower, ambushForce: ambushForce, outcome: outcome, lines: lines, chronicleDeaths: chronicleDeaths };
    state.lastAmbushReport = report;
    checkWinLose(state);
    return report;
  }
  function processShipment(state, lines) {
    if (!state.settlement || state.supply.status === 'inactive') return null;
    state.supply.cadenceCounter += 1;
    if (state.supply.cadenceCounter < TUNABLES.supplyCadence) return null;
    state.supply.cadenceCounter = 0;
    if (state.supply.status === 'choked') { lines.push('Supply shipment skipped: route is choked.'); return null; }
    var exposure = routeExposure(state);
    if (rngChance(state.rng, exposure)) {
      var rep = resolveAmbush(state);
      rep.lines.forEach(function (l) { lines.push(l); });
      return rep;
    }
    addResources(state, clone(TUNABLES.shipmentGoods));
    state.supply.shipmentsCompleted += 1;
    lines.push('Supply shipment arrived: ' + JSON.stringify(TUNABLES.shipmentGoods) + ' (exposure was ' + Math.round(exposure * 100) + '%).');
    return { outcome: 'arrived-safe' };
  }

  /* ---------------- Trade (§4.1 + off-map markets) ------------------------ */
  // One deal book per partner: Kestrel Colony (on-map) and each off-map
  // radio market. acceptDeal resolves the deal wherever it lives.
  function findDeal(state, dealId) {
    var found = null;
    state.colony.deals.forEach(function (d) { if (d.id === dealId) found = { deal: d, book: state.colony }; });
    (state.markets || []).forEach(function (m) {
      m.deals.forEach(function (d) { if (d.id === dealId) found = { deal: d, book: m }; });
    });
    return found;
  }
  function acceptDeal(state, dealId) {
    var located = findDeal(state, dealId);
    if (!located) return { ok: false, reason: 'No such deal.' };
    var deal = located.deal, book = located.book;
    if (!canAfford(state, deal.wants)) return { ok: false, reason: 'Cannot afford deal wants ' + JSON.stringify(deal.wants) + '.' };
    if (deal.kind === 'diver') {
      if (livingDivers(state).length >= state.airship.crewCapacity) return { ok: false, reason: 'Crew capacity reached (' + state.airship.crewCapacity + ').' };
      if (!deal.diverOffered) return { ok: false, reason: 'Deal has no offered diver.' };
    }
    payCost(state, deal.wants);
    if (deal.kind === 'diver') {
      var nd = clone(deal.diverOffered);
      state.divers.push(nd);
      deal.diverOffered = null;
    } else {
      addResources(state, clone(deal.gives));
    }
    book.reputation = clamp((book.reputation || 0) + 1, TUNABLES.reputationMin, TUNABLES.reputationMax);
    book.deals = book.deals.filter(function (d) { return d.id !== dealId; });
    return { ok: true, deal: deal.id, reputation: book.reputation };
  }

  /* ---------------- Training (§4.2) --------------------------------------- */
  function enqueueTraining(state, guaranteedStat, traineeName) {
    if (state.airship.trainingQueue) return { ok: false, reason: 'Training slot is busy (slice: 1 slot).' };
    if (STATS.indexOf(guaranteedStat) < 0) return { ok: false, reason: 'Pick a guaranteed stat: ' + STATS.join('/') + '.' };
    if (!canAfford(state, TUNABLES.trainingCost)) return { ok: false, reason: 'Training costs ' + JSON.stringify(TUNABLES.trainingCost) + '.' };
    payCost(state, TUNABLES.trainingCost);
    state.airship.trainingQueue = {
      guaranteedStat: guaranteedStat, turnsLeft: TUNABLES.trainingTurns,
      name: traineeName || null, pack_id: PACK_ID, content_version: CONTENT_VERSION
    };
    return { ok: true, queue: clone(state.airship.trainingQueue) };
  }
  function cancelTraining(state) {
    if (!state.airship.trainingQueue) return { ok: false, reason: 'No trainee in queue.' };
    state.airship.trainingQueue = null;   // no refund (interp.)
    return { ok: true };
  }
  function progressTraining(state, lines) {
    var q = state.airship.trainingQueue;
    if (!q) return;
    q.turnsLeft -= 1;
    if (q.turnsLeft > 0) { lines.push('Training: ' + q.turnsLeft + ' turn(s) left.'); return; }
    if (livingDivers(state).length >= state.airship.crewCapacity) {
      q.turnsLeft = 1;
      lines.push('Training complete but crew is full — trainee waits.');
      return;
    }
    var name = q.name || TRAINEE_NAMES[state.nextDiverSeq % TRAINEE_NAMES.length];
    var nd = makeDiver(state, name, 'trained', [TUNABLES.traineeStatMin, TUNABLES.traineeStatMax], 1);
    nd.stats[q.guaranteedStat] = TUNABLES.traineeGuaranteedStat;
    state.divers.push(nd);
    state.airship.trainingQueue = null;
    lines.push('Training complete: ' + nd.name + ' joins the roster (guaranteed ' + q.guaranteedStat + ' 5).');
  }

  /* ---------------- Economy upkeep (amendment 2026-10-30) ----------------- */
  // The four resources stop being counters and become a loop, and the loop
  // is written down every turn in a ledger the UI can show: production in,
  // mouths fed, deficits with teeth. Fuel's teeth are the tank itself —
  // at zero the ship is GROUNDED (moveAirship / resolveDrop refuse).
  function isGrounded(state) { return state.airship.fuel <= 0; }
  function computeUpkeep(state, lines) {
    var ledger = {
      turn: state.turn, foodProduced: 0, rationNeed: 0, settlementNeed: 0, foodEaten: 0,
      foodShortfall: 0, starving: false, starvationStreak: state.starvationStreak || 0,
      population: state.settlement ? state.settlement.population : 0,
      grounded: isGrounded(state), starvationConsequence: null, deaths: []
    };
    if (state.settlement) {
      ledger.foodProduced = TUNABLES.settlementFoodOutput[state.settlement.tier] +
        state.settlement.structures.filter(function (s) { return s.type === 'FARM'; }).length * STRUCTURE_DEFS.FARM.foodPerTurn;
      if (ledger.foodProduced > 0) {
        addResources(state, { FOOD: ledger.foodProduced });
        lines.push('Settlement produced ' + ledger.foodProduced + ' FOOD.');
      }
      // The settlement is mouths too: population eats alongside the crew.
      ledger.settlementNeed = Math.ceil(state.settlement.population / TUNABLES.settlementFoodDivisor);
    }
    ledger.rationNeed = livingDivers(state).length * TUNABLES.foodPerDiverPerTurn;
    var need = ledger.rationNeed + ledger.settlementNeed;
    if (state.resources.FOOD >= need) {
      state.resources.FOOD -= need;
      ledger.foodEaten = need;
      state.starving = false; state.starvationStreak = 0; ledger.starvationStreak = 0;
      if (state.settlement) {
        state.settlement.population += TUNABLES.populationGrowthFed;
        ledger.population = state.settlement.population;
      }
      lines.push('Upkeep: fed ' + need + ' FOOD (' + ledger.rationNeed + ' crew rations' +
        (ledger.settlementNeed ? ' + ' + ledger.settlementNeed + ' settlement mouths' : '') + ').');
    } else {
      ledger.foodEaten = state.resources.FOOD;
      ledger.foodShortfall = need - state.resources.FOOD;
      state.resources.FOOD = 0;
      state.starving = true;
      state.starvationStreak = (state.starvationStreak || 0) + 1;
      ledger.starving = true; ledger.starvationStreak = state.starvationStreak;
      lines.push('STARVATION: ' + ledger.foodShortfall + ' FOOD short (crew rations ' + ledger.rationNeed +
        ' + settlement mouths ' + ledger.settlementNeed + '). Squad NERVE penalty applies until fed.');
      if (state.settlement) {
        var popLoss = Math.min(state.settlement.population, 1 + Math.floor(ledger.foodShortfall / 5));
        state.settlement.population -= popLoss;
        ledger.population = state.settlement.population;
        lines.push('The settlement goes hungry: population -' + popLoss + ' (now ' + state.settlement.population + '). A starving settlement builds nothing and gains no one.');
      }
      if (state.starvationStreak >= TUNABLES.starvationConsequenceStreak) {
        // Hunger stops being a debuff and starts being a casualty list.
        var pool = livingDivers(state);
        if (pool.length) {
          var victim = pool[rngInt(state.rng, 0, pool.length - 1)];
          var save = makeGritSave(state, victim, 0);
          if (!save.success && victim.wounds > 0) {
            recordDeath(state, victim, state.settlement ? 'the settlement' : 'the airship',
              'starved at their post — hunger finished what an earlier wound started', ledger.deaths);
            ledger.starvationConsequence = victim.name + ' died of hunger.';
            lines.push('HUNGER: ' + victim.name + ' — already wounded — did not survive the starvation (GRIT save ' +
              save.roll + '+' + save.grit + ' vs ' + save.dc + ').');
          } else if (!save.success) {
            victim.wounds += 1; victim.status = 'wounded';
            ledger.starvationConsequence = victim.name + ' is wasting (wounded by hunger).';
            lines.push('HUNGER: ' + victim.name + ' is wasting — wounded by starvation (GRIT save failed). Fed turns heal it.');
          } else {
            ledger.starvationConsequence = victim.name + ' holds on through the hunger.';
            lines.push('HUNGER: ' + victim.name + ' holds on (GRIT save ' + save.roll + '+' + save.grit + ' vs ' + save.dc + ').');
          }
        }
      }
    }
    if (ledger.grounded) {
      lines.push('AIRSHIP GROUNDED: tank is dry — no drops, no moves until she is refueled (cargo FUEL on the Crew screen, or trade for FUEL).');
    }
    state.lastUpkeep = ledger;
    return ledger;
  }

  /* ---------------- Win / lose (§1 item 11) ------------------------------- */
  function checkWinLose(state) {
    if (state.gameStatus !== 'playing') return state.gameStatus;
    if (livingDivers(state).length === 0) {
      state.gameStatus = 'lost'; state.endReason = 'Roster emptied — every diver is dead.';
      return state.gameStatus;
    }
    if (state.settlement && state.settlement.tier >= 2 && state.raidsSurvivedAtTier2 > 0) {
      state.gameStatus = 'won'; state.endReason = 'Settlement reached Tier 2 and survived a raid.';
      return state.gameStatus;
    }
    return state.gameStatus;
  }
  function markSettlementFallenLoss(state) {
    // §5.2 says a fall is recoverable in the full design; §1 item 11 lists
    // "settlement falls" as the slice lose condition. Slice rule: falling = lost.
    if (state.gameStatus === 'playing') {
      state.gameStatus = 'lost'; state.endReason = 'The settlement fell.';
    }
  }

  /* ---------------- Turn flow (§6.1) -------------------------------------- */
  // Player actions (orders + drops) happen between turns via the functions above.
  // endTurn runs: raid-timer tick -> World Response -> Chronicle -> next-turn Upkeep.
  function endTurn(state) {
    if (state.gameStatus !== 'playing') return { ok: false, reason: 'Game is over: ' + state.gameStatus + '.' };
    var lines = [];
    var hadSettlement = !!state.settlement;
    var settlementFellThisTurn = false;

    // Raid timer tick (Upkeep item, §6.1.1) then raid in World Response (§6.1.4).
    if (state.settlement) {
      state.settlement.raidTimer -= 1;
      if (state.settlement.raidTimer <= 0) {
        var raid = resolveRaid(state);
        raid.lines.forEach(function (l) { lines.push(l); });
        if (raid.outcome === 'fallen') settlementFellThisTurn = true;
      }
    }
    // Supply shipments + ambush checks (World Response, §5.4).
    processShipment(state, lines);
    // Threat creeps on unexplored tiles (§6.1.4).
    var creeped = 0;
    state.tiles.forEach(function (t) {
      if (!t.discovered && t.terrain !== 'water' && t.threat < 5 && rngChance(state.rng, 0.03)) { t.threat += 1; creeped += 1; }
    });
    if (creeped) lines.push('Threat crept up on ' + creeped + ' unexplored tile(s).');

    // Deaths already wrote tombstones at resolution; Chronicle gives them their beat (§6.1.5).
    state.lastReports.forEach(function (r) { (r.chronicleDeaths || []).forEach(function (l) { lines.push(l); }); });
    if (state.lastRaidReport && state.lastRaidReport.turn === state.turn) {
      state.lastRaidReport.chronicleDeaths.forEach(function (l) { lines.push(l); });
    }
    if (state.lastAmbushReport && state.lastAmbushReport.turn === state.turn) {
      state.lastAmbushReport.chronicleDeaths.forEach(function (l) { lines.push(l); });
    }
    state.chronicle.push({ turn: state.turn, lines: lines.slice() });
    state.lastReports = [];

    if (settlementFellThisTurn && hadSettlement) { markSettlementFallenLoss(state); }
    checkWinLose(state);
    if (state.gameStatus !== 'playing') {
      return { ok: true, turn: state.turn, gameStatus: state.gameStatus, lines: lines };
    }

    // ---- Upkeep for the new turn (§6.1.1) ----
    state.turn += 1;
    state.airship.movedThisTurn = 0;
    // Economy upkeep (amendment): production in, mouths fed, deficits bite.
    var ledger = computeUpkeep(state, lines);
    if (ledger.deaths && ledger.deaths.length && state.chronicle.length) {
      // Hunger deaths get their Chronicle beat in the entry just written.
      ledger.deaths.forEach(function (l) { state.chronicle[state.chronicle.length - 1].lines.push(l); });
    }
    // Wounds heal one point per upkeep; dropped/sat-out divers ready again.
    state.divers.forEach(function (d) {
      if (d.status === 'dead') return;
      if (d.wounds > 0) { d.wounds -= 1; d.status = d.wounds > 0 ? 'wounded' : 'ready'; }
      else if (d.status === 'dropped') d.status = 'ready';
    });
    // Training progresses (§6.1.1).
    progressTraining(state, lines);
    // Deal refresh every 5 turns (§4.1).
    if (state.turn - state.colony.lastRefreshTurn >= TUNABLES.dealRefreshTurns) {
      state.colony.deals = generateDeals(state);
      state.colony.lastRefreshTurn = state.turn;
      lines.push('Colony deal table refreshed.');
    }
    // Off-map markets refresh on their own slower cadence (amendment).
    (state.markets || []).forEach(function (m) {
      if (state.turn - (m.lastRefreshTurn || 1) >= TUNABLES.marketRefreshTurns) {
        refreshMarketDeals(state, m);
        m.lastRefreshTurn = state.turn;
        lines.push(m.name + ' (off-map) deal table refreshed by radio.');
      }
    });
    checkWinLose(state);
    return { ok: true, turn: state.turn, gameStatus: state.gameStatus, lines: lines };
  }

  /* ---------------- Save (§8.1 / §8.2) ------------------------------------ */
  function serialize(state) {
    return JSON.stringify({
      version: SAVE_VERSION, pack_id: PACK_ID, content_version: CONTENT_VERSION, state: state
    });
  }
  function deserialize(json) {
    var doc = typeof json === 'string' ? JSON.parse(json) : json;
    if (!doc || typeof doc !== 'object') throw new Error('Invalid save document.');
    var st = doc.state || doc;
    if (st.version != null && st.version !== SAVE_VERSION) {
      // Additive-only pack rule (§8.2): unknown/newer versions load as legacy stub, never fail hard.
      st.legacyStub = true;
    }
    // Resolve pinned definitions; missing pins fall back to legacy stub (§8.2).
    (st.divers || []).concat(st.tombstones || []).forEach(function (d) {
      if (!d.pack_id) { d.pack_id = 'legacy'; d.legacyStub = true; }
    });
    // Additive v2 backfill: pre-amendment saves gain the radio markets and
    // the starvation streak; tiles without site fields simply have none.
    if (!st.markets) generateTradeMarkets(st);
    if (st.starvationStreak == null) st.starvationStreak = 0;
    return st;
  }

  /* ---------------- Exports ------------------------------------------------ */
  var api = {
    VERSION: SAVE_VERSION, PACK_ID: PACK_ID, CONTENT_VERSION: CONTENT_VERSION,
    TUNABLES: TUNABLES, STRUCTURE_DEFS: STRUCTURE_DEFS, TRAITS: TRAITS, STATS: STATS,
    createGame: createGame, createRng: createRng, rngNext: rngNext, rngInt: rngInt, rngD20: rngD20, roll2d20: roll2d20,
    tileAt: tileAt, livingDivers: livingDivers, diverById: diverById, cargoUsed: cargoUsed,
    canAfford: canAfford, diverAvailable: diverAvailable, isGarrisoned: isGarrisoned, isEscorting: isEscorting,
    xpToNextLevel: xpToNextLevel, xpThresholdForLevel: xpThresholdForLevel, gainXp: gainXp, applyLevelUpChoice: applyLevelUpChoice,
    makeGritSave: makeGritSave, recordDeath: recordDeath,
    moveAirship: moveAirship, refuelAirship: refuelAirship, renameDiver: renameDiver, restDiver: restDiver,
    buyRecon: buyRecon, knownThreat: knownThreat,
    dropZoneTiles: dropZoneTiles, findBestTile: findBestTile, computeLanding: computeLanding, landToModifier: landToModifier,
    squadScore: squadScore, projectedBand: projectedBand, bandForOutcome: bandForOutcome, resolveDrop: resolveDrop,
    foundSettlement: foundSettlement, buildStructure: buildStructure, upgradeSettlement: upgradeSettlement,
    structureSlots: structureSlots, assignGarrison: assignGarrison, assignEscort: assignEscort,
    defenseBreakdown: defenseBreakdown, raidForceForTurn: raidForceForTurn, resolveRaid: resolveRaid,
    routeTiles: routeTiles, routeExposure: routeExposure, resolveAmbush: resolveAmbush,
    acceptDeal: acceptDeal, findDeal: findDeal, enqueueTraining: enqueueTraining, cancelTraining: cancelTraining,
    isGrounded: isGrounded, computeUpkeep: computeUpkeep,
    endTurn: endTurn, checkWinLose: checkWinLose, serialize: serialize, deserialize: deserialize,
    revealRadius: revealRadius
  };
  global.DropZoneCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
