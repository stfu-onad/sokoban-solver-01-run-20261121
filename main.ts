// Sokoban solver for make.fun's sokoban-solver-01-run-20261121.
//
// Strategy: the generator lays a hallway one square wide across the board
// with one to four rooms off it, and a box pushed out of a room into the
// hallway can never come back, so each room is solved on its own and the
// rooms' push counts add up to the level's optimum. A room is found by
// cutting the dead squares (squares from which no push can ever reach a
// goal) of the player's row out of the floor and flood-filling what is left.
//
// Each room is solved with A* over pushes: a state is the sorted box
// squares plus the player's reachable region (named by its lowest square).
// The heuristic is the cheapest assignment of boxes to goals by
// walk-distance, which never overestimates the pushes left. Two deadlocks
// are pruned: a box on a dead square, and a frozen 2x2 block of walls and
// boxes with a box off its goal. Everything is budgeted by node count,
// never by the clock, and every tie-break follows a fixed order, so two
// runs answer byte for byte alike.
//
// When a level does not split into rooms, or a room's search runs out of
// budget, the same A* runs over the whole level as a fallback; when that
// gives up too, the level is answered with no moves rather than a wrong
// one, so the other instances still score.
//
// Local run: MAKEFUN_INPUT_DIR=<kit>/practice/input
//            MAKEFUN_OUTPUT_DIR=<out> node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The four directions: [dx, dy, step letter, push letter]. This fixed order
// is the tie-break everywhere (walks, expansions, permutations), which is
// part of what keeps the program deterministic.
const DIRS: ReadonlyArray<readonly [number, number, string, string]> = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

// Node budgets (work, never the clock): a room search that expands this
// many states gives up, and so does a whole-level fallback search. The
// room budget matches the generator's own guarantee: it keeps a room only
// when its push-optimal search solves it within 250,000 states, and A*
// with a consistent heuristic never expands a state that search would
// not have had to visit, so a room that exists is found inside it.
const ROOM_BUDGET = 250_000;
const WHOLE_LEVEL_BUDGET = 300_000;

type Level = {
  w: number;
  h: number;
  size: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
};

/** Parse XSB text. Short rows and the outer frame count as walls. */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  goals.sort((a, b) => a - b);
  boxes.sort((a, b) => a - b);
  return { w, h, size: w * h, wall, goals, boxes, player };
}

/**
 * The live squares: a square from which a box alone can be pushed onto
 * some goal, found by pulling boxes back from the goals. A box can be
 * pulled from x to y = x - d when the player can stand at y - d.
 */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue: number[] = [];
  for (const g of goals) {
    live[g] = 1;
    queue.push(g);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * Flood-fill the player's reachable region from `from` with `occupied`
 * (boxes) in the way, stamping the cells it visits; returns the region's
 * lowest square, which names the region.
 */
function reachRegion(
  w: number,
  wall: Uint8Array,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  const offs = [-w, w, -1, 1];
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n];
    if (p < low) low = p;
    for (const o of offs) {
      const q = p + o;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/**
 * Whether the box just pushed to `t` sits in a frozen 2x2 block: four
 * squares of walls and boxes with a box among them off its goal.
 */
function frozenBlock(
  w: number,
  wall: Uint8Array,
  occupied: Uint8Array,
  goal: Uint8Array,
  t: number,
): boolean {
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a])) continue;
    if (!(wall[b] || occupied[b])) continue;
    if (!(wall[c] || occupied[c])) continue;
    if (!(wall[d] || occupied[d])) continue;
    if (occupied[a] && !goal[a]) return true;
    if (occupied[b] && !goal[b]) return true;
    if (occupied[c] && !goal[c]) return true;
    if (occupied[d] && !goal[d]) return true;
  }
  return false;
}

/** All permutations of 0..n-1, in lexicographic order, for n up to 5. */
function permutations(n: number): number[][] {
  const out: number[][] = [];
  const cur: number[] = [];
  const used = new Array<boolean>(n).fill(false);
  const rec = (): void => {
    if (cur.length === n) {
      out.push(cur.slice());
      return;
    }
    for (let i = 0; i < n; i++) {
      if (used[i]) continue;
      used[i] = true;
      cur.push(i);
      rec();
      cur.pop();
      used[i] = false;
    }
  };
  rec();
  return out;
}
const PERMS: number[][][] = [0, 1, 2, 3, 4, 5].map(permutations);

type SearchCtx = {
  w: number;
  size: number;
  wall: Uint8Array;
  goal: Uint8Array;
  live: Uint8Array;
  goals: number[];
  // dist[a * size + b]: the walk distance from a to b ignoring boxes
  // (-1 when no walk exists), over floor squares.
  dist: Int32Array;
};

