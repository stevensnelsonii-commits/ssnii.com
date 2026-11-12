/* DROP ZONE — feedback layer (§4): REAL catalogue clips first, synth
 * blips only as a load-failure fallback. Every event id the game fires
 * is recorded on the test handle window.__dzFeedback {sfx:[], fx:[]} so
 * the feedback suite can assert "this event played this sound AND
 * applied this visual class". Visual fx classes are pushed by the UI
 * through fx(). Sounds are mono Ogg trims of OvaniSound catalogue clips
 * (production use in the game; NEVER training use) — see
 * assets/sfx/SOUNDS.md for the clip -> event -> source-path manifest.
 *
 * AUDIO ARCHITECTURE (Steve 2026-11-12: "Sound off doesn't work. The
 * background loop is jarring. Build a layered sound that loops."):
 * ONE AudioContext, ONE master gain — every sound the game makes
 * (layered ambience, one-shot clips, fallback blips) flows through it.
 * Mute = master gain 0 AND the context suspended, so OFF is total:
 * no loop, no SFX, no UI click, across screens and reloads. The
 * setting persists in localStorage ('dropzone-sound-v1') and is read
 * here at load, before any audio can start.
 * Ambience is LAYERED: each scene runs 2 decoded buffers at different
 * loop lengths, every loop baked with an equal-power crossfade at its
 * seam (2–3 s), so no loop point is ever audible and the combination
 * does not obviously repeat. Performance: buffers decode ONCE and are
 * cached, at most 4 sources run at once (2 ambience + one-shots),
 * no per-frame nodes are ever created, nothing streams, and the
 * context suspends when muted or while the tab is hidden. */
