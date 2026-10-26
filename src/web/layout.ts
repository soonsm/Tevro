import dagre from '@dagrejs/dagre';
import type { Edge } from '../shared/domain.ts';

// styles.css의 .task-node 크기와 같다. 카드 높이를 고정해야 연결점(카드 세로 가운데)이 배치 계산과 맞는다.
// 하위 공정이 있는 카드는 '하위 n/m · 열기' 줄만큼 더 높다.
export const NODE_WIDTH = 176;
export const NODE_HEIGHT = 92;
export const PARENT_NODE_HEIGHT = 128;

const COLUMN_GAP = 64; // 열 사이 통로의 기본 너비. 세로 선은 통로에만 놓인다
const ROW_GAP = 24; // 같은 열의 카드 사이
const MIN_STEP = 12; // 꺾인 선의 세로 구간은 이보다 짧게 만들지 않는다(작은 계단 방지)
const CLEARANCE = 10; // 열을 건너뛰는 선과 중간 열 카드 사이
const LANE_GAP = 8; // 같은 통로를 지나는 가로 구간끼리
const SOURCE_SIDE = 12; // 세로 선은 통로의 왼쪽 끝 + 12 ~ 오른쪽 끝 - 26 사이에 둔다(오른쪽은 화살촉 자리)
const TARGET_SIDE = 26;
const LINE_SPACING = 8; // 통로 안 세로 선 사이. 선이 많으면 통로를 넓힌다
const SAME_X_GAP = 6; // 같은 x를 함께 쓰는 세로 선끼리의 높이 간격
const CORNER = 5;
// 통로 안 세로 선 순서의 비용(교차 하나가 1). 포개져 없는 연결로 읽히면 VIOLATION,
// 포개지지만 어떻게 읽어도 실제 연결이면 HARMLESS_OVERLAP
const VIOLATION = 1e6;
const HARMLESS_OVERLAP = 1000;

export interface Point {
  x: number;
  y: number;
}

/**
 * 자동 배치 때 정한 선 경로. 두 끝점(연결점)은 그릴 때 받는다.
 * - xs가 비면 직선(두 카드의 높이가 같을 때)
 * - laneY가 없으면 이웃한 열 사이: xs[0]에서 세로로 꺾는다(가로·세로·가로, 꺾임 2번)
 * - laneY가 있으면 열을 건너뛰는 선: xs[0]에서 laneY로 가서 중간 열을 가로지르고 xs[1]에서 도착 높이로 간다(꺾임 최대 4번).
 *   laneY는 중간 열의 카드를 피한 높이다.
 */
export interface Route {
  xs: number[];
  laneY?: number;
}

export interface Layout {
  /** 카드 왼쪽 위 */
  positions: Map<string, Point>;
  /** edgeKey(연결) → 경로 */
  routes: Map<string, Route>;
}

interface Box {
  column: number;
  /** 위쪽 끝 */
  y: number;
  height: number;
}

/** 통로 하나에 놓는 세로 구간. leftY·rightY는 그 구간의 왼쪽·오른쪽으로 이어지는 가로 구간의 높이 */
interface Vertical {
  edge: Edge;
  gap: number;
  group: string;
  leftY: number;
  rightY: number;
  /** leftY·rightY가 카드 연결점 높이면 그 카드(열을 건너뛰는 선의 가운데 높이면 없음) */
  leftNode?: string;
  rightNode?: string;
  route: Route;
  index: number;
}

interface Blocked {
  low: number;
  high: number;
  /** 이 카드에서 나와 그 카드 높이 그대로 가는 선. 같은 카드에서 나오는 다른 선은 줄기를 같이 써도 된다 */
  source?: string;
  /** 이 카드로 그 카드 높이에서 들어오는 선 */
  target?: string;
}

export function edgeKey(edge: Edge): string {
  return `${edge.from}>${edge.to}`;
}

const center = (box: Box) => box.y + box.height / 2;

