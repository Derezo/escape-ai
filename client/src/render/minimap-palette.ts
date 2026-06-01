/**
 * Dedicated minimap tile palette.
 *
 * The in-world `fallbackTileColor` (phaser.ts) is tuned for a full-size tilemap
 * with art over it; at the minimap's 1/32 world scale a single tile collapses to
 * ~1px, so subtle in-world greens/greys turn to mud. This palette trades realism
 * for LEGIBILITY-AT-ONE-PIXEL: higher saturation, more contrast between families,
 * and a deliberate "structure pops against terrain" hierarchy so the zoo's shape
 * (paths, water, buildings, pens) reads at a glance — exactly what a minimap is for.
 *
 * Keyed by the semantic NAME prefix in shared/src/tiles.ts (the single source of
 * truth for tile indices), so new tiles slot into the right family for free. The
 * function is TOTAL over real tile indices and returns null for EMPTY (transparent),
 * matching the renderer's convention.
 */

import { TILE_BY_INDEX } from '@shared/tiles';

/**
 * Minimap color (0xRRGGBB) for a tile index, or null for an empty/transparent cell.
 * Ground families fill their cell; solid structures use strong, distinct hues so the
 * built environment stands out from terrain at minimap scale.
 */
export function minimapTileColor(idx: number): number | null {
  const def = TILE_BY_INDEX[idx];
  if (!def || idx === 0) return null;
  const name = def.name;

  // --- Water: the strongest landmark on any map, so the most saturated blues. ---
  if (name.startsWith('WATER') || name.startsWith('POND')) {
    return name.includes('DEEP') ? 0x1c4fa0 : 0x3a8ee0;
  }
  if (name === 'MOAT_EDGE') return 0x2f6fc0;
  if (name === 'LILY_PAD' || name === 'LILY_FLOWER') return 0x2f7d52;
  if (name === 'BRIDGE_H' || name === 'BRIDGE_V') return 0xc69a5b; // warm plank over water

  // --- Paths / paved: light neutral so the avenue network is obvious. ---
  if (name.startsWith('PAVED') || name.startsWith('COBBLE') || name.startsWith('PATH')) {
    return 0xc8c6cc;
  }

  // --- Bare earth. ---
  if (name.startsWith('DIRT') || name.startsWith('MUD')) return 0x8a6233;
  if (name.startsWith('SAND')) return 0xe6d489;

  // --- Interior floors (so building insides read as floor, not terrain). ---
  if (name.startsWith('FLOOR') || name.startsWith('PEN_FLOOR') || name === 'HEAT_LAMP_FLOOR') {
    return 0xcdbb95;
  }

  // --- Vegetation: grass base + darker canopy/bush so woodland reads as texture. ---
  if (name.startsWith('GRASS') || name === 'GRASS_TALL') return 0x4f9e3a;
  if (name.startsWith('TREE_CANOPY') || name === 'PINE_CANOPY') return 0x256b22;
  if (name.includes('TRUNK') || name === 'LOG' || name === 'STUMP') return 0x6b4a28;
  if (name.startsWith('BUSH') || name === 'REEDS' || name === 'CATTAILS') return 0x2f7a32;
  if (name.startsWith('FLOWER')) return 0xe06a9a;
  if (name === 'NEST' || name === 'BURROW_MOUND' || name === 'MUSHROOM') return 0x9a7a4a;

  // --- Rocks. ---
  if (name.startsWith('ROCK') || name === 'BOULDER' || name.startsWith('ROCKY_DEN')) {
    return 0x9a948c;
  }

  // --- Structures: warm, high-contrast so buildings pop off the terrain. ---
  if (name.startsWith('ROOF')) return 0xcf5340; // brick-red roofs — the clearest building marker
  if (name.startsWith('WALL') || name === 'WINDOW' || name === 'DOOR_CLOSED') return 0x9c7044;
  if (name === 'DOOR_OPEN') return 0x4a3320;
  if (name === 'SHADE_CLOTH') return 0xb0a070;

  // --- Enclosures / barriers: tan so pens & cages outline distinctly. ---
  if (name.startsWith('FENCE') || name.startsWith('CAGE')) return 0xd2a85f;
  if (name.startsWith('AVIARY') || name.startsWith('ENCLOSURE') || name === 'KEEPER_GATE') {
    return 0xb6c0cc;
  }

  // --- Props: muted neutral so clutter doesn't compete with the map's structure. ---
  return 0xa8a4ac;
}
