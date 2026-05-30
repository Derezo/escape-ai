'use strict';

/**
 * Tile-builder registry — the fan-out join point (tile analogue of
 * scripts/sprites/registry.js). Merges every category's builder map into one
 * `{ buildName: fn }` lookup. gen-tiles.js iterates contract.TILE_LIST and calls
 * `registry[entry.build](entry.name)` to draw each tile's inner SVG fragment.
 *
 * Every `build` key referenced in contract.TILE_LIST MUST resolve here — gen-tiles
 * fails loudly if one is missing, so an un-implemented tile can't slip through.
 */

const terrain = require('./builders/terrain');
const edges = require('./builders/edges');
const nature = require('./builders/nature');
const structures = require('./builders/structures');
const fences = require('./builders/fences');
const housing = require('./builders/housing');
const props = require('./builders/props');
const bridges = require('./builders/bridges');

/** EMPTY (index 0): an explicit transparent cell. Phaser treats index 0 as no-tile;
 *  the packer leaves the slot blank, but a builder keeps the contract uniform. */
function buildEmpty() {
  return '';
}

const REGISTRY = Object.assign(
  { buildEmpty },
  terrain,
  edges,
  nature,
  structures,
  fences,
  housing,
  props,
  bridges,
);

// Strip the non-builder helper terrain re-exports (e.g. `ground`) so the registry
// only carries `build*` entries the contract references.
for (const k of Object.keys(REGISTRY)) {
  if (!k.startsWith('build')) delete REGISTRY[k];
}

module.exports = { REGISTRY };