(function (global) {
  'use strict';

  var FILES = {
    select: 'select', deselect: 'deselect', confirm: 'confirm', denied: 'denied',
    fire: 'fire', firehit: 'firehit', firemiss: 'firemiss', punch: 'punch',
    'siren-attack': 'siren-attack', shriek: 'shriek', wingbeat: 'wingbeat',
    'siren-death': 'siren-death', wound: 'wound', death: 'death',
    thunder: 'thunder', touchdown: 'touchdown', explosion: 'touchdown',
    step: 'step', loot: 'loot', coin: 'coin', door: 'door', device: 'device',
    refill: 'refill', powerup: 'powerup', readyfly: 'readyfly', whoosh: 'whoosh',
    success: 'success', fanfare: 'fanfare', raid: 'raid',
    plant: 'plant', flash: 'flash', flare: 'flare'
  };
  var LOOPS = { 'map-ambience': 'wind-loop', 'descent-loop': 'descent-loop', 'settlement-loop': 'crowd' };
  /* The layered sets: bed loudest, accent quiet, lengths differ so the
   * combination never lines up twice the same way. Only clips that
   * exist in assets/sfx/ — wind-loop (6 s), descent-loop (5 s),
   * crowd (8 s). Fades: 2 s on the wind beds, 3 s on the crowd. */
  var AMBIENT_SETS = {
    'map-ambience': [
      { file: 'wind-loop', gain: 0.50, fade: 2 },
      { file: 'descent-loop', gain: 0.15, fade: 2 }
    ],
    'descent-loop': [
      { file: 'descent-loop', gain: 0.55, fade: 2 },
      { file: 'wind-loop', gain: 0.30, fade: 2 }
    ],
    'settlement-loop': [
      { file: 'crowd', gain: 0.45, fade: 3 },
      { file: 'wind-loop', gain: 0.22, fade: 2 }
    ]
  };
  var FALLBACK_TONES = { // [f0, f1, dur, type, vol] — only when a clip fails to load
    select: [620, 940, 0.07, 'square', 0.03], deselect: [480, 300, 0.07, 'square', 0.03],
    confirm: [520, 780, 0.09, 'square', 0.035], denied: [150, 105, 0.16, 'sawtooth', 0.05],
    fire: [220, 90, 0.12, 'sawtooth', 0.05], firehit: [300, 120, 0.14, 'sawtooth', 0.05],
    firemiss: [500, 200, 0.08, 'square', 0.03], punch: [160, 70, 0.1, 'square', 0.05],
    wound: [300, 140, 0.2, 'sawtooth', 0.05], death: [200, 50, 0.4, 'sawtooth', 0.05],
    loot: [660, 990, 0.1, 'square', 0.04], coin: [880, 1320, 0.09, 'square', 0.04],
    door: [140, 220, 0.2, 'square', 0.04], device: [440, 660, 0.1, 'square', 0.035],
    thunder: [80, 40, 0.5, 'sawtooth', 0.06], touchdown: [120, 60, 0.25, 'square', 0.05],
    explosion: [100, 40, 0.4, 'sawtooth', 0.06], step: [300, 240, 0.05, 'square', 0.02],
    success: [520, 1040, 0.15, 'square', 0.04], fanfare: [392, 784, 0.3, 'square', 0.045],
    raid: [180, 180, 0.3, 'sawtooth', 0.05], refill: [300, 600, 0.15, 'square', 0.04],
    powerup: [440, 880, 0.15, 'square', 0.04], readyfly: [240, 720, 0.25, 'sawtooth', 0.04],
    whoosh: [900, 300, 0.15, 'sawtooth', 0.03], shriek: [1200, 700, 0.25, 'sawtooth', 0.04],
    'siren-attack': [500, 200, 0.15, 'sawtooth', 0.045], 'siren-death': [400, 60, 0.3, 'sawtooth', 0.045],
    wingbeat: [200, 120, 0.2, 'square', 0.03], plant: [250, 90, 0.2, 'square', 0.04],
    flash: [1000, 1400, 0.12, 'square', 0.05], flare: [700, 500, 0.3, 'sawtooth', 0.03]
  };

  var handle = { sfx: [], fx: [] };
  global.__dzFeedback = handle;

  var SOUND_KEY = 'dropzone-sound-v1';
  function storedEnabled() {
    try {
      if (typeof localStorage === 'undefined') return true;
      var v = localStorage.getItem(SOUND_KEY);
      return v === null ? true : v !== 'off';   // ui.js's stored convention: 'on'/'off'
    } catch (e) { return true; }
  }
  var enabled = storedEnabled();       // read BEFORE any audio can start
  var masterLevel = enabled ? 0.9 : 0; // the intended master gain, ctx or not

  var broken = {};       // file key -> true once a clip fails (blip from then on)
  var buffers = {};      // file key -> decoded AudioBuffer (decode ONCE)
  var loading = {};      // file key -> [callbacks] while a decode is in flight
  var loopBufs = {};     // file key + fade -> baked seamless-loop buffer
  var ctx = null;        // the ONE AudioContext
  var master = null;     // the ONE master gain -> destination
  var ambientId = null;  // current ambience set id (state even headless)
  var layers = [];       // live layer records {src, gain} (<= 2 by design)
  var liveOneShots = 0;  // concurrency guard: ambience 2 + one-shots <= 4ish
  var autoSuspended = false;

  function ensureCtx() {
    if (ctx) return ctx;
    var AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = masterLevel;
      master.connect(ctx.destination);
      if (!enabled && ctx.state === 'running') ctx.suspend();
    } catch (e) { ctx = null; master = null; }
    return ctx;
  }
  function loadBuffer(fileKey, cb) {
    if (buffers[fileKey]) { cb(buffers[fileKey]); return; }
    if (broken[fileKey]) { cb(null); return; }
    if (loading[fileKey]) { loading[fileKey].push(cb); return; }
    loading[fileKey] = [cb];
    function done(buf) {
      var cbs = loading[fileKey] || [];
      delete loading[fileKey];
      if (buf) buffers[fileKey] = buf; else broken[fileKey] = true;
      cbs.forEach(function (f) { f(buf); });
    }
    var c = ensureCtx();
    if (!c || typeof fetch === 'undefined') { done(null); return; }
    fetch('assets/sfx/' + fileKey + '.ogg')
      .then(function (r) { if (!r.ok) throw new Error('sfx ' + r.status); return r.arrayBuffer(); })
      .then(function (ab) { return c.decodeAudioData(ab); })
      .then(function (buf) { done(buf); })
      .catch(function () { done(null); });
  }
  /* Bake the seam away: the loop body is (duration - fade); its tail is
   * the source's head equal-power crossfaded into the body's end, so a
   * plain loop=true source repeats with no audible join. */
  function loopBuffer(fileKey, buf, fadeSec) {
    var key = fileKey + '@' + fadeSec;
    if (loopBufs[key]) return loopBufs[key];
    var sr = buf.sampleRate;
    var fade = Math.min(Math.floor(fadeSec * sr), Math.floor(buf.length / 2));
    var body = buf.length - fade;
    var out = ctx.createBuffer(buf.numberOfChannels, body, sr);
    for (var ch = 0; ch < buf.numberOfChannels; ch++) {
      var src = buf.getChannelData(ch), dst = out.getChannelData(ch);
      for (var i = 0; i < body; i++) {
        if (i < fade) {
          var t = (i + 0.5) / fade, a = Math.cos(t * Math.PI / 2), b = Math.sin(t * Math.PI / 2);
          dst[i] = src[i] * a + src[body + i] * b;
        } else dst[i] = src[i];
      }
    }
    loopBufs[key] = out;
    return out;
  }
  function startLayer(setId, layerDef) {
    loadBuffer(layerDef.file, function (buf) {
      if (!buf || ambientId !== setId || !ctx || !master) return;
      var src = ctx.createBufferSource();
      src.buffer = loopBuffer(layerDef.file, buf, layerDef.fade);
      src.loop = true;
      var g = ctx.createGain();
      g.gain.value = 0;
      g.gain.setTargetAtTime(layerDef.gain, ctx.currentTime, 0.4); // ease in
      src.connect(g); g.connect(master);
      try { src.start(); } catch (e) { return; }
      layers.push({ src: src, gain: g });
    });
  }
  function stopLayers() {
    var old = layers; layers = [];
    old.forEach(function (L) {
      try {
        L.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.08);
        var s = L.src;
        setTimeout(function () { try { s.stop(); } catch (e) { /* already gone */ } }, 350);
      } catch (e) { try { L.src.stop(); } catch (e2) { /* ignore */ } }
    });
  }
  function ambience(id) {
    if (!AMBIENT_SETS[id]) return;
    if (ambientId === id && layers.length) return; // already playing this set
    stopLayers();
    ambientId = id;
    if (!enabled) return;                    // state recorded; silent by law
    if (!ensureCtx()) return;                // headless: state only
    if (ctx.state === 'suspended') ctx.resume();
    AMBIENT_SETS[id].forEach(function (layerDef) { startLayer(id, layerDef); });
  }
  function stopAmbience() {
    ambientId = null;
    if (ctx) stopLayers();
  }
  function blip(id) {
    var t = FALLBACK_TONES[id] || FALLBACK_TONES.select;
    var c = ensureCtx();
    if (!c || !master) return;
    try {
      if (c.state === 'suspended' && enabled) c.resume();
      var t0 = c.currentTime;
      var osc = c.createOscillator(), g = c.createGain();
      osc.type = t[3];
      osc.frequency.setValueAtTime(t[0], t0);
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, t[1]), t0 + t[2]);
      g.gain.setValueAtTime(t[4], t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + t[2]);
      osc.connect(g); g.connect(master);   // through the master, like everything
      osc.start(t0); osc.stop(t0 + t[2] + 0.03);
    } catch (e) { /* audio is garnish */ }
  }
  function play(id) {
    handle.sfx.push(id);
    if (!enabled) return;
    var fileKey = FILES[id];
    if (!fileKey || broken[fileKey]) { blip(id); return; }
    if (liveOneShots >= 4) return;         // concurrency cap — drop, never pile
    loadBuffer(fileKey, function (buf) {
      if (!buf) { blip(id); return; }
      if (!enabled || !ctx || !master) return;
      try {
        if (ctx.state === 'suspended') ctx.resume();
        var src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(master);
        liveOneShots++;
        src.onended = function () { liveOneShots--; };
        src.start();
      } catch (e) { blip(id); }
    });
  }
  function fx(name) { handle.fx.push(name); }
  function setEnabled(on) {
    enabled = !!on;
    masterLevel = enabled ? 0.9 : 0;
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(SOUND_KEY, enabled ? 'on' : 'off'); } catch (e) { /* ignore */ }
    if (!ctx) return;                       // nothing live yet; state carries
    if (master) master.gain.setTargetAtTime(masterLevel, ctx.currentTime, 0.02);
    if (!enabled) { try { ctx.suspend(); } catch (e) { /* ignore */ } }
    else {
      try { ctx.resume(); } catch (e) { /* ignore */ }
      // A set chosen while muted starts sounding now.
      if (ambientId && !layers.length) {
        var id = ambientId;
        AMBIENT_SETS[id].forEach(function (layerDef) { startLayer(id, layerDef); });
      }
    }
  }
  function getAudioState() {
    return {
      enabled: enabled,
      masterGain: masterLevel,
      ctxState: ctx ? ctx.state : 'none',
      ambient: ambientId,
      layerFiles: ambientId ? AMBIENT_SETS[ambientId].map(function (l) { return l.file; }) : [],
      liveLayers: layers.length
    };
  }
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', function () {
      if (!ctx) return;
      if (document.hidden) {
        if (ctx.state === 'running') { autoSuspended = true; try { ctx.suspend(); } catch (e) { /* ignore */ } }
      } else if (autoSuspended) {
        autoSuspended = false;
        if (enabled) { try { ctx.resume(); } catch (e) { /* ignore */ } }
      }
    });
  }

  global.DropZoneSfx = {
    play: play, fx: fx, ambience: ambience, stopAmbience: stopAmbience,
    setEnabled: setEnabled, FILES: FILES, LOOPS: LOOPS, handle: handle,
    getAudioState: getAudioState
  };
})(typeof window !== 'undefined' ? window : globalThis);
