/* DROP ZONE — weapon thumbnails (fix-it-all §6, 2026-11-10).
 * One hand-drawn inline-SVG icon per weapon in core's gearFor table:
 * the 8 starters + every trait-fallback class + a generic long-arm so no
 * weapon ever renders iconless. Code-drawn marks in the Warm Bone / brick /
 * signature-yellow palette — no AI imagery, no external stock.
 * Plain script: window.DropZoneWeapons { keyFor, icon, ICON_KEYS }.
 */
(function (global) {
  'use strict';

  var BONE = '#e8e4d8', BRICK = '#bf4e4e', DARK = '#1d242c', YELL = '#daca47';

  // Each icon: simple part-composed silhouette in a 72x28 box.
  // parts: barrel length, body, mag style, stock style, extras.
  function svg(parts) {
    var s = '<svg viewBox="0 0 72 28" xmlns="http://www.w3.org/2000/svg" role="img" aria-hidden="true">';
    s += '<rect x="1" y="1" width="70" height="26" rx="4" fill="' + DARK + '"/>';
    s += parts;
    s += '</svg>';
    return s;
  }
  function line(x1, y1, x2, y2, w, c) {
    return '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" stroke="' + (c || BONE) + '" stroke-width="' + (w || 2.4) + '" stroke-linecap="round"/>';
  }
  function rect(x, y, w, h, c) {
    return '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="1" fill="' + (c || BONE) + '"/>';
  }
  function poly(pts, c) { return '<polygon points="' + pts + '" fill="' + (c || BONE) + '"/>'; }

  var ICONS = {
    // AR family — receiver, rail, curved mag, stock; told apart by extras.
    m4a1: svg(line(6, 12, 20, 12, 3) + rect(20, 9, 24, 6) + line(44, 11, 62, 11, 2.2) +
      rect(28, 15, 5, 8) + poly('30,15 35,15 33,24 28,23') + rect(20, 5, 14, 3, BRICK) + line(52, 8, 52, 11, 2)),
    m4: svg(line(8, 12, 20, 12, 3) + rect(20, 9, 22, 6) + line(42, 11, 58, 11, 2.2) +
      rect(27, 15, 5, 8) + poly('29,15 34,15 32,23 27,22') + rect(22, 6, 10, 2.4)),
    hk416: svg(line(4, 12, 18, 12, 3.4) + rect(18, 8, 26, 7) + line(44, 11, 60, 11, 2.6) +
      rect(27, 15, 5, 8) + poly('29,15 34,15 32,24 27,23') + rect(20, 4.6, 20, 3, YELL) + rect(46, 13, 8, 3)),
    m27: svg(line(6, 12, 19, 12, 3) + rect(19, 9, 24, 6) + line(43, 11, 64, 11, 3) +
      rect(27, 15, 5, 8) + poly('29,15 34,15 32,24 27,23') + line(56, 14, 53, 21, 1.8, BRICK) + line(56, 14, 60, 21, 1.8, BRICK) + rect(21, 5, 12, 3)),
    saw: svg(line(8, 13, 18, 13, 3) + rect(18, 8, 28, 8) + line(46, 11, 63, 11, 2.4) +
      rect(24, 16, 14, 8, BRICK) + line(52, 16, 49, 23, 1.8) + line(52, 16, 56, 23, 1.8) + rect(24, 4, 12, 3, YELL)),
    mossberg: svg(line(10, 12, 18, 12, 3) + rect(18, 9, 18, 6) + line(36, 10.6, 64, 10.6, 2.6) +
      line(36, 14, 62, 14, 2) + rect(42, 12, 9, 5, BRICK) + line(60, 8, 60, 10.6, 2)),
    m870: svg(line(10, 12, 18, 12, 3) + rect(18, 9, 17, 6) + line(35, 10.6, 61, 10.6, 2.6) +
      line(35, 14, 59, 14, 2) + rect(41, 12, 8, 5, YELL) + line(57, 8, 57, 10.6, 2)),
    mp5: svg(line(14, 12, 24, 12, 3) + rect(24, 9, 18, 6) + line(42, 11, 52, 11, 2.2) +
      poly('30,15 35,15 36,24 31,24') + rect(46, 7, 3, 4, BRICK) + rect(24, 5.4, 10, 2.4)),
    mp7: svg(line(20, 12, 28, 12, 3) + rect(28, 8, 16, 8) + line(44, 11, 52, 11, 2.4) +
      rect(33, 16, 4, 7, BRICK) + poly('37,15 41,15 40,22 36,21') + rect(30, 5, 10, 2.2, YELL)),
    m320: svg(line(16, 13, 24, 13, 3) + rect(24, 9, 16, 7) + line(40, 11, 58, 11, 5, BONE) +
      rect(29, 16, 4, 7) + rect(42, 6.4, 8, 2.6, BRICK) + line(56, 8, 56, 6.4, 0)),
    mk12: svg(line(8, 12, 19, 12, 3) + rect(19, 9, 22, 6) + line(41, 11, 66, 11, 2) +
      rect(26, 15, 5, 7) + poly('28,15 33,15 31,22 26,21') + rect(24, 4, 12, 3.4, BRICK) + line(58, 14, 55, 21, 1.8) + line(58, 14, 62, 21, 1.8)),
    m110: svg(line(6, 12, 18, 12, 3.6) + rect(18, 8, 24, 7) + line(42, 11, 65, 11, 2.4) +
      rect(27, 15, 5, 8) + poly('29,15 34,15 32,23 27,22') + rect(23, 3.8, 13, 3.6, YELL) + rect(8, 9, 6, 6, BRICK)),
    benelli: svg(line(10, 12, 18, 12, 3) + rect(18, 9, 19, 6) + line(37, 10.6, 63, 10.6, 2.6) +
      line(37, 14, 60, 14, 2) + rect(43, 12, 8, 5, BRICK) + rect(24, 15, 10, 5, YELL) + line(59, 8, 59, 10.6, 2)),
    aa12: svg(line(12, 12, 20, 12, 3.4) + rect(20, 8, 20, 7) + line(40, 11, 58, 11, 3) +
      '<circle cx="31" cy="19" r="5" fill="' + BRICK + '"/>' + rect(22, 4.6, 12, 2.6, YELL)),
    m24: svg(line(8, 12, 18, 12, 3) + rect(18, 9, 20, 6) + line(38, 11, 67, 11, 1.8) +
      rect(26, 15, 4, 6) + poly('28,15 32,15 30,21 26,20') + rect(22, 3.8, 13, 3.4, BRICK) + '<circle cx="42" cy="8" r="1.6" fill="' + YELL + '"/>'),
    law: svg(line(14, 13, 22, 13, 3) + rect(22, 8, 34, 9) + rect(30, 16, 4, 6) +
      rect(26, 4.6, 8, 3, BRICK) + line(56, 10, 62, 10, 3, YELL) + rect(36, 10, 12, 4, DARK)),
    stinger: svg(line(12, 13, 20, 13, 3) + rect(20, 9, 30, 7) + rect(28, 16, 4, 6) +
      rect(38, 3.6, 10, 5, BRICK) + line(50, 11, 60, 11, 3.4) + rect(22, 10, 8, 4, YELL)),
    barrett: svg(line(6, 12, 16, 12, 3.4) + rect(16, 8, 24, 7) + line(40, 11, 68, 11, 2.6) +
      rect(25, 15, 6, 8) + poly('27,15 33,15 31,24 25,23') + rect(21, 4, 13, 3.4, BRICK) + rect(60, 8.6, 6, 5, YELL)),
    colt: svg(rect(16, 8, 26, 6) + line(42, 10, 50, 10, 3) + poly('24,14 32,14 30,24 22,22') +
      rect(18, 5.4, 10, 2.4, BRICK) + rect(36, 14, 4, 4, YELL)),
    generic: svg(line(8, 12, 20, 12, 3) + rect(20, 9, 22, 6) + line(42, 11, 60, 11, 2.2) +
      rect(28, 15, 5, 7) + poly('30,15 34,15 32,22 28,21'))
  };

  function keyFor(weapon) {
    var w = String(weapon || '');
    if (/Colt|M1911/.test(w)) return 'colt';
    if (/Barrett/.test(w)) return 'barrett';
    if (/Stinger/.test(w)) return 'stinger';
    if (/LAW/.test(w)) return 'law';
    if (/AA-12/.test(w)) return 'aa12';
    if (/Benelli|M1014/.test(w)) return 'benelli';
    if (/M24(?!\d)|Mk 13/.test(w)) return 'm24';
    if (/M249/.test(w)) return 'saw';
    if (/590A1/.test(w)) return 'mossberg';
    if (/M870/.test(w)) return 'm870';
    if (/MP5/.test(w)) return 'mp5';
    if (/MP7/.test(w)) return 'mp7';
    if (/M320/.test(w)) return 'm320';
    if (/Mk 12/.test(w)) return 'mk12';
    if (/M110/.test(w)) return 'm110';
    if (/HK416/.test(w)) return 'hk416';
    if (/M27/.test(w)) return 'm27';
    if (/M4A1/.test(w)) return 'm4a1';
    if (/M4/.test(w)) return 'm4';
    return 'generic';
  }
  function icon(weapon) { return ICONS[keyFor(weapon)]; }

  global.DropZoneWeapons = { keyFor: keyFor, icon: icon, ICONS: ICONS };
})(typeof window !== 'undefined' ? window : globalThis);
