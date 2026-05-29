'use strict';

/**
 * Per-room WORLD state — the non-player entities and the shared WorldState.
 *
 * Players live in connectedPlayers (see socket/index.js); everything else in
 * the simulation lives here: the static props + NPC seeds (robots, decoy idle
 * animals, terminals, quest objects, the gate) and the per-room WorldState
 * {panic, panicCapacity, lockdown}.
 *
 * The layout is no longer hand-authored: each room derives its map from a
 * deterministic seed via the shared generator (shared/dist/world.js). The
 * server picks `seed = seedFromString(roomName)`, runs `generateWorld(seed)`,
 * and materializes the map's `entitySpecs` into the entity objects the engine /
 * stealth orchestrator already understand. The same seed is shipped to clients
 * (the `map` event) so they regenerate the identical tilemap for rendering AND
 * collision-aware prediction.
 *
 * Ids are plain and stable (derived from the spec ids, e.g. `robot-1`) so they
 * survive reconnects and the engine's delta diffing treats them as unchanged
 * once sent on a full refresh.
 *
 * The shared generator is ESM and the server is CommonJS, so we load it via a
 * dynamic import() ONCE at boot (loadSharedWorld()) and cache the resolved
 * module — exactly the pattern game/stealth.js uses for shared/dist/step.js.
 * Every per-room call uses the synchronous cached functions; no import() in the
 * room-creation path once warmed.
 */

// Initial WorldState, mirroring shared's INITIAL_WORLD_STATE. Kept as a literal
// because the server consumes none of shared's compiled module at runtime here.
const INITIAL_WORLD_STATE = { panic: 0, panicCapacity: 100, lockdown: false };

// The cached shared world module (resolved by loadSharedWorld() before the loop
// starts). Null until then; getOrCreateRoomWorld throws loudly if a room is
// created before this is warm rather than fall back to a broken empty map.
let sharedWorld = null;

// Map<roomName, { entities: Map<entityId, entity>, world: {...}, map, seed }>
const roomWorlds = new Map();

/**
 * Load + cache the shared world generator (shared/dist/world.js) and seed helper
 * (shared/dist/rng.js). Call once during engine.init(), before the tick loop and
 * before any room is created, so generateWorld is available synchronously.
 * Throws if the expected exports are missing — fail loud rather than silently
 * generate a broken world. Idempotent; returns the cached module after the first
 * resolve.
 * @returns {Promise<object>} the resolved + merged shared world module
 */
async function loadSharedWorld() {
  if (sharedWorld) return sharedWorld;
  // Relative to this file (server/game/world.js) -> shared/dist/*.js.
  const worldMod = await import('../../shared/dist/world.js');
  const rngMod = await import('../../shared/dist/rng.js');
  // Phase 6: the per-species quest definitions live in shared/dist/quests.js
  // (the ONE source of truth). We load them here, alongside the world generator,
  // so the server has a single shared-world cache to draw both the map AND the
  // quest model from — game/quests.js then calls world.questForSpecies(species)
  // rather than maintaining its own loader/cache.
  const questMod = await import('../../shared/dist/quests.js');

  const required = {
    generateWorld: worldMod.generateWorld,
    WORLD_GEN_VERSION: worldMod.WORLD_GEN_VERSION,
    MAP_W: worldMod.MAP_W,
    MAP_H: worldMod.MAP_H,
    tileSolid: worldMod.tileSolid,
    isSolidAt: worldMod.isSolidAt,
    worldToTile: worldMod.worldToTile,
    seedFromString: rngMod.seedFromString,
    questForSpecies: questMod.questForSpecies
  };
  const missing = Object.keys(required).filter((name) => required[name] === undefined);
  if (missing.length) {
    throw new Error(
      `shared/dist/world.js + rng.js are missing expected exports: ${missing.join(', ')}. ` +
      'Did you run `npm run build` in shared/? Refusing to generate a broken world.'
    );
  }

  sharedWorld = required;
  return sharedWorld;
}