/** Build a search context for a level (or a room sub-level). */
function buildCtx(level: Level): SearchCtx {
  const { w, size, wall, goals } = level;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  const dist = new Int32Array(size * size).fill(-1);
  const queue: number[] = [];
  for (let s = 0; s < size; s++) {
    if (wall[s]) continue;
    dist[s * size + s] = 0;
    queue.length = 0;
    queue.push(s);
    for (let qi = 0; qi < queue.length; qi++) {
      const p = queue[qi];
      const nd = dist[s * size + p] + 1;
      for (const [dx, dy] of DIRS) {
        const q = p + dy * w + dx;
        if (wall[q] || dist[s * size + q] !== -1) continue;
        dist[s * size + q] = nd;
        queue.push(q);
      }
    }
  }
  return { w, size, wall, goal, live, goals: goals.slice(), dist };
}

/**
 * A lower bound on the pushes left: with five or fewer boxes, the cheapest
 * assignment of boxes to goals by walk distance; with more, the sum over
 * boxes of the nearest goal's distance. Both never overestimate, because
 * one push moves one box by one square.
 */
function heuristic(ctx: SearchCtx, boxes: number[]): number {
  const { size, goals, dist } = ctx;
  const n = boxes.length;
  if (n <= 5) {
    let best = Infinity;
    for (const perm of PERMS[n]) {
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const d = dist[boxes[i] * size + goals[perm[i]]];
        if (d < 0) {
          sum = Infinity;
          break;
        }
        sum += d;
      }
      if (sum < best) best = sum;
    }
    return best;
  }
  let sum = 0;
  for (const b of boxes) {
    let m = Infinity;
    for (const g of goals) {
      const d = dist[b * size + g];
      if (d >= 0 && d < m) m = d;
    }
    if (m === Infinity) return Infinity;
    sum += m;
  }
  return sum;
}

// A binary heap entry: [f, h, insertion sequence, state index]. Ordered by
// f, then h, then sequence, so the order is fully deterministic.
type HeapEntry = [number, number, number, number];

function heapLess(a: HeapEntry, b: HeapEntry): boolean {
  if (a[0] !== b[0]) return a[0] < b[0];
  if (a[1] !== b[1]) return a[1] < b[1];
  return a[2] < b[2];
}

function heapPush(heap: HeapEntry[], e: HeapEntry): void {
  heap.push(e);
  let i = heap.length - 1;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (!heapLess(heap[i], heap[p])) break;
    const tmp = heap[i];
    heap[i] = heap[p];
    heap[p] = tmp;
    i = p;
  }
}

function heapPop(heap: HeapEntry[]): HeapEntry {
  const top = heap[0];
  const last = heap.pop() as HeapEntry;
  if (heap.length > 0) {
    heap[0] = last;
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let m = i;
      if (l < heap.length && heapLess(heap[l], heap[m])) m = l;
      if (r < heap.length && heapLess(heap[r], heap[m])) m = r;
      if (m === i) break;
      const tmp = heap[i];
      heap[i] = heap[m];
      heap[m] = tmp;
      i = m;
    }
  }
  return top;
}

