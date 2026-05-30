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

// Map<roomName, { entities: Map<entityId, entity>, world: {...}, map, seed,
//                 unlockedDoors: Set<buildingId> }>
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
  // The per-species liked-food table lives in shared/dist/food.js (the ONE source
  // of truth for the animal-collection feature). Loaded here alongside the world
  // generator + quests so the server draws the map, the quest model AND the food
  // model from one shared-world cache — game/follow.js then calls
  // world.foodForSpecies(species) rather than maintaining its own loader.
  const foodMod = await import('../../shared/dist/food.js');

  const required = {
    generateWorld: worldMod.generateWorld,
    WORLD_GEN_VERSION: worldMod.WORLD_GEN_VERSION,
    MAP_W: worldMod.MAP_W,
    MAP_H: worldMod.MAP_H,
    tileSolid: worldMod.tileSolid,
    isSolidAt: worldMod.isSolidAt,
    worldToTile: worldMod.worldToTile,
    seedFromString: rngMod.seedFromString,
    questForSpecies: questMod.questForSpecies,
    foodForSpecies: foodMod.foodForSpecies
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
 *   - terminal    → a static interactable (Second-Law order point); a spec with
 *                   meta.door is an aux-building DOOR terminal (carries door +
 *                   buildingId + auxKind so interact can unlock that building)
 *   - prop        → the carryable Clipboard disguise (carrierId starts null)
 *   - robotSpawn  → a live robot (suspicion 0, facing south); a spec with meta.guard
 *                   is an aux-building GUARD (behavior 'guard' — stays contained)
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
      case 'terminal': {
        // A door-terminal (aux-building lock) carries door + building meta so the
        // interact path can unlock the right building; the junction terminals
        // (terminal-1..4) have no such meta and keep their plain stand-down behavior.
        const t = { id: spec.id, x: spec.x, y: spec.y, name: spec.id, kind: 'terminal' };
        if (spec.meta && spec.meta.door) {
          t.door = true;
          t.buildingId = spec.meta.buildingId;
          t.auxKind = spec.meta.auxKind;
        }
        add(t);
        break;
      }
      case 'prop':
        add({ id: spec.id, x: spec.x, y: spec.y, name: 'Clipboard', kind: 'prop', carrierId: null });
        break;
      case 'robotSpawn': {
        // A guard robot (spec.meta.guard) stays inside its aux building via the
        // 'guard' containment behavior (behaviors.js); it still pursues/investigates
        // intruders. A plain patrol robot (no guard meta) walks the path loop with
        // behavior='patrol' — patrolIndex is assigned lazily on first step from its
        // id hash so robots spread around the loop rather than clumping.
        const robot = { id: spec.id, x: spec.x, y: spec.y, name: spec.id, kind: 'robot', suspicion: 0, facing: 's', behavior: 'patrol' };
        if (spec.meta && spec.meta.guard) {
          robot.behavior = 'guard';
          robot.guard = true;
          robot.buildingId = spec.meta.buildingId;
          robot.auxKind = spec.meta.auxKind;
        }
        add(robot);
        break;
      }
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
      case 'foodSource': {
        // A per-species food source (animal-collection feature). Runtime entity
        // kind is 'food'; the foodKey rides in spec.meta (stamped deterministically
        // by the generator), with a defensive fallback to the shared food table.
        const def = sharedWorld.foodForSpecies(spec.species);
        // The food now lives INSIDE an aux building; carry buildingId/auxKind so
        // follow.collectNearbyFood can gate it behind that building's locked door.
        add({
          id: spec.id,
          x: spec.x,
          y: spec.y,
          kind: 'food',
          species: spec.species,
          foodKey: (spec.meta && spec.meta.foodKey) || def.key,
          name: def.label,
          buildingId: spec.meta && spec.meta.buildingId,
          auxKind: spec.meta && spec.meta.auxKind
        });
        break;
      }
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
      seed,
      // Aux-building doors start LOCKED (the building's `locked: true` flag is pure
      // runtime state — the door TILE is non-solid). A door is opened by tapping its
      // door-terminal, which adds the building id here; food inside stays out of reach
      // until then. Empty = everything locked.
      unlockedDoors: new Set()
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
 * The room's robot patrol loop in world units (the path-network junctions in
 * carve order — see WorldMap.patrolRoute). Robots walk these waypoints in order
 * to patrol the paved avenues. Seed-derived (free on the wire) and cached per
 * room via getOrCreateRoomWorld. May be empty on a degenerate seed; callers fall
 * back to ambient wander. Creates the room on demand.
 * @param {string} roomName
 * @returns {{x:number,y:number}[]}
 */
function getPatrolRoute(roomName) {
  return getOrCreateRoomWorld(roomName).map.patrolRoute || [];
}

