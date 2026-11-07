/* DROP ZONE — world weather (single authority, direction-doc shape).
 * Ported from the engine character lab's WeatherSystem (storm cell as a
 * moving object in world coordinates; local wind = ambient + cell fields
 * with a cyclonic tangential component and gusts) into the shape specified
 * by WEATHER-SYSTEM-DIRECTION.md §1/§2: one weather state, one sampler.
 * The map, the ship readout, and the drop scenario's descent drift ALL read
 * sampleWeather() — no view invents its own weather.
 * Plain script: window.DropZoneWeather. No core.js changes: core movement
 * and balance are untouched; weather pushes the *descent marker* (steering
 * feel), and the landing is still scored by core.computeLanding on the tile
 * actually reached — so weather is causal through drift, not decoration.
 */
(function (global) {
  'use strict';

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function hashSeed(seed) {
    var h = 2166136261 >>> 0, s = String(seed);
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  // Own deterministic stream (splitmix32, same family as core) so weather
  // never consumes combat/presentation rolls.
  function createStream(seed) {
    var st = { state: hashSeed('weather:' + seed) || 1 };
    st.next = function () {
      var z = (st.state + 0x9E3779B9) >>> 0;
      st.state = z;
      z = Math.imul(z ^ (z >>> 16), 0x21F0AAAD);
      z = Math.imul(z ^ (z >>> 15), 0x735A2D97);
      return ((z ^ (z >>> 15)) >>> 0) / 4294967296;
    };
    return st;
  }

  function createWeather(seed) {
    var rnd = createStream(seed);
    var cells = [
      {
        id: 'storm-alpha', kind: 'storm',
        position: { x: -3.2, y: 2 + rnd.next() * 3 },
        velocity: { x: 0.55, y: 0.025 },
        windVector: { x: 1.35, y: 0.22 },
        radius: 4.2, intensity: 0.85, spin: 0.35, seed: Math.floor(rnd.next() * 1e6)
      },
      {
        id: 'squall-beta', kind: 'squall',
        position: { x: 14 + rnd.next() * 6, y: 12 + rnd.next() * 6 },
        velocity: { x: -0.30, y: 0.06 },
        windVector: { x: 0.80, y: -0.12 },
        radius: 2.6, intensity: 0.50, spin: -0.28, seed: Math.floor(rnd.next() * 1e6)
      }
    ];
    return {
      version: 1, seed: seed, tick: 0,
      coordinateSpace: 'sector-tiles',
      ambientWind: { x: 0.18, y: 0.04 },
      gustAmplitude: 0.22, gustPeriodSeconds: 7.5, gust: 0,
      cells: cells
    };
  }

  // Advance the world (preview-time scale, same convention as the map34
  // proof: velocities are tiles per second of presentation time). Cells
  // advect and wrap so the sector always has weather moving through it.
  function advance(w, dt, bounds) {
    if (!(dt > 0)) return w;
    w.tick += dt;
    var phase = (w.tick / w.gustPeriodSeconds) * Math.PI * 2;
    w.gust = Math.sin(phase) * w.gustAmplitude;
    var W = (bounds && bounds.w) || 24, H = (bounds && bounds.h) || 24;
    w.cells.forEach(function (c) {
      c.position.x += c.velocity.x * dt;
      c.position.y += c.velocity.y * dt;
      if (c.position.y < 0.4 || c.position.y > H - 0.4) c.velocity.y *= -1;
      c.position.y = clamp(c.position.y, 0.2, H - 0.2);
      if (c.position.x - c.radius > W + 2) { c.position.x = -c.radius - 1.5; }
      if (c.position.x + c.radius < -2) { c.position.x = W + c.radius + 1.5; }
    });
    return w;
  }

  // The only weather read API (direction doc §2, adapted falloff):
  // falloff = clamp(1 - d/radius, 0, 1)^2; local wind adds the cell's wind
  // vector plus a cyclonic tangent (lab port), scaled by (1 + gust).
  function sampleWeather(w, x, y) {
    var windX = w.ambientWind.x, windY = w.ambientWind.y;
    var storm = 0, cloud = 0.22, dominant = null, best = 0;
    for (var i = 0; i < w.cells.length; i++) {
      var c = w.cells[i];
      var dx = x - c.position.x, dy = y - c.position.y;
      var d = Math.sqrt(dx * dx + dy * dy);
      var f = clamp(1 - d / c.radius, 0, 1);
      f = f * f;
      if (f <= 0) continue;
      var gustScale = 1 + w.gust * (0.35 + c.intensity);
      windX += c.windVector.x * c.intensity * f * gustScale;
      windY += c.windVector.y * c.intensity * f * gustScale;
      // Cyclonic tangential flow around the center (lab weather.js).
      var len = d || 1;
      var rot = c.spin * c.intensity * f * 0.9;
      windX += (-dy / len) * rot;
      windY += (dx / len) * rot;
      var s = c.intensity * f;
      storm += s;
      cloud += (0.35 + 0.65 * c.intensity) * f;
      if (s > best) { best = s; dominant = c.id; }
    }
    storm = clamp(storm, 0, 1);
    return {
      wind: { x: windX, y: windY },
      storm: storm,
      cloud: clamp(cloud, 0, 1),
      visibility: clamp(1 - storm * 0.75, 0.15, 1),
      turbulence: clamp(storm * 0.9, 0, 1),
      dominantCellId: dominant
    };
  }

  global.DropZoneWeather = {
    createWeather: createWeather,
    advance: advance,
    sampleWeather: sampleWeather
  };
})(typeof window !== 'undefined' ? window : globalThis);