/** The shortest walk from `from` to `to` around walls and boxes. */
function walkTo(
  w: number,
  wall: Uint8Array,
  occupied: Uint8Array,
  from: number,
  to: number,
): string {
  if (from === to) return '';
  const size = wall.length;
  const prev = new Int32Array(size).fill(-1);
  const how = new Array<string>(size);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

type SearchResult = { pushes: number; moves: string; player: number };

/**
 * The push-optimal solution of a level (or room sub-level) by A* over
 * pushes, or null when the search gives up (budget spent) or the level has
 * no solution. The heuristic is consistent, so the first solved state
 * popped from the heap is optimal.
 */
function searchPushOptimal(
  ctx: SearchCtx,
  boxes0: number[],
  player0: number,
  maxExpansions: number,
): SearchResult | null {
  const { w, size, wall, goal, live } = ctx;
  const n = boxes0.length;
  if (boxes0.some((b) => !live[b])) return null;
  const solved = (boxes: number[]): boolean => boxes.every((b) => goal[b] === 1);

  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  const occupied = new Uint8Array(size);
  let stamp = 0;

  const keyOf = (boxes: number[], low: number): string => `${low}|${boxes.join(',')}`;

  const sBoxes: number[][] = [boxes0.slice().sort((a, b) => a - b)];
  const sPlayer: number[] = [player0];
  const sParent: number[] = [-1];
  const sG: number[] = [0];
  const sFrom: number[] = [-1];
  const sTo: number[] = [-1];
  const sKey: string[] = [];

  for (const b of sBoxes[0]) occupied[b] = 1;
  const low0 = reachRegion(w, wall, occupied, player0, seen, ++stamp, stack);
  for (const b of sBoxes[0]) occupied[b] = 0;
  sKey.push(keyOf(sBoxes[0], low0));

  const visited = new Map<string, number>();
  visited.set(sKey[0], 0);
  if (solved(sBoxes[0])) return { pushes: 0, moves: '', player: player0 };

  const h0 = heuristic(ctx, sBoxes[0]);
  if (h0 === Infinity) return null;
  const heap: HeapEntry[] = [];
  let seq = 0;
  heapPush(heap, [h0, h0, seq++, 0]);

  let expansions = 0;
  let found = -1;
  while (heap.length > 0) {
    const entry = heapPop(heap);
    const s = entry[3];
    // A stale heap entry: a cheaper path to this state was found since.
    if (visited.get(sKey[s]) !== sG[s]) continue;
    const boxes = sBoxes[s];
    if (solved(boxes)) {
      found = s;
      break;
    }
    if (expansions >= maxExpansions) return null;
    expansions++;
    for (const b of boxes) occupied[b] = 1;
    const here = ++stamp;
    reachRegion(w, wall, occupied, sPlayer[s], seen, here, stack);
    for (let bi = 0; bi < n; bi++) {
      const b = boxes[bi];
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const pushSq = b - d;
        const t = b + d;
        if (seen[pushSq] !== here) continue;
        if (wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(w, wall, occupied, goal, t);
        let next: number[] | null = null;
        let key = '';
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((a, c) => a - c);
          const low = reachRegion(w, wall, occupied, b, mark, ++stamp, stack);
          key = keyOf(next, low);
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || next === null) continue;
        const g2 = sG[s] + 1;
        const prevG = visited.get(key);
        if (prevG !== undefined && prevG <= g2) continue;
        visited.set(key, g2);
        const h2 = heuristic(ctx, next);
        if (h2 === Infinity) continue;
        const idx = sBoxes.length;
        sBoxes.push(next);
        sPlayer.push(b);
        sParent.push(s);
        sG.push(g2);
        sFrom.push(b);
        sTo.push(t);
        sKey.push(key);
        heapPush(heap, [g2 + h2, h2, seq++, idx]);
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  if (found < 0) return null;

  // Rebuild the moves: walk to each push's square, then push.
  const path: number[] = [];
  for (let s = found; s > 0; s = sParent[s]) path.push(s);
  path.reverse();
  let moves = '';
  let player = player0;
  let boxes = sBoxes[0];
  for (const s of path) {
    const nextBoxes = sBoxes[s];
    const from = sFrom[s];
    const to = sTo[s];
    const d = to - from;
    const dir = DIRS.find(([dx, dy]) => dy * w + dx === d);
    if (dir === undefined) throw new Error('reconstruction: bad push direction');
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(w, wall, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += dir[3];
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves, player };
}

type Room = { boxes: number[]; goals: number[] };

/**
 * The level's rooms: cut the dead squares of the player's row (the
 * hallway: a box there reaches no goal) out of the floor, and each part
 * left that holds a box is a room. Null when some part holds more or fewer
 * boxes than goals, a goal is cut off, or a box starts in the hallway:
 * then the level is no set of rooms.
 */
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) {
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i] + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ boxes: [], goals: [] });
  }
  for (const b of boxes) rooms[part[b]].boxes.push(b);
  for (const g of goals) {
    if (part[g] < 0) return null;
    rooms[part[g]].goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/**
 * Solve one level: room by room, the other rooms' boxes standing as walls
 * (on their goals once their room is done), the player walking on from
 * where the last room left it. Falls back to a whole-level search when the
 * level is no set of rooms or a room's search gives up, and to no moves
 * when that gives up too.
 */
function solveLevel(text: string): string {
  const level = parseLevel(text);
  const rooms = roomsOf(level);
  if (rooms !== null) {
    const curBoxes = new Set<number>(level.boxes);
    let player = level.player;
    let moves = '';
    let ok = true;
    for (const room of rooms) {
      const wall = level.wall.slice();
      for (const b of curBoxes) {
        if (!room.boxes.includes(b)) wall[b] = 1;
      }
      const sub: Level = {
        w: level.w,
        h: level.h,
        size: level.size,
        wall,
        goals: room.goals.slice().sort((a, b) => a - b),
        boxes: room.boxes.slice().sort((a, b) => a - b),
        player,
      };
      const res = searchPushOptimal(buildCtx(sub), sub.boxes, player, ROOM_BUDGET);
      if (res === null) {
        ok = false;
        break;
      }
      moves += res.moves;
      player = res.player;
      for (const b of room.boxes) curBoxes.delete(b);
      for (const g of room.goals) curBoxes.add(g);
    }
    if (ok) return moves;
  }
  const res = searchPushOptimal(buildCtx(level), level.boxes, level.player, WHOLE_LEVEL_BUDGET);
  return res === null ? '' : res.moves;
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  const moves = solveLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'));
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
