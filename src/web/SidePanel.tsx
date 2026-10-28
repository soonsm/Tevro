import { useEffect, useId, useState, type FormEvent } from 'react';
import {
  INCONSISTENCY_LABELS,
  STATUS_LABELS,
  TASK_STATUSES,
  ancestorIds,
  hasPrerequisites,
  isHttpUrl,
  type Edge,
  type TaskStatus,
} from '../shared/domain.ts';
import type { GraphDto, TaskDto, TaskInput } from '../shared/types.ts';
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
}

export function SidePanel({ graph, selection, levelId, onFocusTask, onOpenLevel, onAddChild, onUpdateTask, onMoveTask, onDeleteTask, onDeleteEdge }: Props) {
  const byId = new Map(graph.tasks.map((task) => [task.id, task]));
  let content = <Overview graph={graph} onFocusTask={onFocusTask} />;
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
      />
    );
  } else if (selection?.kind === 'edge' && byId.has(selection.from) && byId.has(selection.to)) {
    content = (
      <EdgeDetail from={byId.get(selection.from)!} to={byId.get(selection.to)!} onFocusTask={onFocusTask} onDelete={onDeleteEdge} />
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

function Overview({ graph, onFocusTask }: { graph: GraphDto; onFocusTask: Props['onFocusTask'] }) {
  const byId = new Map(graph.tasks.map((task) => [task.id, task]));
  // 상태 요약과 같이 말단 공정 기준으로 본다(F-H09). 상위 공정의 상태는 하위로 드러난다.
  const remaining = graph.tasks.filter((task) => task.childCount === 0 && task.status !== 'done');
  const groups: { status: TaskStatus; tasks: TaskDto[] }[] = [
    { status: 'in-progress', tasks: remaining.filter((task) => task.status === 'in-progress') },
    { status: 'todo', tasks: remaining.filter((task) => task.status === 'todo') },
  ];
  return (
    <>
      <section className="panel-section">
        <h2 className="panel-heading is-large">남은 공정 {remaining.length}</h2>
        {graph.tasks.length === 0 && <p className="panel-note">아직 공정이 없습니다.</p>}
        {graph.tasks.length > 0 && remaining.length === 0 && <p className="panel-note">모든 공정이 완료되었습니다.</p>}
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
}

function TaskDetail({ task, graph, byId, levelId, onFocusTask, onOpenLevel, onAddChild, onUpdate, onMove, onDelete }: TaskDetailProps) {
  const update = (input: TaskInput) => onUpdate(task.id, input);
  const path = parentPath(graph.tasks, byId, task.id);
  const children = graph.tasks.filter((item) => item.parentId === task.id).map((item) => item.id);
  return (
    <>
      <div className="panel-section is-tight">
        <TitleField task={task} onSave={(title) => update({ title })} />
        <IdRow id={task.id} />
      </div>

      <div className="location-row">
        <span className="field-label">위치</span>
        <span className="location-row__path" title={path || '최상위'}>
          {path ? `${path} 아래` : '최상위'}
        </span>
        <button type="button" className="button small" onClick={() => onMove(task)}>
          옮기기
        </button>
      </div>

      <fieldset className="status-field">
        <legend className="field-label">실행 상태</legend>
        <div className="segmented">
          {TASK_STATUSES.map((status) => (
            <button
              key={status}
              type="button"
              className={`segment status-text-${status}`}
              aria-pressed={task.status === status}
              onClick={() => task.status !== status && update({ status })}
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
        {task.childCount > 0 && !task.inconsistency && (
          <p className="panel-note is-small">하위 공정이 모두 완료되면 자동으로 완료됩니다. 직접 바꿀 수도 있습니다.</p>
        )}
      </fieldset>

      <section className="panel-section">
        <div className="panel-heading-row">
          <h2 className="panel-heading">선행 조건</h2>
          {hasPrerequisites(task) &&
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
            {!task.prerequisitesMet && (
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
          <button type="button" className="button small" onClick={() => onAddChild(task.id)}>
            <PlusIcon />
            하위 공정 추가
          </button>
        </div>
      </section>

      <section className="panel-section">
        <h2 className="panel-heading">링크</h2>
        <LinkField
          label="Jira"
          url={task.jiraUrl}
          text={task.jiraKey ?? task.jiraUrl}
          placeholder="https://jira…/browse/ABC-123"
          onSave={(jiraUrl) => update({ jiraUrl })}
        />
        <LinkField
          label="Confluence"
          url={task.confluenceUrl}
          text={task.confluenceUrl?.replace(/^https?:\/\//, '') ?? null}
          placeholder="https://wiki…/display/…"
          onSave={(confluenceUrl) => update({ confluenceUrl })}
        />
        <p className="panel-note is-small">링크만 저장합니다. Jira 상태는 가져오지 않으며, 실행 상태는 Tevro에서 관리합니다.</p>
      </section>

      <DescriptionField task={task} onSave={(description) => update({ description })} />

      <button type="button" className="button danger panel-footer-button" onClick={() => onDelete(task)}>
        공정 삭제
      </button>
    </>
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

function TitleField({ task, onSave }: { task: TaskDto; onSave: (title: string) => void }) {
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
  onSave: (url: string | null) => void;
}

function LinkField({ label, url, text, placeholder, onSave }: LinkFieldProps) {
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
      <button type="button" className="icon-button" aria-label={`${label} 링크 ${url ? '바꾸기' : '추가'}`} onClick={start}>
        {url ? <PencilIcon /> : <PlusIcon />}
      </button>
    </div>
  );
}

function DescriptionField({ task, onSave }: { task: TaskDto; onSave: (description: string) => void }) {
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
        placeholder="작업 절차, 완료 기준, 참고할 내용"
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => value !== task.description && onSave(value)}
      />
    </div>
  );
}

function EdgeDetail({ from, to, onFocusTask, onDelete }: { from: TaskDto; to: TaskDto; onFocusTask: Props['onFocusTask']; onDelete: Props['onDeleteEdge'] }) {
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
      <div className="panel-section is-tight">
        <button type="button" className="button danger" onClick={() => onDelete({ from: from.id, to: to.id })}>
          연결 삭제
        </button>
        <p className="panel-note is-small">연결 하나는 확인 없이 바로 지워집니다. 잘못 지웠다면 다시 끌어서 연결하세요.</p>
      </div>
    </>
  );
}
