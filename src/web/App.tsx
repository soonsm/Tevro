import { ReactFlowProvider } from '@xyflow/react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { STATUS_LABELS, TRANSITION_LABELS, type Edge, type Summary } from '../shared/domain.ts';
import type { AutoTransition, GraphDto, ProjectDto, TaskDto, TaskInput, TemplateSummaryDto, TrialStatus, UserDto } from '../shared/types.ts';
import { AccountMenu, LoginScreen } from './account.tsx';
import { ApiFailure, api, whenSessionEnds } from './api.ts';
import { DeleteTaskDialog, MoveTaskDialog, SwitchDatasetDialog } from './dialogs.tsx';
import { GraphCanvas } from './GraphCanvas.tsx';
import { AlertIcon, CloseIcon, InfoIcon, LayoutIcon, PlusIcon, RefreshIcon, StatusChip } from './icons.tsx';
import { LevelBar } from './LevelBar.tsx';
import { SidePanel } from './SidePanel.tsx';
import { DeleteTemplateDialog, NewProjectDialog, SaveTemplateDialog, TemplateBar, TemplatesDialog, groupTemplates } from './templates.tsx';
import { TrialBanner } from './TrialBanner.tsx';

export type Selection = { kind: 'task'; id: string } | { kind: 'edge'; from: string; to: string } | null;

interface Notice {
  /** error: 저장하지 못함, info: 저장했고 알려 둘 것(상위 자동 변경 등) */
  tone: 'error' | 'info';
  heading: string;
  detail: string;
  cycle?: string[];
}

type Dialog =
  | { kind: 'new-project'; templateId?: string }
  | { kind: 'templates' }
  /** 새 템플릿(sourceId 없음), 프로젝트를 템플릿으로 저장, 템플릿을 내 템플릿으로 복사 */
  | { kind: 'save-template'; sourceId?: string; sourceName?: string; copy?: boolean }
  | { kind: 'template-info'; template: TemplateSummaryDto }
  | { kind: 'delete-template'; template: TemplateSummaryDto }
  | { kind: 'delete-task'; task: TaskDto }
  | { kind: 'move-task'; task: TaskDto }
  | { kind: 'switch-dataset'; dataset: string; label: string }
  | null;

function transitionText(transitions: AutoTransition[]): string {
  return transitions.map((item) => `${item.title} → ${STATUS_LABELS[item.status]} (${TRANSITION_LABELS[item.cause]})`).join(', ');
}

type Gate =
  | { kind: 'loading' }
  | { kind: 'trial' }
  | { kind: 'login' }
  | { kind: 'signed-in'; user: UserDto }
  | { kind: 'error'; detail: string };

/** 로그인 여부를 보고 로그인 화면이나 작업 화면을 띄운다. 체험 서버는 로그인 없이 바로 작업 화면이다. */
export function App() {
  const [gate, setGate] = useState<Gate>({ kind: 'loading' });

  useEffect(() => {
    whenSessionEnds(() => setGate({ kind: 'login' }));
    void start();
    return () => whenSessionEnds(null);
  }, []);

  async function start() {
    setGate({ kind: 'loading' });
    try {
      if (await api.trialStatus()) {
        setGate({ kind: 'trial' });
        return;
      }
      setGate({ kind: 'signed-in', user: (await api.me()).user });
    } catch (error) {
      if (error instanceof ApiFailure && error.problem.code === 'UNAUTHENTICATED') setGate({ kind: 'login' });
      else setGate({ kind: 'error', detail: error instanceof ApiFailure ? error.problem.detail : String(error) });
    }
  }

  async function logout() {
    try {
      await api.logout();
    } finally {
      setGate({ kind: 'login' });
    }
  }

  switch (gate.kind) {
    case 'trial':
      return <Workspace user={null} />;
    case 'signed-in':
      return <Workspace key={gate.user.id} user={gate.user} onLogout={() => void logout()} />;
    case 'login':
      return <LoginScreen onLogin={(user) => setGate({ kind: 'signed-in', user })} />;
    default:
      return (
        <div className="app">
          <header className="topbar">
            <span className="brand">Tevro</span>
          </header>
          <div className="center-message">
            {gate.kind === 'error' ? (
              <div className="message-card">
                <h1>서버에 연결하지 못했습니다</h1>
                <p className="panel-note">{gate.detail}</p>
                <button type="button" className="button primary" onClick={() => void start()}>
                  다시 시도
                </button>
              </div>
            ) : (
              <p className="panel-note">불러오는 중…</p>
            )}
          </div>
        </div>
      );
  }
}