/** 왼쪽 → 오른쪽으로 카드를 배치하고(Dagre) 선 경로를 정한다. 연결이 없는 공정도 함께 놓는다. */
export function layoutGraph(nodes: readonly { id: string; height: number }[], edges: readonly Edge[]): Layout {
  const graph = new dagre.graphlib.Graph();
  // 정렬 방식을 하나로 정한다. 정하지 않으면 Dagre가 네 방식의 중간값을 써서 이어진 카드가 몇 px씩 어긋난다.
  graph.setGraph({ rankdir: 'LR', nodesep: ROW_GAP, ranksep: COLUMN_GAP, align: 'UL' });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const { id, height } of nodes) graph.setNode(id, { width: NODE_WIDTH, height });
  for (const { from, to } of edges) graph.setEdge(from, to);
  dagre.layout(graph);

  const columnXs = [...new Set(nodes.map(({ id }) => Math.round(graph.node(id).x!)))].sort((a, b) => a - b);
  const boxes = new Map<string, Box>(
    nodes.map(({ id, height }) => {
      const { x, y } = graph.node(id);
      return [id, { column: columnXs.indexOf(Math.round(x!)), y: y! - height / 2, height }];
    }),
  );
  levelNearlyAligned(boxes, edges);
  // 열을 건너뛰는 선은 Dagre가 중간 열의 빈자리에 둔 점 근처 높이를 먼저 찾는다.
  const hint = (edge: Edge) => {
    const points: Point[] = graph.edge(edge.from, edge.to)?.points ?? [];
    const inner = points.slice(1, -1);
    return inner.length === 0 ? null : inner.reduce((sum, point) => sum + point.y, 0) / inner.length;
  };
  let result = route(boxes, edges, hint, columnXs.length);
  // 연결 없는 두 카드가 우연히 같은 높이여서 선이 포개질 수밖에 없으면, 한 카드를 조금 옮겨 다시 그린다.
  for (let attempt = 0; attempt < 5 && result.conflicts.length > 0; attempt += 1) {
    const moved = result.conflicts.some((pair) =>
      pair.some((id) => [MIN_STEP, -MIN_STEP, 2 * MIN_STEP, -2 * MIN_STEP].some((dy) => moveIfAllowed(boxes, edges, id, dy))),
    );
    if (!moved) break;
    result = route(boxes, edges, hint, columnXs.length);
  }
  return result.layout;
}

/**
 * 출발·도착 높이 차가 MIN_STEP보다 작은 연결은 한쪽 카드를 옮겨 높이를 맞춘다.
 * 같은 열의 카드와 가까워지거나, 곧던 선이 굽거나, 다른 선에 작은 계단이 생기면 옮기지 않는다.
 */
function levelNearlyAligned(boxes: Map<string, Box>, edges: readonly Edge[]): void {
  for (const edge of edges) {
    const source = boxes.get(edge.from);
    const target = boxes.get(edge.to);
    if (!source || !target || target.column <= source.column) continue;
    const dy = center(source) - center(target);
    if (Math.abs(dy) < 0.5 || Math.abs(dy) >= MIN_STEP) continue;
    if (!moveIfAllowed(boxes, edges, edge.to, dy)) moveIfAllowed(boxes, edges, edge.from, -dy);
  }
}

/** 카드를 dy만큼 옮겨도 같은 열의 카드와 충분히 떨어져 있고, 곧던 선이 굽지 않고, 작은 계단이 생기지 않으면 옮긴다. */
function moveIfAllowed(boxes: Map<string, Box>, edges: readonly Edge[], id: string, dy: number): boolean {
  const box = boxes.get(id);
  if (!box) return false;
  const top = box.y + dy;
  for (const [otherId, other] of boxes) {
    if (otherId === id || other.column !== box.column) continue;
    if (top < other.y + other.height + ROW_GAP / 2 && other.y < top + box.height + ROW_GAP / 2) return false;
  }
  const allowed = edges.every((edge) => {
    const otherId = edge.from === id ? edge.to : edge.to === id ? edge.from : null;
    const other = otherId === null ? undefined : boxes.get(otherId);
    if (!other) return true;
    const before = Math.abs(center(box) - center(other));
    const after = Math.abs(center(box) + dy - center(other));
    return after < 0.5 || (before >= 0.5 && after >= MIN_STEP);
  });
  if (allowed) box.y = top;
  return allowed;
}

