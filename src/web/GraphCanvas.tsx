import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  applyNodeChanges,
  getSmoothStepPath,
  useInternalNode,
  useReactFlow,
  type AriaLabelConfig,
  type EdgeProps,
  type Edge as FlowEdge,
  type InternalNode,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { INCONSISTENCY_LABELS, hasPrerequisites, reachable, type Edge } from '../shared/domain.ts';
import type { GraphDto, TaskDto } from '../shared/types.ts';
import { CheckIcon, ChevronRightIcon, DocIcon, StackIcon, StatusChip, WarnIcon } from './icons.tsx';
import { NODE_HEIGHT, PARENT_NODE_HEIGHT, edgeKey, layoutGraph, roundedPath, routePoints, type Layout, type Point, type Route } from './layout.ts';
import type { Selection } from './App.tsx';

type TaskNodeType = Node<{ task: TaskDto }, 'task'>;
/** route는 자동 배치 때 정한 경로, sourceAt·targetAt은 그때의 두 카드 위치 */
type RoutedEdgeType = FlowEdge<{ route?: Route; sourceAt?: Point; targetAt?: Point }, 'routed'>;
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
  open: (taskId: string) => void;
}

const ViewContext = createContext<ViewState>({
  selectedId: null,
  related: new Set(),
  cycle: new Set(),
  titles: new Map(),
  open: () => {},
});

interface Props {
  graph: GraphDto;
  /** 보고 있는 층의 상위 공정. null이면 최상위 층. 화면은 한 번에 한 층만 그린다(F-H07). */
  levelId: string | null;
  selection: Selection;
  /** 순환으로 거부된 경로. 알림을 닫을 때까지 강조한다. */
  cycle: string[] | undefined;
  /** '자동 정렬'을 누를 때마다 바뀌는 값 */
  layoutRequest: number;
  onSelect: (selection: Selection) => void;
  /** 공정 안(하위 층)으로 들어간다 */
  onOpen: (taskId: string) => void;
  onConnect: (from: string, to: string) => void;
  onDeleteEdge: (edge: Edge) => void;
  /** 열람자: 연결을 만들거나 지울 수 없다 */
  readOnly?: boolean;
}