/**
 * Materialize a generated map's `entitySpecs` into the live entity objects the
 * engine + stealth orchestrator understand. The specs are produced in a fixed,
 * stable order by the generator, so the resulting entity map is deterministic.
 *
 * Spec kinds map as follows:
 *   - gate        → a static gate (the escape target)
 *   - terminal    → a static interactable (Second-Law order point)
 *   - prop        → the carryable Clipboard disguise (carrierId starts null)
 *   - robotSpawn  → a live robot (suspicion 0, facing south)
 *   - penAnchor   → an idle decoy animal sitting in its species' enclosure (these
 *                   replace the old round-robin idle animals — one decoy per
 *                   species, anchored in its home)
 *   - questObject → a static quest marker (NEW kind; harmless to the engine — it
 *                   rides snapshots as a static prop, carrying its meta for Phase 6)
 *
 * penAnchor and questObject are BOTH emitted per species (sharing a species):
 * one wandering decoy + one quest object per enclosure. That's intended.
 *
 * @param {object} map  a WorldMap from generateWorld
 * @returns {Map<string, object>} entityId -> entity
 */
function spawnFromMap(map) {
  const entities = new Map();
  const add = (entity) => entities.set(entity.id, entity);

  for (const spec of map.entitySpecs) {
    switch (spec.kind) {
      case 'gate':
        add({ id: spec.id, x: spec.x, y: spec.y, name: 'Gate', kind: 'gate' });
        break;
      case 'terminal':
        add({ id: spec.id, x: spec.x, y: spec.y, name: spec.id, kind: 'terminal' });
        break;
      case 'prop':
        add({ id: spec.id, x: spec.x, y: spec.y, name: 'Clipboard', kind: 'prop', carrierId: null });
        break;
      case 'robotSpawn':
        add({ id: spec.id, x: spec.x, y: spec.y, name: spec.id, kind: 'robot', suspicion: 0, facing: 's' });
        break;
      case 'penAnchor':
        add({
          id: spec.id,
          x: spec.x,
          y: spec.y,
          name: `${spec.species}`,
          kind: 'animal',
          species: spec.species,
          humanLikeness: 0,
          facing: 's'
        });
        break;
      case 'questObject':
        add({
          id: spec.id,
          x: spec.x,
          y: spec.y,
          kind: 'questObject',
          species: spec.species,
          name: `quest:${spec.species}`,
          meta: spec.meta
        });
        break;
      default:
        // Unknown spec kind — skip rather than spawn a malformed entity. The
        // generator only emits the kinds above; a new kind is a deliberate
        // additive change that this switch must be taught about.
        break;
    }
  }

  return entities;
}

/**
 * Get a room's world, lazily generating it from the room seed the first time the
 * room is seen. Throws if the shared generator hasn't loaded yet (a programmer
 * error — engine.init() awaits loadSharedWorld() before any room is created).
 * @param {string} roomName
 * @returns {{ entities: Map<string, object>, world: object, map: object, seed: number }}
 */
function getOrCreateRoomWorld(roomName) {
  let roomWorld = roomWorlds.get(roomName);
  if (!roomWorld) {
    if (!sharedWorld) {
      throw new Error(
        `world.getOrCreateRoomWorld("${roomName}") called before loadSharedWorld() resolved. ` +
        'engine.init() must await world.loadSharedWorld() before any room is created.'
      );
    }
    const seed = sharedWorld.seedFromString(roomName);
    const map = sharedWorld.generateWorld(seed);
    roomWorld = {
      entities: spawnFromMap(map),
      world: { ...INITIAL_WORLD_STATE },
      map,
      seed
    };
    roomWorlds.set(roomName, roomWorld);
  }
  return roomWorld;
}

/**
 * The room's collision + spawn data, for collision-aware movement and spawning.
 * Creates the room on demand.
 * @param {string} roomName
 * @returns {{ collision: Uint8Array, w: number, h: number, tile: number, spawns: {x:number,y:number}[] }}
 */
function getRoomMap(roomName) {
  const map = getOrCreateRoomWorld(roomName).map;
  return {
    collision: map.collision,
    w: map.w,
    h: map.h,
    tile: map.tile,
    spawns: map.spawns
  };
}