function route(
  boxes: Map<string, Box>,
  edges: readonly Edge[],
  hint: (edge: Edge) => number | null,
  columnCount: number,
): { layout: Layout; conflicts: [string, string][] } {
  const routes = new Map<string, Route>();
  const verticals: Vertical[] = [];
  const skips: { route: Route; firstGap: number; lastGap: number }[] = [];
  const lanes: { firstGap: number; lastGap: number; y: number; from: string; to: string; sy: number; ty: number }[] = [];

  for (const edge of edges) {
    const source = boxes.get(edge.from);
    const target = boxes.get(edge.to);
    if (!source || !target || target.column <= source.column) continue; // 배치 결과에서는 생기지 않는다. 경로가 없으면 그릴 때 기본 모양을 쓴다.
    const sy = center(source);
    const ty = center(target);
    const route: Route = { xs: [] };
    routes.set(edgeKey(edge), route);

    if (target.column === source.column + 1) {
      if (Math.abs(sy - ty) >= 0.5) {
        verticals.push({ edge, gap: source.column, group: `to:${edge.to}`, leftY: sy, rightY: ty, leftNode: edge.from, rightNode: edge.to, route, index: 0 });
      }
      continue;
    }

    // 피할 높이: 중간 열의 카드(여유 포함), 양 끝 열의 다른 카드 연결점(그 카드의 선과 겹치지 않게), 같은 통로를 지나는 다른 가로 구간
    const blocked: Blocked[] = [];
    for (const [id, box] of boxes) {
      if (box.column > source.column && box.column < target.column) {
        blocked.push({ low: box.y - CLEARANCE, high: box.y + box.height + CLEARANCE });
      } else if ((box.column === source.column || box.column === target.column) && id !== edge.from && id !== edge.to) {
        blocked.push({ low: center(box) - LANE_GAP / 2, high: center(box) + LANE_GAP / 2 });
      }
    }
    for (const lane of lanes) {
      if (lane.firstGap > target.column - 1 || lane.lastGap < source.column) continue;
      blocked.push({
        low: lane.y - LANE_GAP,
        high: lane.y + LANE_GAP,
        source: lane.y === lane.sy ? lane.from : undefined,
        target: lane.y === lane.ty ? lane.to : undefined,
      });
    }
    const free = (y: number, shared: (item: Blocked) => boolean) => blocked.every((item) => y < item.low || y > item.high || shared(item));
    // 출발·도착 높이를 그대로 쓸 수 있으면 꺾임이 줄어든다(다른 쪽 끝과의 높이 차가 작은 계단이 되지 않을 때).
    // 아니면 작은 계단이 생기지 않게 두 높이 근처를 비우고 찾는다.
    const step = Math.abs(ty - sy);
    const laneY =
      free(sy, (item) => item.source === edge.from) && (step < 0.5 || step >= MIN_STEP)
        ? sy
        : free(ty, (item) => item.target === edge.to) && step >= MIN_STEP
          ? ty
          : nearestFree(hint(edge) ?? (sy + ty) / 2, [
              ...blocked,
              { low: sy - MIN_STEP, high: sy + MIN_STEP },
              { low: ty - MIN_STEP, high: ty + MIN_STEP },
            ]);
    lanes.push({ firstGap: source.column, lastGap: target.column - 1, y: laneY, from: edge.from, to: edge.to, sy, ty });
    route.laneY = laneY;
    skips.push({ route, firstGap: source.column, lastGap: target.column - 1 });
    if (laneY !== sy) {
      verticals.push({ edge, gap: source.column, group: `from:${edge.from}`, leftY: sy, rightY: laneY, leftNode: edge.from, route, index: 0 });
    }
    if (laneY !== ty) {
      verticals.push({ edge, gap: target.column - 1, group: `to:${edge.to}`, leftY: laneY, rightY: ty, rightNode: edge.to, route, index: 1 });
    }
  }

  // 통로마다 세로 구간의 x 순서(lane)를 정하고, 선이 많은 통로는 넓힌다.
  const linked = new Set(edges.map(edgeKey));
  const connected = (from: string, to: string) => linked.has(edgeKey({ from, to }));
  const gapCount = Math.max(columnCount - 1, 0);
  const laneCounts = Array.from({ length: gapCount }, () => 1);
  const placed: { vertical: Vertical; lane: number }[] = [];
  const conflicts: [string, string][] = [];
  for (let gap = 0; gap < gapCount; gap += 1) {
    const lanesInGap = assignLanes(
      verticals.filter((vertical) => vertical.gap === gap),
      connected,
    );
    laneCounts[gap] = Math.max(1, ...lanesInGap.units.map((unit) => unit.lane + 1));
    for (const unit of lanesInGap.units) for (const vertical of unit.items) placed.push({ vertical, lane: unit.lane });
    conflicts.push(...lanesInGap.conflicts);
  }
  const widths = laneCounts.map((count) => Math.max(COLUMN_GAP, SOURCE_SIDE + TARGET_SIDE + (count - 1) * LINE_SPACING));
  const left: number[] = [];
  for (let column = 0; column < columnCount; column += 1) {
    left.push(column === 0 ? 0 : left[column - 1] + NODE_WIDTH + widths[column - 1]);
  }
  const laneX = (gap: number, lane: number) => {
    const start = left[gap] + NODE_WIDTH + SOURCE_SIDE;
    const end = left[gap] + NODE_WIDTH + widths[gap] - TARGET_SIDE;
    return laneCounts[gap] === 1 ? (start + end) / 2 : start + ((end - start) * lane) / (laneCounts[gap] - 1);
  };
  // 세로 구간이 없는 쪽(출발·도착 높이를 그대로 쓰는 쪽)의 x는 경로 모양에 영향이 없다. 통로 가운데를 둔다.
  for (const skip of skips) skip.route.xs = [laneX(skip.firstGap, 0), laneX(skip.lastGap, 0)];
  for (const { vertical, lane } of placed) vertical.route.xs[vertical.index] = laneX(vertical.gap, lane);

  return {
    layout: {
      positions: new Map([...boxes].map(([id, box]) => [id, { x: left[box.column], y: box.y }])),
      routes,
    },
    conflicts,
  };
}

