import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Edge } from '../src/shared/domain.ts';
import { NODE_HEIGHT, NODE_WIDTH, PARENT_NODE_HEIGHT, edgeKey, layoutGraph, routePoints, type Point } from '../src/web/layout.ts';

// 연결점은 카드 좌우 끝에 걸친 지름 10px 원의 바깥쪽이다(styles.css .react-flow__handle).
const HANDLE = 5;
const MIN_STEP = 12;

interface Graph {
  nodes: { id: string; height: number }[];
  edges: Edge[];
}

interface Drawn {
  edge: Edge;
  points: Point[];
  columns: number;
}

/** 배치 결과를 화면처럼 그렸을 때의 선(꺾이는 점 목록)과 각 선이 건너는 열 수 */
function draw({ nodes, edges }: Graph) {
  const layout = layoutGraph(nodes, edges);
  const heights = new Map(nodes.map((node) => [node.id, node.height]));
  const columnXs = [...new Set([...layout.positions.values()].map((position) => position.x))].sort((a, b) => a - b);
  const boxes = nodes.map(({ id, height }) => ({ id, ...layout.positions.get(id)!, height }));
  const drawn: Drawn[] = edges.map((edge) => {
    const from = layout.positions.get(edge.from)!;
    const to = layout.positions.get(edge.to)!;
    const route = layout.routes.get(edgeKey(edge));
    assert.ok(route, `${edgeKey(edge)} 경로가 없음`);
    const source = { x: from.x + NODE_WIDTH + HANDLE, y: from.y + heights.get(edge.from)! / 2 };
    const target = { x: to.x - HANDLE, y: to.y + heights.get(edge.to)! / 2 };
    return { edge, points: routePoints(route, source, target), columns: columnXs.indexOf(to.x) - columnXs.indexOf(from.x) };
  });
  return { layout, boxes, drawn };
}

const segments = (points: Point[]) => points.slice(1).map((point, index) => [points[index], point] as const);

/**
 * 두 선이 포개져도 잘못 읽히지 않는 경우: 출발이나 도착 카드가 같거나(갈라지는·모이는 선),
 * 포개진 곳에서 생길 수 있는 두 가지 읽힘(a 출발 → b 도착, b 출발 → a 도착)이 모두 실제 연결일 때.
 * 뒤의 경우는 같은 높이의 두 직선 사이를 엇갈려 잇는 선이 있을 때만 생기고 피할 수 없다.
 */
function harmless(a: Edge, b: Edge, edges: Edge[]): boolean {
  if (a.from === b.from || a.to === b.to) return true;
  const linked = (from: string, to: string) => edges.some((edge) => edge.from === from && edge.to === to);
  return linked(a.from, b.to) && linked(b.from, a.to);
}

/** 요구사항(같은 높이면 직선, 이웃 열은 꺾임 0·2번, 건너뛰면 4번 이하, 카드 밑 통과 금지, 작은 계단·선 포개짐 금지)을 검사한다. */
function checkRouting(graph: Graph) {
  const { boxes, drawn } = draw(graph);
  for (const { edge, points, columns } of drawn) {
    const name = edgeKey(edge);
    const bends = points.length - 2;
    assert.ok(columns >= 1, `${name}: 오른쪽 열로 가야 함`);
    for (const [a, b] of segments(points)) {
      assert.ok(Math.abs(a.x - b.x) < 0.01 || Math.abs(a.y - b.y) < 0.01, `${name}: 가로·세로가 아닌 구간`);
      if (Math.abs(a.x - b.x) < 0.01) assert.ok(Math.abs(a.y - b.y) >= MIN_STEP, `${name}: ${Math.abs(a.y - b.y)}px짜리 작은 계단`);
      for (const box of boxes) {
        const crosses =
          Math.max(a.x, b.x) > box.x + 0.5 &&
          Math.min(a.x, b.x) < box.x + NODE_WIDTH - 0.5 &&
          Math.max(a.y, b.y) > box.y + 0.5 &&
          Math.min(a.y, b.y) < box.y + box.height - 0.5;
        assert.ok(!crosses, `${name}: ${box.id} 카드 밑을 지남`);
      }
    }
    if (columns === 1) {
      const level = Math.abs(points[0].y - points[points.length - 1].y) < 0.5;
      assert.equal(bends, level ? 0 : 2, `${name}: 이웃 열 연결의 꺾임 ${bends}번`);
    } else {
      assert.ok(bends <= 4, `${name}: 열을 건너뛰는 연결의 꺾임 ${bends}번`);
    }
  }
  // 선끼리 같은 줄에 포개지거나 꺾이는 점이 다른 선 위에 놓이면 없는 연결로 읽힐 수 있다.
  for (const [index, a] of drawn.entries()) {
    for (const b of drawn.slice(index + 1)) {
      if (harmless(a.edge, b.edge, graph.edges)) continue;
      const name = `${edgeKey(a.edge)} / ${edgeKey(b.edge)}`;
      for (const [p, q] of segments(a.points)) {
        for (const [r, s] of segments(b.points)) {
          const horizontal = Math.abs(p.y - q.y) < 0.01 && Math.abs(r.y - s.y) < 0.01 && Math.abs(p.y - r.y) < 0.5;
          const vertical = Math.abs(p.x - q.x) < 0.01 && Math.abs(r.x - s.x) < 0.01 && Math.abs(p.x - r.x) < 0.5;
          const [lo1, hi1, lo2, hi2] = horizontal
            ? [Math.min(p.x, q.x), Math.max(p.x, q.x), Math.min(r.x, s.x), Math.max(r.x, s.x)]
            : [Math.min(p.y, q.y), Math.max(p.y, q.y), Math.min(r.y, s.y), Math.max(r.y, s.y)];
          assert.ok(!((horizontal || vertical) && Math.min(hi1, hi2) - Math.max(lo1, lo2) > 0.5), `${name}: 선이 포개짐`);
        }
      }
      for (const [self, other] of [
        [a, b],
        [b, a],
      ]) {
        for (const corner of self.points.slice(1, -1)) {
          for (const [r, s] of segments(other.points)) {
            const onSegment =
              corner.x >= Math.min(r.x, s.x) - 0.5 &&
              corner.x <= Math.max(r.x, s.x) + 0.5 &&
              corner.y >= Math.min(r.y, s.y) - 0.5 &&
              corner.y <= Math.max(r.y, s.y) + 0.5;
            assert.ok(!onSegment, `${name}: 꺾이는 점이 다른 선 위에 놓임`);
          }
        }
      }
    }
  }
}

