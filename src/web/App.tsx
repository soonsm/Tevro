import { ReactFlowProvider } from '@xyflow/react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { STATUS_LABELS, TRANSITION_LABELS, type Edge, type Summary } from '../shared/domain.ts';
import type { AutoTransition, GraphDto, ProjectDto, TaskDto, TaskInput } from '../shared/types.ts';
import { ApiFailure, api } from './api.ts';
import { DeleteTaskDialog, MoveTaskDialog, NewProjectDialog } from './dialogs.tsx';
import { GraphCanvas } from './GraphCanvas.tsx';
import { AlertIcon, CloseIcon, InfoIcon, LayoutIcon, PlusIcon, RefreshIcon, StatusChip } from './icons.tsx';
import { LevelBar } from './LevelBar.tsx';
import { SidePanel } from './SidePanel.tsx';

export type Selection = { kind: 'task'; id: string } | { kind: 'edge'; from: string; to: string } | null;

interface Notice {
  /** error: 저장하지 못함, info: 저장했고 알려 둘 것(상위 자동 변경 등) */
  tone: 'error' | 'info';
  heading: string;
  detail: string;
  cycle?: string[];
}

type Dialog =
  | { kind: 'new-project' }
  | { kind: 'delete-task'; task: TaskDto }
  | { kind: 'move-task'; task: TaskDto }
  | null;

function transitionText(transitions: AutoTransition[]): string {
  return transitions.map((item) => `${item.title} → ${STATUS_LABELS[item.status]} (${TRANSITION_LABELS[item.cause]})`).join(', ');
}

