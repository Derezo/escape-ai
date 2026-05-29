'use strict';

/**
 * Central palette for the whole sprite library (TINS 2026 — The Caves of Steel).
 *
 * Cohesion rule: every fill in every species comes from here — never a hardcoded
 * hex in a species file. Each species declares a 5-slot palette
 * `{ base, shade, light, accent, eye }`:
 *   - base   the dominant body colour (matches the renderer's SPECIES_TINT so the
 *            atlas and the shape-fallback agree — see client/src/render/phaser.ts).
 *   - shade  base darkened ~22% — far side / underside / depth.
 *   - light  base lightened ~18% — top-lit highlight.
 *   - accent a secondary feature colour (mane, stripes, beak, shell, ...).
 *   - eye    pupil / eye colour.
 * The shared 3-tone (base/shade/light) scheme is what makes 14 different animals
 * read as one cohesive set.
 *
 * LOCKED: do not edit slot names or `outline`. New species ADD a slot object.
 */

/** The single outline colour for all sprites (matches the old generator). */
const OUTLINE = '#0b0c10';
/** Neutral white for eye-whites / highlights. */
const WHITE = '#ffffff';

/** Parse '#rrggbb' -> {r,g,b}. */
function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

/** {r,g,b} -> '#rrggbb' (clamped, deterministic). */
function rgbToHex({ r, g, b }) {
  const c = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Darken a hex toward black by fraction t (0..1). Deterministic. */
function shade(hex, t = 0.22) {
  const { r, g, b } = hexToRgb(hex);
  return rgbToHex({ r: r * (1 - t), g: g * (1 - t), b: b * (1 - t) });
}

/** Lighten a hex toward white by fraction t (0..1). Deterministic. */
function tint(hex, t = 0.18) {
  const { r, g, b } = hexToRgb(hex);
  return rgbToHex({ r: r + (255 - r) * t, g: g + (255 - g) * t, b: b + (255 - b) * t });
}

/**
 * Derive a full 5-slot palette from a base colour + optional accent/eye so a
 * species file declares one or two colours and gets a consistent shade/light.
 */
function makePalette(base, { accent, eye } = {}) {
  return {
    base,
    shade: shade(base),
    light: tint(base),
    accent: accent || shade(base, 0.4),
    eye: eye || OUTLINE,
  };
}

/**
 * Per-species palette slots. The first four bases are the LOCKED renderer tints
 * (phaser.ts SPECIES_TINT) so atlas art matches the shape fallback exactly.
 */
const PALETTE = {
  outline: OUTLINE,
  white: WHITE,

  // --- the four original species (bases locked to SPECIES_TINT) ---
  ape: makePalette('#8d6e4f', { accent: '#3a2a1c', eye: '#1a140e' }),
  bird: makePalette('#4cc9f0', { accent: '#f0a500', eye: '#10242c' }),
  rat: makePalette('#9aa3ad', { accent: '#c98a8a', eye: '#101418' }),
  elephant: makePalette('#5a6b7a', { accent: '#e8e2d0', eye: '#14181c' }),

  // --- the zoo expansion ---
  chameleon: makePalette('#6fcf97', { accent: '#3f9d6b', eye: '#1a2a14' }),
  peacock: makePalette('#1f8a8a', { accent: '#2e6fd6', eye: '#0c1c20' }),
  skunk: makePalette('#2b2b30', { accent: '#e9e9ef', eye: '#101014' }),
  mole: makePalette('#6b4f2a', { accent: '#c0a070', eye: '#140e08' }),
  cheetah: makePalette('#d8a24a', { accent: '#3a2a16', eye: '#1c1408' }),
  parrot: makePalette('#e0533a', { accent: '#3aa84a', eye: '#1c0c08' }),
  tortoise: makePalette('#7a6a3a', { accent: '#4f8a4a', eye: '#140e08' }),
  kangaroo: makePalette('#c9925b', { accent: '#7a5638', eye: '#1c1208' }),
  owl: makePalette('#6a5a8a', { accent: '#e6c45a', eye: '#0e0c14' }),
  fox: makePalette('#d2691e', { accent: '#f3ece0', eye: '#1c0e04' }),

  // --- the keeper-robot (steel; matches phaser.ts robot tint) ---
  robot: makePalette('#9aa3ad', { accent: '#5aa0e0', eye: '#e05a5a' }),
};

module.exports = { PALETTE, OUTLINE, WHITE, shade, tint, makePalette, hexToRgb, rgbToHex };