/** blocked에 들지 않으면서 hint에 가장 가까운 높이 */
function nearestFree(hint: number, blocked: Blocked[]): number {
  const merged: [number, number][] = [];
  for (const { low, high } of [...blocked].sort((a, b) => a.low - b.low)) {
    const last = merged[merged.length - 1];
    if (last && low <= last[1] + 2) last[1] = Math.max(last[1], high);
    else merged.push([low, high]);
  }
  const inside = merged.find(([low, high]) => hint >= low && hint <= high);
  if (!inside) return hint;
  return hint - inside[0] <= inside[1] - hint ? inside[0] - 1 : inside[1] + 1;
}

/** 한 x를 함께 쓰는 세로 구간 묶음 */
interface Unit {
  key: string;
  low: number;
  high: number;
  items: Vertical[];
  lane: number;
}

function unitOf(key: string, items: Vertical[]): Unit {
  const ys = items.flatMap((item) => [item.leftY, item.rightY]);
  return { key, low: Math.min(...ys), high: Math.max(...ys), items, lane: 0 };
}

/**
 * 한 통로 안에서 세로 구간마다 x 순서(lane, 0이 왼쪽)를 정한다.
 * 같은 카드로 들어가거나(to:) 같은 카드에서 나오는(from:) 구간은 한 줄로 모으고, 높이 범위가 겹치지 않는 묶음끼리는 같은 x를 다시 쓴다.
 * 높이 범위가 겹치는 묶음끼리의 좌우 순서는 먼저 같은 높이의 가로 구간이 포개지지 않게 하고(포개지면 없는 연결로 읽힌다),
 * 그다음 선끼리의 교차가 적게 고른다. 포개짐을 피할 수 없는 묶음은 선마다 나눈다.
 */
