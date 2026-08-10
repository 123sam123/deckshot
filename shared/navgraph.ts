/**
 * DECKSHOT — waypoint nav graph for SURVIVAL zombie pathing.
 *
 * Owner: survival (new subsystem, this ticket).
 *
 * Pure, engine-free, deterministic: same graph + same zone mask => same path,
 * bit for bit, on Node and in a browser. No randomness, no time.
 *
 * The graph is hand-authored per map (nodes carry a zone index; edges are
 * node-id pairs). THE GATING RULE: an edge is traversable iff the zone of the
 * node it ENTERS is open in `zoneMask`. Zombies can only path where players
 * have paid to open — door-gating falls out of the graph with no extra logic.
 */

import type { Vec3 } from './types.js';

export interface NavNode {
  /** Dense index into the map's node array. */
  id: number;
  pos: Vec3;
  /** Zone index this node sits in. Gates traversal. */
  zone: number;
  /** Node ids reachable in one hop. Author both directions explicitly. */
  edges: readonly number[];
}

/** A compiled graph plus scratch buffers; build once per map, reuse per query. */
export interface NavGraph {
  readonly nodes: readonly NavNode[];
  // --- BFS scratch (written then read within one findPath call) ---
  readonly cameFrom: Int32Array;
  readonly queue: Int32Array;
  readonly visitedStamp: Int32Array;
  stamp: number;
}

export function buildNavGraph(nodes: readonly NavNode[]): NavGraph {
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].id !== i) throw new Error(`nav node ${i} has id ${nodes[i].id}; ids must be dense`);
    for (const e of nodes[i].edges) {
      if (e < 0 || e >= nodes.length) throw new Error(`nav node ${i} edge ${e} out of range`);
    }
  }
  return {
    nodes,
    cameFrom: new Int32Array(nodes.length),
    queue: new Int32Array(nodes.length),
    visitedStamp: new Int32Array(nodes.length),
    stamp: 0,
  };
}

export function zoneOpen(zoneMask: number, zone: number): boolean {
  return (zoneMask & (1 << zone)) !== 0;
}

/**
 * Nearest node whose zone is open, by squared euclidean distance. Ties break
 * to the lowest node id, so the result is deterministic. Returns -1 when no
 * open-zone node exists.
 */
export function nearestNode(graph: NavGraph, pos: Vec3, zoneMask: number): number {
  let best = -1;
  let bestD = Infinity;
  const nodes = graph.nodes;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (!zoneOpen(zoneMask, n.zone)) continue;
    const dx = n.pos.x - pos.x;
    const dy = n.pos.y - pos.y;
    const dz = n.pos.z - pos.z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * Breadth-first path from `fromNode` to `toNode`, honouring the gating rule.
 * Returns node ids from `fromNode` to `toNode` inclusive, or null when
 * unreachable. BFS (not A*) is deliberate: graphs are tiny (< 100 nodes), all
 * edges cost ~the same, and BFS's FIFO order is trivially deterministic.
 */
export function findPath(
  graph: NavGraph,
  fromNode: number,
  toNode: number,
  zoneMask: number,
): number[] | null {
  const nodes = graph.nodes;
  if (fromNode < 0 || fromNode >= nodes.length) return null;
  if (toNode < 0 || toNode >= nodes.length) return null;
  if (!zoneOpen(zoneMask, nodes[fromNode].zone)) return null;
  if (!zoneOpen(zoneMask, nodes[toNode].zone)) return null;
  if (fromNode === toNode) return [fromNode];

  const stamp = ++graph.stamp;
  const { cameFrom, queue, visitedStamp } = graph;

  visitedStamp[fromNode] = stamp;
  cameFrom[fromNode] = -1;
  queue[0] = fromNode;
  let head = 0;
  let tail = 1;

  while (head < tail) {
    const cur = queue[head++];
    const edges = nodes[cur].edges;
    for (let i = 0; i < edges.length; i++) {
      const next = edges[i];
      if (visitedStamp[next] === stamp) continue;
      // The gating rule: the zone being ENTERED must be open.
      if (!zoneOpen(zoneMask, nodes[next].zone)) continue;
      visitedStamp[next] = stamp;
      cameFrom[next] = cur;
      if (next === toNode) {
        // Reconstruct.
        const path: number[] = [];
        let n = toNode;
        while (n !== -1) {
          path.push(n);
          n = cameFrom[n];
        }
        path.reverse();
        return path;
      }
      queue[tail++] = next;
    }
  }
  return null;
}

/**
 * Every node reachable from `fromNode` under `zoneMask`. For the connectivity
 * tests: unlocking a zone must connect exactly its nodes, no more.
 */
export function reachableNodes(graph: NavGraph, fromNode: number, zoneMask: number): Set<number> {
  const out = new Set<number>();
  const nodes = graph.nodes;
  if (fromNode < 0 || fromNode >= nodes.length) return out;
  if (!zoneOpen(zoneMask, nodes[fromNode].zone)) return out;

  const stamp = ++graph.stamp;
  const { queue, visitedStamp } = graph;
  visitedStamp[fromNode] = stamp;
  queue[0] = fromNode;
  let head = 0;
  let tail = 1;
  out.add(fromNode);

  while (head < tail) {
    const cur = queue[head++];
    const edges = nodes[cur].edges;
    for (let i = 0; i < edges.length; i++) {
      const next = edges[i];
      if (visitedStamp[next] === stamp) continue;
      if (!zoneOpen(zoneMask, nodes[next].zone)) continue;
      visitedStamp[next] = stamp;
      out.add(next);
      queue[tail++] = next;
    }
  }
  return out;
}