function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

function randomGraph(seed: number): Graph {
  const random = seeded(seed);
  const count = 3 + Math.floor(random() * 14);
  const nodes = Array.from({ length: count }, (_, index) => ({ id: `t${index}`, height: random() < 0.25 ? PARENT_NODE_HEIGHT : NODE_HEIGHT }));
  const edges: Edge[] = [];
  for (let i = 0; i < count; i += 1) {
    for (let j = i + 1; j < count; j += 1) if (random() < 2.4 / count) edges.push({ from: `t${i}`, to: `t${j}` });
  }
  return { nodes, edges };
}

// scripts/demo.ts의 최상위 층. '애플리케이션 개발'(dev)만 하위 공정이 있다.
const DEMO: Graph = {
  nodes: ['repo', 'ci', 'env', 'db', 'dev', 'gitops', 'verify', 'deploy', 'docs'].map((id) => ({
    id,
    height: id === 'dev' ? PARENT_NODE_HEIGHT : NODE_HEIGHT,
  })),
  edges: [
    ['repo', 'ci'],
    ['ci', 'gitops'],
    ['env', 'gitops'],
    ['gitops', 'verify'],
    ['db', 'verify'],
    ['verify', 'deploy'],
    ['repo', 'dev'],
    ['dev', 'verify'],
  ].map(([from, to]) => ({ from, to })),
};

describe('layoutGraph', () => {
  it('예시 프로젝트: 이웃 열은 곧거나 두 번 꺾이고, 카드 밑으로 지나는 선이 없다', () => {
    checkRouting(DEMO);
  });

  it('같은 높이의 카드를 잇는 선은 직선이다', () => {
    const { drawn } = draw({
      nodes: [
        { id: 'a', height: NODE_HEIGHT },
        { id: 'b', height: PARENT_NODE_HEIGHT },
        { id: 'c', height: NODE_HEIGHT },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
      ],
    });
    for (const { points } of drawn) assert.equal(points.length, 2);
  });

  it('한 카드에서 여러 카드로 갈라지는 선과 여러 카드에서 모이는 선', () => {
    const fan = (count: number): Graph => ({
      nodes: [{ id: 's', height: NODE_HEIGHT }, ...Array.from({ length: count }, (_, index) => ({ id: `t${index}`, height: NODE_HEIGHT }))],
      edges: Array.from({ length: count }, (_, index) => ({ from: 's', to: `t${index}` })),
    });
    for (const count of [2, 3, 6]) {
      checkRouting(fan(count));
      const reversed = fan(count);
      reversed.edges = reversed.edges.map(({ from, to }) => ({ from: to, to: from }));
      checkRouting(reversed);
    }
  });

  it('열을 건너뛰는 선은 중간 열의 카드를 피해 돌아간다', () => {
    const graph: Graph = {
      nodes: ['a', 'b', 'c', 'd'].map((id) => ({ id, height: NODE_HEIGHT })),
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'c', to: 'd' },
        { from: 'a', to: 'd' },
        { from: 'a', to: 'c' },
      ],
    };
    checkRouting(graph);
    const { drawn } = draw(graph);
    assert.ok(drawn.some(({ columns, points }) => columns > 1 && points.length > 2));
  });

  it('무작위 그래프에서 요구사항을 지킨다', () => {
    // 뒤의 네 개는 예전에 실패했던 그래프: 엇갈린 두 직선(416), 순서 제약을 먼저 맞춰야 하는 통로(1187),
    // 연결 없는 두 카드가 같은 높이라 카드를 옮겨야 하는 경우(2278), 열을 건너뛰는 선의 작은 계단(3308)
    const seeds = [...Array.from({ length: 300 }, (_, index) => index + 1), 416, 1187, 2278, 3308];
    for (const seed of seeds) {
      const graph = randomGraph(seed);
      try {
        checkRouting(graph);
      } catch (error) {
        throw new Error(`seed ${seed}: ${(error as Error).message}\n${JSON.stringify(graph)}`);
      }
    }
  });

  it('연결이 없는 공정도 위치를 받는다', () => {
    const { positions, routes } = layoutGraph([{ id: 'x', height: NODE_HEIGHT }], []);
    assert.deepEqual(positions.get('x'), { x: 0, y: 0 });
    assert.equal(routes.size, 0);
  });
});