/**
 * Per-species home CONTAINMENT bounds in world units, for keeping a pen's idle
 * NPC animals inside their enclosure (Phase C). For each housing/building, the
 * bounds are the interior wall-ring inset by one tile, so the ambient wander bias
 * (movement.wanderAvoid(bounds)) turns an animal inward before it reaches the barrier
 * and never lets it drift out the 2-tile (non-solid) enclosure gate. The gatehouse
 * (species == null) is skipped — it has no animals. Computed once per map; the
 * caller keys it to animal ids (`pen-${species}` / `pen-${species}-n`).
 *
 * @param {string} roomName
 * @returns {Map<string, {minX:number,minY:number,maxX:number,maxY:number}>}
 */
function getHomeBoundsBySpecies(roomName) {
  const map = getOrCreateRoomWorld(roomName).map;
  const tile = map.tile;
  const bounds = new Map();
  const add = (species, rx, ry, rw, rh) => {
    if (!species) return; // gatehouse has no species → no animals
    // Interior wall ring inset by one tile (the barrier ring is the outer edge).
    // World-gen guarantees rw>=8/rh>=8 (interior >=6x6), so the inset never
    // inverts; clamp defensively anyway so a degenerate rect can't hand wanderStep
    // an inverted bound (which would pin/freeze an animal) — keep min<=max.
    const minX = (rx + 1) * tile;
    const minY = (ry + 1) * tile;
    const maxX = Math.max((rx + rw - 1) * tile, minX);
    const maxY = Math.max((ry + rh - 1) * tile, minY);
    bounds.set(species, { minX, minY, maxX, maxY });
  };
  for (const h of map.housing) add(h.species, h.rx, h.ry, h.rw, h.rh);
  for (const b of map.buildings) add(b.species, b.rx, b.ry, b.rw, b.rh);
  return bounds;
}

/**
 * Per-species home CENTER in world units, for a released follower's drift-home
 * target (NPC movement refactor). Housing stores a world-unit center (cx,cy)
 * directly; buildings only have a tile rect, so the center is derived from it.
 * The gatehouse (species == null) is skipped. Computed once per map; the caller
 * keys it by species (penSpeciesOf(id) / entity.species). An animal whose species
 * isn't here (e.g. a transient fox decoy) gets no entry → no return-home target.
 *
 * @param {string} roomName
 * @returns {Map<string, {x:number, y:number}>}
 */
function getHomeCentersBySpecies(roomName) {
  const map = getOrCreateRoomWorld(roomName).map;
  const tile = map.tile;
  const centers = new Map();
  for (const h of map.housing) {
    if (h.species) centers.set(h.species, { x: h.cx, y: h.cy });
  }
  for (const b of map.buildings) {
    if (b.species) centers.set(b.species, { x: (b.rx + b.rw / 2) * tile, y: (b.ry + b.rh / 2) * tile });
  }
  return centers;
}

/**
 * Per-species home GATE-INSIDE goal TILE, for the return-home pathfinder (the A*
 * goal — one row inside the enclosure gate / building door, guaranteed non-solid
 * and inside the inset containment bounds, so a solid pond/den core can never make
 * the goal unreachable). Housing's gate is south-center (gateTx = rx+floor(rw/2),
 * gateTy = ry+rh-1) — the same geometry stampHousing carves; a species building
 * carries doorTx/doorTy directly. The gatehouse (species == null) is skipped.
 * Computed once per map; the caller keys it by species. An animal whose species
 * isn't here (a transient fox decoy) gets no entry → no path goal (it drifts).
 * @param {string} roomName
 * @returns {Map<string, {tx:number, ty:number}>}
 */
function getHomeGateInsideBySpecies(roomName) {
  const map = getOrCreateRoomWorld(roomName).map;
  const tiles = new Map();
  for (const h of map.housing) {
    if (!h.species) continue;
    const gateTx = h.rx + Math.floor(h.rw / 2);
    const gateTy = h.ry + h.rh - 1;
    tiles.set(h.species, { tx: gateTx, ty: gateTy - 1 }); // one row inside the gate
  }
  for (const b of map.buildings) {
    if (!b.species) continue;
    tiles.set(b.species, { tx: b.doorTx, ty: b.doorTy - 1 }); // one row inside the door
  }
  return tiles;
}

/**
 * The aux Building (`aux-commissary` / `aux-washroom` / `aux-maintenance`) for an
 * id in a room, or null for an unknown / non-aux id. Only buildings carrying an
 * `auxKind` are aux buildings; the gatehouse + species homes are excluded.
 * @param {string} roomName
 * @param {string} id
 * @returns {object|null}
 */
function auxBuildingById(roomName, id) {
  if (!id) return null;
  const map = getOrCreateRoomWorld(roomName).map;
  return map.buildings.find((b) => b.auxKind && b.id === id) || null;
}

