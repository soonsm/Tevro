import { useEffect, useId, useState, type FormEvent } from 'react';
import {
  INCONSISTENCY_LABELS,
  STATUS_LABELS,
  TASK_STATUSES,
  ancestorIds,
  hasPrerequisites,
  isOverdue,
  lateChildren,
  localToday,
  treeOrder,
  isHttpUrl,
  type Edge,
  type TaskStatus,
} from '../shared/domain.ts';
import type { GraphDto, PersonDto, TaskDto, TaskInput } from '../shared/types.ts';
import {
  ArrowDownIcon,
  CheckIcon,
  CopyIcon,
  ExternalIcon,
  PencilIcon,
  PlusIcon,
  StatusChip,
  StatusIcon,
  WarnIcon,
} from './icons.tsx';
import { TaskJiraBox } from './jira.tsx';
import type { Selection } from './App.tsx';

interface Props {
  graph: GraphDto;
  selection: Selection;
  /** 보고 있는 층의 상위 공정. null이면 최상위 층 */
  levelId: string | null;
  /** 공정이 있는 층으로 가서 그 공정을 고른다 */
  onFocusTask: (taskId: string) => void;
  /** 공정 안(하위 층)으로 들어간다 */
  onOpenLevel: (taskId: string) => void;
  /** 공정 안으로 들어가 하위 공정 입력란에 커서를 둔다 */
  onAddChild: (taskId: string) => void;
  onUpdateTask: (taskId: string, input: TaskInput) => void;
  onMoveTask: (task: TaskDto) => void;
  onDeleteTask: (task: TaskDto) => void;
  onDeleteEdge: (edge: Edge) => void;
  /** 열람자: 보기만 하고 고치는 버튼·입력은 숨기거나 잠근다 */
  readOnly?: boolean;
  /** 담당자로 고를 수 있는 사람. 체험 모드처럼 계정이 없으면 빈 목록이고 담당자 칸을 숨긴다 */
  people?: PersonDto[];
  /** 로그인한 사람의 ID('내가 맡은 일' 필터). 체험 모드면 null */
  meId?: string | null;
  /** 이 공정으로 Jira 이슈 만들기(프로젝트에 Jira 설정이 있고 고칠 수 있을 때만) */
  onCreateJira?: (taskId: string) => void;
}

export function SidePanel({
  graph,
  selection,
  levelId,
  onFocusTask,
  onOpenLevel,
  onAddChild,
  onUpdateTask,
  onMoveTask,
  onDeleteTask,
  onDeleteEdge,
  readOnly = false,
  people = [],
  meId = null,
  onCreateJira,
}: Props) {
  const byId = new Map(graph.tasks.map((task) => [task.id, task]));
  const template = graph.project.kind === 'template';
  let content = template ? (
    <TemplateOverview graph={graph} onFocusTask={onFocusTask} readOnly={readOnly} />
  ) : (
    <Overview graph={graph} onFocusTask={onFocusTask} meId={meId} />
  );
  if (selection?.kind === 'task' && byId.has(selection.id)) {
    const task = byId.get(selection.id)!;
    content = (
      <TaskDetail
        key={task.id}
        task={task}
        graph={graph}
        byId={byId}
        levelId={levelId}
        onFocusTask={onFocusTask}
        onOpenLevel={onOpenLevel}
        onAddChild={onAddChild}
        onUpdate={onUpdateTask}
        onMove={onMoveTask}
        onDelete={onDeleteTask}
        readOnly={readOnly}
        template={template}
        people={people}
        onCreateJira={onCreateJira}
      />
    );
  } else if (selection?.kind === 'edge' && byId.has(selection.from) && byId.has(selection.to)) {
    content = (
      <EdgeDetail from={byId.get(selection.from)!} to={byId.get(selection.to)!} onFocusTask={onFocusTask} onDelete={onDeleteEdge} readOnly={readOnly} />
    );
  }
  return <aside className="panel">{content}</aside>;
}

