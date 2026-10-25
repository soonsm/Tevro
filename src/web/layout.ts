import dagre from '@dagrejs/dagre';
import type { Edge } from '../shared/domain.ts';

// styles.css의 .task-node 크기와 맞춘다.
export const NODE_WIDTH = 176;
export const NODE_HEIGHT = 88;

/** 왼쪽 → 오른쪽 방향으로 자동 배치한 공정 카드 위치(왼쪽 위 기준). 연결이 없는 공정도 함께 놓는다. */
export function layoutPositions(taskIds: readonly string[], edges: readonly Edge[]): Map<string, { x: number; y: number }> {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: 'LR', nodesep: 24, ranksep: 48 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const id of taskIds) graph.setNode(id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const { from, to } of edges) graph.setEdge(from, to);
  dagre.layout(graph);
  return new Map(
    taskIds.map((id) => {
      const { x, y } = graph.node(id);
      return [id, { x: x! - NODE_WIDTH / 2, y: y! - NODE_HEIGHT / 2 }];
    }),
  );
}
