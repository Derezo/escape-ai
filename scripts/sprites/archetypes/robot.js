'use strict';

/**
 * ROBOT archetype — a mechanical keeper: a boxy/hexagonal chassis, a single optic
 * eye, an antenna, and two stiff legs. Deliberately NOT organic so it reads apart
 * from every animal. The "walk" cycle is a stiff piston stride (no bob — robots
 * don't breathe); the optic eye is the species' accent colour.
 *
 * Authored directions only (s, n, e, se, ne); generator mirrors to w/sw/nw.
 *
 * parts = {
 *   palette,
 *   chassisR, chassisY,           // hexagon chassis radius + centre y
 *   headSize, headY,              // boxy head
 *   legLen, legThick, legY,
 *   antenna,                      // bool
 *   opticR,                       // optic eye radius
 * }
 */

const { CENTER } = require('../contract');
const t = require('../template');
const anim = require('../anim');

function legs(parts, state, frame) {
  const { palette, legLen, legThick, legY } = parts;
  const cx = CENTER;
  const phase = state === 'walk' ? frame / 4 : 0;
  // Stiff piston: legs extend/retract vertically rather than swing wide.
  const pl = state === 'walk' ? Math.round(2 * Math.sin(phase * Math.PI * 2)) : 0;
  const pr = state === 'walk' ? Math.round(2 * Math.sin((phase + 0.5) * Math.PI * 2)) : 0;
  const spread = legThick * 1.6;
  return (
    t.rect(cx - spread - legThick / 2, legY, legThick, legLen + pl, palette.shade, { rx: 1 }) +
    t.rect(cx + spread - legThick / 2, legY, legThick, legLen + pr, palette.shade, { rx: 1 }) +
    t.rect(cx - spread - legThick, legY + legLen + pl, legThick * 1.6, 3, palette.accent, { rx: 1 }) +
    t.rect(cx + spread - legThick * 0.6, legY + legLen + pr, legThick * 1.6, 3, palette.accent, { rx: 1 })
  );
}

function chassis(parts) {
  const { palette, chassisR, chassisY } = parts;
  const cx = CENTER;
  // flat-top hexagon
  let s = t.ngon(cx, chassisY, chassisR, 6, -Math.PI / 2, palette.base);
  // a riveted highlight panel
  s += t.rect(cx - chassisR * 0.4, chassisY - chassisR * 0.5, chassisR * 0.8, chassisR * 0.7, palette.light, { rx: 2 });
  return s;
}

function head(parts, dir) {
  const { palette, headSize, headY, opticR } = parts;
  const cx = CENTER;
  let s = t.rect(cx - headSize / 2, headY - headSize / 2, headSize, headSize, palette.shade, { rx: 3 });
  if (parts.antenna) {
    s = t.limb(cx, headY - headSize / 2, cx, headY - headSize, palette.shade, 2) +
      t.circle(cx, headY - headSize, 2.2, palette.accent) + s;
  }
  if (dir === 'n') return s; // back: no optic
  // single optic eye (accent); in profile it sits toward +x
  const ox = dir === 'e' || dir === 'se' || dir === 'ne' ? cx + headSize * 0.18 : cx;
  s += t.circle(ox, headY, opticR, palette.eye) +
    t.circle(ox, headY, opticR * 0.5, palette.accent, { stroke: palette.accent });
  return s;
}

function buildRobot(parts, dir, state, frame) {
  // No bob; a tiny idle "hum" flicker via breathe only.
  const lift = 0;
  void frame;
  let body = '';
  body += legs(parts, state, frame);
  body += chassis(parts);
  body += head(parts, dir);
  return t.group(body, lift ? `translate(0,${t.n1(lift)})` : undefined);
}

module.exports = { buildRobot };
