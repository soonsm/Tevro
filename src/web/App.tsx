import { ReactFlowProvider } from '@xyflow/react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Edge, Summary } from '../shared/domain.ts';
import type { GraphDto, ProjectDto, TaskDto, TaskInput } from '../shared/types.ts';
import { ApiFailure, api } from './api.ts';
import { DeleteTaskDialog, NewProjectDialog } from './dialogs.tsx';
import { GraphCanvas } from './GraphCanvas.tsx';
import { AlertIcon, CloseIcon, LayoutIcon, PlusIcon, RefreshIcon, StatusChip } from './icons.tsx';
import { SidePanel } from './SidePanel.tsx';

export type Selection = { kind: 'task'; id: string } | { kind: 'edge'; from: string; to: string } | null;

interface Notice {
  heading: string;
  detail: string;
  cycle?: string[];
}

type Dialog = { kind: 'new-project' } | { kind: 'delete-task'; task: TaskDto } | null;

export function App() {
  const [projects, setProjects] = useState<ProjectDto[] | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [graph, setGraph] = useState<GraphDto | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [layoutRequest, setLayoutRequest] = useState(0);
  const currentProject = useRef<string | null>(null);

  useEffect(() => {
    void loadProjects();
  }, []);

  useEffect(() => {
    currentProject.current = projectId;
    setSelection(null);
    setGraph(null);
    if (!projectId) return;
    history.replaceState(null, '', `?project=${encodeURIComponent(projectId)}`);
    void reloadGraph();
  }, [projectId]);

  // 다른 곳(CLI 등)에서 지워진 공정·연결을 고르고 있었다면 선택을 푼다.
  useEffect(() => {
    if (!graph || !selection) return;
    const exists =
      selection.kind === 'task'
        ? graph.tasks.some((task) => task.id === selection.id)
        : graph.dependencies.some((edge) => edge.from === selection.from && edge.to === selection.to);
    if (!exists) setSelection(null);
  }, [graph, selection]);

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
      setNotice({ heading: code === 'NETWORK' ? '서버에 연결하지 못했습니다' : heading, detail, cycle });
    } else {
      setNotice({ heading, detail: error instanceof Error ? error.message : String(error) });
    }
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

  async function addTask(title: string): Promise<boolean> {
    const created = await mutate('공정을 추가하지 못했습니다', () => api.createTask(projectId!, { title }));
    if (created) setSelection({ kind: 'task', id: created.id });
    return created !== null;
  }

  function updateTask(taskId: string, input: TaskInput) {
    void mutate('저장하지 않았습니다', () => api.updateTask(taskId, input));
  }

  async function deleteTask(task: TaskDto) {
    setDialog(null);
    if (await mutate('공정을 삭제하지 못했습니다', () => api.deleteTask(task.id))) setSelection(null);
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
            <Toolbar onAdd={addTask} onArrange={() => setLayoutRequest((count) => count + 1)} />
            <div className="canvas">
              <ReactFlowProvider>
                <GraphCanvas
                  graph={graph}
                  selection={selection}
                  cycle={notice?.cycle}
                  layoutRequest={layoutRequest}
                  onSelect={setSelection}
                  onConnect={addDependency}
                  onDeleteEdge={removeDependency}
                />
              </ReactFlowProvider>
              {graph.tasks.length === 0 && (
                <p className="canvas-empty">아직 공정이 없습니다. 위 입력란에 첫 공정의 제목을 쓰고 Enter를 누르세요.</p>
              )}
              {notice && <NoticeBanner notice={notice} onClose={() => setNotice(null)} />}
            </div>
          </main>
          <SidePanel
            graph={graph}
            selection={selection}
            onSelect={setSelection}
            onUpdateTask={updateTask}
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
    </div>
  );
}

function SummaryChips({ summary }: { summary: Summary }) {
  return (
    <div className="summary">
      <span>
        전체 <b>{summary.total}</b>
      </span>
      <StatusChip status="todo">미착수 {summary.todo}</StatusChip>
      <StatusChip status="in-progress">진행 중 {summary.inProgress}</StatusChip>
      <StatusChip status="done">완료 {summary.done}</StatusChip>
    </div>
  );
}

function Toolbar({ onAdd, onArrange }: { onAdd: (title: string) => Promise<boolean>; onArrange: () => void }) {
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
          새 공정
        </label>
        <input
          id="new-task"
          className="input"
          value={title}
          maxLength={200}
          placeholder="제목 입력 후 Enter"
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
    <div className="notice" role="alert">
      <AlertIcon />
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