function assignLanes(
  verticals: Vertical[],
  connected: (from: string, to: string) => boolean,
): { units: Unit[]; conflicts: [string, string][] } {
  // u의 왼쪽 가로 구간과 v의 오른쪽 가로 구간이 같은 높이면 u가 v보다 왼쪽에 있어야 포개지지 않는다. 어길 때의 비용을 돌려준다.
  // 포개져서 생기는 두 가지 잘못 읽힘(u 출발 → v 도착, v 출발 → u 도착)이 모두 실제 연결이면 피할 수 없을 때 받아들인다.
  const precedence = (u: Vertical, v: Vertical) => {
    if (Math.abs(u.leftY - v.rightY) >= 1 || u.edge.from === v.edge.from || u.edge.to === v.edge.to) return 0;
    return connected(u.edge.from, v.edge.to) && connected(v.edge.from, u.edge.to) ? HARMLESS_OVERLAP : VIOLATION;
  };
  const overlaps = (a: Unit, b: Unit) => a.low - SAME_X_GAP <= b.high && b.low - SAME_X_GAP <= a.high;
  const inside = (y: number, unit: Unit) => y > unit.low + 0.5 && y < unit.high - 0.5;
  // a를 b보다 왼쪽에 둘 때의 비용: 어긴 순서와 교차 수
  const cost = (a: Unit, b: Unit) => {
    if (!overlaps(a, b)) return 0;
    let total = 0;
    for (const u of a.items) {
      for (const v of b.items) total += precedence(v, u);
      if (inside(u.rightY, b)) total += 1;
    }
    for (const v of b.items) if (inside(v.leftY, a)) total += 1;
    return total;
  };

  const groups = new Map<string, Vertical[]>();
  for (const vertical of verticals) groups.set(vertical.group, [...(groups.get(vertical.group) ?? []), vertical]);
  let units = [...groups].map(([key, items]) => unitOf(key, items));
  for (;;) {
    const order = arrange(units, cost);
    const violated = order.flatMap((a, index) => order.slice(index + 1).filter((b) => cost(a, b) >= VIOLATION).map((b) => [a, b]));
    const split = violated.flat().find((unit) => unit.items.length > 1);
    if (!split) {
      order.forEach((unit, index) => {
        unit.lane = Math.max(0, ...order.slice(0, index).filter((other) => overlaps(other, unit)).map((other) => other.lane + 1));
      });
      // 그래도 포개지는 곳은 서로 연결 없는 두 카드(왼쪽 열 카드, 오른쪽 열 카드)가 같은 높이인 곳이다.
      const conflicts: [string, string][] = [];
      for (const [a, b] of violated) {
        for (const u of a.items) {
          for (const v of b.items) {
            if (precedence(v, u) >= VIOLATION && v.leftNode && u.rightNode && !connected(v.leftNode, u.rightNode)) {
              conflicts.push([v.leftNode, u.rightNode]);
            }
          }
        }
      }
      return { units: order, conflicts };
    }
    units = units.flatMap((unit) => (unit === split ? unit.items.map((item, index) => unitOf(`${unit.key}#${index}`, [item])) : [unit]));
  }
}


/**
 * 지켜야 할 순서를 먼저 맞추고(그런 제약이 없으면 위쪽에서 시작하는 묶음부터) 놓은 뒤,
 * 한 묶음을 다른 자리로 옮겨 비용이 줄면 옮기기를 되풀이한다.
 */