/** 최상위부터 taskId 바로 위까지의 제목 경로. 최상위 공정이면 빈 문자열 */
function parentPath(tasks: TaskDto[], byId: Map<string, TaskDto>, taskId: string): string {
  return ancestorIds(tasks, taskId)
    .reverse()
    .map((id) => byId.get(id)?.title)
    .join(' › ');
}

/** 템플릿의 개요: 진행 상태 대신 공정 구조와 출처 규칙을 보여 준다. */
function TemplateOverview({ graph, onFocusTask, readOnly }: { graph: GraphDto; onFocusTask: Props['onFocusTask']; readOnly: boolean }) {
  return (
    <>
      <section className="panel-section">
        <h2 className="panel-heading is-large">템플릿 공정 {graph.tasks.length}</h2>
        {graph.project.description && <p className="panel-note">{graph.project.description}</p>}
        {graph.tasks.length === 0 ? (
          <p className="panel-note">아직 공정이 없습니다.{readOnly ? '' : ' 위 입력란에 제목을 쓰고 Enter를 누르세요.'}</p>
        ) : (
          <ul className="template-tree">
            {treeOrder(graph.tasks).map(({ task, depth }) => (
              <li key={task.id} style={{ paddingLeft: depth * 16 }}>
                <button type="button" className="link-button" onClick={() => onFocusTask(task.id)}>
                  {task.title}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="panel-section help">
        <h2 className="panel-heading">템플릿으로 프로젝트를 만들면</h2>
        <ul>
          <li>공정·연결·하위 구조가 새 ID로 복사됩니다</li>
          <li>진행 상태는 모두 미착수로 시작합니다</li>
          <li>Confluence 링크는 복사하고 Jira 링크는 비웁니다</li>
          <li>템플릿을 나중에 고쳐도 이미 만든 프로젝트는 바뀌지 않습니다</li>
        </ul>
      </section>
    </>
  );
}

function Overview({ graph, onFocusTask, meId }: { graph: GraphDto; onFocusTask: Props['onFocusTask']; meId: string | null }) {
  const byId = new Map(graph.tasks.map((task) => [task.id, task]));
  const [mineOnly, setMineOnly] = useState(false);
  const today = localToday();
  // 상태 요약과 같이 말단 공정 기준으로 본다(F-H09). 상위 공정의 상태는 하위로 드러난다.
  // 같은 상태 안에서는 기한이 이른 것부터(기한 없는 것은 뒤로).
  const remaining = graph.tasks
    .filter((task) => task.childCount === 0 && task.status !== 'done')
    .filter((task) => !mineOnly || task.assigneeId === meId)
    .sort((a, b) => (a.deadline ?? '9999').localeCompare(b.deadline ?? '9999'));
  const overdue = remaining.filter((task) => isOverdue(task, today)).length;
  const groups: { status: TaskStatus; tasks: TaskDto[] }[] = [
    { status: 'in-progress', tasks: remaining.filter((task) => task.status === 'in-progress') },
    { status: 'todo', tasks: remaining.filter((task) => task.status === 'todo') },
  ];
  return (
    <>
      {graph.project.source && (
        <p className="panel-note source-note">
          템플릿 ‘{graph.project.source.name}’ {graph.project.source.version}판으로 만든 프로젝트 ({graph.project.source.appliedAt.slice(0, 10)})
        </p>
      )}
      <section className="panel-section">
        <div className="panel-heading-row">
          <h2 className="panel-heading is-large">
            {mineOnly ? '내가 맡은 일' : '남은 공정'} {remaining.length}
            {overdue > 0 && <span className="task-row__deadline is-overdue"> · 지연 {overdue}</span>}
          </h2>
          {meId && (
            <div className="filter-tabs" role="group" aria-label="보기">
              <button type="button" aria-pressed={!mineOnly} onClick={() => setMineOnly(false)}>
                전체
              </button>
              <button type="button" aria-pressed={mineOnly} onClick={() => setMineOnly(true)}>
                내가 맡은 일
              </button>
            </div>
          )}
        </div>
        {graph.tasks.length === 0 && <p className="panel-note">아직 공정이 없습니다.</p>}
        {graph.tasks.length > 0 && remaining.length === 0 && (
          <p className="panel-note">{mineOnly ? '나에게 맡겨진 남은 일이 없습니다.' : '모든 공정이 완료되었습니다.'}</p>
        )}
        {groups
          .filter((group) => group.tasks.length > 0)
          .map((group) => (
            <div key={group.status} className="task-group">
              <span className="field-label">
                {STATUS_LABELS[group.status]} {group.tasks.length}
              </span>
              {group.tasks.map((task) => {
                const path = parentPath(graph.tasks, byId, task.id);
                return (
                  <button key={task.id} type="button" className="task-row" onClick={() => onFocusTask(task.id)}>
                    <span className="task-row__main">
                      {path && <span className="task-row__path">{path}</span>}
                      <span className={`task-row__title status-text-${task.status}`}>
                        <StatusIcon status={task.status} />
                        <span>{task.title}</span>
                      </span>
                    </span>
                    {task.deadline && (
                      <span className={`task-row__deadline${isOverdue(task, today) ? ' is-overdue' : ''}`}>
                        {isOverdue(task, today) ? '지연 ' : '~'}
                        {task.deadline.slice(5).replace('-', '/')}
                      </span>
                    )}
                    <PrerequisiteBadge task={task} />
                  </button>
                );
              })}
            </div>
          ))}
      </section>
      <section className="panel-section help">
        <h2 className="panel-heading">사용 방법</h2>
        <ul>
          <li>공정 추가: 위 입력란에 제목을 쓰고 Enter</li>
          <li>연결: 카드 오른쪽 끝을 끌어 다른 카드에 놓기</li>
          <li>연결 삭제: 연결선을 고르고 Delete</li>
          <li>카드를 끌어 옮기면 그 자리가 저장되어 모두에게 같게 보입니다. [자동 정렬]을 누르면 다시 배치합니다</li>
          <li>기한·담당자: 카드를 고르고 오른쪽에서 정합니다. 기한이 지나면 빨간색으로 ‘지연’이 붙습니다</li>
          <li>하위 공정: 카드의 ‘열기’나 두 번 누르기로 들어가고, 위에 뜬 줄의 ← 버튼이나 Esc로 돌아오기</li>
          <li>하위 공정이 모두 완료되면 상위 공정이 자동으로 완료됩니다</li>
          <li>선행 조건이 갖춰지지 않아도 상태 변경은 막지 않습니다</li>
        </ul>
      </section>
    </>
  );
}

function PrerequisiteBadge({ task }: { task: TaskDto }) {
  if (!hasPrerequisites(task)) return null;
  return task.prerequisitesMet ? (
    <span className="prerequisite-text is-met">
      <CheckIcon />
      선행 충족
    </span>
  ) : (
    <span className="prerequisite-text is-unmet">
      <WarnIcon />
      선행 미충족 {task.unmetPrerequisiteIds.length}
    </span>
  );
}

interface TaskDetailProps {
  task: TaskDto;
  graph: GraphDto;
  byId: Map<string, TaskDto>;
  levelId: string | null;
  onFocusTask: Props['onFocusTask'];
  onOpenLevel: Props['onOpenLevel'];
  onAddChild: Props['onAddChild'];
  onUpdate: Props['onUpdateTask'];
  onMove: Props['onMoveTask'];
  onDelete: Props['onDeleteTask'];
  readOnly: boolean;
  /** 템플릿 공정: 진행 상태·선행 충족·Jira 링크·기한·담당자가 없다 */
  template: boolean;
  people: PersonDto[];
  onCreateJira?: (taskId: string) => void;
}

function TaskDetail({ task, graph, byId, levelId, onFocusTask, onOpenLevel, onAddChild, onUpdate, onMove, onDelete, readOnly, template, people, onCreateJira }: TaskDetailProps) {
  const update = (input: TaskInput) => onUpdate(task.id, input);
  const path = parentPath(graph.tasks, byId, task.id);
  const children = graph.tasks.filter((item) => item.parentId === task.id).map((item) => item.id);
  return (
    <>
      <div className="panel-section is-tight">
        <TitleField task={task} readOnly={readOnly} onSave={(title) => update({ title })} />
        <IdRow id={task.id} />
      </div>

      <div className="location-row">
        <span className="field-label">위치</span>
        <span className="location-row__path" title={path || '최상위'}>
          {path ? `${path} 아래` : '최상위'}
        </span>
        {!readOnly && (
          <button type="button" className="button small" onClick={() => onMove(task)}>
            옮기기
          </button>
        )}
      </div>

      {task.jira && <TaskJiraBox task={task} />}
      {!template && !task.jira && !task.jiraUrl && onCreateJira && (
        <button type="button" className="button small jira-create-one" onClick={() => onCreateJira(task.id)}>
          이 공정으로 Jira 이슈 만들기
        </button>
      )}

      {!template && (
        <DeadlineFields task={task} parent={task.parentId ? (byId.get(task.parentId) ?? null) : null} late={lateChildren(graph.tasks, task)} people={people} readOnly={readOnly} onUpdate={update} />
      )}

      {template ? (
        <p className="panel-note is-small">템플릿 공정에는 진행 상태가 없습니다. 이 템플릿으로 만든 프로젝트에서는 모두 미착수로 시작합니다.</p>
      ) : (
      <fieldset className="status-field">
        <legend className="field-label">실행 상태</legend>
        <div className="segmented">
          {TASK_STATUSES.map((status) => (
            <button
              key={status}
              type="button"
              className={`segment status-text-${status}`}
              aria-pressed={task.status === status}
              disabled={readOnly && task.status !== status}
              onClick={() => !readOnly && task.status !== status && update({ status })}
            >
              <StatusIcon status={status} />
              {STATUS_LABELS[status]}
            </button>
          ))}
        </div>
        {task.inconsistency && (
          <div className="warning-box is-compact">
            <WarnIcon />
            <p>{INCONSISTENCY_LABELS[task.inconsistency]} 막지는 않으니 필요하면 직접 맞추세요.</p>
          </div>
        )}
        {task.childCount > 0 && !task.inconsistency && !task.jira && (
          <p className="panel-note is-small">하위 공정이 모두 완료되면 자동으로 완료됩니다. 직접 바꿀 수도 있습니다.</p>
        )}
        {task.childCount > 0 && task.jira && <p className="panel-note is-small">Jira에 연결된 상위 공정은 하위가 모두 끝나도 자동으로 완료하지 않습니다.</p>}
      </fieldset>
      )}

      <section className="panel-section">
        <div className="panel-heading-row">
          <h2 className="panel-heading">선행 조건</h2>
          {!template &&
            hasPrerequisites(task) &&
            (task.prerequisitesMet ? (
              <span className="chip is-met">
                <CheckIcon />
                충족
              </span>
            ) : (
              <span className="chip is-unmet">
                <WarnIcon />
                미충족
              </span>
            ))}
        </div>
        {!hasPrerequisites(task) ? (
          <p className="panel-note">선행 공정이 없습니다.</p>
        ) : (
          <>
            {!template && !task.prerequisitesMet && (
              <p className="panel-note">
                완료되지 않은 선행 공정이 {task.unmetPrerequisiteIds.length}개 있습니다. 그래도 상태는 바꿀 수 있습니다.
              </p>
            )}
            {task.predecessorIds.length > 0 &&
              (task.inheritedPredecessors.length > 0 ? (
                <div className="task-group">
                  <span className="field-label">직접 선행</span>
                  <TaskList ids={task.predecessorIds} byId={byId} onFocusTask={onFocusTask} />
                </div>
              ) : (
                <TaskList ids={task.predecessorIds} byId={byId} onFocusTask={onFocusTask} />
              ))}
            {task.inheritedPredecessors.length > 0 && (
              <div className="task-group">
                <span className="field-label">물려받은 선행</span>
                <ul className="linked-tasks">
                  {task.inheritedPredecessors.map(({ taskId, inheritedFrom }) => {
                    const linked = byId.get(taskId);
                    if (!linked) return null;
                    return (
                      <li key={`${inheritedFrom}>${taskId}`}>
                        <span className="linked-tasks__main">
                          <button type="button" className="link-button" onClick={() => onFocusTask(taskId)}>
                            {linked.title}
                          </button>
                          <span className="linked-tasks__note">{byId.get(inheritedFrom)?.title}의 선행</span>
                        </span>
                        <StatusChip status={linked.status} />
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </>
        )}
      </section>

      <section className="panel-section">
        <h2 className="panel-heading">후속 공정</h2>
        {task.successorIds.length === 0 ? (
          <p className="panel-note">후속 공정이 없습니다.</p>
        ) : (
          <TaskList ids={task.successorIds} byId={byId} onFocusTask={onFocusTask} />
        )}
      </section>

      <section className="panel-section">
        <div className="panel-heading-row">
          <h2 className="panel-heading">하위 공정</h2>
          {task.childCount > 0 && (
            <span className="panel-heading-row__aside">
              {task.doneChildCount}/{task.childCount} 완료
            </span>
          )}
        </div>
        {children.length === 0 ? (
          <p className="panel-note">하위 공정이 없습니다.</p>
        ) : (
          <TaskList ids={children} byId={byId} onFocusTask={onFocusTask} />
        )}
        <div className="button-row">
          {children.length > 0 && levelId !== task.id && (
            <button type="button" className="button small" onClick={() => onOpenLevel(task.id)}>
              하위 공정 열기
            </button>
          )}
          {!readOnly && (
            <button type="button" className="button small" onClick={() => onAddChild(task.id)}>
              <PlusIcon />
              하위 공정 추가
            </button>
          )}
        </div>
      </section>

      <section className="panel-section">
        <h2 className="panel-heading">링크</h2>
        {!template && (
        <LinkField
          label="Jira"
          url={task.jiraUrl}
          text={task.jiraKey ?? task.jiraUrl}
          placeholder="https://jira…/browse/ABC-123"
          readOnly={readOnly}
          onSave={(jiraUrl) => update({ jiraUrl })}
        />
        )}
        <LinkField
          label="Confluence"
          url={task.confluenceUrl}
          text={task.confluenceUrl?.replace(/^https?:\/\//, '') ?? null}
          placeholder="https://wiki…/display/…"
          readOnly={readOnly}
          onSave={(confluenceUrl) => update({ confluenceUrl })}
        />
        <p className="panel-note is-small">
          {template
            ? 'Confluence 링크는 이 템플릿으로 만든 프로젝트에 그대로 복사됩니다. Jira 이슈는 프로젝트마다 달라 템플릿에는 넣지 않습니다.'
            : graph.jira.enabled
              ? `이 서버의 Jira(${graph.jira.siteUrl}) 이슈 주소를 넣으면 상태·기한·담당자를 Jira와 주고받습니다. 다른 주소는 링크로만 저장합니다.`
              : '링크만 저장합니다. Jira 상태는 가져오지 않으며, 실행 상태는 Tevro에서 관리합니다.'}
        </p>
      </section>

      <DescriptionField task={task} readOnly={readOnly} onSave={(description) => update({ description })} />

      {!readOnly && (
        <button type="button" className="button danger panel-footer-button" onClick={() => onDelete(task)}>
          공정 삭제
        </button>
      )}
    </>
  );
}

/** 기한과 담당자. 상위 공정보다 늦은 기한은 막지 않고 알린다. */
function DeadlineFields({
  task,
  parent,
  late,
  people,
  readOnly,
  onUpdate,
}: {
  task: TaskDto;
  parent: TaskDto | null;
  late: TaskDto[];
  people: PersonDto[];
  readOnly: boolean;
  onUpdate: (input: TaskInput) => void;
}) {
  const overdue = isOverdue(task, localToday());
  const laterThanParent = parent?.deadline && task.deadline && task.deadline > parent.deadline;
  // 비활성화돼 목록에 없는 담당자도 이름은 보이게 둔다.
  const options = task.assigneeId && !people.some((person) => person.id === task.assigneeId)
    ? [...people, { id: task.assigneeId, username: '', displayName: `${task.assigneeName ?? task.assigneeId} (비활성)` }]
    : people;
  return (
    <div className="panel-section is-tight">
      <div className="deadline-row">
        <div className="field">
          <label className="field-label" htmlFor="task-deadline">
            기한
          </label>
          <input
            id="task-deadline"
            className="input"
            type="date"
            defaultValue={task.deadline ?? ''}
            key={task.deadline ?? ''}
            readOnly={readOnly}
            // 날짜를 다 고른 때만 저장하고, 비운 채 떠나면 지운다(입력 도중의 빈 값으로 지우지 않게).
            onChange={(event) => !readOnly && event.target.value && event.target.value !== task.deadline && onUpdate({ deadline: event.target.value })}
            onBlur={(event) => !readOnly && !event.target.value && task.deadline && onUpdate({ deadline: null })}
          />
        </div>
        {(people.length > 0 || task.assigneeId) && (
          <div className="field">
            <label className="field-label" htmlFor="task-assignee">
              담당
            </label>
            <select
              id="task-assignee"
              className="select"
              value={task.assigneeId ?? ''}
              disabled={readOnly}
              onChange={(event) => onUpdate({ assigneeId: event.target.value || null })}
            >
              <option value="">없음</option>
              {options.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.displayName}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      {overdue && <p className="panel-note is-error">기한({task.deadline})이 지났는데 아직 끝나지 않았습니다.</p>}
      {laterThanParent && (
        <p className="panel-note is-small warn-text">
          상위 공정 ‘{parent!.title}’의 기한({parent!.deadline})보다 늦습니다.
        </p>
      )}
      {late.length > 0 && (
        <p className="panel-note is-small warn-text">
          하위 공정 {late.length}개의 기한이 이 공정의 기한({task.deadline})보다 늦습니다: {late.map((child) => child.title).join(', ')}
        </p>
      )}
    </div>
  );
}

function TaskList({ ids, byId, onFocusTask }: { ids: string[]; byId: Map<string, TaskDto>; onFocusTask: Props['onFocusTask'] }) {
  return (
    <ul className="linked-tasks">
      {ids.map((id) => {
        const linked = byId.get(id);
        if (!linked) return null;
        return (
          <li key={id}>
            <button type="button" className="link-button" onClick={() => onFocusTask(id)}>
              {linked.title}
            </button>
            <StatusChip status={linked.status} />
          </li>
        );
      })}
    </ul>
  );
}

function TitleField({ task, readOnly, onSave }: { task: TaskDto; readOnly: boolean; onSave: (title: string) => void }) {
  const [value, setValue] = useState(task.title);
  useEffect(() => setValue(task.title), [task.title]);
  const commit = () => {
    const title = value.trim();
    if (title === '' || title === task.title) setValue(task.title);
    else onSave(title);
  };
  return (
    <>
      <label className="field-label" htmlFor="task-title">
        제목
      </label>
      <input
        id="task-title"
        className="input title-input"
        value={value}
        readOnly={readOnly}
        maxLength={200}
        onChange={(event) => setValue(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.currentTarget.blur();
          if (event.key === 'Escape') setValue(task.title);
        }}
      />
    </>
  );
}

function IdRow({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(id);
    } catch {
      // http로 다른 PC에서 열면 클립보드 API를 쓸 수 없어 예전 방식으로 복사한다.
      const field = document.createElement('textarea');
      field.value = id;
      document.body.append(field);
      field.select();
      document.execCommand('copy');
      field.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="id-row">
      <span className="id-row__value" title={id}>
        {id}
      </span>
      <button type="button" className="button small" onClick={copy}>
        <CopyIcon />
        {copied ? '복사됨' : 'ID 복사'}
      </button>
    </div>
  );
}

interface LinkFieldProps {
  label: string;
  url: string | null;
  text: string | null;
  placeholder: string;
  readOnly: boolean;
  onSave: (url: string | null) => void;
}

function LinkField({ label, url, text, placeholder, readOnly, onSave }: LinkFieldProps) {
  const inputId = useId();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(url ?? '');
  const start = () => {
    setValue(url ?? '');
    setEditing(true);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next = value.trim() === '' ? null : value.trim();
    if (next !== url) onSave(next);
    setEditing(false);
  };
  if (editing) {
    return (
      <form className="link-row is-editing" onSubmit={submit}>
        <label className="link-row__label" htmlFor={inputId}>
          {label}
        </label>
        <input
          id={inputId}
          className="input"
          type="url"
          value={value}
          placeholder={placeholder}
          autoFocus
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => event.key === 'Escape' && setEditing(false)}
        />
        <div className="link-row__actions">
          <button type="submit" className="button small primary">
            저장
          </button>
          <button type="button" className="button small" onClick={() => setEditing(false)}>
            취소
          </button>
          {url && <span className="panel-note is-small">비우고 저장하면 링크를 지웁니다.</span>}
        </div>
      </form>
    );
  }
  return (
    <div className="link-row">
      <span className="link-row__label">{label}</span>
      {url && isHttpUrl(url) ? (
        <a className="link-row__link" href={url} target="_blank" rel="noreferrer noopener" title={url}>
          <ExternalIcon />
          {text}
        </a>
      ) : (
        <span className="link-row__empty">없음</span>
      )}
      {!readOnly && (
        <button type="button" className="icon-button" aria-label={`${label} 링크 ${url ? '바꾸기' : '추가'}`} onClick={start}>
          {url ? <PencilIcon /> : <PlusIcon />}
        </button>
      )}
    </div>
  );
}

function DescriptionField({ task, readOnly, onSave }: { task: TaskDto; readOnly: boolean; onSave: (description: string) => void }) {
  const [value, setValue] = useState(task.description);
  useEffect(() => setValue(task.description), [task.description]);
  return (
    <div className="panel-section is-tight">
      <label className="field-label" htmlFor="task-description">
        설명
      </label>
      <textarea
        id="task-description"
        className="input"
        rows={3}
        value={value}
        readOnly={readOnly}
        placeholder={readOnly ? '' : '작업 절차, 완료 기준, 참고할 내용'}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => value !== task.description && onSave(value)}
      />
    </div>
  );
}

function EdgeDetail({
  from,
  to,
  onFocusTask,
  onDelete,
  readOnly,
}: {
  from: TaskDto;
  to: TaskDto;
  onFocusTask: Props['onFocusTask'];
  onDelete: Props['onDeleteEdge'];
  readOnly: boolean;
}) {
  return (
    <>
      <span className="field-label">선택한 연결</span>
      <div className="edge-cards">
        <button type="button" className="edge-card" onClick={() => onFocusTask(from.id)}>
          <span className="field-label">선행</span>
          <span className="edge-card__title">{from.title}</span>
          <StatusChip status={from.status} />
        </button>
        <span className="edge-cards__arrow">
          <ArrowDownIcon />
        </span>
        <button type="button" className="edge-card" onClick={() => onFocusTask(to.id)}>
          <span className="field-label">후속</span>
          <span className="edge-card__title">{to.title}</span>
          <StatusChip status={to.status} />
        </button>
      </div>
      <p className="panel-note">선행 공정이 완료되어야 후속 공정의 선행 조건이 갖춰집니다.</p>
      {!readOnly && (
        <div className="panel-section is-tight">
          <button type="button" className="button danger" onClick={() => onDelete({ from: from.id, to: to.id })}>
            연결 삭제
          </button>
          <p className="panel-note is-small">연결 하나는 확인 없이 바로 지워집니다. 잘못 지웠다면 다시 끌어서 연결하세요.</p>
        </div>
      )}
    </>
  );
}
