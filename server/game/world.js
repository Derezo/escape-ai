'use strict';

/**
 * Per-room WORLD state — the non-player entities and the shared WorldState.
 *
 * Players live in connectedPlayers (see socket/index.js); everything else in
 * the simulation lives here: the static props (pens, robots, idle animals,
 * terminals, the gate) and the per-room WorldState {panic, panicCapacity,
 * lockdown}. Phase 1 only proves these sync — none of the props move and no
 * panic logic runs yet.
 *
 * Ids are plain and stable (e.g. `robot-1`) so they survive reconnects and the
 * engine's delta diffing treats them as unchanged once sent on a full refresh.
 */

// Initial WorldState, mirroring shared's INITIAL_WORLD_STATE. Kept as a literal
// because the server consumes none of shared's compiled module at runtime.
const INITIAL_WORLD_STATE = { panic: 0, panicCapacity: 100, lockdown: false };

// Map<roomName, { entities: Map<entityId, entity>, world: {panic,panicCapacity,lockdown} }>
const roomWorlds = new Map();

/**
 * Build the deterministic starter layout for a room. No Math.random, so the
 * same room always spawns the same props — reproducible across reconnects.
 * @returns {Map<string, object>} entityId -> entity
 */
function spawnStarterLayout() {
  const entities = new Map();
  const add = (entity) => entities.set(entity.id, entity);

  // ~4 pens, laid out on a coarse grid in the lower-left quadrant.
  const penSpots = [
    { x: 150, y: 150 },
    { x: 350, y: 150 },
    { x: 150, y: 350 },
    { x: 350, y: 350 }
  ];
  penSpots.forEach((spot, i) => {
    add({ id: `pen-${i + 1}`, x: spot.x, y: spot.y, name: `Pen ${i + 1}`, kind: 'pen' });
  });

  // ~6 robots, spread across the 0..1000 world. suspicion starts at 0.
  const robotSpots = [
    { x: 200, y: 600 },
    { x: 500, y: 200 },
    { x: 800, y: 400 },
    { x: 650, y: 700 },
    { x: 100, y: 850 },
    { x: 900, y: 800 }
  ];
  robotSpots.forEach((spot, i) => {
    add({ id: `robot-${i + 1}`, x: spot.x, y: spot.y, name: `Robot ${i + 1}`, kind: 'robot', suspicion: 0 });
  });

  // ~8 idle animals, species cycled through the full roster so the decoys show off
  // the whole zoo (they wander + animate but have no abilities). humanLikeness 0.
  const species = [
    'ape', 'bird', 'rat', 'elephant', 'chameleon', 'peacock', 'skunk',
    'mole', 'cheetah', 'parrot', 'tortoise', 'kangaroo', 'owl', 'fox'
  ];
  const animalSpots = [
    { x: 250, y: 500 },
    { x: 450, y: 550 },
    { x: 600, y: 450 },
    { x: 750, y: 550 },
    { x: 350, y: 700 },
    { x: 550, y: 800 },
    { x: 700, y: 250 },
    { x: 850, y: 650 }
  ];
  animalSpots.forEach((spot, i) => {
    add({
      id: `animal-${i + 1}`,
      x: spot.x,
      y: spot.y,
      name: `${species[i % species.length]} ${i + 1}`,
      kind: 'animal',
      species: species[i % species.length],
      humanLikeness: 0
    });
  });

  // ~3 terminals, scattered.
  const terminalSpots = [
    { x: 500, y: 500 },
    { x: 150, y: 750 },
    { x: 850, y: 200 }
  ];
  terminalSpots.forEach((spot, i) => {
    add({ id: `terminal-${i + 1}`, x: spot.x, y: spot.y, name: `Terminal ${i + 1}`, kind: 'terminal' });
  });

  // 1 gate, near the right edge of the world.
  add({ id: 'gate-1', x: 980, y: 500, name: 'Gate', kind: 'gate' });

  // 1 disguise prop (the Clipboard), parked beside the lower-left pens. The ape
  // species can pick it up to floor its human-likeness (STEALTH.PROP_BONUS) and
  // courier it / hand it off. carrierId is null while it sits on the ground;
  // when a player carries it, stealth.js moves the prop to that carrier each
  // tick so it follows visually. Position lives near pen-1 / pen-3.
  add({ id: 'prop-1', x: 250, y: 250, name: 'Clipboard', kind: 'prop', carrierId: null });

  return entities;
}

/**
 * Get a room's world, lazily spawning the starter layout the first time the
 * room is seen.
 * @param {string} roomName
 * @returns {{ entities: Map<string, object>, world: object }}
 */
function getOrCreateRoomWorld(roomName) {
  let roomWorld = roomWorlds.get(roomName);
  if (!roomWorld) {
    roomWorld = {
      entities: spawnStarterLayout(),
      world: { ...INITIAL_WORLD_STATE }
    };
    roomWorlds.set(roomName, roomWorld);
  }
  return roomWorld;
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

/** Remove a world entity by id (e.g. an expired hazard). */
function removeWorldEntity(roomName, entityId) {
  const rw = roomWorlds.get(roomName);
  if (rw) rw.entities.delete(entityId);
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

module.exports = {
  getOrCreateRoomWorld,
  getWorldEntities,
  getWorldState,
  removeRoom,
  addWorldEntity,
  removeWorldEntity,
  pruneExpired,
  nextTempId,
  INITIAL_WORLD_STATE
};
