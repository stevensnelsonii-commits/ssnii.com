/* DROP ZONE — diver portraits (creator hook).
 * Procedural canvas busts drawn by hand-written code from a deterministic
 * hash of the diver's id + a "look variant" — flat vector-style character
 * thumbnails in the studio's Warm Bone / brick / signature-yellow palette.
 * No AI-generated imagery anywhere: these are code-drawn marks, generated
 * locally in the browser, and the variant cycler is the lightweight creator
 * step ("New look") tied conceptually to Prime's character creator.
 * Plain script: window.DropZonePortraits.
 */
(function (global) {
  'use strict';

  function hashOf(str) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  // mulberry-style stream from a hash, so a portrait is stable per id+variant.
  function stream(seedNum) {
    var a = seedNum >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  var SKIN = ['#e8b48c', '#c98a5e', '#8a5a38', '#f0c8a0', '#6e4526'];
  var HAIR = ['#2b2118', '#5a3d22', '#8a6a3a', '#c9b489', '#3a3a40', '#711b19'];
  var SUIT = {
    Steady: '#3e5a54', Reckless: '#bf4e4e', Medic: '#e8e4d8', none: '#46525e'
  };
  var SUIT_ALT = ['#2b3540', '#5a4632', '#37474f', '#4a3a52', '#6b5136'];
  var BG = ['#233140', '#2e2a24', '#33262a', '#243430', '#2b3540'];

  function primaryTrait(diver) {
    return (diver.traits && diver.traits[0]) || 'none';
  }

  function draw(ctx, diver, variant, size) {
    var S = size || 96;
    var rnd = stream(hashOf(String(diver.id) + ':' + (variant || 0) + ':' + String(diver.name || '')));
    var trait = primaryTrait(diver);
    ctx.save();
    ctx.clearRect(0, 0, S, S);
    // Backdrop
    var bg = BG[Math.floor(rnd() * BG.length)];
    var grad = ctx.createLinearGradient(0, 0, 0, S);
    grad.addColorStop(0, bg); grad.addColorStop(1, '#141a20');
    ctx.fillStyle = grad; ctx.fillRect(0, 0, S, S);
    // Suit / shoulders
    var suit = (variant % 3 === 0 && variant > 0) ? SUIT_ALT[Math.floor(rnd() * SUIT_ALT.length)] : (SUIT[trait] || SUIT.none);
    ctx.fillStyle = suit;
    ctx.beginPath();
    ctx.moveTo(S * 0.08, S);
    ctx.quadraticCurveTo(S * 0.10, S * 0.68, S * 0.34, S * 0.62);
    ctx.lineTo(S * 0.66, S * 0.62);
    ctx.quadraticCurveTo(S * 0.90, S * 0.68, S * 0.92, S);
    ctx.closePath(); ctx.fill();
    // Collar accent in signature yellow
    ctx.fillStyle = '#daca47';
    ctx.fillRect(S * 0.44, S * 0.64, S * 0.12, S * 0.05);
    // Trait pip
    ctx.fillStyle = trait === 'Medic' ? '#bf4e4e' : '#daca47';
    ctx.beginPath(); ctx.arc(S * 0.72, S * 0.82, S * 0.045, 0, Math.PI * 2); ctx.fill();
    // Neck + head
    var skin = SKIN[Math.floor(rnd() * SKIN.length)];
    ctx.fillStyle = skin;
    ctx.fillRect(S * 0.44, S * 0.52, S * 0.12, S * 0.12);
    var headW = S * (0.30 + rnd() * 0.05), headH = S * (0.34 + rnd() * 0.05);
    var hx = S / 2 - headW / 2, hy = S * 0.16;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(hx, hy, headW, headH, S * 0.09); else ctx.rect(hx, hy, headW, headH);
    ctx.fill();
    if (diver.heroId === 'nick') {
      // Strong jaw (likeness, see hair note): widen the lower face.
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(hx - S * 0.012, hy + headH * 0.52, headW + S * 0.024, headH * 0.48, S * 0.07);
      else ctx.rect(hx - S * 0.012, hy + headH * 0.52, headW + S * 0.024, headH * 0.48);
      ctx.fill();
    }
    // Hair style: 0 flat, 1 mop, 2 bun, 3 shaved sides + strap
    var hair = HAIR[Math.floor(rnd() * HAIR.length)];
    var style = Math.floor(rnd() * 4);
    // LIKENESS (Steve, 2026-11-12 — "Match his likeness"): Nick's bust is
    // drawn from his standard B&W author photo (workspace
    // your_files/vegas-pics/nic_web.jpg): dark hair swept up off the
    // forehead, a strong wide jaw, light stubble. His tattoo band rides
    // his right forearm — below this bust's head/shoulders crop, exactly
    // as in the photo's framing — so it is not drawn here.
    var isNick = diver.heroId === 'nick';
    if (isNick) { hair = '#2b2118'; style = 4; }
    ctx.fillStyle = hair;
    if (style === 4) { // swept up: a taller mass rising off the forehead
      ctx.beginPath();
      ctx.moveTo(hx - S * 0.01, hy + S * 0.045);
      ctx.quadraticCurveTo(hx + headW * 0.10, hy - S * 0.085, hx + headW * 0.52, hy - S * 0.075);
      ctx.quadraticCurveTo(hx + headW * 0.95, hy - S * 0.06, hx + headW + S * 0.01, hy + S * 0.045);
      ctx.lineTo(hx + headW + S * 0.01, hy + S * 0.075);
      ctx.lineTo(hx - S * 0.01, hy + S * 0.075);
      ctx.closePath(); ctx.fill();
    }
    else if (style === 0) { ctx.fillRect(hx - S * 0.01, hy - S * 0.015, headW + S * 0.02, S * 0.075); }
    else if (style === 1) {
      ctx.beginPath(); ctx.arc(S / 2, hy + S * 0.02, headW * 0.58, Math.PI, 0); ctx.fill();
      ctx.fillRect(hx - S * 0.02, hy - S * 0.01, S * 0.05, S * 0.10);
    } else if (style === 2) {
      ctx.fillRect(hx, hy - S * 0.01, headW, S * 0.05);
      ctx.beginPath(); ctx.arc(S / 2, hy - S * 0.045, S * 0.055, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.fillRect(hx - S * 0.005, hy + S * 0.02, S * 0.018, headH * 0.55);
      ctx.fillRect(hx + headW - S * 0.013, hy + S * 0.02, S * 0.018, headH * 0.55);
      ctx.fillStyle = '#daca47'; ctx.fillRect(hx, hy + S * 0.055, headW, S * 0.022);
    }
    // Eyes + brows (brow angle stiffens with GRIT)
    var grit = (diver.stats && diver.stats.GRIT) || 3;
    var eyeY = hy + headH * 0.46, eyeDX = headW * 0.24;
    ctx.fillStyle = '#1d242c';
    ctx.beginPath(); ctx.arc(S / 2 - eyeDX, eyeY, S * 0.016, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(S / 2 + eyeDX, eyeY, S * 0.016, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#1d242c'; ctx.lineWidth = Math.max(1.2, S * 0.016);
    var tilt = (grit - 3) * S * 0.008;
    ctx.beginPath();
    ctx.moveTo(S / 2 - eyeDX - S * 0.045, eyeY - S * 0.055 + tilt);
    ctx.lineTo(S / 2 - eyeDX + S * 0.045, eyeY - S * 0.055 - tilt);
    ctx.moveTo(S / 2 + eyeDX - S * 0.045, eyeY - S * 0.055 - tilt);
    ctx.lineTo(S / 2 + eyeDX + S * 0.045, eyeY - S * 0.055 + tilt);
    ctx.stroke();
    // Mouth (set by NERVE)
    var nerve = (diver.stats && diver.stats.NERVE) || 3;
    ctx.beginPath();
    ctx.moveTo(S / 2 - S * 0.05, hy + headH * 0.78);
    ctx.lineTo(S / 2 + S * 0.05, hy + headH * 0.78 + (nerve >= 4 ? -S * 0.008 : S * 0.004));
    ctx.stroke();
    if (isNick) {
      // Light stubble (likeness): translucent dark along the jaw sides
      // and the chin, leaving the mouth clear.
      ctx.fillStyle = 'rgba(43, 33, 24, 0.38)';
      ctx.fillRect(hx + S * 0.008, hy + headH * 0.58, headW * 0.30, headH * 0.42);
      ctx.fillRect(hx + headW * 0.70, hy + headH * 0.58, headW * 0.29, headH * 0.42);
      ctx.fillRect(hx + headW * 0.28, hy + headH * 0.88, headW * 0.44, headH * 0.12);
    }
    // Wound bandage when the diver is carrying wounds
    if (diver.wounds > 0 || diver.status === 'wounded') {
      ctx.fillStyle = '#f0e7d3';
      ctx.fillRect(hx + headW * 0.55, hy + headH * 0.10, headW * 0.42, S * 0.045);
    }
    ctx.restore();
  }

  var cache = {};
  function url(diver, variant) {
    var key = diver.id + ':' + (variant || 0) + ':' + (diver.wounds || 0) + ':' + diver.status;
    if (cache[key]) return cache[key];
    var c = document.createElement('canvas');
    c.width = 96; c.height = 96;
    draw(c.getContext('2d'), diver, variant || 0, 96);
    cache[key] = c.toDataURL('image/png');
    return cache[key];
  }
  var imgCache = {};
  function image(diver, variant) {
    var key = diver.id + ':' + (variant || 0) + ':' + (diver.wounds || 0) + ':' + diver.status;
    if (!imgCache[key]) {
      var img = new Image();
      img.src = url(diver, variant);
      imgCache[key] = img;
    }
    return imgCache[key];
  }

  global.DropZonePortraits = { draw: draw, url: url, image: image, primaryTrait: primaryTrait };
})(typeof window !== 'undefined' ? window : globalThis);