export function App() {
  const [projects, setProjects] = useState<ProjectDto[] | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [graph, setGraph] = useState<GraphDto | null>(null);
  /** 보고 있는 층의 상위 공정. null이면 최상위 층(F-H07: 한 번에 한 층) */
  const [levelId, setLevelId] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [layoutRequest, setLayoutRequest] = useState(0);
  const currentProject = useRef<string | null>(null);
  // 주소의 층(?level=)은 처음 연 프로젝트에만 쓴다.
  const initialLevel = useRef(new URLSearchParams(location.search).get('level'));

  useEffect(() => {
    void loadProjects();
  }, []);

  useEffect(() => {
    currentProject.current = projectId;
    setSelection(null);
    setGraph(null);
    if (!projectId) return;
    setLevelId(initialLevel.current);
    initialLevel.current = null;
    void reloadGraph();
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    const query = new URLSearchParams({ project: projectId });
    if (levelId) query.set('level', levelId);
    history.replaceState(null, '', `?${query}`);
  }, [projectId, levelId]);

  // 다른 곳(CLI 등)에서 지워진 공정·연결을 고르고 있었다면 선택을 풀고, 보던 층의 상위 공정이 지워졌으면 최상위로 돌아간다.
  useEffect(() => {
    if (!graph) return;
    if (levelId && !graph.tasks.some((task) => task.id === levelId)) setLevelId(null);
    if (!selection) return;
    const exists =
      selection.kind === 'task'
        ? graph.tasks.some((task) => task.id === selection.id)
        : graph.dependencies.some((edge) => edge.from === selection.from && edge.to === selection.to);
    if (!exists) setSelection(null);
  }, [graph, levelId, selection]);

  async function loadProjects(prefer?: string) {
    try {
      const list = await api.listProjects();
      setProjects(list);
      setProjectId((current) => {
        const wanted = prefer ?? current ?? new URLSearchParams(location.search).get('project');
        return list.find((item) => item.id === wanted)?.id ?? list[0]?.id ?? null;
      });
    } catch (error) {
      showError('프로젝트 목록을 불러오지 못했습니다', error);
    }
  }

  async function reloadGraph() {
    const id = currentProject.current;
    if (!id) return;
    try {
      const next = await api.getGraph(id);
      if (currentProject.current === id) setGraph(next);
    } catch (error) {
      showError('그래프를 불러오지 못했습니다', error);
    }
  }

  function showError(heading: string, error: unknown) {
    if (error instanceof ApiFailure) {
      const { code, detail, cycle } = error.problem;
      setNotice({ tone: 'error', heading: code === 'NETWORK' ? '서버에 연결하지 못했습니다' : heading, detail, cycle });
    } else {
      setNotice({ tone: 'error', heading, detail: error instanceof Error ? error.message : String(error) });
    }
  }

  /** 하위 공정 때문에 상위 공정이 자동으로 바뀌었으면 알린다(PRD §6.9). */
  function reportTransitions(transitions: AutoTransition[]) {
    if (transitions.length === 0) return;
    setNotice({ tone: 'info', heading: '상위 공정 상태가 자동으로 바뀌었습니다', detail: transitionText(transitions) });
  }

  /** 서버에 변경을 보내고 그래프를 다시 읽는다. 판정은 서버가 하고, 화면은 서버 결과만 그린다. */
  async function mutate<T>(heading: string, action: () => Promise<T>): Promise<T | null> {
    try {
      const result = await action();
      setNotice(null);
      return result;
    } catch (error) {
      showError(heading, error);
      return null;
    } finally {
      await reloadGraph();
    }
  }

  /** 다른 층으로 간다. selected는 그 층에서 골라 둘 공정이다. */
  const openLevel = useCallback((id: string | null, selected: string | null = null) => {
    setLevelId(id);
    setSelection(selected ? { kind: 'task', id: selected } : null);
  }, []);

  /** 공정이 있는 층으로 가서 그 공정을 고른다(패널의 공정 목록, 남은 공정 등). */
  function focusTask(taskId: string) {
    const task = graph?.tasks.find((item) => item.id === taskId);
    if (!task) return;
    setLevelId(task.parentId);
    setSelection({ kind: 'task', id: taskId });
  }

  /** 공정 안으로 들어가 그 공정을 패널에 둔 채 하위 공정 입력란에 커서를 둔다. */
  function addChild(taskId: string) {
    openLevel(taskId, taskId);
    requestAnimationFrame(() => document.getElementById('new-task')?.focus());
  }

  async function addTask(title: string): Promise<boolean> {
    const result = await mutate('공정을 추가하지 못했습니다', () => api.createTask(projectId!, { title, parentId: levelId }));
    if (!result) return false;
    setSelection({ kind: 'task', id: result.task.id });
    reportTransitions(result.autoTransitions);
    return true;
  }

  async function updateTask(taskId: string, input: TaskInput) {
    const result = await mutate('저장하지 않았습니다', () => api.updateTask(taskId, input));
    if (result) reportTransitions(result.autoTransitions);
  }

  async function moveTask(task: TaskDto, parentId: string | null, removeDependencies: Edge[]) {
    setDialog(null);
    const result = await mutate('공정을 옮기지 못했습니다', () => api.moveTask(task.id, { parentId, removeDependencies }));
    if (!result) return;
    // 지금 층에 남아 여러 공정을 이어서 옮길 수 있게 한다. 옮긴 공정은 패널에 그대로 둔다.
    const place = parentId ? `‘${graph?.tasks.find((item) => item.id === parentId)?.title}’ 아래` : '최상위';
    const parts = [`‘${task.title}’ → ${place}`];
    if (result.removedDependencies.length > 0) parts.push(`지운 연결 ${result.removedDependencies.length}개`);
    if (result.autoTransitions.length > 0) parts.push(`자동 변경: ${transitionText(result.autoTransitions)}`);
    setNotice({ tone: 'info', heading: '공정을 옮겼습니다', detail: parts.join(' · ') });
  }

  async function deleteTask(task: TaskDto) {
    setDialog(null);
    const result = await mutate('공정을 삭제하지 못했습니다', () => api.deleteTask(task.id));
    if (!result) return;
    setSelection(null);
    reportTransitions(result.autoTransitions);
  }

  function addDependency(from: string, to: string) {
    void mutate('연결을 저장하지 않았습니다', () => api.addDependency(projectId!, from, to));
  }

  async function removeDependency(edge: Edge) {
    if (await mutate('연결을 지우지 못했습니다', () => api.removeDependency(projectId!, edge.from, edge.to))) {
      setSelection(null);
    }
  }

  async function createProject(name: string) {
    setDialog(null);
    try {
      const created = await api.createProject(name);
      setNotice(null);
      await loadProjects(created.id);
    } catch (error) {
      showError('프로젝트를 만들지 못했습니다', error);
    }
  }

  async function refresh() {
    await loadProjects();
    await reloadGraph();
  }

  const levelTask = levelId ? graph?.tasks.find((task) => task.id === levelId) : undefined;
  const levelTaskCount = graph ? graph.tasks.filter((task) => task.parentId === (levelTask ? levelTask.id : null)).length : 0;

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">Tevro</span>
        {projects && projects.length > 0 && (
          <div className="project-picker">
            <label className="field-label" htmlFor="project-select">
              프로젝트
            </label>
            <select
              id="project-select"
              className="select"
              value={projectId ?? ''}
              onChange={(event) => setProjectId(event.target.value)}
            >
              {projects.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <button type="button" className="button" onClick={() => setDialog({ kind: 'new-project' })}>
              <PlusIcon />새 프로젝트
            </button>
          </div>
        )}
        <div className="topbar__end">
          {graph && <SummaryChips summary={graph.summary} />}
          <button type="button" className="button" title="다른 사람이나 CLI가 바꾼 내용을 불러옵니다" onClick={refresh}>
            <RefreshIcon />
            새로고침
          </button>
        </div>
      </header>

      {projects === null ? (
        <div className="center-message">
          {notice ? (
            <div className="message-card">
              <h1>{notice.heading}</h1>
              <p className="panel-note">{notice.detail}</p>
              <button
                type="button"
                className="button primary"
                onClick={() => {
                  setNotice(null);
                  void loadProjects();
                }}
              >
                다시 시도
              </button>
            </div>
          ) : (
            <p className="panel-note">불러오는 중…</p>
          )}
        </div>
      ) : projects.length === 0 ? (
        <FirstProject notice={notice} onCreate={createProject} />
      ) : graph ? (
        <div className="workspace">
          <main className="canvas-column">
            <Toolbar
              levelTitle={levelTask?.title ?? null}
              onAdd={addTask}
              onArrange={() => setLayoutRequest((count) => count + 1)}
            />
            {levelTask && (
              <LevelBar
                graph={graph}
                levelId={levelTask.id}
                onOpenLevel={openLevel}
                onShowTask={(id) => setSelection({ kind: 'task', id })}
                onFocusTask={focusTask}
              />
            )}
            <div className="canvas">
              <ReactFlowProvider>
                <GraphCanvas
                  graph={graph}
                  levelId={levelTask ? levelTask.id : null}
                  selection={selection}
                  cycle={notice?.cycle}
                  layoutRequest={layoutRequest}
                  onSelect={setSelection}
                  onOpen={openLevel}
                  onConnect={addDependency}
                  onDeleteEdge={removeDependency}
                />
              </ReactFlowProvider>
              {levelTaskCount === 0 && (
                <p className="canvas-empty">
                  {levelTask
                    ? `‘${levelTask.title}’ 안에 하위 공정이 없습니다. 위 입력란에 제목을 쓰고 Enter를 누르세요.`
                    : '아직 공정이 없습니다. 위 입력란에 첫 공정의 제목을 쓰고 Enter를 누르세요.'}
                </p>
              )}
              {notice && <NoticeBanner notice={notice} onClose={() => setNotice(null)} />}
            </div>
          </main>
          <SidePanel
            graph={graph}
            selection={selection}
            levelId={levelTask ? levelTask.id : null}
            onFocusTask={focusTask}
            onOpenLevel={openLevel}
            onAddChild={addChild}
            onUpdateTask={(taskId, input) => void updateTask(taskId, input)}
            onMoveTask={(task) => setDialog({ kind: 'move-task', task })}
            onDeleteTask={(task) => setDialog({ kind: 'delete-task', task })}
            onDeleteEdge={removeDependency}
          />
        </div>
      ) : (
        <div className="center-message">
          {notice ? <NoticeBanner notice={notice} onClose={() => setNotice(null)} /> : <p className="panel-note">불러오는 중…</p>}
        </div>
      )}

      {dialog?.kind === 'new-project' && <NewProjectDialog onCancel={() => setDialog(null)} onCreate={createProject} />}
      {dialog?.kind === 'delete-task' && graph && (
        <DeleteTaskDialog
          task={dialog.task}
          graph={graph}
          onCancel={() => setDialog(null)}
          onConfirm={() => void deleteTask(dialog.task)}
        />
      )}
      {dialog?.kind === 'move-task' && graph && (
        <MoveTaskDialog
          task={dialog.task}
          graph={graph}
          onCancel={() => setDialog(null)}
          onConfirm={(parentId, removeDependencies) => void moveTask(dialog.task, parentId, removeDependencies)}
        />
      )}
    </div>
  );
}

