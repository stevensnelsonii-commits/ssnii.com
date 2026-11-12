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
    poolPointWeight: 0.04,                       // pool model (2026-11-07): each committed member past the anchor adds their point value x this to the squad score
    radiationThreatWeight: 4,                    // LIVE MAP (2026-11-07, Steve canon): threat points per POI radiation level — the more radiated the ground, the bigger and badder what lives there; radiation is the monster-scaling input
    depotGuardThreat: 10,                        // MACHINE channel: a standing tech depot's guardians add FIXED threat — machines hold where they stand; this never scales with radiation
    cityGateHeroes: 5,                           // ENDGAME city gate (Steve): a city drop needs FIVE heroes...
    cityGateLevel: 10,                           // ...ALL of them level 10 (the squad key)...
    cityUnlockThings: 12,                        // ...AND this many things done — drops resolved + POIs worked (the progression key). Tunable by design.
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
    moveFuelPerTiles: 1,                         // Steve 2026-11-10 (fix-it-all §2): 1 fuel per tile moved — movement always costs, visibly
    dropFuelCost: 2,                             // §6.1 drops burn fuel (fix-it-all §2: 2 per drop, shown before launch)
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
    marketRefreshTurns: 7,                       // off-map deal tables refresh slower than Kestrel's
    // --- Campaign layer (2026-11-10, Acts 1-2 + co-op seam; Story doc §0-§5) ---
    playerCount: 1,                              // CO-OP SEAM (Rule 21): commanders sharing this campaign, 1-3. Solo-first: 1 is the baseline tuning. NO netcode reads this yet — it is the scaling hook a later co-op build drives.
    playerCountStep: 0.25,                       // each commander past the first multiplies drop threat AND yields (the stakes) by +25% — pressure and payoff scale together, content never gates
    zoneGreenMaxRad: 1,                          // zone ladder (Story §2): POI radiation 0-1 = GREEN...
    zoneYellowMaxRad: 3,                         // ...2-3 = YELLOW, 4 = RED (the books' three colours; yellow is Book 3 text)
    greenPoiFuelCells: 4,                        // fuel-cell stock held by a GREEN building/depot POI — paid once, when first worked; then the site is picked clean (Story §1-§3)
    yellowPoiFuelCells: 2,                       // yellow POIs hold a smaller cell stock
    fallSeverityGreen: 1,                        // fall weather severity by the drop hex's zone tier (Story §2: zone = story tier = weather tier, one number)
    fallSeverityYellow: 1.5,
    fallSeverityRed: 2,
    populationStart: 443,                        // souls aboard at campaign start (Story §1: the book's arithmetic, made the stakes meter — Book 2 text)
    populationCapDisplay: 500,                   // the ship-screen gauge reads against this many berths
    populationDriftPerTurn: 1,                   // the slow decline: -1 soul per turn of campaign time (sickness, age, the arithmetic) — milestones push back
    populationSettlementBonus: 10,               // founding a settlement: families commit, births resume — the meter moves the other way
    populationFarmBonus: 5,                      // each FARM built: fed people stay, and stay alive
    populationTier2Bonus: 15,                    // settlement Tier 2 milestone
    guardThreatTurretTruck: 6,                   // MACHINE channel (Rule 18 as amended): a standing turret truck's FIXED positional threat — never radiation-scaled
    guardThreatAbrams: 8,                        // an M3 Abrams tank holds harder ground than a turret truck
    communalBands: 6,                            // the Communal silo is worked band by band across repeated drops (Story §1, Act 2)
    communalSeedBand: 2,                         // band carrying the seed bank
    communalAiBand: 4,                           // band where the facility AI is reached — the reveal fires here (Story §5)
    communalCryoBand: 5,                         // band carrying the cryo bay
    communalCryoCapsules: 10,                    // ten capsules still functioning (Book 2 text)
    communalBandScrap: 3, communalBandIntel: 1,  // per-band salvage
    communalSeedFood: 8,                         // the seed bank also yields grown stock
    bunkerCryoCapsules: 2,                       // sleepers behind the bunker's cryogenics door
    sleeperWakeCost: { FOOD: 4, SCRAP: 2 },      // waking a sleeper is priced in resources...
    sleeperWakeTurns: 2,                         // ...and in time (they arrive through the wake queue, like training)
    // --- Ship Deck + Heroes (Steve 2026-11-10): book heroes wake from the
    // Communal cryo bay, keep one station each, join drops free at beats or
    // hired for one drop (INTEL + SCRAP by tier; X is the most expensive).
    // Heroes never permanently die in this build (tone law: "generally you
    // won't die") — WORKING: a lethal hit downs them into a Medbay timer.
    heroDownedTurns: 3,                          // turns a downed hero spends in the Medbay before returning
    heroBeatCooldownTurns: 3,                    // turns before a site-beat free join can fire again for a hero
    heroPrices: { 1: { INTEL: 4, SCRAP: 10 }, 2: { INTEL: 8, SCRAP: 20 }, 3: { INTEL: 14, SCRAP: 35 } },
    graveyardScrap: 6,                           // the robot graveyard pays modest salvage, once — dressing, not combat (Story §4)
    midnightFragmentDrops: 3,                    // the rumor chart fragment surfaces after this many resolved drops (Midnight recordings — Story §0/§1)
    // --- Fix-it-all §9 (Steve 2026-11-10): KINETIC LAW — real firearms
    // only, no energy weapons. Battle profiles by weapon class; better
    // weapons are FOUND at POIs (ladder tiers; vault/Communal/depot = top).
    weaponProfiles: {
      ar:      { range: 6, dmg: 1, dcMod: 0 },
      saw:     { range: 6, dmg: 1, dcMod: -1 },  // volume of fire
      shotgun: { range: 3, dmg: 2, dcMod: 0 },   // short + heavy (Blitzer)
      smg:     { range: 4, dmg: 1, dcMod: 0 },
      launcher:{ range: 5, dmg: 2, dcMod: 0 },   // M320 blast
      spr:     { range: 9, dmg: 2, dcMod: 0 },   // long guns
      bolt:    { range: 11, dmg: 3, dcMod: 0 },  // bolt-action tier (vault)
      heavy:   { range: 8, dmg: 4, dcMod: 0 },   // LAW / Stinger / Barrett class
      sidearm: { range: 3, dmg: 1, dcMod: 0 },   // Colt .45 — the book sidearm
      generic: { range: 5, dmg: 1, dcMod: 0 }
    },
    // Found-in-the-world pools by site tier (weapons research 2026-11-10,
    // §4): tier 2 = bunker doors / shallow bands; tier 3 = vault-class
    // ruins, deep Communal bands; tier 4 = the ITC depot vault only.
    weaponFindPools: {
      2: ['M4A1 carbine', 'MP5', 'Mossberg 590A1', 'M27 IAR', 'M110 SASS', 'M320 launcher', 'Mk 12 SPR'],
      3: ['HK416', 'M249 SAW', 'Benelli M1014', 'M24 SWS', 'M72 LAW'],
      4: ['AA-12', 'Barrett M82A1', 'FIM-92 Stinger']
    },
    weaponFindChance: 0.6,                       // at an eligible POI work
    attachmentFindChance: 0.35,                  // optic/muzzle/light pool items (§15)
    throwableFindChance: 0.4,                    // +1-2 throwables at an eligible work (§10)
    c4Damage: 3,                                 // explosives expert charge vs machine/plant/door targets
    c4ChargesPerExpert: 2,                       // per drop
    // --- §10-12: throwables + kit standards --------------------------------
    throwApCost: 2, throwRange: 5, throwRangeExplosives: 7,
    flareTurns: 3,                               // burning turns per placed flare
    kitThrows: {                                 // §12 kit standards AFTER the
      ASSAULT: {}, BLITZER: {}, ENGINEER: { flare: 1 }, // §10 calibration
      EXPLOSIVES: { flare: 1 }, SNIPER: { flare: 1 }    // (Steve 18:23): only
    },                                           // flares are free kit now
    kitSlotType: { ASSAULT: 'frag', BLITZER: 'flash', ENGINEER: 'flare', EXPLOSIVES: 'any', SNIPER: 'flare' },
    // §10 TUNING (Steve 18:23): grenades are SCARCE BUT DEADLY — one kit
    // grenade per diver per drop (explosives carry one of every type and
    // throw further), found grenades rare, flares the common utility.
    grenadeFindChance: 0.12, flareFindChance: 0.4,
    fragDamage: 3,                               // fight-ending vs clusters
    grenadeCarryLimit: 1,                        // §10 carry cap (Steve 18:24): at most ONE grenade-type throwable per diver per drop
    tacLightWeight: 0.5,                         // §15-ext carried tactical light
    sniperFireApCost: 3,                         // §11: the set-up beat
    sniperDmgBonus: 1,
    // --- §13: weight-bound loadouts ----------------------------------------
    carryBase: 12, carryPerGrit: 2,              // bound = base + 2 x GRIT (kg)
    kitBaseWeight: 4,                            // rig + pack + kit, standard issue
    weaponWeights: { ar: 4, saw: 7, shotgun: 4, smg: 3, launcher: 3, spr: 5, bolt: 6, heavy: 7, sidearm: 1, generic: 4 },
    weaponWeightOverrides: { 'AA-12': 5, 'Barrett M82A1': 12, 'M72 LAW': 3, 'FIM-92 Stinger': 7, 'M24 SWS': 6, 'M249 SAW': 7 },
    throwableWeight: 0.5,                        // per carried throwable
    // --- §14: Armory upgrades ------------------------------------------------
    upgradeCosts: [10, 18, 30, 45],              // SCRAP to step +1 / +2 / +3 (+4 = master bench, Armory tier 3)
    maxUpgrade: 3,                               // base cap; the ADVANCED Armory bench raises it to +4
    // --- SHIP AS HOME (Steve 2026-11-10): station tiers, trophies, journal --
    stationIds: ['quarters', 'medbay', 'engineering', 'comms', 'library', 'armory', 'dropbay'],
    stationTierCosts: [12, 28],                  // SCRAP: tier 1 -> 2, tier 2 -> 3
    stationTierNames: {                          // what each fitted tier is CALLED at its station
      quarters:    ['Fitted bunks', 'The warm room'],
      medbay:      ['Sterile ward', 'The full ward'],
      engineering: ['Tuned plant', 'Overbuilt plant'],
      comms:       ['The long ear', 'The deep ear'],
      library:     ['Reading room', 'The deep stacks'],
      armory:      ['Fitted bench', 'Master bench'],
      dropbay:     ['Lit gantry', 'The parade bay']
    },
    shipTierFuelBonus: 5,                        // per Engineering tier above 1: tank max +5
    trophyFindChance: 0.06,                      // trophy-class find while working deep sites (§ loot)
    apexHostileHp: 8,                            // the marked apex on its home ground
    snippetMarkersPerDrop: 2,                    // journal pages seeded per expedition
    // --- §15: attachments + armor --------------------------------------------
    attachmentWeights: { optic: 1, suppressor: 1, brake: 0.5, 'weapon light': 0.5, laser: 0.5 },
    attachmentKinds: ['optic', 'suppressor', 'brake', 'weapon light', 'laser'],
    armorTiers: {
      light:    { label: 'Light chest rig', weight: 2, protection: 0 },
      plate:    { label: 'Plate carrier',   weight: 4, protection: 1 },
      heavy:    { label: 'Heavy plates',    weight: 8, protection: 2 }
    }
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
  // Sleepers woken from the buried cryo bays — the game's own cast (the
  // books supply the capsules, never their names; Rule 13 name law).
  var SLEEPER_NAMES = [
    'Wren Hallis', 'Bram Osei', 'Talia Venn', 'Rurik Saan',
    'Odette Marsh', 'Kian Doyle', 'Sable Iversen', 'Yusuf Adeyemi'
  ];

  /* ---------------- Gear loadouts (2026-11-07) -----------------------------
   * Hand-authored kit for the eight starters: real weapons by model, real
   * rig/pack/kit. The weapon's EFFECT line takes liberties on purpose —
   * reality governs what it is, not what it does down there. Anyone not in
   * this table (trainees, traded, renamed) gets a kit derived from their
   * stats/traits in deriveGear(). */
  var STARTER_GEAR = {
    'Mara Voss':      { weapon: 'M4A1 carbine',    effect: 'never jams. ever.', rig: 'plate carrier',  pack: 'framed ruck',   kit: 'trauma aid bag' },
    'Jace Keller':    { weapon: 'M249 SAW',        effect: 'a wall of lead',    rig: 'plate carrier',  pack: 'ammo ruck',     kit: 'spare barrel kit' },
    'Ines Duarte':    { weapon: 'Mossberg 590A1',  effect: 'opens any door',    rig: 'light chest rig', pack: 'assault pack', kit: 'breaching kit' },
    'Tom Okafor':     { weapon: 'MP5',             effect: 'quiet, up close',   rig: 'plate carrier',  pack: 'aid pack',      kit: 'IFAK + syrettes' },
    'Riley Chen':     { weapon: 'M320 launcher',   effect: 'ends arguments',    rig: 'light rig',       pack: 'day pack',      kit: '40mm bandolier' },
    'Sara Lindqvist': { weapon: 'HK416',           effect: 'runs and runs',     rig: 'plate carrier',  pack: 'aid ruck',      kit: 'IFAK + triage tags' },
    'Dex Marlowe':    { weapon: 'Mk 12 SPR',       effect: 'seen = hit',        rig: 'plate carrier',  pack: 'drag bag',      kit: 'rangefinder' },
    'June Park':      { weapon: 'M27 IAR',         effect: 'metronome fire',    rig: 'plate carrier',  pack: 'standard ruck', kit: 'tool roll' }
  };
  /* ---- HEROES (Ship Deck + Heroes, Steve 2026-11-10) --------------------
   * Extracted from the RECORD ONLY — every row carries its source. A hero
   * with no sourced name, role, or kit is NOT in this table (heroes are
   * sourced-or-absent, never invented). Heroes sleep in NAMED pods at the
   * Communal cryo bay and wake through the same wake queue as generic
   * sleepers; on waking they take one station on the ship deck by sourced
   * role. `archetype`/`weaponClassOf` fills marked GAME LAW are the game's
   * own mapping where the books name a role but no personal weapon model.
   * Rodger's book status (dies in Hell Divers Book 3) is kept honest on his
   * card; the Drop Zone frame is cryo — he slept 350 years and wakes here.
   * HERO FIX (Steve 2026-11-12): the first slate carried three EXTINCTION
   * CYCLE names in a Hell Divers game — Steve ordered them out. The slate
   * is Hell Divers only now; see HERO_ID_MIGRATION below for how old saves
   * are carried across (the retired names survive ONLY in that migration
   * block, as recognition data for legacy saves — never rendered). */
  var HEROES = [
    { id: 'x', name: 'Xavier "X" Rodriguez', shortName: 'X', station: 'armory',
      archetype: 'ASSAULT', weapon: 'M4A1 carbine', tier: 3, level: 4,
      stats: { GRIT: 9, AIM: 8, NERVE: 9, HAUL: 7 }, trait: 'Steady',
      gearEffect: 'the commander\'s carbine — never jams', kit: 'trauma aid bag',
      joinKinds: ['communal'],
      flavor: 'Ninety-six dives. The average Hell Diver got fifteen.',
      source: 'Hell Divers lore doc §0.7 (Loc 354/665) + §9: Commander Xavier "X" Rodriguez, most experienced Hell Diver, 96 dives vs a 15-jump life expectancy. Role/station: the commander keeps the Armory (brief lean). Archetype + M4A1 carbine = GAME LAW mapping — the books never name X\'s personal rifle.' },
    { id: 'rodger', name: 'Rodger', shortName: 'Rodger', station: 'engineering',
      archetype: 'ENGINEER', weapon: 'M4 carbine', tier: 2, level: 3,
      stats: { GRIT: 8, AIM: 7, NERVE: 6, HAUL: 8 }, trait: 'Reckless',
      gearEffect: 'steady under fire', kit: 'tool roll',
      joinKinds: ['depot'],
      flavor: 'Magnolia\'s dive partner. The ship\'s systems answer to him now.',
      source: 'Hell Divers lore doc §9.2 (Book 2 notes, Ch. 14: Magnolia and Rodger escape a Siren to the cryo lab) + §10.5 (Book 3 TEXT, pp.68–69: Rodger in the Room 91 scene). Book status: DIES in Hell Divers Book 3 (lore doc §10.5, p.388 — Magnolia sails for payback) — kept honest here; Drop Zone frame = cryo sleeper woken 350 years on. Station ENGINEERING (the ship\'s systems and the long repairs), ENGINEER archetype and the M4 carbine kit are GAME LAW fills — the books name no personal weapon or ship posting for him.' },
    { id: 'magnolia', name: 'Magnolia', shortName: 'Magnolia', station: 'comms',
      archetype: 'ASSAULT', weapon: 'M4 carbine', tier: 2, level: 3,
      stats: { GRIT: 6, AIM: 10, NERVE: 8, HAUL: 4 }, trait: 'Steady',
      gearEffect: 'light and fast', kit: 'climbing kit',
      joinKinds: [], joinApex: true,
      flavor: 'The diver who listened for survivors — and heard them.',
      source: 'Hell Divers lore doc §9.5 (Book 2 TEXT: her chute cut, p.85; the dive at p.149) + §9.2 (Book 2 notes: the 30-story descent; the cryo lab escape with Rodger) + §10.5 (Book 3 TEXT: she sails the Sea Wolf). Station COMMS — Midnight recordings and intel, the listening post — plus the ASSAULT archetype and M4 carbine kit are GAME LAW mappings: the books name no personal weapon and no ship posting for her. Free-join beat: rides any drop on apex ground (station mechanic, unchanged).' },
    { id: 'tin', name: 'Michael "Tin" Everhart', shortName: 'Tin', station: 'dropbay',
      archetype: 'ASSAULT', weapon: 'M4 carbine', tier: 1, level: 3,
      stats: { GRIT: 8, AIM: 8, NERVE: 7, HAUL: 6 }, trait: 'Steady',
      gearEffect: 'Raptor standard', kit: 'breaching kit',
      joinKinds: ['bunker'],
      flavor: 'The boy called Tin grew up. Raptor Team musters to his word.',
      source: 'Hell Divers lore doc §9.1 (Audible, Ghosts synopsis: Michael Everhart — the boy once known as Tin — grown into the commander of Hell Diver Raptor Team) + §9.5 (Book 2 TEXT, p.294: he names the found ship) + §10.1 (Book 3 synopsis: Commander Michael Everhart). Station DROP BAY — the Raptor commander musters the squads — and the M4 carbine kit are GAME LAW mappings; the books name no personal weapon for him.' },
    { id: 'nick', name: 'Nicholas "Nick" Sansbury Smith', shortName: 'Nick', title: 'The Architect',
      station: 'library', archetype: 'ENGINEER', weapon: 'M4 carbine', tier: 2, level: 3,
      stats: { GRIT: 6, AIM: 6, NERVE: 8, HAUL: 5 }, trait: 'Steady',
      gearEffect: 'the record, kept complete', kit: 'field journal',
      joinKinds: [],
      flavor: 'He wrote the books this war is fought from. Now he keeps their record — in the Library, where the Journal lives.',
      source: 'Steve ruling, 2026-11-12: "Make Nick Sandbury Smith a crew member." / "We\'ll call him The Architect." / "Runs the library." Nicholas Sansbury Smith is the AUTHOR of the Hell Divers books — the one hero whose source is the man who wrote the others. Title "The Architect" and the LIBRARY station are Steve\'s calls (X keeps the Armory, untouched); his bust is drawn from his standard B&W author photo in portraits.js. Archetype/tier/stats = GAME LAW fills by Steve\'s order; the books name no posting for their author.' }
  ];
  var HERO_BY_ID = {};
  HEROES.forEach(function (h) { HERO_BY_ID[h.id] = h; });
  function heroDef(heroId) { return HERO_BY_ID[heroId] || null; }
  function heroPriceOf(def) { return TUNABLES.heroPrices[def.tier] || TUNABLES.heroPrices[1]; }

  /* ================= SHIP AS HOME (Steve 2026-11-10) =====================
   * The ship is home: stations UPGRADE in tiers bought with SCRAP at the
   * station, and every tier changes what the station LOOKS like on the
   * walkable deck (the deck renderer keys distinct prop compositions off
   * the tier — never a mere recolor). Hooks stay small and honest:
   *   ENGINEERING tier -> tank max +5 per tier (shipTierFuelBonus)
   *   MEDBAY tier 2    -> rest costs 1 FOOD per wound (from 2)
   *   MEDBAY tier 3    -> one rest (2 FOOD) clears ALL wounds; downed
   *                       heroes recover 1 turn sooner per tier above 1
   *   ARMORY tier 3    -> the master bench raises the weapon upgrade cap
   *                       from +3 to +4 (the +4 scrap step is in TUNABLES)
   * Quarters / Comms / Drop Bay tiers are VISUAL ONLY and labeled so.
   * Trophies are EARNED, never bought; the Journal collects VERBATIM book
   * quotes (SNIPPETS below — record text only, never paraphrase). */
  function freshShip() {
    var tiers = {};
    TUNABLES.stationIds.forEach(function (id) { tiers[id] = 1; });
    return { tiers: tiers };
  }
  function ensureShip(state) {
    if (!state.ship || typeof state.ship !== 'object') state.ship = freshShip();
    if (!state.ship.tiers) state.ship.tiers = {};
    TUNABLES.stationIds.forEach(function (id) {
      if (!state.ship.tiers[id]) state.ship.tiers[id] = 1;
    });
    return state.ship;
  }
  function stationTier(state, stationId) {
    ensureShip(state);
    return state.ship.tiers[stationId] || 1;
  }
  function stationTierName(state, stationId) {
    var t = stationTier(state, stationId);
    if (t <= 1) return 'Ship-standard';
    return (TUNABLES.stationTierNames[stationId] || [])[t - 2] || ('Tier ' + t);
  }
  function shipFuelMax(state) {
    return TUNABLES.airshipMaxFuel + (stationTier(state, 'engineering') - 1) * TUNABLES.shipTierFuelBonus;
  }
  function weaponUpgradeCap(state) {
    return TUNABLES.maxUpgrade + (stationTier(state, 'armory') >= 3 ? 1 : 0);
  }
  function upgradeStation(state, stationId) {
    if (TUNABLES.stationIds.indexOf(stationId) < 0) return { ok: false, reason: 'No such station.' };
    ensureShip(state);
    var tier = state.ship.tiers[stationId];
    if (tier >= 3) return { ok: false, reason: 'This station is fully fitted — tier 3 is the top of the ladder.' };
    var cost = TUNABLES.stationTierCosts[tier - 1];
    if (state.resources.SCRAP < cost) {
      return { ok: false, reason: 'Fitting the next tier costs ' + cost + ' SCRAP — you have ' + state.resources.SCRAP + ' (short ' + (cost - state.resources.SCRAP) + ').' };
    }
    state.resources.SCRAP -= cost;
    state.ship.tiers[stationId] = tier + 1;
    var note = 'Visual refit — the station looks different on the deck now.';
    if (stationId === 'engineering') {
      state.airship.maxFuel = shipFuelMax(state);
      note = 'Tank max is now ' + state.airship.maxFuel + ' (bigger baffled tanks, fitted in place).';
    } else if (stationId === 'medbay') {
      note = tier + 1 >= 3 ? 'The full ward: one rest (2 FOOD) now clears ALL of a diver\'s wounds, and downed heroes recover a turn sooner.' :
        'Sterile ward: rest now costs 1 FOOD per wound (from 2).';
    } else if (stationId === 'armory') {
      note = tier + 1 >= 3 ? 'Master bench: pooled weapons can now be upgraded to +4.' :
        'Fitted bench — visual refit; the master bench at tier 3 raises the upgrade cap to +4.';
    }
    return { ok: true, station: stationId, tier: tier + 1, cost: cost, name: stationTierName(state, stationId), note: note };
  }

  /* ---------------- Trophies: earned, never bought ------------------------
   * state.trophies = { earned: [{id, kind, name, story, turn}], placed:
   * {slotId: trophyId} }. Sources: apex skulls (the anchor), chart
   * fragments as won, act-completion marks, one memorabilia item per hero
   * woken, and rare trophy-class finds in the loot. Placement is free and
   * unlimited; an unearned trophy can never be placed. */
  var TROPHY_SLOTS = [
    { id: 'mount-apex', label: 'Apex mount' },
    { id: 'mount-second', label: 'Second mount' },
    { id: 'chart-wall', label: 'The chart wall' },
    { id: 'shelf-high', label: 'High shelf' },
    { id: 'shelf-low', label: 'Low shelf' },
    { id: 'glass-case', label: 'Glass case' },
    { id: 'wall-hook', label: 'Wall hook' },
    { id: 'the-nook', label: 'The nook' }
  ];
  function trophySlotDef(slotId) {
    for (var i = 0; i < TROPHY_SLOTS.length; i++) if (TROPHY_SLOTS[i].id === slotId) return TROPHY_SLOTS[i];
    return null;
  }
  function freshTrophies() { return { earned: [], placed: {} }; }
  function ensureTrophies(state) {
    if (!state.trophies || typeof state.trophies !== 'object') state.trophies = freshTrophies();
    if (!Array.isArray(state.trophies.earned)) state.trophies.earned = [];
    if (!state.trophies.placed || typeof state.trophies.placed !== 'object') state.trophies.placed = {};
    return state.trophies;
  }
  function trophyById(state, trophyId) {
    ensureTrophies(state);
    return state.trophies.earned.filter(function (t) { return t.id === trophyId; })[0] || null;
  }
  function awardTrophy(state, spec) {
    ensureTrophies(state);
    if (trophyById(state, spec.id)) return null;      // one of each, ever
    var t = { id: spec.id, kind: spec.kind, name: spec.name, story: spec.story, turn: state.turn };
    state.trophies.earned.push(t);
    return t;
  }
  function placeTrophy(state, trophyId, slotId) {
    ensureTrophies(state);
    if (!trophySlotDef(slotId)) return { ok: false, reason: 'No such display slot.' };
    var t = trophyById(state, trophyId);
    if (!t) return { ok: false, reason: 'That trophy has not been earned — trophies are earned, never bought.' };
    // A trophy lives in exactly one slot; placing it elsewhere moves it.
    Object.keys(state.trophies.placed).forEach(function (s) {
      if (state.trophies.placed[s] === trophyId) delete state.trophies.placed[s];
    });
    state.trophies.placed[slotId] = trophyId;
    return { ok: true, trophy: t, slot: slotId };
  }
  function unplaceTrophy(state, slotId) {
    ensureTrophies(state);
    if (!state.trophies.placed[slotId]) return { ok: false, reason: 'That slot is empty.' };
    var id = state.trophies.placed[slotId];
    delete state.trophies.placed[slotId];
    return { ok: true, trophyId: id };
  }
  var FRAGMENT_TROPHY_STORIES = {
    rumor: 'Word from the Midnight recordings — a bearing the charts do not have. The crew\'s chart of fragments begins here.',
    ai: 'The damaged fragment pried out of the silo AI in the Communal\'s deep bands.',
    city: 'The city chart, taken through the two-key gate.',
    approach: 'The approach window — the last fragment. The way to the Cazadores is known.'
  };
  var FRAGMENT_TROPHY_NAMES = {
    rumor: 'Chart fragment — the rumor', ai: 'Chart fragment — the silo AI',
    city: 'Chart fragment — the city chart', approach: 'Chart fragment — the approach window'
  };
  var HERO_TROPHY_ITEMS = {
    x: 'X\'s spent shell casing', rodger: 'Rodger\'s dive slate',
    magnolia: 'Magnolia\'s signal log', tin: 'Tin\'s Raptor patch'
  };
  // Reconcile sweep: campaign state -> trophies. Idempotent; called at
  // turn/drop settles and on load, so a fragment flag, an act step, or a
  // woken hero ALWAYS has its trophy, whenever it was earned.
  function syncCampaignTrophies(state) {
    ensureTrophies(state);
    var made = [];
    if (state.campaign && state.campaign.fragments) {
      ['rumor', 'ai', 'city', 'approach'].forEach(function (fk) {
        if (state.campaign.fragments[fk]) {
          var t = awardTrophy(state, { id: 'fragment-' + fk, kind: 'fragment', name: FRAGMENT_TROPHY_NAMES[fk], story: FRAGMENT_TROPHY_STORIES[fk] });
          if (t) made.push(t);
        }
      });
      if (state.campaign.act >= 2) {
        var a2 = awardTrophy(state, { id: 'act-2-mark', kind: 'act', name: 'Act II service stripe', story: 'Act II — The Buried World: the squad worked yellow ground and came home to tell it.' });
        if (a2) made.push(a2);
      }
      if (state.campaign.act >= 3) {
        var a3 = awardTrophy(state, { id: 'act-3-mark', kind: 'act', name: 'Act III service stripe', story: 'Act III — The Sea: red ground, worked and survived.' });
        if (a3) made.push(a3);
      }
    }
    ensureHeroes(state);
    HEROES.forEach(function (h) {
      if (state.heroes[h.id] && state.heroes[h.id].woken) {
        var t = awardTrophy(state, {
          id: 'hero-' + h.id, kind: 'hero', name: HERO_TROPHY_ITEMS[h.id],
          story: 'From the day ' + h.name + ' woke at the Communal and took their station aboard.'
        });
        if (t) made.push(t);
      }
    });
    return made;
  }
  // The apex kill, settled: skull trophy + the apex record's own note.
  function awardApexSkull(state, apexId, placeLabel) {
    var rec = (state.apex || []).filter(function (a) { return a.id === apexId; })[0];
    if (!rec || rec.dead) return null;
    rec.dead = true;
    rec.killedTurn = state.turn;
    rec.notes = rec.notes || [];
    rec.notes.push('skull on your wall');
    var t = awardTrophy(state, {
      id: 'skull-' + apexId, kind: 'apex-skull',
      name: (rec.name || 'The unnamed apex') + ' — apex skull',
      story: 'Apex of ' + placeLabel + ' — dropped on turn ' + state.turn + '. Its skull rides the wall now.'
    });
    return t;
  }

  /* ---------------- Lore snippets + the Journal ---------------------------
   * Collectible pages carry VERBATIM book quotes — mined ONLY from the
   * record (the Hell Divers B1 structures harvest §0 TEXT layer and the EC
   * dossiers), each with the source the record gives. NEVER invented,
   * NEVER paraphrased: if the record has no line for a subject, there is
   * no snippet for it. `site` is the ground-phase placement key (matched
   * against the expedition context by snippetSiteMatches); `hint` is the
   * journal silhouette text shown once the snippet's region is known. */
  var SNIPPET_GROUPS = ['SIRENS', 'HEROES', 'PLACES', 'THE WORLD', 'THE SHIP'];
  var SNIPPETS = [
    // SIRENS
    { id: 'siren-vertebrae', group: 'SIRENS', site: 'apex', hint: 'Something marked lives on apex ground. Its body is in the books.',
      text: 'spiked vertebrae jutted from its thin neck like bony fins', source: 'Hell Divers Book 1, Loc 722' },
    { id: 'siren-shriek', group: 'SIRENS', site: 'nest', hint: 'Where Sirens nest, their voices are described exactly.',
      text: 'They communicate through high-pitched shrieks that sound exactly like an emergency siren', source: 'Hell Divers Book 1, Loc 1877' },
    { id: 'siren-sonar', group: 'SIRENS', site: 'nest', hint: 'They hunt without eyes. The books say how.',
      text: "Some sort of sonar, because they don't have eyes.", source: 'Hell Divers Book 1, Loc 1877' },
    { id: 'siren-energy', group: 'SIRENS', site: 'nest', hint: 'What draws them is one word long, and it is about energy.',
      text: "Energy. They're drawn to energy.", source: 'Hell Divers Book 1, Loc 2623' },
    { id: 'siren-nests', group: 'SIRENS', site: 'nest', hint: 'Look up, in the buried interiors — the nests hang overhead.',
      text: 'Several pale, bulb-shaped nests hung overhead', source: 'Hell Divers Book 1, Loc 1740' },
    { id: 'siren-not-robotic', group: 'SIRENS', site: 'machine', hint: 'At the machine ruins: what the Sirens are NOT.',
      text: "There wasn't anything robotic about 'em.", source: 'Hell Divers Book 1, Loc 1189' },
    { id: 'siren-rads', group: 'SIRENS', site: 'rad', hint: 'Hot ground keeps a diver\'s observation about what survives there.',
      text: 'Nothing could survive the rads, especially here.', source: 'Hell Divers Book 1, Loc 728' },
    // HEROES
    { id: 'hero-life-expectancy', group: 'HEROES', site: 'pod', hint: 'At the cryo pods: what a diver\'s life was worth, in jumps.',
      text: 'The average life expectancy for a Hell Diver was fifteen jumps.', source: 'Hell Divers Book 1, Loc 354' },
    { id: 'hero-keep-fighting', group: 'HEROES', site: 'pod', hint: 'The last line of a war, kept where the sleepers wake.',
      text: 'We keep fighting. And we never stop.', source: 'Extinction Age (EC) — closing line, per the EC dossier' },
    { id: 'hero-kryptonite', group: 'HEROES', site: 'graveyard', hint: 'A dying officer\'s last order rests among the graves.',
      text: 'Make sure Kryptonite gets deployed worldwide. Do the right thing.', source: 'Extinction Age (EC) — Jensen\'s dying words, per the EC dossier' },
    // PLACES
    { id: 'place-eggs', group: 'PLACES', site: 'bunker', hint: 'At the Bunkers: what ringed the ITC towers.',
      text: 'they looked like clutches of giant eggs surrounding the ITC towers.', source: 'Hell Divers Book 1, Loc 4576' },
    { id: 'place-shelves', group: 'PLACES', site: 'depot', hint: 'Inside the depots, the shelves still stand as described.',
      text: 'row after row of shelves stacked high with boxes and metal crates', source: 'Hell Divers Book 1, Loc 693' },
    { id: 'place-communal', group: 'PLACES', site: 'communal', hint: 'The Communal has a true name, and a second one it earned.',
      text: 'ITC Communal Thirteen. What became known as the Hilltop Bastion.', source: 'Hell Divers Book 2, p. 182' },
    { id: 'place-factory', group: 'PLACES', site: 'building', hint: 'The surface buildings keep their ITC purpose in the record.',
      text: 'This is an ITC factory on the outskirts of Hades.', source: 'Hell Divers Book 1, Loc 2297' },
    // THE WORLD
    { id: 'world-surface', group: 'THE WORLD', site: 'any', hint: 'Why the ships never land — written on the open ground.',
      text: 'Humans could never return to the poisoned, desolate surface, and they\'d never risk landing the [airship]', source: 'Hell Divers Book 1, Loc 892' },
    { id: 'world-hallucinations', group: 'THE WORLD', site: 'rad', hint: 'Hot ground plays tricks; the books name the mechanism.',
      text: 'High doses of radiation can cause hallucinations.', source: 'Hell Divers Book 1, Loc 1189' },
    { id: 'world-turret', group: 'THE WORLD', site: 'machine', hint: 'The dormant machines were described before they ever woke.',
      text: 'A turret topped a boxy machine that had what appeared to be a cannon of some sort on it.', source: 'Hell Divers Book 1, Loc 3531' },
    // THE SHIP
    { id: 'ship-dying', group: 'THE SHIP', site: 'debris', hint: 'Among the wreckage: what the ship was, to the man who dove for it.',
      text: 'The ship was dying, and if X didn\'t return with more cells, it would be a matter of when, not if, they crashed', source: 'Hell Divers Book 1, Loc 665' },
    { id: 'ship-546', group: 'THE SHIP', site: 'debris', hint: 'Count the souls overhead — the number is in the books.',
      text: 'Twenty thousand feet overhead, 546 men, women, and children were counting on him.', source: 'Hell Divers Book 1, Loc 665' },
    { id: 'ship-two', group: 'THE SHIP', site: 'debris', hint: 'How many airships are left in the entire world?',
      text: 'There are only two airships left in the entire world', source: 'Hell Divers Book 1, Loc 592' }
  ];
  var SNIPPET_BY_ID = {};
  SNIPPETS.forEach(function (s) { SNIPPET_BY_ID[s.id] = s; });
  function snippetDef(id) { return SNIPPET_BY_ID[id] || null; }
  function freshJournal() { return { found: [] }; }   // found: [{id, turn, place}]
  function ensureJournal(state) {
    if (!state.journal || typeof state.journal !== 'object') state.journal = freshJournal();
    if (!Array.isArray(state.journal.found)) state.journal.found = [];
    return state.journal;
  }
  function snippetFound(state, id) {
    ensureJournal(state);
    return state.journal.found.filter(function (f) { return f.id === id; })[0] || null;
  }
  function collectSnippet(state, id, placeLabel) {
    var def = snippetDef(id);
    if (!def) return { ok: false, reason: 'No such page.' };
    if (snippetFound(state, id)) return { ok: false, reason: 'Already in the Journal.' };
    ensureJournal(state).found.push({ id: id, turn: state.turn, place: placeLabel || 'the ground' });
    return { ok: true, snippet: def };
  }
  function journalProgress(state) {
    ensureJournal(state);
    return { found: state.journal.found.length, total: SNIPPETS.length };
  }
  // Placement matching: does this snippet belong on an expedition with
  // this context? ctx = { poiKind, radiation, isApex, hasMachine }.
  function snippetSiteMatches(def, ctx) {
    if (!def || !ctx) return false;
    switch (def.site) {
      case 'any': return true;
      case 'apex': return !!ctx.isApex;
      case 'machine': return !!ctx.hasMachine;
      case 'rad': return (ctx.radiation || 0) >= 3;
      case 'nest': return ctx.poiKind === 'zone' || ctx.poiKind === 'communal';
      case 'pod': return ctx.poiKind === 'communal';   // the pods sleep at the Communal
      default: return ctx.poiKind === def.site;   // communal/graveyard/bunker/depot/building/debris
    }
  }
  // Has the player learned the region a snippet lives in? (Journal hints.)
  function snippetRegionKnown(state, def) {
    ensureJournal(state);
    var pois = state.pois || [];
    function poiKnown(p) {
      var t = tileAt(state, p.x, p.y);
      return !!((t && (t.discovered || (t.reconTier || 0) > 0)) || p.cleared || (p.workedBands || 0) > 0 ||
        (p.doors || []).some(function (d) { return d.state === 'opened'; }));
    }
    function kindKnown(kind) {
      return pois.some(function (p) { return p.kind === kind && poiKnown(p); });
    }
    switch (def.site) {
      case 'any': return (state.totalDrops || 0) >= 1;
      case 'apex': return (state.apex || []).some(function (a) { return (a.notes || []).length > 0 || a.dead; });
      case 'machine': return (state.tiles || []).some(function (t) { return t.robotSite && (t.discovered || (t.reconTier || 0) > 0); });
      case 'rad': return pois.some(function (p) { return (p.radiation || 0) >= 3 && poiKnown(p); });
      case 'nest': return kindKnown('zone') || kindKnown('communal');
      default: return kindKnown(def.site === 'pod' ? 'communal' : def.site);
    }
  }
  function journalView(state) {
    ensureJournal(state);
    return SNIPPET_GROUPS.map(function (g) {
      return {
        group: g,
        entries: SNIPPETS.filter(function (s) { return s.group === g; }).map(function (s) {
          var f = snippetFound(state, s.id);
          if (f) return { def: s, state: 'found', turn: f.turn, place: f.place };
          return { def: s, state: snippetRegionKnown(state, s) ? 'hint' : 'hidden' };
        })
      };
    });
  }
  function freshHeroes() {
    var out = {};
    HEROES.forEach(function (h) {
      out[h.id] = { woken: false, diverId: null, hiredNext: false, freeJoinPending: false, beatReadyTurn: 0 };
    });
    return out;
  }
  /* HERO FIX migration (Steve 2026-11-12): saves written before the fix
   * carry the retired EC hero ids through the whole state — the hero
   * ledger, a thawing wakeQueue, the woken hero DIVER (id tag + name),
   * and the hero keepsake trophy. Additive-backfill rules (§8.2): the
   * hero's progress (woken, diver, XP, wounds, joins) is the player's and
   * is NEVER reset — the record is re-badged onto the replacement hero at
   * the same station/tier, the diver is renamed and re-kitted from the
   * new def (their Armory assignment and level/XP stand), and the old
   * ledger keys are removed so the retired ids exist nowhere in state.
   * Idempotent: once migrated, no old key remains to trigger it again. */
  var HERO_ID_MIGRATION = { panda: 'rodger', fitz: 'magnolia', garcia: 'tin' };
  var RETIRED_HERO_NAMES = {
    panda: 'Carlos "Panda" Spinoza', fitz: 'Joe Fitzpatrick', garcia: 'Sgt. Jose Garcia'
  };
  function migrateHeroIds(state) {
    if (!state.heroes) return;
    Object.keys(HERO_ID_MIGRATION).forEach(function (oldId) {
      var newId = HERO_ID_MIGRATION[oldId];
      var old = state.heroes[oldId];
      if (!old) return;
      var def = heroDef(newId);
      if (old.woken && !(state.heroes[newId] && state.heroes[newId].woken)) {
        state.heroes[newId] = old;
      }
      delete state.heroes[oldId];
      if (state.airship && state.airship.wakeQueue && state.airship.wakeQueue.heroId === oldId) {
        state.airship.wakeQueue.heroId = newId;
      }
      (state.divers || []).concat(state.tombstones || []).forEach(function (d) {
        if (d.hero !== oldId) return;
        d.hero = newId;
        if (def && d.name === RETIRED_HERO_NAMES[oldId]) d.name = def.name;
        if (def) {
          d.archetype = def.archetype;
          d.gear = { weapon: def.weapon, effect: def.gearEffect, rig: 'plate carrier', pack: 'framed ruck', kit: def.kit };
        }
      });
      if (state.trophies && Array.isArray(state.trophies.earned)) {
        state.trophies.earned.forEach(function (t) {
          if (t.id === 'hero-' + oldId && def) { t.id = 'hero-' + newId; t.name = HERO_TROPHY_ITEMS[newId]; }
        });
        if (state.trophies.placed) Object.keys(state.trophies.placed).forEach(function (s) {
          if (state.trophies.placed[s] === 'hero-' + oldId) state.trophies.placed[s] = 'hero-' + newId;
        });
      }
    });
  }
  function ensureHeroes(state) {
    migrateHeroIds(state);
    var fresh = freshHeroes();
    if (!state.heroes) state.heroes = fresh;
    else Object.keys(fresh).forEach(function (k) { if (!state.heroes[k]) state.heroes[k] = fresh[k]; });
    if (!state.deck) state.deck = { station: 'quarters' };
    return state.heroes;
  }
  function heroDiverOf(state, heroId) {
    ensureHeroes(state);
    var rec = state.heroes[heroId];
    if (!rec || !rec.diverId) return null;
    return diverById(state, rec.diverId);
  }
  // Unwoken heroes still in their named pods at the Communal cryo bay.
  function heroPods(state) {
    ensureHeroes(state);
    return HEROES.filter(function (h) { return !state.heroes[h.id].woken; });
  }
  function setDeckStation(state, stationId) {
    ensureHeroes(state);
    state.deck.station = stationId;
    return state.deck;
  }

  function deriveGear(d) {
    var weapon = 'M4 carbine', effect = 'steady under fire';
    if (d.traits.indexOf('Medic') >= 0) { weapon = 'M4 carbine'; effect = 'fires and patches'; }
    else if (d.stats.AIM >= 6) { weapon = 'M110 SASS'; effect = 'long reach'; }
    else if (d.stats.GRIT >= 6) { weapon = 'M870 shotgun'; effect = 'the last word'; }
    else if (d.stats.NERVE >= 6) { weapon = 'MP7'; effect = 'no hesitation'; }
    var kit = d.traits.indexOf('Medic') >= 0 ? 'IFAK + aid pouch'
      : d.traits.indexOf('Reckless') >= 0 ? 'breaching kit' : 'tool roll';
    return { weapon: weapon, effect: effect, rig: 'plate carrier',
      pack: d.stats.HAUL >= 6 ? 'big ruck' : 'day pack', kit: kit };
  }
  function gearFor(d) {
    if (!d) return null;
    if (d.gear) return d.gear;
    if (STARTER_GEAR[d.name]) return STARTER_GEAR[d.name];
    return deriveGear(d);
  }
  /* ---------------- Archetypes + weapon classes (§9) -----------------------
   * Archetype is a DATA FIELD on the diver: ASSAULT (rifle line),
   * BLITZER (shotgun: short/heavy/fast), ENGINEER (support: systems worked
   * cheaper, field support actions), EXPLOSIVES (C4 charges vs machines,
   * nests, plants, doors). Assigned from the authored kit for starters;
   * derived for everyone else. */
  var ARCHETYPES = {
    ASSAULT: { label: 'Assault', icon: '⚔' },
    BLITZER: { label: 'Blitzer', icon: '💥' },
    ENGINEER: { label: 'Engineer', icon: '🔧' },
    EXPLOSIVES: { label: 'Explosives Expert', icon: '🧨' },
    SNIPER: { label: 'Sniper', icon: '🎯' }
  };
  var STARTER_ARCHETYPES = {
    'Mara Voss': 'ASSAULT', 'Jace Keller': 'ASSAULT', 'Ines Duarte': 'BLITZER',
    'Tom Okafor': 'ASSAULT', 'Riley Chen': 'EXPLOSIVES', 'Sara Lindqvist': 'ENGINEER',
    'Dex Marlowe': 'SNIPER', 'June Park': 'ENGINEER'
  };
  function weaponClassOf(weapon) {
    var w = String(weapon || '');
    if (/Colt|M1911/.test(w)) return 'sidearm';
    if (/M249/.test(w)) return 'saw';
    if (/Barrett|LAW|Stinger/.test(w)) return 'heavy';
    if (/M24|Mk 13/.test(w)) return 'bolt';
    if (/590A1|M870|M1014|AA-12|shotgun/i.test(w)) return 'shotgun';
    if (/MP5|MP7/.test(w)) return 'smg';
    if (/M320/.test(w)) return 'launcher';
    if (/Mk 12|M110/.test(w)) return 'spr';
    if (/M4|HK416|M27/.test(w)) return 'ar';
    return 'generic';
  }
  function weaponProfileFor(weapon) {
    return TUNABLES.weaponProfiles[weaponClassOf(weapon)] || TUNABLES.weaponProfiles.generic;
  }
  var WEAPON_TIERS = {
    'M4 carbine': 1, 'MP7': 1, 'M870 shotgun': 1, 'Mk 12 SPR': 1, 'Colt .45': 1,
    'M4A1 carbine': 2, 'MP5': 2, 'Mossberg 590A1': 2, 'M27 IAR': 2, 'M110 SASS': 2, 'M320 launcher': 2,
    'HK416': 3, 'M249 SAW': 3, 'Benelli M1014': 3, 'M24 SWS': 3, 'M72 LAW': 3,
    'AA-12': 4, 'Barrett M82A1': 4, 'FIM-92 Stinger': 4
  };
  function weaponTierOf(weapon) { return WEAPON_TIERS[weapon] || 1; }
  function archetypeFor(d) {
    if (!d) return 'ASSAULT';
    if (STARTER_ARCHETYPES[d.name]) return STARTER_ARCHETYPES[d.name];
    var g = gearFor(d);
    var wc = g ? weaponClassOf(g.weapon) : 'ar';
    if (wc === 'shotgun') return 'BLITZER';
    if (wc === 'launcher') return 'EXPLOSIVES';
    if (d.traits && d.traits.indexOf('Medic') >= 0) return 'ENGINEER';
    if (g && /tool roll/i.test(g.kit || '')) return 'ENGINEER';
    return 'ASSAULT';
  }
  // A member's point value: the price of committing them to a drop. Stat
  // total, plus a rank premium as they level (2026-11-07 pool model).
  function diverValue(d) {
    var v = 0;
    STATS.forEach(function (s) { v += d.stats[s]; });
    return v + (d.level - 1) * 4;
  }
  function squadPool(state, diverIds) {
    var total = 0;
    diverIds.forEach(function (id) { var d = diverById(state, id); if (d) total += diverValue(d); });
    return total;
  }

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
    if (diver && diver.hero) {
      // HERO LAW (this build): a hero never permanently dies — a lethal hit
      // downs them; the ship winches them out and the Medbay timer runs.
      // No tombstone, no population loss.
      diver.wounds = 0;
      diver.status = 'downed';
      // SHIP AS HOME: a fitted Medbay brings heroes back sooner (floor 1).
      diver.downedTurns = Math.max(1, TUNABLES.heroDownedTurns - (stationTier(state, 'medbay') - 1));
      var hLine = diver.name + ' is DOWN at ' + place + ' (' + cause + ') — but a hero does not die down there: ' +
        'winched out and evac\'d to the ship\'s Medbay, out for ' + diver.downedTurns + ' turns.';
      if (chronicleLines) chronicleLines.push(hLine);
      return { heroDowned: true, id: diver.id, name: diver.name, downedTurns: diver.downedTurns };
    }
    // The population meter counts every soul: a death aboard is a death
    // in the count (campaign layer, 2026-11-10).
    if (state.population != null) state.population = Math.max(0, state.population - 1);
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
      gear: STARTER_GEAR[name] || null,
      archetype: STARTER_ARCHETYPES[name] || null,
      pack_id: PACK_ID, content_version: CONTENT_VERSION
    };
  }
  // Every diver carries an archetype (§9): starters authored above; anyone
  // else derives from kit/traits the first time anyone asks.
  function ensureArchetype(d) {
    if (d && !d.archetype) d.archetype = archetypeFor(d);
    return d ? d.archetype : 'ASSAULT';
  }

  /* ---------------- Armory + loadouts (§§13-15) ----------------------------
   * The Armory is the ship's pool: everything found banks here on
   * extraction; nothing is owned by the finder. A diver's loadout =
   * PRIMARY + SECONDARY slots (defaults: their authored gun + the book
   * sidearm, Colt .45), an armor tier, and pooled attachments fitted to a
   * pooled primary. Every kilo counts against the carry bound. */
  function freshArmory() {
    // §10 calibration: grenade stock starts in SINGLE DIGITS — five
    // grenades in the inventory is significant. Flares are ship-standard
    // issue and never counted here.
    return { weapons: [], attachments: [], throwables: { frag: 3, flash: 2, conc: 2, flare: 0 }, tacLights: 2, nextSeq: 1 };
  }
  function ensureArmory(state) {
    if (!state.armory) state.armory = freshArmory();
    if (!state.armory.throwables) state.armory.throwables = { frag: 0, flash: 0, conc: 0, flare: 0 };
    if (!state.armory.weapons) state.armory.weapons = [];
    if (!state.armory.attachments) state.armory.attachments = [];
    if (state.armory.tacLights == null) state.armory.tacLights = 0;
    if (!state.armory.nextSeq) state.armory.nextSeq = 1;
    return state.armory;
  }
  // §15-ext: carried tactical lights are pooled; a diver carries at most one.
  function tacLightsAssigned(state) {
    return (state.divers || []).filter(function (d) { return d.tacLight; }).length;
  }
  function assignTacLight(state, diverId, on, opts) {
    var d = diverById(state, diverId);
    if (!d) return { ok: false, reason: 'No such diver.' };
    if (on && !d.tacLight && tacLightsAssigned(state) >= ensureArmory(state).tacLights) {
      return { ok: false, reason: 'No carried tac light free in the Armory — every pooled light is already carried.' };
    }
    d.tacLight = !!on;
    if (!opts || !opts.auto) d.customized = true;
    return { ok: true };
  }
  function armoryItem(state, id) {
    ensureArmory(state);
    return state.armory.weapons.filter(function (w) { return w.id === id; })[0] || null;
  }
  function armoryAddWeapon(state, name) {
    var a = ensureArmory(state);
    var item = { id: 'armory-' + (a.nextSeq++), name: name, level: 0, attachments: {} };
    a.weapons.push(item);
    return item;
  }
  function armoryAddAttachment(state, kind) {
    var a = ensureArmory(state);
    var item = { id: 'att-' + (a.nextSeq++), kind: kind };
    a.attachments.push(item);
    return item;
  }
  var DEFAULT_SECONDARY = 'Colt .45';
  function loadoutOf(d) {
    if (!d.loadout) d.loadout = { primaryItemId: null, secondaryItemId: null };
    return d.loadout;
  }
  function effectiveWeapon(state, d, slot) {
    var lo = loadoutOf(d);
    var itemId = slot === 'secondary' ? lo.secondaryItemId : lo.primaryItemId;
    if (itemId) {
      var item = armoryItem(state, itemId);
      if (item) return { name: item.name, level: item.level || 0, attachments: item.attachments || {}, itemId: item.id, isDefault: false };
    }
    if (slot === 'secondary') return { name: DEFAULT_SECONDARY, level: 0, attachments: {}, itemId: null, isDefault: true };
    var g = gearFor(d);
    return { name: g ? g.weapon : 'M4 carbine', level: 0, attachments: {}, itemId: null, isDefault: true };
  }
  function weaponWeightOf(name) {
    if (TUNABLES.weaponWeightOverrides[name] != null) return TUNABLES.weaponWeightOverrides[name];
    return TUNABLES.weaponWeights[weaponClassOf(name)] || 4;
  }
  function attachmentsWeight(att) {
    var sum = 0;
    Object.keys(att || {}).forEach(function (slot) { sum += TUNABLES.attachmentWeights[att[slot]] || 0; });
    return sum;
  }
  function armorOf(d) {
    if (d.armor && TUNABLES.armorTiers[d.armor]) return d.armor;
    var g = gearFor(d);
    return g && /light/.test(g.rig || '') ? 'light' : 'plate';
  }
  function armorProtection(d) { return TUNABLES.armorTiers[armorOf(d)].protection; }
  function kitThrowsFor(arch) { return TUNABLES.kitThrows[arch] || TUNABLES.kitThrows.ASSAULT; }
  // Grenade packs (§10 calibration + carry cap): a diver's pack holds pool
  // grenades drawn at the Armory. At most grenadeCarryLimit grenade-type
  // throwables per diver, of their archetype's slot type (EXPLOSIVES: any).
  function grenadePackOf(d) {
    if (!d.grenadePack) d.grenadePack = { frag: 0, flash: 0, conc: 0 };
    return d.grenadePack;
  }
  function grenadePackCount(d) {
    var p = grenadePackOf(d);
    return (p.frag || 0) + (p.flash || 0) + (p.conc || 0);
  }
  function assignGrenade(state, diverId, type, delta, opts) {
    var d = diverById(state, diverId);
    if (!d) return { ok: false, reason: 'No such diver.' };
    if (['frag', 'flash', 'conc'].indexOf(type) < 0) return { ok: false, reason: 'Flares are ship-standard — they never come out of the grenade pool.' };
    var arch = ensureArchetype(d);
    var slot = TUNABLES.kitSlotType[arch];
    if (slot !== 'any' && slot !== type) {
      return { ok: false, reason: 'The kit slot of ' + d.name + ' takes ' + slot + ' grenades (archetype standard) — ' + type + ' does not fit it.' };
    }
    var pack = grenadePackOf(d);
    var a = ensureArmory(state);
    if (delta > 0) {
      if (grenadePackCount(d) + delta > TUNABLES.grenadeCarryLimit) {
        return { ok: false, reason: 'Carry cap: at most ' + TUNABLES.grenadeCarryLimit + ' grenade per diver per drop — ' + d.name + ' is already carrying one.' };
      }
      if ((a.throwables[type] || 0) < delta) {
        return { ok: false, reason: 'The Armory holds ' + (a.throwables[type] || 0) + ' ' + type + ' grenade(s) — not enough. Grenades are scarce; finds are how the pool grows.' };
      }
      // (slot-fit wording lives in the branch above)
      a.throwables[type] -= delta; pack[type] += delta;
    } else if (delta < 0) {
      var back = Math.min(pack[type] || 0, -delta);
      pack[type] -= back; a.throwables[type] = (a.throwables[type] || 0) + back;
    }
    if (!opts || !opts.auto) d.customized = true;
    return { ok: true };
  }
  function loadoutWeight(state, d) {
    var prim = effectiveWeapon(state, d, 'primary');
    var sec = effectiveWeapon(state, d, 'secondary');
    var kit = kitThrowsFor(ensureArchetype(d));
    var throwCount = Object.keys(kit).reduce(function (a, k) { return a + kit[k]; }, 0) + grenadePackCount(d);
    return TUNABLES.kitBaseWeight + TUNABLES.armorTiers[armorOf(d)].weight +
      weaponWeightOf(prim.name) + attachmentsWeight(prim.attachments) +
      weaponWeightOf(sec.name) + throwCount * TUNABLES.throwableWeight +
      (d.tacLight ? TUNABLES.tacLightWeight : 0);
  }
  function carryBound(d) { return TUNABLES.carryBase + TUNABLES.carryPerGrit * (d.stats.GRIT || 3); }
  function loadoutCheck(state, diverIds) {
    return (diverIds || []).map(function (id) {
      var d = diverById(state, id);
      if (!d) return null;
      var w = loadoutWeight(state, d), b = carryBound(d);
      return { id: id, name: d.name, weight: Math.round(w * 2) / 2, bound: b, over: Math.max(0, Math.round((w - b) * 2) / 2) };
    }).filter(Boolean);
  }
  function slotFits(slot, weaponName) {
    var wc = weaponClassOf(weaponName);
    if (slot === 'primary') return wc !== 'sidearm';
    return wc === 'sidearm' || wc === 'smg';
  }
  function assignedItemIds(state) {
    var used = {};
    (state.divers || []).forEach(function (d) {
      var lo = loadoutOf(d);
      if (lo.primaryItemId) used[lo.primaryItemId] = d.id;
      if (lo.secondaryItemId) used[lo.secondaryItemId] = d.id;
    });
    return used;
  }
  function assignWeapon(state, diverId, slot, itemId, opts) {
    var d = diverById(state, diverId);
    if (!d) return { ok: false, reason: 'No such diver.' };
    var lo = loadoutOf(d);
    if (itemId) {
      var item = armoryItem(state, itemId);
      if (!item) return { ok: false, reason: 'That weapon is not in the Armory.' };
      if (!slotFits(slot, item.name)) return { ok: false, reason: 'The ' + item.name + ' does not fit the ' + slot + ' slot.' };
      var used = assignedItemIds(state);
      if (used[itemId] && used[itemId] !== diverId) {
        var holder = diverById(state, used[itemId]);
        return { ok: false, reason: 'The ' + item.name + ' is already on ' + (holder ? holder.name : 'another diver') + ' — unassign it there first.' };
      }
    }
    if (slot === 'secondary') lo.secondaryItemId = itemId; else lo.primaryItemId = itemId;
    if (!opts || !opts.auto) d.customized = true;
    return { ok: true };
  }
  function setArmor(state, diverId, tier, opts) {
    var d = diverById(state, diverId);
    if (!d || !TUNABLES.armorTiers[tier]) return { ok: false, reason: 'No such armor tier.' };
    d.armor = tier;
    if (!opts || !opts.auto) d.customized = true;
    return { ok: true };
  }
  var ATTACHMENT_SLOTS = { optic: 'optic', suppressor: 'muzzle', brake: 'muzzle', 'weapon light': 'light', laser: 'light' };
  function fitAttachment(state, itemId, attachmentId) {
    var item = armoryItem(state, itemId);
    if (!item) return { ok: false, reason: 'That weapon is not in the Armory.' };
    var a = ensureArmory(state);
    var att = a.attachments.filter(function (x) { return x.id === attachmentId; })[0];
    if (!att) return { ok: false, reason: 'That attachment is not in the Armory pool.' };
    var slot = ATTACHMENT_SLOTS[att.kind];
    if (item.attachments[slot]) return { ok: false, reason: 'The ' + slot + ' slot already holds a ' + item.attachments[slot] + ' — remove it first.' };
    item.attachments[slot] = att.kind;
    a.attachments = a.attachments.filter(function (x) { return x !== att; });
    return { ok: true, slot: slot, kind: att.kind };
  }
  function removeAttachment(state, itemId, slot) {
    var item = armoryItem(state, itemId);
    if (!item || !item.attachments[slot]) return { ok: false, reason: 'Nothing fitted there.' };
    var kind = item.attachments[slot];
    delete item.attachments[slot];
    armoryAddAttachment(state, kind);
    return { ok: true, kind: kind };
  }
  // §14: upgrades live on the pooled weapon; profile steps damage-first.
  function upgradedProfile(base, level) {
    if (typeof base === 'string') base = TUNABLES.weaponProfiles[weaponClassOf(base)] || TUNABLES.weaponProfiles.generic;
    var p = { range: base.range, dmg: base.dmg, dcMod: base.dcMod || 0 };
    if (level >= 1) p.dcMod -= 1;                  // reliability / zeroing
    if (level >= 2) p.dmg += 1;                    // damage step
    if (level >= 3) { p.range += 1; p.dcMod -= 1; } // the full work-over
    if (level >= 4) p.dmg += 1;                    // master bench (Armory tier 3): the barrel step
    return p;
  }
  function upgradeWeapon(state, itemId) {
    var item = armoryItem(state, itemId);
    if (!item) return { ok: false, reason: 'That weapon is not in the Armory.' };
    var level = item.level || 0;
    var cap = weaponUpgradeCap(state);
    if (level >= cap) return { ok: false, reason: 'The ' + item.name + ' is already at +' + cap + ' — the top of this bench.' +
      (cap < 4 ? ' The Armory\'s master bench (tier 3) raises the cap to +4.' : '') };
    var cost = TUNABLES.upgradeCosts[level];
    if (state.resources.SCRAP < cost) {
      return { ok: false, reason: 'Upgrading the ' + item.name + ' to +' + (level + 1) + ' costs ' + cost + ' SCRAP — you have ' + state.resources.SCRAP + ' (' + (cost - state.resources.SCRAP) + ' short).' };
    }
    var base = TUNABLES.weaponProfiles[weaponClassOf(item.name)];
    var before = upgradedProfile(base, level);
    state.resources.SCRAP -= cost;
    item.level = level + 1;
    var after = upgradedProfile(base, item.level);
    return { ok: true, cost: cost, before: before, after: after, level: item.level };
  }
  // Effective battle profile: class profile + upgrade steps + attachments.
  function effectiveProfile(state, d, slot, dist) {
    var w = effectiveWeapon(state, d, slot || 'primary');
    var base = TUNABLES.weaponProfiles[weaponClassOf(w.name)] || TUNABLES.weaponProfiles.generic;
    var p = upgradedProfile(base, w.level || 0);
    var att = w.attachments || {};
    if (att.optic) { p.range += 1; p.dcMod -= 1; }
    if (att.muzzle === 'brake') p.dcMod -= 1;
    if (att.light === 'laser' && (dist == null || dist <= 3)) p.dcMod -= 1;
    p.weapon = w.name; p.level = w.level || 0; p.attachments = att;
    p.suppressed = att.muzzle === 'suppressor';
    p.hasLight = att.light === 'weapon light';
    return p;
  }
  // §13-ext AUTO-EQUIP ALL: fair spread, weight-legal, OK-not-optimal.
  // Worst-armed divers draw first; nobody's default is taken away; an item
  // is only assigned when it upgrades that diver and the whole kit stays
  // within their bound. One sensible attachment per pooled primary.
  function autoEquip(state, diverIds) {
    ensureArmory(state);
    var lines = [];
    var divers = (diverIds || []).map(function (id) { return diverById(state, id); }).filter(Boolean);
    var pref = { ASSAULT: ['ar', 'smg'], BLITZER: ['shotgun'], ENGINEER: ['ar', 'saw', 'smg'], EXPLOSIVES: ['launcher', 'heavy', 'ar'], SNIPER: ['spr', 'bolt', 'ar'] };
    function freeItems() {
      var used = assignedItemIds(state);
      return state.armory.weapons.filter(function (w) { return !used[w.id]; });
    }
    function tryAssign(d, slot, item) {
      var lo = loadoutOf(d);
      var prev = slot === 'secondary' ? lo.secondaryItemId : lo.primaryItemId;
      if (slot === 'secondary') lo.secondaryItemId = item.id; else lo.primaryItemId = item.id;
      if (loadoutWeight(state, d) > carryBound(d)) {
        if (slot === 'secondary') lo.secondaryItemId = prev; else lo.primaryItemId = prev;
        return false;
      }
      return true;
    }
    // Primaries: worst-armed first (fair spread beats best-in-slot hoarding).
    var byTier = divers.slice().sort(function (a, b) {
      return weaponTierOf(effectiveWeapon(state, a, 'primary').name) - weaponTierOf(effectiveWeapon(state, b, 'primary').name);
    });
    byTier.forEach(function (d) {
      var arch = ensureArchetype(d);
      var curTier = weaponTierOf(effectiveWeapon(state, d, 'primary').name);
      var candidates = freeItems().filter(function (w) {
        return slotFits('primary', w.name) && weaponTierOf(w.name) > curTier &&
          (pref[arch] || []).indexOf(weaponClassOf(w.name)) >= 0;
      }).sort(function (a, b) {
        // Archetype class preference first, then smallest sufficient upgrade.
        var pa = (pref[arch] || []).indexOf(weaponClassOf(a.name)) - (pref[arch] || []).indexOf(weaponClassOf(b.name));
        return pa !== 0 ? pa : weaponTierOf(a.name) - weaponTierOf(b.name);
      });
      if (candidates.length && tryAssign(d, 'primary', candidates[0])) {
        lines.push(d.name + ' draws the ' + candidates[0].name + ' from the Armory.');
      }
    });
    // Secondaries from what remains (compact classes only).
    byTier.forEach(function (d) {
      var candidates = freeItems().filter(function (w) { return slotFits('secondary', w.name); })
        .sort(function (a, b) { return weaponWeightOf(a.name) - weaponWeightOf(b.name); });
      if (candidates.length && tryAssign(d, 'secondary', candidates[0])) {
        lines.push(d.name + ' takes the ' + candidates[0].name + ' as a secondary.');
      }
    });
    // One sensible attachment per pooled primary, weight permitting.
    divers.forEach(function (d) {
      var w = effectiveWeapon(state, d, 'primary');
      if (!w.itemId) return;
      var arch = ensureArchetype(d);
      var want = arch === 'SNIPER' ? 'optic' : (arch === 'BLITZER' ? 'weapon light' : 'optic');
      var att = state.armory.attachments.filter(function (x) { return x.kind === want; })[0] ||
        state.armory.attachments[0];
      if (!att) return;
      var item = armoryItem(state, w.itemId);
      var slot = ATTACHMENT_SLOTS[att.kind];
      if (item.attachments[slot]) return;
      var before = loadoutWeight(state, d);
      var fitted = fitAttachment(state, w.itemId, att.id);
      if (fitted.ok && loadoutWeight(state, d) > carryBound(d)) {
        removeAttachment(state, w.itemId, slot);
      } else if (fitted.ok) {
        lines.push(d.name + ' takes the pooled ' + att.kind + ' on the ' + item.name + '.');
      }
    });
    divers.forEach(function (d) { d.customized = false; });
    return { ok: true, lines: lines };
  }
  function gearLineFor(state, d) {
    var w = effectiveWeapon(state, d, 'primary');
    var line = w.name + (w.level ? ' +' + w.level : '');
    var att = w.attachments || {};
    var parts = [];
    if (att.optic) parts.push(att.optic);
    if (att.muzzle) parts.push(att.muzzle);
    if (att.light) parts.push(att.light);
    if (parts.length) line += ' · ' + parts.join(' · ');
    return line;
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
    // Live map layer (2026-11-07): POIs + apex fixtures ride the same rng
    // stream, so placement stays a pure function of the seed.
    seedPois(state);
    seedApex(state);
  }
  function revealRadius(state, cx, cy, r) {
    for (var y = cy - r; y <= cy + r; y++) {
      for (var x = cx - r; x <= cx + r; x++) {
        var t = tileAt(state, x, y);
        if (t && Math.abs(x - cx) + Math.abs(y - cy) <= r + 1) t.discovered = true;
      }
    }
  }

  /* ---------------- Live map: POIs, radiation, cities, apex (2026-11-07) --
   * THE MAP IS ONE CANONICAL LIVE ASSET (Steve): `state.pois` is the single
   * POI list every screen reads — map, briefing and debrief all render from
   * it, and drops mutate it (see the sync at the end of resolveDrop). POIs
   * are the sector's notable ruins: a warehouse, a grain silo, a four-store
   * small-town strip (the STORES group — store-to-store exploration), three
   * ruined houses, a quonset barn, a tech depot, five debris piles, and two
   * city-ruin zones. Drops happen in small towns and nowheresville; cities
   * are ENDGAME, gated (see cityGate).
   *
   * RADIATION (Steve canon): every POI carries a radiation level — a
   * gradient across the map, cities hottest. Radiation is the FAUNA scaling
   * input: poiThreatBonus() is what the drop math reads, and the more
   * radiated the ground, the bigger and badder what lives there. MACHINES
   * are a separate channel: robot/depot threat is FIXED by where they stand
   * (TUNABLES.robotThreatBonus / depotGuardThreat) and never scales with
   * radiation. What lives on any of this ground is NOT named here — the
   * books farm owns fauna; this layer only says how big/bad.
   *
   * APEX (Steve canon): the biggest ones are KNOWN — persistent fixtures
   * on the hottest ground, shown on the map by default. Individual NAMES
   * are still a GAP in every source — apex records ship with name: null,
   * never invented. The CLASS intel is now book-sourced: SIRENS (Hell
   * Divers Book 1 text, lore doc §0.6) — see APEX_INTEL at seedApex.
   * Encounter notes still come from actual play only.
   *
   * Placement is deterministic (the sector rng stream). Pre-POI saves are
   * backfilled in deserialize() from a same-seed scratch game — the live
   * sector itself is never regenerated or reset. */
  var POI_BUILDINGS = [
    { building: 'warehouse', label: 'Warehouse',        kind: 'building', sizeClass: 'L', radiation: 1 },
    { building: 'silo',      label: 'Grain Silo',       kind: 'building', sizeClass: 'T', radiation: 3 },
    { building: 'store_a',   label: 'Storefront',       kind: 'building', sizeClass: 'S', radiation: 0, group: 'stores' },
    { building: 'store_b',   label: 'Storefront',       kind: 'building', sizeClass: 'S', radiation: 1, group: 'stores' },
    { building: 'store_c',   label: 'Storefront',       kind: 'building', sizeClass: 'S', radiation: 2, group: 'stores' },
    { building: 'store_d',   label: 'Storefront',       kind: 'building', sizeClass: 'S', radiation: 1, group: 'stores' },
    { building: 'house_a',   label: 'Ruined House',     kind: 'building', sizeClass: 'M', radiation: 1 },
    { building: 'house_b',   label: 'Ruined House',     kind: 'building', sizeClass: 'S', radiation: 3 },
    { building: 'house_c',   label: 'Ruined House',     kind: 'building', sizeClass: 'S', radiation: 0 },
    { building: 'barn',      label: 'Quonset Barn',     kind: 'building', sizeClass: 'M', radiation: 2 },
    { building: 'depot',     label: 'Tech Depot',       kind: 'depot',    sizeClass: 'M', radiation: 2 }
  ];
  var POI_DEBRIS_RADIATION = [0, 1, 2, 1, 0];
  var POI_SEED_STATES = { store_b: 'looted', house_a: 'cleared', silo: 'occupied' };

  function seedPois(state) {
    if (state.pois && state.pois.length) return state.pois;
    var rng = state.rng;
    var reserved = {};
    reserved[key(state.airship.x, state.airship.y)] = true;
    if (state.greenZone) reserved[key(state.greenZone.x, state.greenZone.y)] = true;
    if (state.colonyTile) reserved[key(state.colonyTile.x, state.colonyTile.y)] = true;
    if (state.interdictionTile) reserved[key(state.interdictionTile.x, state.interdictionTile.y)] = true;
    state.tiles.forEach(function (t) { if (t.supplySite || t.robotSite) reserved[key(t.x, t.y)] = true; });
    function free(t, needRuin) {
      return !!t && !reserved[key(t.x, t.y)] && t.terrain !== 'water' &&
        !t.isGreenZone && !t.isColony && !t.isInterdiction && (!needRuin || t.terrain === 'ruin') &&
        Math.abs(t.x - state.airship.x) + Math.abs(t.y - state.airship.y) > 3;   // the start clearing stays clear
    }
    var ruinTiles = state.tiles.filter(function (t) { return free(t, true); })
      .sort(function (a, b) { return (a.y - b.y) || (a.x - b.x); });
    var landTiles = state.tiles.filter(function (t) { return free(t, false); })
      .sort(function (a, b) { return (a.y - b.y) || (a.x - b.x); });
    var src = ruinTiles.length >= 14 ? ruinTiles : landTiles;
    var used = {};
    function take(t) { used[key(t.x, t.y)] = true; return t; }
    function spread(pool, n, minGap) {
      // Deterministic shuffle first (same rng stream): a sorted sweep
      // clusters picks along the first rows; a shuffled greedy pass
      // distributes them across the whole sector.
      var deck = pool.slice();
      for (var s = deck.length - 1; s > 0; s--) {
        var r = rngInt(rng, 0, s);
        var tmp = deck[s]; deck[s] = deck[r]; deck[r] = tmp;
      }
      var picked = [];
      for (var gap = minGap; gap >= 0 && picked.length < n; gap--) {
        for (var k = 0; k < deck.length && picked.length < n; k++) {
          var t = deck[k];
          if (used[key(t.x, t.y)]) continue;
          var okGap = true;
          for (var j = 0; j < picked.length; j++) {
            if (Math.abs(picked[j].x - t.x) + Math.abs(picked[j].y - t.y) < gap) { okGap = false; break; }
          }
          if (okGap) { picked.push(t); take(t); }
        }
      }
      return picked;
    }
    function townRun(pool) {
      var byRow = {};
      pool.forEach(function (t) { if (!used[key(t.x, t.y)]) (byRow[t.y] = byRow[t.y] || []).push(t); });
      var runs = [];
      Object.keys(byRow).forEach(function (yk) {
        var row = byRow[yk].slice().sort(function (a, b) { return a.x - b.x; });
        var runStart = 0;
        for (var i = 1; i <= row.length; i++) {
          if (i === row.length || row[i].x !== row[i - 1].x + 1) {
            if (i - runStart >= 4) runs.push(row.slice(runStart, runStart + 4));
            runStart = i;
          }
        }
      });
      if (!runs.length) return null;
      // The town is a place you travel TO: prefer a strip well clear of the
      // start clearing; pick deterministically among the candidates.
      var farRuns = runs.filter(function (run) {
        return Math.abs(run[0].x - state.airship.x) + Math.abs(run[0].y - state.airship.y) >= 6;
      });
      var choices = farRuns.length ? farRuns : runs;
      return choices[rngInt(rng, 0, choices.length - 1)];
    }
    var pois = [];
    function addPoi(def, tile, extra) {
      var poi = { id: 'poi-' + (pois.length + 1), kind: def.kind, building: def.building || null,
        label: def.label, group: def.group || null, zone: def.zone || null, sizeClass: def.sizeClass || null,
        x: tile.x, y: tile.y, radiation: def.radiation,
        state: POI_SEED_STATES[def.building] || 'standing',
        fuelCells: (def.kind === 'building' || def.kind === 'depot') ? fuelCellsFor(def.radiation) : 0,
        pack_id: PACK_ID, content_version: CONTENT_VERSION };
      if (extra) Object.keys(extra).forEach(function (k) { poi[k] = extra[k]; });
      pois.push(poi); tile.poiId = poi.id;
      return poi;
    }
    // Town strip first (placement anchor): 4 adjacent storefronts.
    var town = townRun(ruinTiles) || townRun(landTiles);
    var storeDefs = POI_BUILDINGS.filter(function (d) { return d.group === 'stores'; });
    if (town) town.forEach(function (t, i) { take(t); addPoi(storeDefs[i], t); });
    // City zones: far corners of the ruin field — hottest ground on the map.
    var far = ruinTiles.filter(function (t) {
        return !used[key(t.x, t.y)] &&
          (!state.colonyTile || Math.abs(t.x - state.colonyTile.x) + Math.abs(t.y - state.colonyTile.y) >= 4);
      })
      .sort(function (a, b) {
        var da = Math.abs(a.x - state.airship.x) + Math.abs(a.y - state.airship.y);
        var db = Math.abs(b.x - state.airship.x) + Math.abs(b.y - state.airship.y);
        return (db - da) || (a.y - b.y) || (a.x - b.x);
      });
    var cityTiles = [];
    for (var ci = 0; ci < far.length && cityTiles.length < 2; ci++) {
      var ct = far[ci];
      if (cityTiles.length && Math.abs(cityTiles[0].x - ct.x) + Math.abs(cityTiles[0].y - ct.y) < 10) continue;
      cityTiles.push(ct); take(ct);
    }
    cityTiles.forEach(function (t, i) {
      addPoi({ kind: 'zone', label: 'City Ruins', zone: 'city', radiation: 4 }, t,
        { label: 'City Ruins — ' + (t.y <= 11 ? 'North' : 'South') });
    });
    // Singles: warehouse, silo, houses, barn, depot — spread across the sector.
    var singleDefs = POI_BUILDINGS.filter(function (d) { return !d.group; });
    var spots = spread(src, singleDefs.length, 5);
    singleDefs.forEach(function (d, i) { if (spots[i]) addPoi(d, spots[i]); });
    // Debris piles scattered on open land near the set.
    var debrisSpots = spread(landTiles, POI_DEBRIS_RADIATION.length, 3);
    debrisSpots.forEach(function (t, i) {
      var poi = addPoi({ kind: 'debris', building: 'debris_' + 'abc'[i % 3], label: 'Debris Pile', radiation: POI_DEBRIS_RADIATION[i] }, t);
      if (i === 2) poi.state = 'picked';       // one pile already picked clean — state reads at a glance
      else poi.state = 'unsearched';
    });
    // Campaign classes (2026-11-10): the bunker, the Communal, and the
    // robot graveyard ride the same deterministic placement helper the
    // save backfill uses — no extra rng draws here.
    placeCampaignPois(state, pois);
    state.pois = pois;
    return pois;
  }
  function poiAt(state, x, y) {
    var list = state.pois || [];
    for (var i = 0; i < list.length; i++) if (list[i].x === x && list[i].y === y) return list[i];
    return null;
  }
  // FAUNA channel: radiation -> threat. (Machines are NOT this — see header.)
  function poiThreatBonus(state, x, y) {
    var p = poiAt(state, x, y);
    return p ? p.radiation * TUNABLES.radiationThreatWeight : 0;
  }
  // Progression key counter: one "thing" per drop resolved + per POI worked.
  function countThing(state) {
    if (!state.mapProgress) state.mapProgress = { things: 0 };
    state.mapProgress.things += 1;
  }
  // ENDGAME gate (Steve): BOTH keys must read complete — the squad key
  // (5 selected heroes, all at the level cap) and the progression key
  // (TUNABLES.cityUnlockThings things done). Pure read; resolveDrop enforces.
  function cityGate(state, diverIds) {
    var levels = [];
    (diverIds || []).forEach(function (id) {
      var d = diverById(state, id);
      if (d && d.status !== 'dead') levels.push(d.level);
    });
    var heroes = levels.length;
    var minLevel = heroes ? Math.min.apply(null, levels) : 0;
    var things = state.mapProgress ? state.mapProgress.things : 0;
    var squadOk = heroes >= TUNABLES.cityGateHeroes && minLevel >= TUNABLES.cityGateLevel;
    var progressOk = things >= TUNABLES.cityUnlockThings;
    return { unlocked: squadOk && progressOk, squadOk: squadOk, progressOk: progressOk,
      heroes: heroes, heroesNeeded: TUNABLES.cityGateHeroes, levels: levels,
      minLevel: minLevel, levelNeeded: TUNABLES.cityGateLevel,
      things: things, thingsNeeded: TUNABLES.cityUnlockThings };
  }
  /* ---------------- Campaign layer: zones, objective, population ---------
   * (2026-11-10 — DROP-ZONE-STORY-AND-PROGRESSION.md §0-§5, Rules 20-21.)
   * The campaign is ONE hunt — find the islands of the people who harvest
   * the frozen — tracked as chart fragments on the one canonical state.
   * This build earns the first two fragments (rumor, AI) and lays the
   * co-op seam; Acts 3-4 content and all netcode are later briefs. */

  // Zone ladder: a POI's radiation band IS its campaign tier (Story §2).
  function zoneTierFor(radiation) {
    var r = radiation || 0;
    if (r <= TUNABLES.zoneGreenMaxRad) return 'green';
    if (r <= TUNABLES.zoneYellowMaxRad) return 'yellow';
    return 'red';
  }
  function poiZoneTier(poi) { return poi ? zoneTierFor(poi.radiation) : 'green'; }
  function tileZoneTier(state, x, y) { return poiZoneTier(poiAt(state, x, y)); }
  // Fall weather severity follows the drop hex's zone tier (Story §2:
  // electrical storms are the green zone's apex hazard and stay dangerous
  // everywhere — hotter ground, worse sky). The descent reads this one
  // number; the weather system itself is untouched.
  function fallSeverity(state, x, y) {
    var tier = tileZoneTier(state, x, y);
    var mult = tier === 'red' ? TUNABLES.fallSeverityRed
      : tier === 'yellow' ? TUNABLES.fallSeverityYellow : TUNABLES.fallSeverityGreen;
    return { tier: tier, multiplier: mult };
  }
  // The green zones are running out (Book 2 text): green POIs hold a finite
  // fuel-cell stock, paid once when first worked. This is the count the
  // map's green-fuel meter reads.
  function remainingGreenFuel(state) {
    var sources = 0, cells = 0;
    (state.pois || []).forEach(function (p) {
      if ((p.fuelCells || 0) > 0 && poiZoneTier(p) === 'green') { sources += 1; cells += p.fuelCells; }
    });
    return { sources: sources, cells: cells };
  }
  // MACHINE channel for the new POI classes (Rule 18 as amended): guards
  // are a list on the POI record — form + FIXED threat + active flag.
  // Positional only: radiation never enters this sum.
  function activeGuards(poi) {
    return (poi && poi.guards) ? poi.guards.filter(function (g) { return g.active; }) : [];
  }
  function poiGuardThreat(state, poi) {
    return activeGuards(poi).reduce(function (a, g) { return a + (g.threat || 0); }, 0);
  }
  function makeGuard(form) {
    return { form: form, active: true,
      threat: form === 'M3 Abrams tank' ? TUNABLES.guardThreatAbrams : TUNABLES.guardThreatTurretTruck };
  }
  // CO-OP SEAM (Rule 21): one multiplier, applied at drop resolution to
  // threat AND to yields — each commander past the first raises pressure
  // and stakes together. Solo (playerCount 1) is exactly x1: the baseline
  // tuning never moves. A netcode build will drive playerCount from the
  // joined squad; here it is a TUNABLE on the one canonical state.
  function coopMultiplier(state) {
    var n = clamp((TUNABLES.playerCount | 0) || 1, 1, 3);
    return 1 + (n - 1) * TUNABLES.playerCountStep;
  }
  // Campaign state defaults — shared by createGame and the save backfill,
  // so an old save and a new game read identically. Never consumes rng.
  function ensureCampaign(st) {
    if (!st.campaign) {
      st.campaign = { act: 1, fragments: { rumor: false, ai: false, city: false, approach: false },
        aiFound: false, revealSeen: false };
    }
    if (!st.campaign.fragments) st.campaign.fragments = { rumor: false, ai: false, city: false, approach: false };
    if (st.population == null) st.population = TUNABLES.populationStart;
    return st.campaign;
  }
  function chartFragmentCount(state) {
    var f = (state.campaign && state.campaign.fragments) || {};
    return (f.rumor ? 1 : 0) + (f.ai ? 1 : 0) + (f.city ? 1 : 0) + (f.approach ? 1 : 0);
  }
  // Has any YELLOW-tier POI been worked? That is Act 2's door (Story §1):
  // the buried world opens when the squad first works hot buried ground.
  function yellowWorked(state) {
    return (state.pois || []).some(function (p) {
      if (poiZoneTier(p) !== 'yellow') return false;
      // Debris never counts: it is scavenged dressing, not a worked site —
      // and the seed pre-picks one pile as flavor, which must not fake
      // the campaign milestone.
      if (p.kind === 'debris' || p.kind === 'graveyard' || p.kind === 'zone') return false;
      if (p.kind === 'bunker') return (p.doors || []).some(function (d) { return d.state === 'opened'; });
      if (p.kind === 'communal') return (p.workedBands || 0) > 0;
      return p.state === 'looted' || p.state === 'cleared';
    });
  }
  function deriveAct(state) {
    var c = ensureCampaign(state);
    if (c.act < 2 && yellowWorked(state)) c.act = 2;
    return c.act;
  }
  // Apex intel has two tenses (Story §7): what the ship believes in Act 1,
  // and what the AI's testimony makes of it after the reveal. The record
  // carries both; the card shows the campaign's current tense.
  function apexIntelFor(state, a) {
    if (state.campaign && state.campaign.revealSeen && a.intelPost && a.intelPost.length) return a.intelPost;
    return a.intel || [];
  }
  // Fuel-cell stock a POI of this radiation band starts with (0 on red).
  function fuelCellsFor(radiation) {
    var tier = zoneTierFor(radiation);
    return tier === 'green' ? TUNABLES.greenPoiFuelCells
      : tier === 'yellow' ? TUNABLES.yellowPoiFuelCells : 0;
  }
  // The bunker's doors, named as the books name them (Book 2 Prologue):
  // the stores door (food, water and medical supplies laid down for five
  // hundred years), the seed vault, and the door marked CRYOGENICS.
  function makeBunkerDoors() {
    return [
      { key: 'stores', label: 'Stores — food, water & medical', state: 'sealed', yield: { FOOD: 12 } },
      { key: 'seed', label: 'Seed Vault', state: 'sealed', yield: { FOOD: 6, INTEL: 4 } },
      { key: 'cryo', label: 'Cryogenics', state: 'sealed', yield: {}, capsules: TUNABLES.bunkerCryoCapsules }
    ];
  }
  /* Deterministic, rng-free placement for the campaign POI classes —
   * shared by seedPois (new games) and deserialize (backfill into existing
   * saves), so both paths land the same classes the same way and the live
   * rng stream is never touched. Picks run off tile state only: no POI
   * yet, no site, no water, clear of the start clearing; the Communal
   * wants the far ground, the bunker mid-field, the graveyard anywhere. */
  function placeCampaignPois(state, pois) {
    pois = pois || state.pois || [];
    function has(kind) { return pois.some(function (p) { return p.kind === kind; }); }
    var used = {};
    pois.forEach(function (p) { used[key(p.x, p.y)] = true; });
    function candidates(minDist) {
      return state.tiles.filter(function (t) {
        return !used[key(t.x, t.y)] && !t.poiId && t.terrain !== 'water' &&
          !t.isGreenZone && !t.isColony && !t.isInterdiction && !t.supplySite && !t.robotSite &&
          Math.abs(t.x - state.airship.x) + Math.abs(t.y - state.airship.y) >= minDist;
      }).sort(function (a, b) {
        var da = Math.abs(a.x - state.airship.x) + Math.abs(a.y - state.airship.y);
        var db = Math.abs(b.x - state.airship.x) + Math.abs(b.y - state.airship.y);
        return (db - da) || (a.y - b.y) || (a.x - b.x);
      });
    }
    function gapOk(t, minGap) {
      return pois.every(function (p) { return Math.abs(p.x - t.x) + Math.abs(p.y - t.y) >= minGap || p.kind === 'debris' || p.kind === 'graveyard'; });
    }
    function place(kind, def, extra) {
      if (has(kind)) return null;
      var pool = candidates(def.minDist).filter(function (t) { return gapOk(t, def.minGap); });
      if (!pool.length) pool = candidates(4);
      if (!pool.length) return null;
      var t = pool[0];
      var poi = { id: 'poi-' + kind + '-' + (t.x) + '-' + (t.y), kind: kind, building: def.building,
        label: def.label, group: null, zone: null, sizeClass: def.sizeClass || 'M',
        x: t.x, y: t.y, radiation: def.radiation, state: def.state, fuelCells: 0,
        pack_id: PACK_ID, content_version: CONTENT_VERSION };
      if (extra) Object.keys(extra).forEach(function (k) { poi[k] = extra[k]; });
      if ((kind === 'bunker' || kind === 'communal') && !poi.fuelCells) poi.fuelCells = fuelCellsFor(def.radiation);
      pois.push(poi); t.poiId = poi.id; used[key(t.x, t.y)] = true;
      return poi;
    }
    place('communal', { building: 'communal', label: 'Communal Silo', radiation: 3, state: 'standing', sizeClass: 'S', minDist: 10, minGap: 5 }, {
      bandsTotal: TUNABLES.communalBands, workedBands: 0, seedBankTaken: false, cryoReached: false,
      cryoBay: { capsules: TUNABLES.communalCryoCapsules },
      guards: [makeGuard('M3 Abrams tank'), makeGuard('turret truck')]
    });
    place('bunker', { building: 'bunker', label: 'ITC Bunker', radiation: 2, state: 'standing', minDist: 7, minGap: 5 }, {
      doors: makeBunkerDoors(), guards: [makeGuard('turret truck')]
    });
    place('graveyard', { building: 'graveyard', label: 'Machine Graveyard', radiation: 1, state: 'unsearched', minDist: 5, minGap: 3 }, {
      guards: []
    });
    state.pois = pois;
    return pois;
  }

  /* Sourced class intel for the apex fixtures — Hell Divers Book 1 TEXT
   * (goals/drop-zone-prototype/files/HELL-DIVERS-B1-STRUCTURES-LORE.md
   * §0.6; Kindle locs 722/728/1740/1877/2623/3037). Facts only: the
   * individual apex stays UNNAMED in every source (name: null — GAP),
   * and Sirens are fauna, explicitly not machines (Loc 1189). */
  var APEX_INTEL = [
    'Class: SIREN — eyeless; it hunts by sonar.',
    'Its shriek sounds like an emergency siren.',
    'Drawn to energy.',
    'Some are winged.',
    'Nests: pale, bulb-shaped, hung overhead.',
    'Spiked vertebrae jut from its neck like bony fins.'
  ];
  /* Post-reveal intel — Book 2 TEXT (§9.5 of the lore doc): what the
   * facility AI's testimony adds once the squad reaches it. Sourced facts
   * only, in the game's own voice; it is testimony, flagged as such. */
  var APEX_INTEL_POST = [
    'Class: SIREN — they were people. Modified people, made to survive down here. (The AI\'s testimony.)',
    'Engineered in the buried communal silos to survive hostile ground.',
    'They were meant to sleep five hundred years. They were woken centuries early.',
    'Eyeless; they hunt by sonar, and they are drawn to energy — dark and quiet is harder to find.',
    'They shy from flare light.',
    'Some are winged. The nests are pale bulbs, hung overhead.'
  ];
  function seedApex(state) {
    if (state.apex && state.apex.length) {
      // Top up class intel on records seeded before the Book 1 text landed.
      state.apex.forEach(function (a) {
        if (!a.intel) a.intel = APEX_INTEL.slice();
        if (!a.intelPost) a.intelPost = APEX_INTEL_POST.slice();
      });
      return state.apex;
    }
    var pois = state.pois || [];
    var hot = null;
    pois.forEach(function (p) { if (p.zone !== 'city' && (!hot || p.radiation > hot.radiation)) hot = p; });
    var city = null;
    pois.forEach(function (p) { if (!city && p.zone === 'city') city = p; });
    var homes = [];
    if (city) homes.push(city);
    if (hot && (!city || hot.id !== city.id)) homes.push(hot);
    state.apex = homes.slice(0, 2).map(function (p, i) {
      return { id: 'apex-' + (i + 1), name: null, x: p.x, y: p.y, homePoiId: p.id, notes: [], intel: APEX_INTEL.slice(), intelPost: APEX_INTEL_POST.slice() };
    });
    return state.apex;
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
        trainingQueue: null, wakeQueue: null, movedThisTurn: 0
      },
      // Campaign layer (2026-11-10): the population stakes meter and the
      // chart-fragment hunt live on the one canonical state (co-op seam:
      // one fleet, one chart, one population — however many commanders).
      population: TUNABLES.populationStart,
      campaign: { act: 1, fragments: { rumor: false, ai: false, city: false, approach: false },
        aiFound: false, revealSeen: false },
      resources: clone(TUNABLES.startResources),
      tiles: [], greenZone: null, colonyTile: null, interdictionTile: null,
      settlement: null,
      colony: { name: 'Kestrel Colony', reputation: 0, deals: [], lastRefreshTurn: 1 },
      supply: { escort: [], status: 'inactive', cadenceCounter: 0, shipmentsCompleted: 0, interdictions: 0 },
      chronicle: [], lastReports: [], lastRaidReport: null, lastAmbushReport: null,
      starving: false, starvationStreak: 0, lastUpkeep: null, markets: [],
      gameStatus: 'playing', endReason: null,
      raidsSurvived: 0, raidsSurvivedAtTier2: 0, totalDrops: 0,
      pois: [], apex: [], mapProgress: { things: 0 },   // live map layer (2026-11-07), seeded by generateSector
      heroes: freshHeroes(),  // Ship Deck + Heroes: named pods at the Communal, one station each
      deck: { station: 'quarters' }, // the deck layer remembers where the commander stands
      ship: freshShip(),      // SHIP AS HOME: station tiers (visual refits + small hooks)
      trophies: freshTrophies(), // SHIP AS HOME: earned display pieces + Trophy Room placement
      journal: freshJournal(),   // SHIP AS HOME: collected verbatim book quotes, by subject
      armory: freshArmory()   // §13: the ship's pool — finds bank here, loadouts draw here
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
    // SHIP AS HOME: the Medbay tier sets the rest economy — tier 1 is the
    // shipped baseline (2 FOOD per wound), tier 2 halves the food, tier 3
    // (the full ward) clears every wound for one 2-FOOD rest.
    var tier = stationTier(state, 'medbay');
    var cost = tier >= 2 ? (tier >= 3 ? 2 : 1) : 2;
    var heal = tier >= 3 ? d.wounds : 1;
    if (state.resources.FOOD < cost) return { ok: false, reason: 'Rest costs ' + cost + ' FOOD at this Medbay tier.' };
    state.resources.FOOD -= cost; d.wounds -= heal;
    if (d.wounds === 0 && d.status === 'wounded') d.status = 'ready';
    return { ok: true, woundsLeft: d.wounds, healed: heal, cost: cost };
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
    // Pool commitment (Steve, 2026-11-07): a drop is a pool of committed
    // points, not just an average. Past the priciest member (the anchor),
    // every diver adds their full point value x poolPointWeight — adding
    // bodies always helps, and adding expensive bodies helps more. (Before
    // this, the pure average meant a strong solo diver out-scored a full
    // squad: diluting the pool could only hurt.)
    if (divers.length > 1) {
      var poolPts = 0, anchor = 0;
      divers.forEach(function (d) { var v = diverValue(d); poolPts += v; if (v > anchor) anchor = v; });
      score += (poolPts - anchor) * TUNABLES.poolPointWeight;
    }
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
    expected -= poiThreatBonus(state, x, y);   // live map: fauna pressure from the ground's radiation
    var pbPoi = poiAt(state, x, y);
    if (pbPoi && pbPoi.kind === 'depot' && pbPoi.state === 'standing') expected -= TUNABLES.depotGuardThreat;  // machines: fixed, positional
    var pbGuard = pbPoi ? poiGuardThreat(state, pbPoi) : 0;
    if (pbGuard) expected -= pbGuard;          // campaign POIs: dormant war machines on the door (fixed, positional)
    // CO-OP SEAM: extra commanders scale the whole threat picture.
    var pbMult = coopMultiplier(state);
    if (pbMult !== 1) {
      var pbThreat = tile.threat * TUNABLES.threatWeight + poiThreatBonus(state, x, y) + pbGuard +
        ((pbPoi && pbPoi.kind === 'depot' && pbPoi.state === 'standing') ? TUNABLES.depotGuardThreat : 0) +
        (tile.robotSite && !tile.robotSite.cleared ? TUNABLES.robotThreatBonus : 0) +
        (tile.supplySite && !tile.supplySite.looted ? TUNABLES.supplyThreatBonus : 0);
      expected -= Math.round(pbThreat * (pbMult - 1));
    }
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

  /* ---------------- Drop gate (Steve, 2026-11-12) ------------------------ */
  // "I shouldn't be able to drop unless I move the ship to the tile."
  // A drop launches FROM the airship, so the ship must be over the target
  // tile. Pure query — the briefing reads it every render (Launch disabled
  // + the reason in plain words) and the launch path enforces it. A refused
  // drop costs nothing: no fuel, no turn.
  function dropGate(state, x, y) {
    if (state.airship.x === x && state.airship.y === y) return { ok: true };
    return { ok: false, reason: 'The airship is not over this tile — move the ship onto it before dropping.' };
  }

  /* ---------------- Drop resolution (§5.1 / §5.4 interdiction) ------------ */
  // opts: { diverIds, x, y, land (0-100), kind: 'gather'|'scout'|'interdiction'|'clear-route'|'generic' }
  function resolveDrop(state, opts) {
    var tile = tileAt(state, opts.x, opts.y);
    if (!tile) return { ok: false, reason: 'No such tile.' };
    var divers = opts.diverIds.map(function (id) { return diverById(state, id); }).filter(Boolean);
    if (!divers.length) return { ok: false, reason: 'No squad selected.' };
    ensureCampaign(state);   // campaign layer defaults, even on hand-built states
    for (var i = 0; i < divers.length; i++) {
      if (!diverAvailable(state, divers[i])) return { ok: false, reason: divers[i].name + ' is not available to drop.' };
    }
    if (state.airship.fuel < TUNABLES.dropFuelCost) {
      return { ok: false, reason: isGrounded(state)
        ? 'Airship is GROUNDED — the tank is dry. Use Refuel from cargo on the Map screen (or trade for FUEL); a grounded ship drops no one.'
        : 'Not enough airship fuel for a drop.' };
    }
    // ENDGAME gate (2026-11-07): city zones refuse the drop until both keys
    // read complete. A refused drop costs nothing — no fuel, no turn.
    var targetPoi = poiAt(state, opts.x, opts.y);
    if (targetPoi && targetPoi.zone === 'city') {
      var gate = cityGate(state, opts.diverIds);
      if (!gate.unlocked) {
        return { ok: false, reason: 'ENDGAME — the city stays shut. It takes ' + TUNABLES.cityGateHeroes +
          ' heroes at level ' + TUNABLES.cityGateLevel + ' AND ' + TUNABLES.cityUnlockThings +
          ' things done. (Now: ' + gate.heroes + ' heroes selected, squad min level ' + gate.minLevel +
          ', ' + gate.things + ' things done.)' };
      }
    }
    var kind = opts.kind || (tile.robotSite && !tile.robotSite.cleared ? 'robot'
      : tile.supplySite && !tile.supplySite.looted ? 'supply'
      : tile.resourceType ? 'gather' : 'generic');
    var reconTier = tile.reconTier || 0;
    state.airship.fuel -= TUNABLES.dropFuelCost;
    state.totalDrops += 1;
    countThing(state);   // live map: every resolved drop is one "thing done" toward the city key
    tile.discovered = true;

    var squad = squadScore(state, divers);
    var landMod = landToModifier(opts.land);
    var recon = TUNABLES.reconBonus[reconTier];
    var roll = roll2d20(state.rng);
    var threatPts = tile.threat * TUNABLES.threatWeight;
    if (kind === 'robot') threatPts += TUNABLES.robotThreatBonus;
    if (kind === 'supply') threatPts += TUNABLES.supplyThreatBonus;
    // Live map channels (2026-11-07): FAUNA pressure scales with the
    // ground's radiation; MACHINE threat is fixed by where it stands.
    var poiRadBonus = poiThreatBonus(state, opts.x, opts.y);
    threatPts += poiRadBonus;
    var depotGuard = (targetPoi && targetPoi.kind === 'depot' && targetPoi.state === 'standing') ? TUNABLES.depotGuardThreat : 0;
    threatPts += depotGuard;
    // Campaign POI guards (2026-11-10): dormant war machines hold the
    // bunker and the Communal approaches — fixed positional threat from
    // the POI record, never radiation-scaled (Rule 18 as amended).
    var poiGuards = targetPoi ? activeGuards(targetPoi) : [];
    var guardThreat = poiGuards.reduce(function (a, g) { return a + (g.threat || 0); }, 0);
    threatPts += guardThreat;
    // CO-OP SEAM (Rule 21): commanders past the first scale the threat.
    var coopMult = coopMultiplier(state);
    if (coopMult !== 1) threatPts = Math.round(threatPts * coopMult);
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
    if (poiRadBonus > 0) {
      lines.push('RADIATION ' + targetPoi.radiation + '/4: hot ground — what lives on ground like this runs bigger and meaner (fauna pressure +' + poiRadBonus + ' threat).');
    }
    if (depotGuard > 0) {
      // Book-true machine texture (Book 1 text, Loc 3531/3535): the iron
      // is Old World war stock — turret trucks and M3 Abrams tanks. The
      // "guardians" class name stays game canon (lore doc §12, Collision A).
      lines.push('MACHINES: depot guardians hold this ground (fixed threat +' + depotGuard + ' — machines do not scale with radiation). The iron is Old World war stock — turret trucks and M3 Abrams tanks.');
    }
    if (guardThreat > 0) {
      lines.push('MACHINES: dormant war machines hold this site — ' +
        poiGuards.map(function (g) { return g.form; }).join(' + ') +
        ' (fixed threat +' + guardThreat + ' — positional; machines do not scale with radiation). Work the site and they go dark.');
    }
    if (coopMult !== 1) {
      lines.push('CO-OP TABLE: ' + (TUNABLES.playerCount | 0) + ' commanders share this campaign — threat and stakes scaled x' + coopMult + ' (the co-op scaling hook, Rule 21).');
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
    // Tech depot (live map, 2026-11-07): salvage concentrates here, behind
    // its guardians. A worked depot pays out machine-tech salvage, once.
    var depotWorked = false;
    if (targetPoi && targetPoi.kind === 'depot' && targetPoi.state === 'standing') {
      if (band === 'Flawless' || band === 'Success' || band === 'Costly success') {
        var dFull = 10 + Math.floor(meanHaul / 2);
        var dScrap = band === 'Flawless' ? dFull + 4 : band === 'Success' ? dFull : Math.floor(dFull * TUNABLES.costlyYieldFraction);
        var dIntel = band === 'Costly success' ? 2 : 4;
        yieldGains.SCRAP = (yieldGains.SCRAP || 0) + dScrap;
        yieldGains.INTEL = (yieldGains.INTEL || 0) + dIntel;
        depotWorked = true;
        lines.push('Depot salvage: the Tech Depot gives up ' + dScrap + ' SCRAP and pre-Burn tech (+' + dIntel + ' INTEL). The guardians go dark.');
      } else {
        lines.push('The depot\'s guardians hold. The tech stays behind their guns.');
      }
    }
    // Campaign POIs (2026-11-10): the bunker, the Communal, the graveyard,
    // and every workable POI's fuel-cell stock. A yielding band works the
    // site — doors open, floor bands clear, guards go dark, cells come up.
    var yielding = band === 'Flawless' || band === 'Success' || band === 'Costly success';
    var poiFuelPaid = 0, revealFired = false;
    if (targetPoi && yielding) {
      var guardsOff = activeGuards(targetPoi);
      function disablePoiGuards() {
        if (!guardsOff.length) return;
        guardsOff.forEach(function (g) { g.active = false; });
        lines.push('MACHINES DOWN: the ' + guardsOff.map(function (g) { return g.form; }).join(' + ') +
          ' guarding ' + targetPoi.label + ' go dark — the squad worked past them.');
      }
      // Fuel-cell stock: finite, located, paid ONCE when first worked —
      // after that the site is picked clean (the green zones run out).
      var workableKind = targetPoi.kind === 'building' || targetPoi.kind === 'depot' ||
        targetPoi.kind === 'bunker' || targetPoi.kind === 'communal';
      if (workableKind && (targetPoi.fuelCells || 0) > 0) {
        poiFuelPaid = targetPoi.fuelCells;
        targetPoi.fuelCells = 0;
        yieldGains.FUEL = (yieldGains.FUEL || 0) + poiFuelPaid;
        lines.push('FUEL CELLS: +' + poiFuelPaid + ' FUEL — the site\'s cell stock, lifted whole. What remains down there is picked clean.');
      }
      if (targetPoi.kind === 'bunker') {
        var door = (targetPoi.doors || []).filter(function (d) { return d.state === 'sealed'; })[0];
        if (door) {
          door.state = 'opened';
          Object.keys(door.yield || {}).forEach(function (k) {
            var amt = band === 'Costly success' ? Math.floor(door.yield[k] * TUNABLES.costlyYieldFraction) : door.yield[k];
            if (amt > 0) yieldGains[k] = (yieldGains[k] || 0) + amt;
          });
          lines.push('BUNKER: the ' + door.label + ' door opens.' +
            (Object.keys(door.yield || {}).length ? ' Inside: ' + JSON.stringify(door.yield) + ' for the balloons.' : ''));
          if (door.key === 'cryo') {
            lines.push('CRYO: ' + (door.capsules || 0) + ' capsules still cold behind the cryogenics door — their sleepers can be woken from the Crew screen.');
          }
          disablePoiGuards();
          countThing(state);
        } else {
          lines.push('BUNKER: every door already stands open — the bunker is worked through.');
        }
      } else if (targetPoi.kind === 'communal') {
        if ((targetPoi.workedBands || 0) < (targetPoi.bandsTotal || TUNABLES.communalBands)) {
          targetPoi.workedBands = (targetPoi.workedBands || 0) + 1;
          var bandNo = targetPoi.workedBands;
          yieldGains.SCRAP = (yieldGains.SCRAP || 0) + TUNABLES.communalBandScrap;
          yieldGains.INTEL = (yieldGains.INTEL || 0) + TUNABLES.communalBandIntel;
          lines.push('COMMUNAL: floor band ' + bandNo + ' of ' + (targetPoi.bandsTotal || TUNABLES.communalBands) +
            ' worked. The surface showed a hut on a dirt hill; the silo goes down and down.');
          if (bandNo === TUNABLES.communalSeedBand && !targetPoi.seedBankTaken) {
            targetPoi.seedBankTaken = true;
            yieldGains.FOOD = (yieldGains.FOOD || 0) + TUNABLES.communalSeedFood;
            lines.push('SEED BANK: the silo\'s seed bank, intact — vault stock and grown greens ( +' + TUNABLES.communalSeedFood + ' FOOD).');
          }
          if (bandNo === TUNABLES.communalAiBand && !state.campaign.aiFound) {
            state.campaign.aiFound = true;
            state.campaign.fragments.ai = true;
            state.campaign.revealSeen = true;
            revealFired = true;
            lines.push('THE VOICE IN THE SILO: the facility\'s intelligence is still running — and it has been waiting to tell someone what the things on the surface ARE. (Chart fragment: the AI\'s — ' + chartFragmentCount(state) + ' of 4.)');
          }
          if (bandNo === TUNABLES.communalCryoBand && !targetPoi.cryoReached) {
            targetPoi.cryoReached = true;
            lines.push('CRYO BAY: ' + ((targetPoi.cryoBay && targetPoi.cryoBay.capsules) || 0) +
              ' capsules still functioning in the loading bay — sleepers can be woken from the Crew screen.');
          }
          disablePoiGuards();
          countThing(state);
        } else {
          lines.push('COMMUNAL: every floor band is worked — the silo is cleared.');
        }
      } else if (targetPoi.kind === 'graveyard') {
        if (targetPoi.state === 'unsearched') {
          yieldGains.SCRAP = (yieldGains.SCRAP || 0) + TUNABLES.graveyardScrap;
          lines.push('GRAVEYARD: robot skeletons in rows, mixed with the people they were buried beside — the machine age ended here. Salvage crews pick +' +
            TUNABLES.graveyardScrap + ' SCRAP from the remains. Nothing in this field fights back.');
        }
      }
    }
    // CO-OP SEAM: the same multiplier that scaled the threat scales the
    // stakes — a bigger table hauls more home.
    if (coopMult !== 1 && Object.keys(yieldGains).length) {
      Object.keys(yieldGains).forEach(function (k) { yieldGains[k] = Math.round(yieldGains[k] * coopMult); });
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
          var rdLeft = recordDeath(state, left, 'tile (' + opts.x + ',' + opts.y + ')', 'left behind on a failed drop', chronicleDeaths);
          if (rdLeft && rdLeft.heroDowned) {
            lines.push('DISASTER — averted: ' + left.name + ' was left behind, but the balloon crew dragged them clear. Down, evac\'d to the Medbay — not dead.');
          } else {
            deaths.push(left.name);
            lines.push('DISASTER: ' + left.name + ' was left behind and is dead (10% failure-band risk, §5.1).');
          }
        }
      }
    } else if (band === 'Catastrophe') {
      if (kind === 'robot') {
        // Machines do not miss: against the guardians there is no GRIT save
        // for the point diver. Everyone else still rolls.
        var machineVictim = divers.slice().sort(function (a, b) { return a.stats.GRIT - b.stats.GRIT; })[0];
        var rdMach = recordDeath(state, machineVictim, 'robot ruin at (' + opts.x + ',' + opts.y + ')',
          'cut down by the ruin\'s machine guardians — sentient robots, the thing that burned the world; no GRIT save against machines', chronicleDeaths);
        if (rdMach && rdMach.heroDowned) {
          lines.push('CATASTROPHE: the machine guardians do not miss — ' + machineVictim.name + ' is cut down with no save, but a hero does not die down there: winched out, down in the Medbay.');
        } else {
          deaths.push(machineVictim.name);
          lines.push('CATASTROPHE: the machine guardians do not miss — ' + machineVictim.name + ' is cut down with no save.');
        }
        divers = divers.filter(function (d) { return d !== machineVictim; });
      }
      divers.forEach(function (d) {
        var save = makeGritSave(state, d, 0);
        if (!save.success) {
          var rdCat = recordDeath(state, d, 'tile (' + opts.x + ',' + opts.y + ')', 'catastrophe on drop — failed GRIT save (' + save.roll + '+' + save.grit + ' vs ' + save.dc + ')', chronicleDeaths);
          if (rdCat && rdCat.heroDowned) {
            lines.push('CATASTROPHE: ' + d.name + ' failed the GRIT save (' + save.roll + '+' + save.grit + ' vs ' + save.dc + ') and went down — evac\'d to the Medbay, alive.');
          } else {
            deaths.push(d.name);
            lines.push('CATASTROPHE: ' + d.name + ' failed the GRIT save (' + save.roll + '+' + save.grit + ' vs ' + save.dc + ') and died.');
          }
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

    // Live-map POI sync (2026-11-07): the drop just worked this ground, so
    // the canonical POI record follows — every screen reads the same map.
    // A state transition counts one "thing" toward the city progression
    // key; re-working an already-worked POI does not farm the counter.
    if (targetPoi) {
      var poiBefore = targetPoi.state;
      if (targetPoi.kind === 'debris' || targetPoi.kind === 'graveyard') {
        if (poiBefore === 'unsearched' && Object.keys(yieldGains).length) targetPoi.state = 'picked';
      } else if (targetPoi.kind === 'depot') {
        if (depotWorked) targetPoi.state = 'looted';
      } else if (targetPoi.kind === 'bunker') {
        // The bunker's state IS its doors: cleared when the last door opens.
        if ((targetPoi.doors || []).every(function (d) { return d.state === 'opened'; })) targetPoi.state = 'cleared';
      } else if (targetPoi.kind === 'communal') {
        if ((targetPoi.workedBands || 0) >= (targetPoi.bandsTotal || TUNABLES.communalBands)) targetPoi.state = 'cleared';
      } else if (targetPoi.kind === 'building') {
        if (tile.robotSite && tile.robotSite.cleared && poiBefore === 'standing') targetPoi.state = 'cleared';
        else if (poiBefore === 'standing' && (Object.keys(yieldGains).length || poiFuelPaid)) targetPoi.state = 'looted';
      }
      if (targetPoi.state !== poiBefore) {
        countThing(state);
        lines.push('MAP: ' + targetPoi.label + ' (' + targetPoi.x + ',' + targetPoi.y + ') is now marked ' +
          targetPoi.state.toUpperCase() + ' on the live map.');
      }
      // Apex chronicle: a drop on an apex's home ground is recorded as a
      // plain fact of play (turn + band) — the only intel that exists
      // until the books farm sources more.
      (state.apex || []).forEach(function (a) {
        if (a.x === opts.x && a.y === opts.y) {
          a.notes.push({ turn: state.turn, text: 'Turn ' + state.turn + ' — a squad dropped on its ground: ' + band + '.' });
          lines.push('MAP: the apex sign at (' + a.x + ',' + a.y + ') has a new encounter on record.');
        }
      });
    }

    // Campaign beats (2026-11-10): the rumor fragment surfaces from the
    // Midnight recordings once the squad has real drops on the books —
    // recordings and echoes, not live calls (the surface lies about time).
    // The act turns the first time yellow ground is worked.
    var fragmentEarned = revealFired ? 'ai' : null;
    if (!state.campaign.fragments.rumor && state.totalDrops >= TUNABLES.midnightFragmentDrops) {
      state.campaign.fragments.rumor = true;
      fragmentEarned = fragmentEarned || 'rumor';
      lines.push('MIDNIGHT: another surface recording, centuries cold — but this one names a bearing the charts do not have. The crew starts a chart of fragments. (Chart fragment: the rumor — ' +
        chartFragmentCount(state) + ' of 4.)');
    }
    var actBeforeReport = state.campaign.act;
    deriveAct(state);
    if (state.campaign.act > actBeforeReport) {
      lines.push('ACT ' + state.campaign.act + ' — THE BURIED WORLD: the squad has worked yellow ground. What is buried down there is older, richer, and less dead than the towns.');
    }

    var report = {
      ok: true, kind: kind, turn: state.turn, x: opts.x, y: opts.y, land: opts.land,
      squad: Math.round(squad * 100) / 100, landMod: landMod, reconTier: reconTier, reconBonus: recon,
      dice: roll.dice, rollTotal: roll.total, threat: tile.threat, threatPts: threatPts,
      outcome: outcome, band: band, yield: yieldGains, ascent: ascent, deaths: deaths, wounded: wounded,
      coopMult: coopMult, guardThreat: guardThreat,
      fragmentEarned: fragmentEarned, reveal: revealFired,
      diverIds: opts.diverIds.slice(),
      act: state.campaign.act, chartFragments: chartFragmentCount(state),
      lines: lines, chronicleDeaths: chronicleDeaths
    };
    state.lastReports.push(report);
    syncCampaignTrophies(state);   // SHIP AS HOME: fragments won here reach the chart wall
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
    // Population milestone (2026-11-10): founding gives the count a reason
    // to move the other way — families commit to the ground.
    ensureCampaign(state);
    state.population += TUNABLES.populationSettlementBonus;
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
    if (type === 'FARM') {   // fed people stay, and stay alive (2026-11-10)
      ensureCampaign(state);
      state.population += TUNABLES.populationFarmBonus;
    }
    return { ok: true, structures: state.settlement.structures.length };
  }
  function upgradeSettlement(state) {
    if (!state.settlement) return { ok: false, reason: 'No settlement.' };
    if (state.settlement.tier >= TUNABLES.settlementTierCap) return { ok: false, reason: 'Slice caps settlements at Tier 2.' };
    if (!canAfford(state, TUNABLES.upgradeTier2Cost)) return { ok: false, reason: 'Upgrade costs ' + JSON.stringify(TUNABLES.upgradeTier2Cost) + '.' };
    payCost(state, TUNABLES.upgradeTier2Cost);
    state.settlement.tier = 2;
    ensureCampaign(state);
    state.population += TUNABLES.populationTier2Bonus;   // Tier 2 milestone (2026-11-10)
    checkWinLose(state);
    return { ok: true, tier: 2 };
  }
  function assignGarrison(state, diverId, on) {
    if (!state.settlement) return { ok: false, reason: 'No settlement.' };
    var d = diverById(state, diverId);
    if (!d || d.status === 'dead') return { ok: false, reason: 'No such diver.' };
    if (d.hero && on) return { ok: false, reason: d.name + ' keeps a station aboard — heroes do not garrison.' };
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
    if (d.hero && on) return { ok: false, reason: d.name + ' keeps a station aboard — heroes do not escort.' };
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

  /* ---------------- Waking sleepers (2026-11-10) -------------------------
   * The buried cryo bays are the roster's third source, beside training
   * and trade (Story §6): capsules wait in the Communal's cryo bay (once
   * its band is reached) and behind the bunker's cryogenics door. Waking
   * is priced in resources AND time — the sleeper thaws through the wake
   * queue and joins like a trainee arriving, population +1 on joining. */
  function cryoSources(state) {
    var out = [];
    (state.pois || []).forEach(function (p) {
      if (p.kind === 'communal' && p.cryoReached && p.cryoBay && p.cryoBay.capsules > 0) {
        out.push({ poiId: p.id, label: p.label, capsules: p.cryoBay.capsules });
      } else if (p.kind === 'bunker') {
        (p.doors || []).forEach(function (d) {
          if (d.key === 'cryo' && d.state === 'opened' && (d.capsules || 0) > 0) {
            out.push({ poiId: p.id, label: p.label, capsules: d.capsules });
          }
        });
      }
    });
    return out;
  }
  function wakeSleeper(state, poiId) {
    ensureCampaign(state);
    if (state.airship.wakeQueue) return { ok: false, reason: 'A sleeper is already thawing (one at a time).' };
    var poi = null;
    (state.pois || []).forEach(function (p) { if (p.id === poiId) poi = p; });
    if (!poi) return { ok: false, reason: 'No such site.' };
    var holder = null;
    if (poi.kind === 'communal' && poi.cryoReached && poi.cryoBay && poi.cryoBay.capsules > 0) holder = poi.cryoBay;
    if (poi.kind === 'bunker') {
      (poi.doors || []).forEach(function (d) { if (d.key === 'cryo' && d.state === 'opened' && (d.capsules || 0) > 0) holder = d; });
    }
    if (!holder) return { ok: false, reason: 'No reachable capsule at that site — work the site until its cryo is open, and check capsules remain.' };
    if (poi.kind === 'communal') {
      // Named pods are reserved: the last capsules at the Communal belong
      // to the heroes. Generic sleepers stop before them.
      var named = heroPods(state);
      if (named.length > 0 && holder.capsules <= named.length) {
        return { ok: false, reason: 'The remaining capsules carry names — ' +
          named.map(function (h) { return h.shortName; }).join(', ') +
          '. Wake the heroes by name (Crew screen or the deck\'s Comms station).' };
      }
    }
    if (livingDivers(state).length >= state.airship.crewCapacity) return { ok: false, reason: 'Crew is full — no berth for a sleeper.' };
    if (!canAfford(state, TUNABLES.sleeperWakeCost)) return { ok: false, reason: 'Waking a sleeper costs ' + JSON.stringify(TUNABLES.sleeperWakeCost) + ' (thaw power, meds, food).' };
    payCost(state, TUNABLES.sleeperWakeCost);
    holder.capsules -= 1;
    state.airship.wakeQueue = { turnsLeft: TUNABLES.sleeperWakeTurns, fromLabel: poi.label,
      pack_id: PACK_ID, content_version: CONTENT_VERSION };
    return { ok: true, turnsLeft: TUNABLES.sleeperWakeTurns, from: poi.label, capsulesLeft: holder.capsules };
  }
  // Wake a NAMED hero pod at the Communal cryo bay. Same queue, same cost,
  // same thaw time as a generic sleeper — the difference is who steps out.
  function wakeHero(state, heroId) {
    ensureCampaign(state); ensureHeroes(state);
    var def = heroDef(heroId);
    if (!def) return { ok: false, reason: 'No such hero in the record.' };
    if (state.heroes[heroId].woken) return { ok: false, reason: def.name + ' is already awake.' };
    if (state.airship.wakeQueue) return { ok: false, reason: 'A sleeper is already thawing (one at a time).' };
    var poi = null;
    (state.pois || []).forEach(function (p) { if (p.kind === 'communal') poi = p; });
    if (!poi || !poi.cryoReached || !poi.cryoBay || poi.cryoBay.capsules <= 0) {
      return { ok: false, reason: 'The named pods sleep at the Communal cryo bay — work the silo to band ' +
        TUNABLES.communalCryoBand + ' and reach the bay first.' };
    }
    if (livingDivers(state).length >= state.airship.crewCapacity) return { ok: false, reason: 'Crew is full — no berth for a hero.' };
    if (!canAfford(state, TUNABLES.sleeperWakeCost)) return { ok: false, reason: 'Waking a hero costs ' + JSON.stringify(TUNABLES.sleeperWakeCost) + ' (thaw power, meds, food).' };
    payCost(state, TUNABLES.sleeperWakeCost);
    poi.cryoBay.capsules -= 1;
    state.airship.wakeQueue = { turnsLeft: TUNABLES.sleeperWakeTurns, fromLabel: poi.label, heroId: heroId,
      pack_id: PACK_ID, content_version: CONTENT_VERSION };
    return { ok: true, heroId: heroId, turnsLeft: TUNABLES.sleeperWakeTurns, from: poi.label, capsulesLeft: poi.cryoBay.capsules };
  }
  // The hero steps out of the pod: a full diver with the book kit, their
  // weapon banked into the Armory and assigned, station claimed, and the
  // FIRST-WAKE free join armed (they ride the next drop, free — the beat
  // every hero gets exactly once).
  function makeHeroDiver(state, def, lines) {
    var nd = makeDiver(state, def.name, 'hero', [1, 1], 0);
    nd.hero = def.id;
    nd.stats = { GRIT: def.stats.GRIT, AIM: def.stats.AIM, NERVE: def.stats.NERVE, HAUL: def.stats.HAUL };
    nd.traits = [def.trait];
    nd.archetype = def.archetype;
    nd.level = def.level;
    nd.xp = xpThresholdForLevel(def.level);
    nd.gear = { weapon: def.weapon, effect: def.gearEffect, rig: 'plate carrier', pack: 'framed ruck', kit: def.kit };
    nd.customized = true;
    state.divers.push(nd);   // roster first: assignWeapon looks the diver up
    var item = armoryAddWeapon(state, def.weapon);
    if (def.attachment) {
      var att = armoryAddAttachment(state, def.attachment);
      fitAttachment(state, item.id, att.id);
    }
    assignWeapon(state, nd.id, 'primary', item.id, { auto: true });
    state.heroes[def.id].woken = true;
    state.heroes[def.id].diverId = nd.id;
    state.heroes[def.id].freeJoinPending = true;
    lines.push('A LEGEND WAKES: ' + def.name + ' steps out of the Communal cryo bay, 350 years down. ' +
      def.flavor + ' They take the ' + def.station.toUpperCase() + ' station — and they ride the next drop free.');
    return nd;
  }
  function progressWakeQueue(state, lines) {
    var q = state.airship.wakeQueue;
    if (!q) return;
    q.turnsLeft -= 1;
    if (q.turnsLeft > 0) { lines.push('Thaw: a sleeper from ' + q.fromLabel + ' is waking — ' + q.turnsLeft + ' turn(s) left.'); return; }
    if (livingDivers(state).length >= state.airship.crewCapacity) {
      q.turnsLeft = 1;
      lines.push('Thaw complete but crew is full — the sleeper waits in the capsule.');
      return;
    }
    if (q.heroId) {
      var hDef = heroDef(q.heroId);
      state.airship.wakeQueue = null;
      if (hDef) {
        makeHeroDiver(state, hDef, lines);
        state.population += 1;   // one more soul aboard (2026-11-10)
      }
      return;
    }
    var name = SLEEPER_NAMES[state.nextDiverSeq % SLEEPER_NAMES.length];
    var nd = makeDiver(state, name, 'sleeper', [TUNABLES.traineeStatMin, TUNABLES.traineeStatMax], 1);
    state.divers.push(nd);
    state.airship.wakeQueue = null;
    state.population += 1;   // one more soul aboard (2026-11-10)
    lines.push('A sleeper wakes: ' + nd.name + ' joins the roster, two centuries down and blinking. Population +1.');
  }
  // Medbay recovery for downed heroes (endTurn beat): the timer runs, then
  // they are back — heroes heal at the Medbay like anyone, only from worse.
  function progressHeroRecovery(state, lines) {
    ensureHeroes(state);
    state.divers.forEach(function (d) {
      if (!d.hero || d.status !== 'downed') return;
      d.downedTurns = (d.downedTurns || TUNABLES.heroDownedTurns) - 1;
      if (d.downedTurns <= 0) {
        d.downedTurns = 0; d.status = 'ready';
        lines.push('MEDBAY: ' + d.name + ' is back on their feet — cleared for duty.');
      } else {
        lines.push('MEDBAY: ' + d.name + ' is still down — ' + d.downedTurns + ' turn(s) of recovery left.');
      }
    });
  }
  // HIRE a woken hero for ONE drop at the tier price (INTEL + SCRAP).
  function hireHero(state, heroId) {
    ensureHeroes(state);
    var def = heroDef(heroId);
    if (!def) return { ok: false, reason: 'No such hero in the record.' };
    var rec = state.heroes[heroId];
    if (!rec.woken) return { ok: false, reason: def.name + ' still sleeps in a named pod at the Communal cryo bay.' };
    var d = diverById(state, rec.diverId);
    if (!d || d.status === 'dead') return { ok: false, reason: 'Hero record is broken — no living diver aboard.' };
    if (d.status === 'downed') return { ok: false, reason: def.shortName + ' is down in the Medbay — out for ' + (d.downedTurns || 0) + ' more turn(s).' };
    if (d.status !== 'ready' || d.wounds > 0) return { ok: false, reason: def.shortName + ' is not fit to drop (wounded or away). Rest them at the Medbay first.' };
    if (rec.hiredNext) return { ok: false, reason: def.shortName + ' is already hired for the next drop.' };
    if (rec.freeJoinPending) return { ok: false, reason: def.shortName + ' rides the next drop FREE (first-wake join) — no hire needed.' };
    var price = heroPriceOf(def);
    if (!canAfford(state, price)) return { ok: false, reason: 'Hiring ' + def.shortName + ' for one drop costs ' + JSON.stringify(price) + ' — the ship cannot pay it.' };
    payCost(state, price);
    rec.hiredNext = true;
    return { ok: true, heroId: heroId, price: clone(price) };
  }
  // Pure query (safe to call every render): which heroes ride a drop on
  // `poi`, and why. Free joins: the first-wake join (once per hero) and
  // site beats (per-hero ground, cooldown-gated). Hires ride once.
  function heroJoinsForDrop(state, poi) {
    ensureHeroes(state);
    var out = [];
    HEROES.forEach(function (def) {
      var rec = state.heroes[def.id];
      if (!rec.woken || !rec.diverId) return;
      var d = diverById(state, rec.diverId);
      if (!d || d.status !== 'ready' || d.wounds > 0) return;
      if (rec.hiredNext) { out.push({ heroId: def.id, diverId: d.id, mode: 'hire', reason: 'Hired for this drop (' + JSON.stringify(heroPriceOf(def)) + ' paid).' }); return; }
      if (rec.freeJoinPending) { out.push({ heroId: def.id, diverId: d.id, mode: 'free', reason: 'First-wake join — fresh out of cryo, rides free.' }); return; }
      if (poi && state.turn >= (rec.beatReadyTurn || 0)) {
        if ((def.joinKinds || []).indexOf(poi.kind) >= 0) {
          out.push({ heroId: def.id, diverId: d.id, mode: 'free', reason: 'Campaign beat: ' + def.shortName + ' knows this ground — a ' + poi.kind + ' drop — and rides free.' });
          return;
        }
        if (def.joinApex && poi.x != null && (state.apex || []).some(function (a) { return a.x === poi.x && a.y === poi.y; })) {
          out.push({ heroId: def.id, diverId: d.id, mode: 'free', reason: 'Campaign beat: an apex Siren hunts this ground — ' + def.shortName + ' rides free.' });
        }
      }
    });
    return out;
  }
  // Consume joins at launch: hires are spent, free joins are spent, and the
  // site-beat cooldown starts ticking.
  function commitHeroJoins(state, joins) {
    ensureHeroes(state);
    (joins || []).forEach(function (j) {
      var rec = state.heroes[j.heroId];
      if (!rec) return;
      rec.hiredNext = false;
      if (j.mode === 'free') {
        rec.freeJoinPending = false;
        rec.beatReadyTurn = state.turn + TUNABLES.heroBeatCooldownTurns;
      }
    });
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
    // Campaign stakes (2026-11-10): the ship's soul count drifts down with
    // campaign time — sickness, age, the arithmetic. Milestones (founding,
    // farms, Tier 2, woken sleepers) push it back up where they land. The
    // meter is stakes, never a lose timer (Story §1).
    ensureCampaign(state);
    var drift = Math.min(state.population, TUNABLES.populationDriftPerTurn);
    state.population -= drift;
    ledger.shipPopulation = state.population;
    ledger.populationDrift = drift;
    if (drift > 0) lines.push('Souls aboard: ' + state.population + ' — the arithmetic took ' + drift + ' this turn. Settlements, farms and woken sleepers push it back.');
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
        // Heroes are never the hunger victim (hero law: no permadeath).
        var pool = livingDivers(state).filter(function (d) { return !d.hero; });
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
      lines.push('AIRSHIP GROUNDED: tank is dry — no drops, no moves until she is refueled (Refuel from cargo on the Map screen, or trade for FUEL).');
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
    // Sleeper thaw progresses on the same beat (2026-11-10).
    progressWakeQueue(state, lines);
    // Downed heroes recover in the Medbay on the same beat.
    progressHeroRecovery(state, lines);
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
    syncCampaignTrophies(state);   // SHIP AS HOME: turn settles land trophies too
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
    // Live-map backfill (2026-11-07): pre-POI saves gain the POI layer, the
    // apex fixtures and the progression counter WITHOUT regenerating the
    // sector — a scratch game on the same seed reproduces the exact
    // placement (generation is a pure function of the seed), and only the
    // POI data is copied across. The live tiles, turn and roster are
    // untouched; the live rng stream is never consumed.
    if (!st.mapProgress) st.mapProgress = { things: st.totalDrops || 0 };
    if (!st.pois && st.seed != null) {
      var scratch = createGame(st.seed);
      st.pois = scratch.pois;
      st.apex = scratch.apex;
      var pidByCoord = {};
      st.pois.forEach(function (p) { pidByCoord[key(p.x, p.y)] = p.id; });
      (st.tiles || []).forEach(function (t) {
        var pid = pidByCoord[key(t.x, t.y)];
        if (pid) t.poiId = pid;
      });
    }
    if (!st.pois) st.pois = [];
    // Campaign backfill (2026-11-10): pre-campaign saves gain the campaign
    // state, the population count, per-POI fuel-cell stock, and the three
    // campaign POI classes (bunker / Communal / graveyard) — additive
    // only, placed rng-free off the live tiles, so an in-progress campaign
    // keeps its sector, roster, turn and rng stream exactly.
    ensureCampaign(st);
    if (st.airship && st.airship.wakeQueue === undefined) st.airship.wakeQueue = null;
    // §9 backfill: pre-archetype saves gain the field (derived, deterministic).
    (st.divers || []).concat(st.tombstones || []).forEach(function (d) {
      if (!d.archetype) d.archetype = archetypeFor(d);
    });
    // §§13-15 backfill: pre-Armory saves gain the pool (empty — nothing is
    // invented into a player's stores) and loadout defaults ride lazily.
    ensureArmory(st);
    // Ship Deck + Heroes backfill: pre-hero saves gain the hero ledger
    // (all asleep) and the deck position — additive only.
    ensureHeroes(st);
    // SHIP AS HOME backfill: pre-refit saves gain tier-1 stations (the
    // shipped look), an empty Trophy Room, an empty Journal — and the
    // reconcile sweep awards whatever the campaign already earned (chart
    // fragments, act marks, woken heroes). Tank max follows Engineering.
    ensureShip(st);
    ensureTrophies(st);
    ensureJournal(st);
    if (st.airship) st.airship.maxFuel = shipFuelMax(st);
    syncCampaignTrophies(st);
    st.pois.forEach(function (p) {
      if (p.fuelCells === undefined) {
        p.fuelCells = (p.kind === 'building' || p.kind === 'depot') ? fuelCellsFor(p.radiation) : 0;
      }
    });
    if (st.tiles && st.tiles.length) placeCampaignPois(st, st.pois);
    // Always run seedApex: it seeds when missing and tops up sourced
    // class intel on apex records written before the Book 1 text landed.
    seedApex(st);
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
    squadScore: squadScore, projectedBand: projectedBand, bandForOutcome: bandForOutcome, resolveDrop: resolveDrop, dropGate: dropGate,
    diverValue: diverValue, squadPool: squadPool, gearFor: gearFor,
    ARCHETYPES: ARCHETYPES, archetypeFor: archetypeFor, ensureArchetype: ensureArchetype, weaponClassOf: weaponClassOf,
    weaponProfileFor: weaponProfileFor, weaponTierOf: weaponTierOf,
    ensureArmory: ensureArmory, armoryItem: armoryItem, armoryAddWeapon: armoryAddWeapon,
    armoryAddAttachment: armoryAddAttachment, effectiveWeapon: effectiveWeapon,
    weaponWeightOf: weaponWeightOf, armorOf: armorOf, armorProtection: armorProtection,
    kitThrowsFor: kitThrowsFor, loadoutWeight: loadoutWeight, carryBound: carryBound,
    loadoutCheck: loadoutCheck, slotFits: slotFits, assignWeapon: assignWeapon, setArmor: setArmor,
    fitAttachment: fitAttachment, removeAttachment: removeAttachment,
    upgradedProfile: upgradedProfile, upgradeWeapon: upgradeWeapon,
    effectiveProfile: effectiveProfile, gearLineFor: gearLineFor, autoEquip: autoEquip,
    loadoutOf: loadoutOf, assignedItemIds: assignedItemIds,
    assignGrenade: assignGrenade, grenadePackOf: grenadePackOf, grenadePackCount: grenadePackCount,
    assignTacLight: assignTacLight, tacLightsAssigned: tacLightsAssigned,
    DEFAULT_SECONDARY: DEFAULT_SECONDARY,
    foundSettlement: foundSettlement, buildStructure: buildStructure, upgradeSettlement: upgradeSettlement,
    structureSlots: structureSlots, assignGarrison: assignGarrison, assignEscort: assignEscort,
    defenseBreakdown: defenseBreakdown, raidForceForTurn: raidForceForTurn, resolveRaid: resolveRaid,
    routeTiles: routeTiles, routeExposure: routeExposure, resolveAmbush: resolveAmbush,
    acceptDeal: acceptDeal, findDeal: findDeal, enqueueTraining: enqueueTraining, cancelTraining: cancelTraining,
    isGrounded: isGrounded, computeUpkeep: computeUpkeep,
    endTurn: endTurn, checkWinLose: checkWinLose, serialize: serialize, deserialize: deserialize,
    revealRadius: revealRadius,
    poiAt: poiAt, poiThreatBonus: poiThreatBonus, cityGate: cityGate, seedPois: seedPois, seedApex: seedApex,
    zoneTierFor: zoneTierFor, poiZoneTier: poiZoneTier, tileZoneTier: tileZoneTier, fallSeverity: fallSeverity,
    remainingGreenFuel: remainingGreenFuel, poiGuardThreat: poiGuardThreat, activeGuards: activeGuards,
    coopMultiplier: coopMultiplier, chartFragmentCount: chartFragmentCount, deriveAct: deriveAct,
    apexIntelFor: apexIntelFor, cryoSources: cryoSources, wakeSleeper: wakeSleeper, placeCampaignPois: placeCampaignPois,
    HEROES: HEROES, heroDef: heroDef, heroPriceOf: heroPriceOf, ensureHeroes: ensureHeroes,
    heroDiverOf: heroDiverOf, heroPods: heroPods, setDeckStation: setDeckStation,
    wakeHero: wakeHero, hireHero: hireHero, heroJoinsForDrop: heroJoinsForDrop, commitHeroJoins: commitHeroJoins,
    // SHIP AS HOME (2026-11-10): station tiers, trophies, journal.
    ensureShip: ensureShip, stationTier: stationTier, stationTierName: stationTierName,
    shipFuelMax: shipFuelMax, weaponUpgradeCap: weaponUpgradeCap, upgradeStation: upgradeStation,
    TROPHY_SLOTS: TROPHY_SLOTS, trophySlotDef: trophySlotDef, ensureTrophies: ensureTrophies,
    trophyById: trophyById, awardTrophy: awardTrophy, placeTrophy: placeTrophy, unplaceTrophy: unplaceTrophy,
    syncCampaignTrophies: syncCampaignTrophies, awardApexSkull: awardApexSkull,
    SNIPPETS: SNIPPETS, SNIPPET_GROUPS: SNIPPET_GROUPS, snippetDef: snippetDef,
    ensureJournal: ensureJournal, snippetFound: snippetFound, collectSnippet: collectSnippet,
    journalProgress: journalProgress, snippetSiteMatches: snippetSiteMatches,
    snippetRegionKnown: snippetRegionKnown, journalView: journalView,
    progressHeroRecovery: progressHeroRecovery
  };
  global.DropZoneCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