/**
 * The `map` event payload meta for a room: everything a client needs to
 * regenerate the tilemap deterministically. Creates the room on demand.
 * @param {string} roomName
 * @returns {{ seed: number, version: number, tile: number, w: number, h: number }}
 */
function getMapMeta(roomName) {
  const rw = getOrCreateRoomWorld(roomName);
  return {
    seed: rw.seed,
    version: rw.map.version,
    tile: rw.map.tile,
    w: rw.map.w,
    h: rw.map.h
  };
}

/**
 * Whether a world-unit position sits on a solid tile in a room (OOB is solid).
 * Used by stealth.js to hold robots / idle decoys out of walls when their
 * wander step would carry them into one. Creates the room on demand.
 * @param {string} roomName
 * @param {number} x
 * @param {number} y
 * @returns {boolean}
 */
function isSolidAtRoom(roomName, x, y) {
  const map = getOrCreateRoomWorld(roomName).map;
  return sharedWorld.isSolidAt(map, x, y);
}

/**
 * The room's world entities as a fresh array. Creates the world on demand.
 * @param {string} roomName
 * @returns {object[]}
 */
function getWorldEntities(roomName) {
  return Array.from(getOrCreateRoomWorld(roomName).entities.values());
}

/**
 * The room's WorldState object. Creates the world on demand.
 * @param {string} roomName
 * @returns {object}
 */
function getWorldState(roomName) {
  return getOrCreateRoomWorld(roomName).world;
}

/** Forget a room's world entirely (e.g. when the room empties). */
function removeRoom(roomName) {
  roomWorlds.delete(roomName);
}

/**
 * Add a (usually temporary) entity to a room's world — e.g. a skunk stink-cloud
 * hazard or a fox lure decoy. Stored in the same entity map as the static props,
 * so it rides the engine's delta diff automatically. An entity carrying an
 * `expireTick` is swept by pruneExpired once that tick passes.
 * @param {string} roomName
 * @param {object} entity  must have a unique `id`
 */
function addWorldEntity(roomName, entity) {
  getOrCreateRoomWorld(roomName).entities.set(entity.id, entity);
}

/**
 * Remove every world entity in a room whose `expireTick` has passed. Called each
 * tick from the engine so temporary effects (hazards, decoys) clean themselves up
 * and stop riding the snapshot. Returns the number removed.
 * @param {string} roomName
 * @param {number} currentTick
 * @returns {number}
 */
function pruneExpired(roomName, currentTick) {
  const rw = roomWorlds.get(roomName);
  if (!rw) return 0;
  let removed = 0;
  for (const [id, e] of rw.entities) {
    if (typeof e.expireTick === 'number' && e.expireTick <= currentTick) {
      rw.entities.delete(id);
      removed++;
    }
  }
  return removed;
}

/** Monotonic per-room counter for unique temporary-entity ids (no Math.random). */
const tempCounterByRoom = new Map();
function nextTempId(roomName, prefix) {
  const n = (tempCounterByRoom.get(roomName) || 0) + 1;
  tempCounterByRoom.set(roomName, n);
  return `${prefix}-${n}`;
}

/**
 * The shared quest definition for a species (Phase 6). A pure lookup into the
 * cached shared/dist/quests.js — the ONE source of truth for per-species quests.
 * Throws if called before loadSharedWorld() resolves (a programmer error; the
 * engine awaits it at boot), rather than silently returning undefined.
 * @param {string} species
 * @returns {{species:string,type:string,title:string,blurb:string,need:number}}
 */
function questForSpecies(species) {
  if (!sharedWorld) {
    throw new Error(
      'world.questForSpecies() called before loadSharedWorld() resolved. ' +
      'engine.init() must await world.loadSharedWorld() before any player joins.'
    );
  }
  return sharedWorld.questForSpecies(species);
}

module.exports = {
  loadSharedWorld,
  getOrCreateRoomWorld,
  getRoomMap,
  getMapMeta,
  isSolidAtRoom,
  getWorldEntities,
  getWorldState,
  removeRoom,
  addWorldEntity,
  pruneExpired,
  nextTempId,
  questForSpecies,
  INITIAL_WORLD_STATE
};