export function GraphCanvas({ graph, levelId, selection, cycle, layoutRequest, onSelect, onOpen, onConnect, onDeleteEdge, readOnly = false }: Props) {
  const { fitView } = useReactFlow();
  const [nodes, setNodes] = useState<TaskNodeType[]>([]);
  const [layout, setLayout] = useState<Layout | null>(null);
  const layoutKey = useRef('');

  // 연결은 같은 층 안에서만 맺으므로 이 층 공정끼리의 연결만 고르면 된다.
  const level = useMemo(() => {
    const tasks = graph.tasks.filter((task) => task.parentId === levelId);
    const ids = new Set(tasks.map((task) => task.id));
    return { tasks, ids, dependencies: graph.dependencies.filter((edge) => ids.has(edge.from) && ids.has(edge.to)) };
  }, [graph, levelId]);
  // 다른 층의 공정(예: 경로에서 고른 상위 공정)을 골랐을 때는 이 층에서 강조할 것이 없다.
  const selectedTaskId = selection?.kind === 'task' && level.ids.has(selection.id) ? selection.id : null;

  const structure = useMemo(
    () =>
      [
        graph.project.id,
        levelId ?? '',
        level.tasks.map((task) => `${task.id}${task.childCount > 0 ? '+' : ''}`).join(','),
        level.dependencies.map(edgeKey).join(','),
      ].join('|'),
    [graph.project.id, levelId, level],
  );

  // 층을 옮기거나, 공정·연결이 바뀌거나, '자동 정렬'을 누르면 다시 배치한다. 상태·제목만 바뀌면 위치를 그대로 둔다.
  // 위치는 저장하지 않으므로 끌어서 옮긴 자리도 다음 배치 때 다시 정렬된다.
  useEffect(() => {
    const key = `${structure}#${layoutRequest}`;
    const relayout = key !== layoutKey.current;
    layoutKey.current = key;
    const next = relayout
      ? layoutGraph(
          level.tasks.map((task) => ({ id: task.id, height: task.childCount > 0 ? PARENT_NODE_HEIGHT : NODE_HEIGHT })),
          level.dependencies,
        )
      : null;
    if (next) setLayout(next);
    setNodes((previous) => {
      const byId = new Map(previous.map((node) => [node.id, node]));
      return level.tasks.map((task): TaskNodeType => {
        const old = byId.get(task.id);
        const position = next?.positions.get(task.id) ?? old?.position ?? { x: 0, y: 0 };
        return old ? { ...old, position, data: { task } } : { id: task.id, type: 'task', position, data: { task } };
      });
    });
    if (relayout) void fitView(FIT_VIEW);
  }, [level, structure, layoutRequest, fitView]);

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
      up: reachable(level.dependencies, selectedTaskId, 'up'),
      down: reachable(level.dependencies, selectedTaskId, 'down'),
    };
  }, [level.dependencies, selectedTaskId]);

  const view = useMemo<ViewState>(
    () => ({
      selectedId: selectedTaskId,
      related: new Set([...(highlight?.up ?? []), ...(highlight?.down ?? [])]),
      cycle: new Set(cycle ?? []),
      // 물려받은 선행은 다른 층에 있으므로 이름은 전체 공정에서 찾는다.
      titles: new Map(graph.tasks.map((task) => [task.id, task.title])),
      open: onOpen,
    }),
    [selectedTaskId, highlight, cycle, graph.tasks, onOpen],
  );

  const edges = useMemo<RoutedEdgeType[]>(() => {
    const cycleEdges = new Set((cycle ?? []).slice(1).map((to, index) => `${cycle![index]}>${to}`));
    const onPath = (edge: Edge) => {
      if (!highlight || !selectedTaskId) return false;
      const upstream = (id: string) => id === selectedTaskId || highlight.up.has(id);
      const downstream = (id: string) => id === selectedTaskId || highlight.down.has(id);
      return (upstream(edge.from) && upstream(edge.to)) || (downstream(edge.from) && downstream(edge.to));
    };
    return level.dependencies.map((edge) => {
      const id = edgeKey(edge);
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
        type: 'routed',
        data: { route: layout?.routes.get(id), sourceAt: layout?.positions.get(edge.from), targetAt: layout?.positions.get(edge.to) },
        selected: tone === 'selected',
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16, markerUnits: 'userSpaceOnUse' },
        style: { stroke: color, strokeWidth: tone === 'selected' ? 3 : 2 },
        zIndex: tone === 'normal' || tone === 'dim' ? 0 : 1,
        interactionWidth: 18,
      };
    });
  }, [level.dependencies, highlight, selectedTaskId, selection, cycle, layout]);

  return (
    <ViewContext.Provider value={view}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={(changes) => setNodes((current) => applyNodeChanges(changes, current))}
        onNodeClick={(_, node) => onSelect({ kind: 'task', id: node.id })}
        // 하위가 없는 카드는 두 번 눌러도 빈 층으로 들어가지 않는다. 첫 하위는 패널의 '하위 공정 추가'로 만든다.
        onNodeDoubleClick={(_, node) => node.data.task.childCount > 0 && onOpen(node.id)}
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
        nodesConnectable={!readOnly}
        deleteKeyCode={readOnly ? null : ['Backspace', 'Delete']}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        zoomOnDoubleClick={false}
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
  const parent = task.childCount > 0;
  return (
    <div className={`task-node is-${emphasis}${parent ? ' is-parent' : ''}`} title={task.title}>
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
      {parent && (
        <div className="task-node__children">
          <span
            className={`task-node__count${task.inconsistency ? ' is-warn' : ''}`}
            title={task.inconsistency ? INCONSISTENCY_LABELS[task.inconsistency] : `하위 공정 ${task.childCount}개 중 ${task.doneChildCount}개 완료`}
          >
            {task.inconsistency ? <WarnIcon /> : <StackIcon />}
            하위 {task.doneChildCount}/{task.childCount}
          </span>
          <button
            type="button"
            className="node-open nodrag"
            aria-label={`${task.title} 하위 공정 열기`}
            onClick={(event) => {
              event.stopPropagation();
              view.open(task.id);
            }}
          >
            열기
            <ChevronRightIcon />
          </button>
        </div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
});

const nodeTypes = { task: TaskNode };

const isAt = (node: InternalNode | undefined, at: Point | undefined) =>
  !!node && !!at && Math.abs(node.internals.positionAbsolute.x - at.x) < 0.5 && Math.abs(node.internals.positionAbsolute.y - at.y) < 0.5;

/** 자동 배치 때 정한 경로로 그린다. 카드를 끌어 옮겨 위치가 달라지면 그 카드의 선은 React Flow 기본 계단선으로 그린다. */
const RoutedEdge = memo(function RoutedEdge({
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  markerEnd,
  style,
  interactionWidth,
}: EdgeProps<RoutedEdgeType>) {
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  const path =
    data?.route && isAt(sourceNode, data.sourceAt) && isAt(targetNode, data.targetAt)
      ? roundedPath(routePoints(data.route, { x: sourceX, y: sourceY }, { x: targetX, y: targetY }))
      : getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, borderRadius: 5 })[0];
  return <BaseEdge path={path} markerEnd={markerEnd} style={style} interactionWidth={interactionWidth} />;
});

const edgeTypes = { routed: RoutedEdge };

/** 카드 셋째 줄. 완료 안 된 선행(물려받은 것 포함)이 1개면 이름, 2개 이상이면 개수만 보여 준다(이름은 패널에). */
function PrerequisiteLine({ task, titles }: { task: TaskDto; titles: Map<string, string> }) {
  if (!hasPrerequisites(task)) return null;
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
