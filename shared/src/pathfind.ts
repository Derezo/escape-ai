/**
 * Deterministic tile-grid pathfinding — the GLOBAL route layer.
 *
 * The reactive steering in {@link ./movement.ts} (`steerAround`) only probes one
 * tile ahead, so it can round a corner but it cannot FIND a two-tile door gap from
 * outside a walled enclosure. This module adds the missing piece: a 4-connected A*
 * over the same `collision` grid the integrator already uses, returning a coarse
 * waypoint route that the caller follows with the EXISTING `steerAround` +
 * `moveWithCollision` for the final leg. A* supplies the global plan (around walls,
 * through the gate); the local steering supplies the slide.
 *
 * CRITICAL — PURE + DETERMINISTIC (same contract as step.ts / movement.ts):
 *   - no Math.random, no Date.now / performance.now — every input is explicit.
 *   - the open set pops by an EXPLICIT TOTAL ORDER (f, then g, then flat tile
 *     index), never by insertion order or object identity, so two equal-cost
 *     frontiers resolve identically across V8 builds. This is the determinism crux.
 *   - the neighbour expansion order is E, W, S, N — IDENTICAL to world.ts
 *     `floodReachable`, so "reachable" (the world-gen reachability check) and
 *     "pathable" (this) can never disagree on the same grid.
 *   - integer step-count g-scores (uniform edge cost 1) + an integer Manhattan
 *     heuristic — no float fragility.
 *
 * This is a low-level LEAF peer of step.ts: it imports only `boxHitsSolid` from
 * step.ts (for the optional radius-aware variant) — no world.ts import, so there's
 * no step→world→rng→step cycle. The caller passes in `(collision, w, h, tile)`.
 *
 * Consumed SERVER-SIDE only (robots + animals are server-owned; their positions
 * already ride the per-tick snapshot delta). The path itself is per-entity scratch
 * state that is NEVER serialized — so this adds nothing to the net contract.
 */

import { boxHitsSolid } from './step.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * Reference cap on cells expanded by one A* search. This is a SENTINEL meaning
 * "no explicit cap given — bound to one full grid sweep (w*h)". A 128×128 map is
 * 16384 cells, so a search is bounded to at most one pass over the grid: it always
 * terminates (no hang on a pathological seed) yet never abandons a goal that is
 * genuinely reachable (a cross-map route can legitimately expand most of the grid).
 * On overflow findPath returns `[]` and the caller falls back to its reactive
 * behaviour (steerAround toward the raw goal / ambient drift). A caller that wants
 * a tighter, cheaper search (e.g. "only path if it's nearby") passes a smaller cap.
 *
 * Worst case measured ~0.6ms for a full cross-map route with a reused scratch;
 * paths recompute on a slow cadence (not per-NPC per-tick), so this is well within
 * a 50ms (20Hz) tick budget even for a roomful of NPCs.
 */
export const DEFAULT_MAX_EXPAND = -1;

/** A tile coordinate (grid units). */
export interface Tile {
  tx: number;
  ty: number;
}

/** A world-unit point (the waypoint type the steering layer consumes). */
export interface Point {
  x: number;
  y: number;
}

/** An axis-aligned world-unit rect (containment bounds). */
export interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

// ---------------------------------------------------------------------------
// Reusable scratch — so a per-tick search allocates NOTHING.
//
// All four arrays are sized w*h once (via makeScratch) and reused across every
// findPath call on the same map. To avoid an O(w*h) clear per call, `gen` is a
// monotonically rising generation stamp: a cell's g-score / cameFrom / closed
// entry is "live" only if its `seenGen[i] === currentGen`. Bumping `gen` by one
// per search invalidates every cell in O(1), so a search costs O(cells expanded),
// not O(grid). (When `gen` would overflow a 32-bit int the arrays are reset once.)
// ---------------------------------------------------------------------------

/** Pre-allocated, reusable per-map buffers for {@link findPath}. */
export interface PathScratch {
  w: number;
  h: number;
  /** Step-count g-score per cell; only valid where seenGen[i] === gen. */
  gScore: Int32Array;
  /** Predecessor flat index per cell (for reconstruction); valid where seenGen[i] === gen. */
  cameFrom: Int32Array;
  /** Generation stamp per cell — the O(1) "clear". */
  seenGen: Int32Array;
  /** Set once a cell is popped (finalized); valid where seenGen[i] === gen. */
  closedGen: Int32Array;
  /** Binary min-heap of flat cell indices, ordered by (f, g, index). */
  heap: Int32Array;
  /** Parallel heap keys: f-score for heap[k]. */
  heapF: Int32Array;
  /** Parallel heap keys: g-score for heap[k] (tie-break after f). */
  heapG: Int32Array;
  /** Current generation; bumped per search. Internal. */
  gen: number;
}

