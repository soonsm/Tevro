import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  applyNodeChanges,
  useReactFlow,
  type AriaLabelConfig,
  type Edge as FlowEdge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { reachable, type Edge } from '../shared/domain.ts';
import type { GraphDto, TaskDto } from '../shared/types.ts';
import { CheckIcon, DocIcon, StatusChip, WarnIcon } from './icons.tsx';
import { layoutPositions } from './layout.ts';
import type { Selection } from './App.tsx';

type TaskNodeType = Node<{ task: TaskDto }, 'task'>;
type Emphasis = 'normal' | 'selected' | 'related' | 'dimmed' | 'cycle';
type EdgeTone = 'normal' | 'path' | 'dim' | 'cycle' | 'selected';

const EDGE_COLORS: Record<EdgeTone, string> = {
  normal: '#8a919e',
  path: '#2e3440',
  dim: '#cbd0d8',
  cycle: '#c2410c',
  selected: '#1a1d23',
};

const FIT_VIEW = { padding: 0.06, maxZoom: 1 };

const ARIA_LABELS: Partial<AriaLabelConfig> = {
  'controls.ariaLabel': '화면 조작',
  'controls.zoomIn.ariaLabel': '확대',
  'controls.zoomOut.ariaLabel': '축소',
  'controls.fitView.ariaLabel': '전체 보기',
  'node.a11yDescription.default': 'Enter나 Space로 공정을 고릅니다. 방향키로 옮길 수 있습니다.',
  'node.a11yDescription.keyboardDisabled': 'Enter나 Space로 공정을 고릅니다.',
  'edge.a11yDescription.default': 'Enter나 Space로 연결을 고르고, Delete로 지웁니다.',
  'handle.ariaLabel': '연결 지점',
};

interface ViewState {
  selectedId: string | null;
  related: Set<string>;
  cycle: Set<string>;
  titles: Map<string, string>;
}

const ViewContext = createContext<ViewState>({ selectedId: null, related: new Set(), cycle: new Set(), titles: new Map() });

interface Props {
  graph: GraphDto;
  selection: Selection;
  /** 순환으로 거부된 경로. 알림을 닫을 때까지 강조한다. */
  cycle: string[] | undefined;
  /** '자동 정렬'을 누를 때마다 바뀌는 값 */
  layoutRequest: number;
  onSelect: (selection: Selection) => void;
  onConnect: (from: string, to: string) => void;
  onDeleteEdge: (edge: Edge) => void;
}