function arrange(units: Unit[], cost: (a: Unit, b: Unit) => number): Unit[] {
  const sorted = [...units].sort((a, b) => a.low - b.low || a.key.localeCompare(b.key));
  const index = new Map(sorted.map((unit, position) => [unit, position]));
  const matrix = sorted.map((a) => sorted.map((b) => (a === b ? 0 : cost(a, b))));
  const pairCost = (a: Unit, b: Unit) => matrix[index.get(a)!][index.get(b)!];

  const pending = [...sorted];
  const order: Unit[] = [];
  while (pending.length > 0) {
    // 아직 안 놓은 묶음 중 '반드시 앞에 와야 하는' 것이 없는 첫 묶음. 순서 제약이 돌고 돌면 맨 앞 묶음.
    const next = pending.findIndex((unit) =>
      pending.every((other) => other === unit || pairCost(unit, other) < VIOLATION || pairCost(other, unit) >= VIOLATION),
    );
    order.push(...pending.splice(Math.max(next, 0), 1));
  }

  // 한 묶음을 옮기면 그 묶음이 건너뛴 묶음들과의 좌우만 바뀐다.
  for (let improved = true; improved; ) {
    improved = false;
    for (let from = 0; from < order.length && !improved; from += 1) {
      const unit = order[from];
      for (const step of [1, -1]) {
        let delta = 0;
        for (let to = from + step; to >= 0 && to < order.length && !improved; to += step) {
          const other = order[to];
          delta += step > 0 ? pairCost(other, unit) - pairCost(unit, other) : pairCost(unit, other) - pairCost(other, unit);
          if (delta < 0) {
            order.splice(to, 0, ...order.splice(from, 1));
            improved = true;
          }
        }
        if (improved) break;
      }
    }
  }
  return order;
}

/** 경로의 꺾이는 점들(두 끝점 포함). 겹치는 점과 한 직선 위의 가운데 점은 뺀다. */
export function routePoints(route: Route, source: Point, target: Point): Point[] {
  const points: Point[] = [source];
  if (route.laneY === undefined) {
    if (route.xs.length > 0 && Math.abs(source.y - target.y) >= 1) {
      points.push({ x: route.xs[0], y: source.y }, { x: route.xs[0], y: target.y });
    }
  } else {
    // 연결점 측정값의 소수점 오차로 1px도 안 되는 꺾임이 생기지 않게 끝점 높이에 맞춘다.
    let lane = route.laneY;
    if (Math.abs(lane - source.y) < 1) lane = source.y;
    else if (Math.abs(lane - target.y) < 1) lane = target.y;
    const [first, last] = route.xs;
    points.push({ x: first, y: source.y }, { x: first, y: lane }, { x: last, y: lane }, { x: last, y: target.y });
  }
  points.push(target);
  return simplify(points);
}

function simplify(points: Point[]): Point[] {
  const distinct = points.filter((point, index) => {
    const previous = points[index - 1];
    return !previous || Math.abs(point.x - previous.x) >= 0.5 || Math.abs(point.y - previous.y) >= 0.5;
  });
  return distinct.filter((point, index) => {
    const previous = distinct[index - 1];
    const next = distinct[index + 1];
    if (!previous || !next) return true;
    const sameColumn = Math.abs(previous.x - point.x) < 0.5 && Math.abs(point.x - next.x) < 0.5;
    const sameRow = Math.abs(previous.y - point.y) < 0.5 && Math.abs(point.y - next.y) < 0.5;
    return !sameColumn && !sameRow;
  });
}

/** 꺾이는 점을 둥근 모서리로 이은 SVG 경로 */
export function roundedPath(points: Point[], radius = CORNER): string {
  const at = (point: Point) => `${round(point.x)},${round(point.y)}`;
  let path = `M${at(points[0])}`;
  for (let index = 1; index < points.length - 1; index += 1) {
    const [previous, corner, next] = [points[index - 1], points[index], points[index + 1]];
    const r = Math.min(radius, distance(previous, corner) / 2, distance(corner, next) / 2);
    path += ` L${at(toward(corner, previous, r))} Q${at(corner)} ${at(toward(corner, next, r))}`;
  }
  return `${path} L${at(points[points.length - 1])}`;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function toward(from: Point, to: Point, length: number): Point {
  const total = distance(from, to);
  return total === 0 ? from : { x: from.x + ((to.x - from.x) * length) / total, y: from.y + ((to.y - from.y) * length) / total };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