/** Allocate reusable scratch for a `w×h` grid. Build ONE per room and reuse it. */
export function makeScratch(w: number, h: number): PathScratch {
  const n = w * h;
  return {
    w,
    h,
    gScore: new Int32Array(n),
    cameFrom: new Int32Array(n),
    seenGen: new Int32Array(n), // 0 = never touched; searches start at gen 1
    closedGen: new Int32Array(n),
    heap: new Int32Array(n),
    heapF: new Int32Array(n),
    heapG: new Int32Array(n),
    gen: 0,
  };
}

// --- the deterministic binary heap, keyed by (f, g, flat index) --------------

/** True if heap entry a should pop before b: lower f, then lower g, then lower index. */
function heapLess(scratch: PathScratch, k: number, j: number): boolean {
  const fk = scratch.heapF[k];
  const fj = scratch.heapF[j];
  if (fk !== fj) return fk < fj;
  const gk = scratch.heapG[k];
  const gj = scratch.heapG[j];
  if (gk !== gj) return gk < gj;
  // Final tie-break on the flat cell index — a TOTAL order, so the pop sequence
  // is fully determined regardless of insertion order (the determinism crux).
  return scratch.heap[k] < scratch.heap[j];
}

function heapSwap(scratch: PathScratch, k: number, j: number): void {
  const ti = scratch.heap[k];
  scratch.heap[k] = scratch.heap[j];
  scratch.heap[j] = ti;
  const tf = scratch.heapF[k];
  scratch.heapF[k] = scratch.heapF[j];
  scratch.heapF[j] = tf;
  const tg = scratch.heapG[k];
  scratch.heapG[k] = scratch.heapG[j];
  scratch.heapG[j] = tg;
}

function heapPush(scratch: PathScratch, size: number, cell: number, f: number, g: number): number {
  let k = size;
  scratch.heap[k] = cell;
  scratch.heapF[k] = f;
  scratch.heapG[k] = g;
  // sift up
  while (k > 0) {
    const parent = (k - 1) >> 1;
    if (heapLess(scratch, k, parent)) {
      heapSwap(scratch, k, parent);
      k = parent;
    } else break;
  }
  return size + 1;
}

/** Pop the min entry into scratch.heap[size-1] is NOT done; returns the popped cell.
 *  Caller passes the current size and uses the returned `size-1` as the new size. */
function heapPop(scratch: PathScratch, size: number): number {
  const top = scratch.heap[0];
  const last = size - 1;
  heapSwap(scratch, 0, last);
  // sift down over the reduced heap [0, last)
  let k = 0;
  while (true) {
    const l = 2 * k + 1;
    const r = 2 * k + 2;
    let smallest = k;
    if (l < last && heapLess(scratch, l, smallest)) smallest = l;
    if (r < last && heapLess(scratch, r, smallest)) smallest = r;
    if (smallest === k) break;
    heapSwap(scratch, k, smallest);
    k = smallest;
  }
  return top;
}

// ---------------------------------------------------------------------------
// The core: 4-connected A*
// ---------------------------------------------------------------------------

/** Whether tile (tx,ty) is solid. OOB is solid (mirrors world.ts tileSolid). */
function solid(collision: Uint8Array, w: number, h: number, tx: number, ty: number): boolean {
  if (tx < 0 || ty < 0 || tx >= w || ty >= h) return true;
  return collision[ty * w + tx] === 1;
}

/** Bump the scratch generation (the O(1) clear), resetting the arrays on overflow. */
function nextGen(scratch: PathScratch): number {
  scratch.gen += 1;
  if (scratch.gen >= 0x7fffffff) {
    // Extremely rare (would need ~2^31 searches on one room). Reset once.
    scratch.seenGen.fill(0);
    scratch.closedGen.fill(0);
    scratch.gen = 1;
  }
  return scratch.gen;
}

/**
 * 4-connected A* from (startTx,startTy) to (goalTx,goalTy) over `collision`.
 * Returns the tile path start→goal INCLUSIVE, or `[]` when:
 *   - start or goal is solid / out of bounds,
 *   - goal is unreachable from start,
 *   - the search exceeds `maxExpand` cells (graceful degrade — caller falls back).
 *
 * Pure + deterministic: fixed E,W,S,N expansion, integer Manhattan heuristic,
 * total-order open set. Pass a reused {@link PathScratch} to allocate nothing per
 * call; omit it and a fresh one is built (fine for tests / cold paths).
 */