export function GraphCanvas({ graph, selection, cycle, layoutRequest, onSelect, onConnect, onDeleteEdge }: Props) {
  const { fitView } = useReactFlow();
  const [nodes, setNodes] = useState<TaskNodeType[]>([]);
  const layoutKey = useRef('');
  const selectedTaskId = selection?.kind === 'task' ? selection.id : null;

  const structure = useMemo(
    () =>
      [graph.project.id, graph.tasks.map((task) => task.id).join(','), graph.dependencies.map((edge) => `${edge.from}>${edge.to}`).join(',')].join('|'),
    [graph],
  );

  // 공정이나 연결이 바뀌거나 '자동 정렬'을 누르면 다시 배치한다. 상태·제목만 바뀌면 위치를 그대로 둔다.
  // 위치는 저장하지 않으므로 끌어서 옮긴 자리도 다음 배치 때 다시 정렬된다.
  useEffect(() => {
    const key = `${structure}#${layoutRequest}`;
    const relayout = key !== layoutKey.current;
    layoutKey.current = key;
    const positions = relayout ? layoutPositions(graph.tasks.map((task) => task.id), graph.dependencies) : null;
    setNodes((previous) => {
      const byId = new Map(previous.map((node) => [node.id, node]));
      return graph.tasks.map((task): TaskNodeType => {
        const old = byId.get(task.id);
        const position = positions?.get(task.id) ?? old?.position ?? { x: 0, y: 0 };
        return old ? { ...old, position, data: { task } } : { id: task.id, type: 'task', position, data: { task } };
      });
    });
    if (relayout) void fitView(FIT_VIEW);
  }, [graph, structure, layoutRequest, fitView]);

  // React Flow의 선택 표시를 패널의 선택과 맞춘다(키보드 삭제가 엉뚱한 대상을 잡지 않게).
  useEffect(() => {
    setNodes((previous) =>
      previous.map((node) => {
        const selected = node.id === selectedTaskId;
        return node.selected === selected ? node : { ...node, selected };
      }),
    );
  }, [selectedTaskId]);

  const highlight = useMemo(() => {
    if (!selectedTaskId) return null;
    return {
      up: reachable(graph.dependencies, selectedTaskId, 'up'),
      down: reachable(graph.dependencies, selectedTaskId, 'down'),
    };
  }, [graph.dependencies, selectedTaskId]);

  const view = useMemo<ViewState>(
    () => ({
      selectedId: selectedTaskId,
      related: new Set([...(highlight?.up ?? []), ...(highlight?.down ?? [])]),
      cycle: new Set(cycle ?? []),
      titles: new Map(graph.tasks.map((task) => [task.id, task.title])),
    }),
    [selectedTaskId, highlight, cycle, graph.tasks],
  );

  const edges = useMemo<FlowEdge[]>(() => {
    const cycleEdges = new Set((cycle ?? []).slice(1).map((to, index) => `${cycle![index]}>${to}`));
    const onPath = (edge: Edge) => {
      if (!highlight || !selectedTaskId) return false;
      const upstream = (id: string) => id === selectedTaskId || highlight.up.has(id);
      const downstream = (id: string) => id === selectedTaskId || highlight.down.has(id);
      return (upstream(edge.from) && upstream(edge.to)) || (downstream(edge.from) && downstream(edge.to));
    };
    return graph.dependencies.map((edge) => {
      const id = `${edge.from}>${edge.to}`;
      const tone: EdgeTone =
        selection?.kind === 'edge' && selection.from === edge.from && selection.to === edge.to
          ? 'selected'
          : cycleEdges.has(id)
            ? 'cycle'
            : highlight
              ? onPath(edge)
                ? 'path'
                : 'dim'
              : 'normal';
      const color = EDGE_COLORS[tone];
      return {
        id,
        source: edge.from,
        target: edge.to,
        type: 'smoothstep',
        selected: tone === 'selected',
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16, markerUnits: 'userSpaceOnUse' },
        style: { stroke: color, strokeWidth: tone === 'selected' ? 3 : 2 },
        zIndex: tone === 'normal' || tone === 'dim' ? 0 : 1,
        interactionWidth: 18,
      };
    });
  }, [graph.dependencies, highlight, selectedTaskId, selection, cycle]);

  return (
    <ViewContext.Provider value={view}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={(changes) => setNodes((current) => applyNodeChanges(changes, current))}
        onNodeClick={(_, node) => onSelect({ kind: 'task', id: node.id })}
        onEdgeClick={(_, edge) => onSelect({ kind: 'edge', from: edge.source, to: edge.target })}
        onPaneClick={() => onSelect(null)}
        onConnect={({ source, target }) => {
          if (source && target) onConnect(source, target);
        }}
        isValidConnection={({ source, target }) => source !== target}
        onBeforeDelete={async ({ nodes: deletingNodes, edges: deletingEdges }) => {
          // 키보드로는 연결만 지운다. 공정 삭제는 영향을 확인하는 패널의 버튼으로만 한다.
          if (deletingNodes.length === 0 && deletingEdges.length === 1) {
            onDeleteEdge({ from: deletingEdges[0].source, to: deletingEdges[0].target });
          }
          return false;
        }}
        deleteKeyCode={['Backspace', 'Delete']}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        fitView
        fitViewOptions={FIT_VIEW}
        minZoom={0.2}
        maxZoom={1.5}
        ariaLabelConfig={ARIA_LABELS}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="#d3d8df" />
        <Controls showInteractive={false} position="bottom-left" />
      </ReactFlow>
    </ViewContext.Provider>
  );
}

const TaskNode = memo(function TaskNode({ data: { task } }: NodeProps<TaskNodeType>) {
  const view = useContext(ViewContext);
  const emphasis: Emphasis = view.cycle.has(task.id)
    ? 'cycle'
    : view.selectedId === task.id
      ? 'selected'
      : view.selectedId
        ? view.related.has(task.id)
          ? 'related'
          : 'dimmed'
        : 'normal';
  return (
    <div className={`task-node is-${emphasis}`} title={task.title}>
      <Handle type="target" position={Position.Left} />
      <div className="task-node__top">
        <StatusChip status={task.status} />
        {(task.jiraUrl || task.confluenceUrl) && (
          <span className="task-node__links">
            {task.confluenceUrl && <DocIcon label="Confluence 문서 있음" />}
            {task.jiraUrl && <span>{task.jiraKey ?? 'Jira'}</span>}
          </span>
        )}
      </div>
      <div className="task-node__title">{task.title}</div>
      <PrerequisiteLine task={task} titles={view.titles} />
      <Handle type="source" position={Position.Right} />
    </div>
  );
});

const nodeTypes = { task: TaskNode };

/** 카드 셋째 줄. 완료 안 된 선행이 1개면 이름, 2개 이상이면 개수만 보여 준다(이름은 패널에). */
function PrerequisiteLine({ task, titles }: { task: TaskDto; titles: Map<string, string> }) {
  if (task.predecessorIds.length === 0) return null;
  if (task.prerequisitesMet) {
    return (
      <div className="task-node__prerequisite is-met">
        <CheckIcon />
        선행 충족
      </div>
    );
  }
  const unmet = task.unmetPrerequisiteIds;
  return (
    <div className="task-node__prerequisite is-unmet">
      <WarnIcon />
      <span>선행 미충족: {unmet.length === 1 ? titles.get(unmet[0]) : `${unmet.length}개`}</span>
    </div>
  );
}