function SummaryChips({ summary }: { summary: Summary }) {
  return (
    <div className="summary" title="말단 공정(하위 공정이 없는 공정) 기준">
      <span>
        전체 <b>{summary.total}</b>
      </span>
      <StatusChip status="todo">미착수 {summary.todo}</StatusChip>
      <StatusChip status="in-progress">진행 중 {summary.inProgress}</StatusChip>
      <StatusChip status="done">완료 {summary.done}</StatusChip>
    </div>
  );
}

interface ToolbarProps {
  /** 하위 층에 있으면 그 상위 공정의 제목. 새 공정은 그 아래에 들어간다 */
  levelTitle: string | null;
  onAdd: (title: string) => Promise<boolean>;
  onArrange: () => void;
}

function Toolbar({ levelTitle, onAdd, onArrange }: ToolbarProps) {
  const [title, setTitle] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = title.trim();
    if (trimmed && (await onAdd(trimmed))) setTitle('');
  };
  return (
    <div className="toolbar">
      <form className="add-task" onSubmit={submit}>
        <label className="field-label" htmlFor="new-task">
          {levelTitle ? '새 하위 공정' : '새 공정'}
        </label>
        <input
          id="new-task"
          className="input"
          value={title}
          maxLength={200}
          placeholder={levelTitle ? `${levelTitle} 아래에 추가` : '제목 입력 후 Enter'}
          onChange={(event) => setTitle(event.target.value)}
        />
        <button type="submit" className="button primary" disabled={!title.trim()}>
          추가
        </button>
      </form>
      <button type="button" className="button" onClick={onArrange}>
        <LayoutIcon />
        자동 정렬
      </button>
      <span className="toolbar__hint">카드 오른쪽 끝을 끌어 다른 카드에 놓으면 연결 · 연결선을 고르고 Delete로 삭제</span>
    </div>
  );
}