export function findPath(
  collision: Uint8Array,
  w: number,
  h: number,
  startTx: number,
  startTy: number,
  goalTx: number,
  goalTy: number,
  scratch: PathScratch = makeScratch(w, h),
  maxExpand: number = DEFAULT_MAX_EXPAND,
): Tile[] {
  // Sentinel (or any non-positive value): bound the search to one full grid sweep,
  // so a genuinely-reachable cross-map goal is never abandoned but the search still
  // terminates. A caller passes a smaller positive cap to limit cost ("nearby only").
  const cap = maxExpand > 0 ? maxExpand : w * h;
  if (solid(collision, w, h, startTx, startTy)) return [];
  if (solid(collision, w, h, goalTx, goalTy)) return [];

  const start = startTy * w + startTx;
  const goal = goalTy * w + goalTx;
  if (start === goal) return [{ tx: startTx, ty: startTy }];

  const gen = nextGen(scratch);
  const { gScore, cameFrom, seenGen, closedGen } = scratch;

  const heuristic = (cell: number): number => {
    const cx = cell % w;
    const cy = (cell - cx) / w;
    return Math.abs(cx - goalTx) + Math.abs(cy - goalTy);
  };

  gScore[start] = 0;
  cameFrom[start] = -1;
  seenGen[start] = gen;
  let heapSize = heapPush(scratch, 0, start, heuristic(start), 0);

  let expanded = 0;
  while (heapSize > 0) {
    const cur = heapPop(scratch, heapSize);
    heapSize -= 1;

    // Skip a stale heap entry (a cell re-pushed at a lower g is already closed).
    if (closedGen[cur] === gen) continue;
    closedGen[cur] = gen;

    if (cur === goal) return reconstruct(scratch, gen, goal, w);

    if (++expanded > cap) return []; // graceful degrade — caller falls back

    const cx = cur % w;
    const cy = (cur - cx) / w;
    const ng = gScore[cur] + 1;
    // Fixed neighbour order E, W, S, N (identical to world.ts floodReachable) so
    // the explored frontier — and thus the chosen path among equal-cost ties — is
    // bit-stable.
    const neighbours = [
      cx + 1 < w ? cur + 1 : -1,
      cx - 1 >= 0 ? cur - 1 : -1,
      cy + 1 < h ? cur + w : -1,
      cy - 1 >= 0 ? cur - w : -1,
    ];
    for (let i = 0; i < 4; i++) {
      const nb = neighbours[i];
      if (nb < 0) continue;
      if (collision[nb] === 1) continue;
      if (closedGen[nb] === gen) continue;
      const known = seenGen[nb] === gen;
      if (!known || ng < gScore[nb]) {
        gScore[nb] = ng;
        cameFrom[nb] = cur;
        seenGen[nb] = gen;
        heapSize = heapPush(scratch, heapSize, nb, ng + heuristic(nb), ng);
      }
    }
  }
  return []; // open set drained → goal unreachable
}

/** Walk cameFrom from goal back to start, producing the start→goal tile list. */
function reconstruct(scratch: PathScratch, gen: number, goal: number, w: number): Tile[] {
  const out: Tile[] = [];
  let cur = goal;
  // cameFrom[start] === -1 terminates the walk; seenGen guards against a stale read.
  while (cur !== -1 && scratch.seenGen[cur] === gen) {
    const cx = cur % w;
    const cy = (cur - cx) / w;
    out.push({ tx: cx, ty: cy });
    cur = scratch.cameFrom[cur];
  }
  out.reverse(); // we built it goal→start; hand back start→goal
  return out;
}

// ---------------------------------------------------------------------------
// Path post-processing + following
// ---------------------------------------------------------------------------

/** Flat-index key for a tile (for the keepTiles allow-list). */
function tkey(t: Tile): number {
  return t.ty * 100000 + t.tx;
}

/**
 * Collapse collinear runs of a tile path down to its turning points, so the cached
 * waypoint list is short (junction-to-junction). A tile is KEPT when it changes the
 * direction of travel, is an endpoint, OR appears in `keepTiles`. `keepTiles` makes
 * the gate threshold cells (outside-tile then inside-tile) MANDATORY axis-aligned
 * waypoints, so the AABB threads the two-tile gap straight-on the way the player
 * does — never cutting the corner of a fence post. Pure; never mutates the input.
 */