/**
 * Whether an aux building's door is currently LOCKED in a room. True unless the
 * building has been unlocked (its id is in the room's unlockedDoors set). Only
 * meaningful for aux buildings: an unknown / non-aux id returns false, so
 * non-gated food (a fallback or a future free food source) is never blocked.
 * @param {string} roomName
 * @param {string} buildingId
 * @returns {boolean}
 */
function isDoorLocked(roomName, buildingId) {
  if (!auxBuildingById(roomName, buildingId)) return false; // unknown / non-aux → not gated
  const rw = getOrCreateRoomWorld(roomName);
  return !rw.unlockedDoors.has(buildingId);
}

/**
 * Unlock an aux building's door in a room (idempotent). Adds the building id to the
 * room's unlockedDoors set so isDoorLocked returns false afterward and the food
 * inside becomes collectible. Creates the room on demand.
 * @param {string} roomName
 * @param {string} buildingId
 */
function unlockDoor(roomName, buildingId) {
  if (!buildingId) return;
  getOrCreateRoomWorld(roomName).unlockedDoors.add(buildingId);
}

/**
 * Per-guard-robot CONTAINMENT bounds in world units, for keeping a guard robot
 * inside its aux building (mirrors getHomeBoundsBySpecies for pen animals). For
 * each aux building, the bounds are the interior wall-ring inset by one tile, and
 * the guard's id (`robot-guard-${auxKind}`) maps to them. The same inset math as
 * getHomeBoundsBySpecies, clamped so min<=max on a degenerate rect. Computed once
 * per map; the caller keys it by robot id.
 * @param {string} roomName
 * @returns {Map<string, {minX:number,minY:number,maxX:number,maxY:number}>}
 */
function getGuardBoundsByRobotId(roomName) {
  const map = getOrCreateRoomWorld(roomName).map;
  const tile = map.tile;
  const bounds = new Map();
  for (const b of map.buildings.filter((bb) => bb.auxKind)) {
    // Interior wall ring inset by one tile (the barrier ring is the outer edge).
    const minX = (b.rx + 1) * tile;
    const minY = (b.ry + 1) * tile;
    const maxX = Math.max((b.rx + b.rw - 1) * tile, minX);
    const maxY = Math.max((b.ry + b.rh - 1) * tile, minY);
    bounds.set(`robot-guard-${b.auxKind}`, { minX, minY, maxX, maxY });
  }
  return bounds;
}

/**
 * The aux-building INTERIOR rects in world units, as a plain array (the same inset
 * wall-ring math as getGuardBoundsByRobotId, but unkeyed — the awareness filter only
 * asks "is this point inside ANY aux interior", not which one). Used to make an
 * animal that has somehow ended up inside an aux building invisible to robots (it's
 * "where it belongs", same rule as a contained pen animal). Computed once per map.
 * @param {string} roomName
 * @returns {{minX:number,minY:number,maxX:number,maxY:number}[]}
 */
function getAuxInteriorRects(roomName) {
  const map = getOrCreateRoomWorld(roomName).map;
  const tile = map.tile;
  const rects = [];
  for (const b of map.buildings.filter((bb) => bb.auxKind)) {
    const minX = (b.rx + 1) * tile;
    const minY = (b.ry + 1) * tile;
    const maxX = Math.max((b.rx + b.rw - 1) * tile, minX);
    const maxY = Math.max((b.ry + b.rh - 1) * tile, minY);
    rects.push({ minX, minY, maxX, maxY });
  }
  return rects;
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

/**
 * The shared liked-food definition for a species (animal-collection feature). A
 * pure lookup into the cached shared/dist/food.js — the ONE source of truth for
 * per-species food. Total (never undefined). Throws if called before
 * loadSharedWorld() resolves (a programmer error; the engine awaits it at boot).
 * @param {string} species
 * @returns {{species:string,key:string,label:string,tint:number,icon:string,blurb:string}}
 */
function foodForSpecies(species) {
  if (!sharedWorld) {
    throw new Error(
      'world.foodForSpecies() called before loadSharedWorld() resolved. ' +
      'engine.init() must await world.loadSharedWorld() before any player joins.'
    );
  }
  return sharedWorld.foodForSpecies(species);
}

module.exports = {
  loadSharedWorld,
  getOrCreateRoomWorld,
  getRoomMap,
  getPatrolRoute,
  getHomeBoundsBySpecies,
  getHomeCentersBySpecies,
  getHomeGateInsideBySpecies,
  getGuardBoundsByRobotId,
  getAuxInteriorRects,
  auxBuildingById,
  isDoorLocked,
  unlockDoor,
  getMapMeta,
  isSolidAtRoom,
  getWorldEntities,
  getWorldState,
  removeRoom,
  addWorldEntity,
  pruneExpired,
  nextTempId,
  questForSpecies,
  foodForSpecies,
  INITIAL_WORLD_STATE
};