function NoticeBanner({ notice, onClose }: { notice: Notice; onClose: () => void }) {
  return (
    <div className={`notice is-${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
      {notice.tone === 'error' ? <AlertIcon /> : <InfoIcon />}
      <div className="notice__text">
        <strong>{notice.heading}</strong>
        <span>{notice.detail}</span>
      </div>
      <button type="button" className="icon-button" aria-label="알림 닫기" onClick={onClose}>
        <CloseIcon />
      </button>
    </div>
  );
}

function FirstProject({ notice, onCreate }: { notice: Notice | null; onCreate: (name: string) => void }) {
  const [name, setName] = useState('');
  return (
    <div className="center-message">
      <form
        className="message-card"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) onCreate(name.trim());
        }}
      >
        <h1>첫 프로젝트를 만드세요</h1>
        {notice && <p className="panel-note is-error">{notice.detail}</p>}
        <label className="field-label" htmlFor="first-project-name">
          프로젝트 이름
        </label>
        <input
          id="first-project-name"
          className="input"
          value={name}
          maxLength={100}
          placeholder="예: 신규 서비스 준비"
          autoFocus
          onChange={(event) => setName(event.target.value)}
        />
        <button type="submit" className="button primary" disabled={!name.trim()}>
          프로젝트 만들기
        </button>
        <p className="panel-note is-small">
          예시 프로젝트를 CLI로 만들려면 서버를 켠 채로 다른 터미널에서 <code>npm run demo</code>
        </p>
      </form>
    </div>
  );
}