export function simplifyPath(path: Tile[], keepTiles: Tile[] = []): Tile[] {
  if (path.length <= 2) return path.slice();
  const keep = new Set(keepTiles.map(tkey));
  const out: Tile[] = [path[0]];
  for (let i = 1; i < path.length - 1; i++) {
    const prev = path[i - 1];
    const cur = path[i];
    const next = path[i + 1];
    const turning = (cur.tx - prev.tx) !== (next.tx - cur.tx) || (cur.ty - prev.ty) !== (next.ty - cur.ty);
    if (turning || keep.has(tkey(cur))) out.push(cur);
  }
  out.push(path[path.length - 1]);
  return out;
}

/** Tile-center (world units) of tile `t`. tileCenter(t)=t*tile+tile/2 (mirrors world.ts). */
export function tileToWorld(t: Tile, tile: number): Point {
  return { x: t.tx * tile + tile / 2, y: t.ty * tile + tile / 2 };
}

/** Map a tile path to a world-unit waypoint list (tile centers). */
export function toWorldWaypoints(path: Tile[], tile: number): Point[] {
  return path.map((t) => tileToWorld(t, tile));
}

/** The outcome of one {@link nextWaypoint} advance. */
export interface WaypointStep {
  /** The world-unit waypoint to head toward (the last one when the path is done). */
  target: Point;
  /** The (possibly advanced) index — caller writes it back onto the entity. */
  index: number;
  /** True once the final waypoint is within `arriveR` (the route is exhausted). */
  done: boolean;
}

/**
 * Advance an index along a world-unit waypoint list: while within `arriveR` of
 * `waypoints[index]`, step the index forward (skipping any cluster of close
 * waypoints in one tick), then return the current target. Mirrors patrolStep's
 * arrive-radius advance so following a path reads like following a patrol route.
 * Pure: derived only from (waypoints, index, pos, arriveR). Empty list → done.
 */
export function nextWaypoint(waypoints: Point[], index: number, pos: Point, arriveR: number): WaypointStep {
  if (waypoints.length === 0) return { target: pos, index: 0, done: true };
  let i = index < 0 ? 0 : index;
  const r2 = arriveR * arriveR;
  // Skip every waypoint already reached this tick (advance through a tight cluster).
  while (i < waypoints.length - 1) {
    const wp = waypoints[i];
    const dx = wp.x - pos.x;
    const dy = wp.y - pos.y;
    if (dx * dx + dy * dy <= r2) i += 1;
    else break;
  }
  const last = waypoints.length - 1;
  const target = waypoints[Math.min(i, last)];
  const dlx = waypoints[last].x - pos.x;
  const dly = waypoints[last].y - pos.y;
  const done = i >= last && dlx * dlx + dly * dly <= r2;
  return { target, index: i, done };
}

// ---------------------------------------------------------------------------
// Geometry helpers (used by the awareness filter + the return-home goal)
// ---------------------------------------------------------------------------

/** O(1) point-in-rect test (inclusive). Used by the robot-awareness containment
 *  filter and the true return-home arrival check. */
export function inBounds(x: number, y: number, b: Rect): boolean {
  return x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY;
}

/**
 * The interior threshold tile of a south-facing door/gate: one row INSIDE the door
 * tile. Housing gates and building doors share this geometry — the door tile is the
 * bottom wall row (doorTy = ry+rh-1, non-solid) and the row above it (doorTy-1) is
 * the first interior floor row, guaranteed non-solid and inside the inset
 * containment bounds. Used as the GOAL for return-home A*: aiming one tile inside
 * the gate (not the enclosure center) sidesteps a solid pond/den core that could
 * make the center unreachable, and lands the animal cleanly through the gap.
 */
export function gateInsideTile(doorTx: number, doorTy: number): Tile {
  return { tx: doorTx, ty: doorTy - 1 };
}

/**
 * OPTIONAL radius-aware passability: whether a box of half-extent `radius`
 * centered on tile (tx,ty)'s center clears all solids. Not used by the default
 * point-based findPath (which mirrors floodReachable so reachability==pathability),
 * but exported for callers that want to prune sub-radius slivers from a goal/seed.
 * The canonical 2-tile doors always clear at the tile center, so this never seals a
 * gate. Pure; reuses the SAME boxHitsSolid the integrator commits with.
 */
export function tileClearsRadius(
  collision: Uint8Array,
  w: number,
  h: number,
  tile: number,
  radius: number,
  tx: number,
  ty: number,
): boolean {
  return !boxHitsSolid(tx * tile + tile / 2, ty * tile + tile / 2, radius, collision, w, h, tile);
}