/** 프로젝트 그래프를 보고 고치는 화면. user가 null이면 체험 모드(로그인 없음), 열람자면 보기만 한다. */
function Workspace({ user, onLogout }: { user: UserDto | null; onLogout?: () => void }) {
  const readOnly = user?.role === 'viewer';
  const [projects, setProjects] = useState<ProjectDto[] | null>(null);
  const [templates, setTemplates] = useState<TemplateSummaryDto[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [graph, setGraph] = useState<GraphDto | null>(null);
  /** 보고 있는 층의 상위 공정. null이면 최상위 층(F-H07: 한 번에 한 층) */
  const [levelId, setLevelId] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [layoutRequest, setLayoutRequest] = useState(0);
  /** 체험 서버일 때만 있다 */
  const [trial, setTrial] = useState<TrialStatus | null>(null);
  const currentProject = useRef<string | null>(null);
  // 주소의 층(?level=)은 처음 연 프로젝트에만 쓴다.
  const initialLevel = useRef(new URLSearchParams(location.search).get('level'));

  useEffect(() => {
    // 체험 서버가 아니면 null이라 안내 띠를 그리지 않는다.
    api.trialStatus().then(setTrial, () => setTrial(null));
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
      const [list, templateList] = await Promise.all([api.listProjects(), api.listTemplates()]);
      setProjects(list);
      setTemplates(templateList);
      // 주소의 ?project=에는 템플릿 ID도 올 수 있다.
      setProjectId((current) => {
        const wanted = prefer ?? current ?? new URLSearchParams(location.search).get('project');
        return (
          list.find((item) => item.id === wanted)?.id ?? templateList.find((item) => item.id === wanted)?.id ?? list[0]?.id ?? null
        );
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

  /** 템플릿 작업을 하고 목록을 다시 읽은 뒤 open이 있으면 그 프로젝트·템플릿으로 간다. */
  async function templateAction(heading: string, action: () => Promise<ProjectDto | void>, done?: string) {
    setDialog(null);
    try {
      const result = await action();
      setNotice(done ? { tone: 'info', heading: done, detail: result ? `‘${result.name}’` : '' } : null);
      await loadProjects(result ? result.id : undefined);
      if (result && result.id === currentProject.current) await reloadGraph();
    } catch (error) {
      showError(heading, error);
    }
  }

  function createFromTemplate(templateId: string, name: string) {
    void templateAction('템플릿으로 프로젝트를 만들지 못했습니다', () => api.instantiate(templateId, name));
  }

  async function deleteTemplate(template: TemplateSummaryDto) {
    setDialog(null);
    try {
      await api.deleteTemplate(template.id);
      setNotice({ tone: 'info', heading: '템플릿을 삭제했습니다', detail: `‘${template.name}’. 이 템플릿으로 만든 프로젝트는 그대로입니다.` });
      const leaving = currentProject.current === template.id;
      if (leaving) setProjectId(null);
      await loadProjects(leaving ? (projects?.[0]?.id ?? undefined) : undefined);
    } catch (error) {
      showError('템플릿을 삭제하지 못했습니다', error);
    }
  }

  /** 체험 모드: 고른 예시 데이터를 처음 상태로 불러온다. 이 창에서 바꾼 내용이 있으면 먼저 확인한다. */
  async function chooseDataset(dataset: string) {
    const label = trial?.datasets.find((item) => item.key === dataset)?.label ?? dataset;
    try {
      const status = await api.trialStatus();
      setTrial(status);
      if (status?.dirty) {
        setDialog({ kind: 'switch-dataset', dataset, label });
        return;
      }
    } catch (error) {
      showError('예시 데이터를 불러오지 못했습니다', error);
      return;
    }
    await switchDataset(dataset);
  }

  async function switchDataset(dataset: string) {
    setDialog(null);
    try {
      const status = await api.resetTrial(dataset);
      const [list, templateList] = await Promise.all([api.listProjects(), api.listTemplates()]);
      setTrial(status);
      setProjects(list);
      setTemplates(templateList);
      setNotice(null);
      setSelection(null);
      setLevelId(null);
      setLayoutRequest((count) => count + 1);
      // 같은 예시를 다시 불러오면 프로젝트 ID가 그대로라 보던 프로젝트에 남는다.
      const target = list.find((item) => item.id === currentProject.current)?.id ?? list[0]?.id ?? null;
      if (target === currentProject.current) await reloadGraph();
      else setProjectId(target);
    } catch (error) {
      showError('예시 데이터를 불러오지 못했습니다', error);
    }
  }

  async function refresh() {
    await loadProjects();
    await reloadGraph();
  }

  const levelTask = levelId ? graph?.tasks.find((task) => task.id === levelId) : undefined;
  // 템플릿을 보고 있으면 그 템플릿 정보. 고칠 수 없는 템플릿(다른 사람 것, 관리자가 아닐 때 회사 템플릿)은 보기 전용이다.
  const currentTemplate = graph?.project.kind === 'template' ? templates.find((item) => item.id === graph.project.id) : undefined;
  const graphReadOnly = graph?.project.kind === 'template' ? !currentTemplate?.canEdit : readOnly;
  const readOnlyReason =
    graph?.project.kind !== 'template'
      ? '열람자 계정이라 보기만 할 수 있습니다.'
      : currentTemplate?.template.official
        ? '회사 템플릿은 관리자만 고칩니다. 고쳐 쓰려면 위 띠의 [내 템플릿으로 복사]를 누르세요.'
        : '다른 사람의 템플릿이라 보기만 할 수 있습니다.';
  const grouped = groupTemplates(templates, user);

  // 하위 층에서 Esc를 누르면 위 층으로 돌아간다(입력 중이거나 대화상자가 열려 있을 때는 제외).
  const levelParent = levelTask ? levelTask.parentId : undefined;
  const levelOwner = levelTask?.id;
  useEffect(() => {
    if (!levelOwner || dialog) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if ((event.target as HTMLElement | null)?.closest('input, textarea, select, dialog')) return;
      openLevel(levelParent ?? null, levelOwner);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [levelOwner, levelParent, dialog, openLevel]);
  const levelTaskCount = graph ? graph.tasks.filter((task) => task.parentId === (levelTask ? levelTask.id : null)).length : 0;

  return (
    <div className="app">
      {trial && <TrialBanner trial={trial} onChoose={(dataset) => void chooseDataset(dataset)} />}
      <header className="topbar">
        <span className="brand">Tevro</span>
        {projects && projects.length + templates.length > 0 && (
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
              {!projectId && <option value="">프로젝트를 고르세요</option>}
              <optgroup label="프로젝트">
                {projects.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                    {item.source ? ` · ${item.source.name} ${item.source.version}판` : ''}
                  </option>
                ))}
              </optgroup>
              {[
                { label: '회사 템플릿', items: grouped.company },
                { label: '내 템플릿', items: grouped.mine },
                { label: '다른 사람의 템플릿', items: grouped.others },
              ]
                .filter((group) => group.items.length > 0)
                .map((group) => (
                  <optgroup key={group.label} label={group.label}>
                    {group.items.map((item) => (
                      <option key={item.id} value={item.id}>
                        [템플릿] {item.name} · {item.template.version}판
                      </option>
                    ))}
                  </optgroup>
                ))}
            </select>
            {!readOnly && (
              <button type="button" className="button" onClick={() => setDialog({ kind: 'new-project' })}>
                <PlusIcon />새 프로젝트
              </button>
            )}
            <button type="button" className="button" onClick={() => setDialog({ kind: 'templates' })}>
              템플릿
            </button>
          </div>
        )}
        <div className="topbar__end">
          {graph &&
            (graph.project.kind === 'template' ? (
              <div className="summary">
                <span>
                  공정 <b>{graph.tasks.length}</b>
                </span>
                <span>
                  연결 <b>{graph.dependencies.length}</b>
                </span>
              </div>
            ) : (
              <SummaryChips summary={graph.summary} />
            ))}
          <button type="button" className="button" title="다른 사람이나 CLI가 바꾼 내용을 불러옵니다" onClick={refresh}>
            <RefreshIcon />
            새로고침
          </button>
          {user && onLogout && <AccountMenu user={user} onLogout={onLogout} />}
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
      ) : projects.length === 0 && !projectId ? (
        readOnly ? (
          <div className="center-message">
            <div className="message-card">
              <h1>아직 프로젝트가 없습니다</h1>
              <p className="panel-note">열람자는 프로젝트를 만들 수 없습니다. 편집자에게 요청하거나 관리자에게 역할 변경을 요청하세요.</p>
            </div>
          </div>
        ) : (
          <FirstProject
            notice={notice}
            onCreate={createProject}
            onFromTemplate={templates.length > 0 ? () => setDialog({ kind: 'new-project' }) : undefined}
          />
        )
      ) : graph ? (
        <>
        {currentTemplate && (
          <TemplateBar
            template={currentTemplate}
            user={user}
            onNewProject={() => setDialog({ kind: 'new-project', templateId: currentTemplate.id })}
            onCopy={() => setDialog({ kind: 'save-template', sourceId: currentTemplate.id, sourceName: currentTemplate.name, copy: true })}
            onEditInfo={() => setDialog({ kind: 'template-info', template: currentTemplate })}
            onToggleOfficial={() =>
              void templateAction(
                '회사 템플릿 지정을 바꾸지 못했습니다',
                () => api.updateTemplate(currentTemplate.id, { official: !currentTemplate.template.official }),
                currentTemplate.template.official ? '회사 템플릿에서 해제했습니다' : '회사 템플릿으로 지정했습니다',
              )
            }
            onDelete={() => setDialog({ kind: 'delete-template', template: currentTemplate })}
          />
        )}
        <div className="workspace">
          <main className="canvas-column">
            <Toolbar
              readOnly={graphReadOnly}
              readOnlyReason={readOnlyReason}
              levelTitle={levelTask?.title ?? null}
              onAdd={addTask}
              onArrange={() => setLayoutRequest((count) => count + 1)}
            />
            <div className={`canvas${levelTask ? ' has-levelbar' : ''}`}>
              {levelTask && (
                <LevelBar
                  graph={graph}
                  levelId={levelTask.id}
                  onOpenLevel={openLevel}
                  onShowTask={(id) => setSelection({ kind: 'task', id })}
                  onFocusTask={focusTask}
                />
              )}
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
                  readOnly={graphReadOnly}
                />
              </ReactFlowProvider>
              {levelTaskCount === 0 && (
                <p className="canvas-empty">
                  {graphReadOnly
                    ? '이 층에는 공정이 없습니다.'
                    : levelTask
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
            readOnly={graphReadOnly}
          />
        </div>
        </>
      ) : (
        <div className="center-message">
          {notice ? <NoticeBanner notice={notice} onClose={() => setNotice(null)} /> : <p className="panel-note">불러오는 중…</p>}
        </div>
      )}

      {dialog?.kind === 'new-project' && (
        <NewProjectDialog
          templates={templates}
          user={user}
          initialTemplateId={dialog.templateId}
          onCancel={() => setDialog(null)}
          onCreateBlank={(name) => void createProject(name)}
          onCreateFromTemplate={createFromTemplate}
        />
      )}
      {dialog?.kind === 'templates' && (
        <TemplatesDialog
          templates={templates}
          user={user}
          currentProject={graph?.project.kind === 'project' ? graph.project : null}
          onClose={() => setDialog(null)}
          onOpen={(id) => {
            setDialog(null);
            setProjectId(id);
          }}
          onNew={() => setDialog({ kind: 'save-template' })}
          onSaveProject={() => graph && setDialog({ kind: 'save-template', sourceId: graph.project.id, sourceName: graph.project.name })}
          onCopy={(item) => setDialog({ kind: 'save-template', sourceId: item.id, sourceName: item.name, copy: true })}
          onDelete={(item) => setDialog({ kind: 'delete-template', template: item })}
        />
      )}
      {dialog?.kind === 'save-template' && (
        <SaveTemplateDialog
          heading={dialog.copy ? '내 템플릿으로 복사' : dialog.sourceId ? '템플릿으로 저장' : '새 템플릿'}
          submitLabel={dialog.copy ? '복사' : dialog.sourceId ? '저장' : '만들기'}
          initialName={dialog.copy ? `${dialog.sourceName} (내 수정본)` : (dialog.sourceName ?? '')}
          note={
            dialog.copy
              ? '공정·연결·하위 구조를 내 템플릿으로 복사합니다. 복사본을 고쳐도 원래 템플릿은 바뀌지 않습니다.'
              : dialog.sourceId
                ? '공정·연결·하위 구조와 Confluence 링크를 저장합니다. 진행 상태와 Jira 링크는 저장하지 않습니다.'
                : '빈 템플릿을 만들고 프로젝트처럼 공정을 추가합니다.'
          }
          canMakeOfficial={user?.role === 'admin'}
          onCancel={() => setDialog(null)}
          onSave={(input) =>
            void templateAction(
              '템플릿을 저장하지 못했습니다',
              () => (dialog.sourceId ? api.saveAsTemplate(dialog.sourceId, input) : api.createTemplate(input)),
              dialog.copy ? '내 템플릿으로 복사했습니다' : '템플릿을 만들었습니다',
            )
          }
        />
      )}
      {dialog?.kind === 'template-info' && (
        <SaveTemplateDialog
          heading="템플릿 이름·설명"
          submitLabel="저장"
          initialName={dialog.template.name}
          initialDescription={dialog.template.description}
          canMakeOfficial={false}
          onCancel={() => setDialog(null)}
          onSave={({ name, description }) =>
            void templateAction('템플릿을 고치지 못했습니다', () => api.updateTemplate(dialog.template.id, { name, description }))
          }
        />
      )}
      {dialog?.kind === 'delete-template' && (
        <DeleteTemplateDialog template={dialog.template} onCancel={() => setDialog(null)} onConfirm={() => void deleteTemplate(dialog.template)} />
      )}
      {dialog?.kind === 'switch-dataset' && (
        <SwitchDatasetDialog
          label={dialog.label}
          onCancel={() => setDialog(null)}
          onConfirm={() => void switchDataset(dialog.dataset)}
        />
      )}
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
  /** 보기 전용(열람자, 고칠 수 없는 템플릿): 공정 추가 입력란 대신 그 까닭을 알린다 */
  readOnly: boolean;
  readOnlyReason: string;
  /** 하위 층에 있으면 그 상위 공정의 제목. 새 공정은 그 아래에 들어간다 */
  levelTitle: string | null;
  onAdd: (title: string) => Promise<boolean>;
  onArrange: () => void;
}

function Toolbar({ readOnly, readOnlyReason, levelTitle, onAdd, onArrange }: ToolbarProps) {
  const [title, setTitle] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = title.trim();
    if (trimmed && (await onAdd(trimmed))) setTitle('');
  };
  if (readOnly) {
    return (
      <div className="toolbar">
        <button type="button" className="button" onClick={onArrange}>
          <LayoutIcon />
          자동 정렬
        </button>
        <span className="toolbar__hint">{readOnlyReason}</span>
      </div>
    );
  }
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

function FirstProject({ notice, onCreate, onFromTemplate }: { notice: Notice | null; onCreate: (name: string) => void; onFromTemplate?: () => void }) {
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
        {onFromTemplate && (
          <button type="button" className="button" onClick={onFromTemplate}>
            템플릿에서 시작
          </button>
        )}
        <p className="panel-note is-small">
          예시 프로젝트를 CLI로 만들려면 서버를 켠 채로 다른 터미널에서 <code>npm run demo</code>
        </p>
      </form>
    </div>
  );
}
