import dagre from '@dagrejs/dagre';
import type { Edge } from '../shared/domain.ts';

// styles.css의 .task-node 크기와 맞춘다. 하위 공정이 있는 카드는 '하위 n/m · 열기' 줄만큼 더 높다.
export const NODE_WIDTH = 176;
export const NODE_HEIGHT = 88;
export const PARENT_NODE_HEIGHT = 118;

/** 왼쪽 → 오른쪽 방향으로 자동 배치한 공정 카드 위치(왼쪽 위 기준). 연결이 없는 공정도 함께 놓는다. */
export function layoutPositions(
  nodes: readonly { id: string; height: number }[],
  edges: readonly Edge[],
): Map<string, { x: number; y: number }> {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: 'LR', nodesep: 24, ranksep: 48 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const { id, height } of nodes) graph.setNode(id, { width: NODE_WIDTH, height });
  for (const { from, to } of edges) graph.setEdge(from, to);
  dagre.layout(graph);
  return new Map(
    nodes.map(({ id, height }) => {
      const { x, y } = graph.node(id);
      return [id, { x: x! - NODE_WIDTH / 2, y: y! - height / 2 }];
    }),
  );
}
