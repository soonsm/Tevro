// Jira 연동 화면(ADR-0009): 내 Jira 연결, 프로젝트의 Jira 띠·설정, 이슈 만들기, Jira에서 바뀐 값 확인, 공정 패널의 Jira 정보.
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { STATUS_LABELS, treeOrder, type TaskStatus } from '../shared/domain.ts';
import type {
  GraphDto,
  JiraCreateFieldDto,
  JiraCreateMetaDto,
  JiraCreateResultDto,
  JiraTokenStatusDto,
  JiraValuesDto,
  PersonDto,
  ProjectJiraDto,
  TaskDto,
  TaskInput,
} from '../shared/types.ts';
import { ApiFailure, api } from './api.ts';
import { Modal } from './dialogs.tsx';
import { AlertIcon, ExternalIcon, RefreshIcon } from './icons.tsx';

function errorText(error: unknown): string {
  if (error instanceof ApiFailure) return error.problem.detail;
  return error instanceof Error ? error.message : String(error);
}

/** 지난 시각을 '3분 전'처럼 */
export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return '아직 없음';
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return '방금';
  if (minutes < 60) return `${minutes}분 전`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}시간 전`;
  return iso.slice(0, 10);
}

const TASK_STATUSES: TaskStatus[] = ['todo', 'in-progress', 'done'];

// ───────────────────────── 내 Jira 연결(계정 메뉴) ─────────────────────────

export function JiraTokenDialog({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<JiraTokenStatusDto | null>(null);
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.jiraToken().then(setStatus, (failure) => setError(errorText(failure)));
  }, []);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setStatus(await api.setJiraToken(token.trim()));
      setToken('');
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setError(null);
    try {
      setStatus(await api.deleteJiraToken());
    } catch (failure) {
      setError(errorText(failure));
    }
  };
  return (
    <Modal labelledBy="jira-token-title" onClose={onClose}>
      <h2 id="jira-token-title" className="modal__title">
        Jira 연결
      </h2>
      <p className="panel-note">
        Tevro가 내 대신 Jira 이슈를 만들고 상태·기한·담당자를 주고받을 때 쓰는 <b>내 Jira 개인 액세스 토큰</b>입니다. Tevro는 내가 누른 작업만
        이 토큰으로 처리하며, 내 Jira 권한을 넘는 일은 할 수 없습니다.
      </p>
      {error && (
        <p className="panel-note is-error" role="alert">
          {error}
        </p>
      )}
      {status && (
        <div className="jira-token-status">
          <div>
            <span className="field-label">Jira</span> <span>{status.siteUrl}</span>
          </div>
          {status.connected ? (
            <div>
              <span className="field-label">연결됨</span>{' '}
              <b>{status.jiraDisplayName}</b> <span className="panel-note is-small">({status.jiraName}) · 등록 {status.registeredAt?.slice(0, 10)} · 마지막 사용 {ago(status.lastUsedAt)}</span>
            </div>
          ) : (
            <div className="panel-note">아직 토큰을 등록하지 않았습니다.</div>
          )}
          {status.problem && <p className="panel-note is-error">{status.problem}</p>}
        </div>
      )}
      {status?.storage !== false && (
        <form className="token-form" onSubmit={save}>
          <div className="token-form__row">
            <label className="field-label" htmlFor="jira-token">
              {status?.connected ? '새 토큰으로 바꾸기' : '토큰'}
            </label>
            <input
              id="jira-token"
              className="input"
              type="password"
              autoComplete="off"
              value={token}
              placeholder="Jira 프로필 → 개인 액세스 토큰에서 만든 값"
              onChange={(event) => setToken(event.target.value)}
            />
          </div>
          <p className="panel-note is-small">
            Jira 오른쪽 위 내 프로필 → <b>개인 액세스 토큰</b> → 토큰 만들기. 만료일을 정해 두기를 권합니다. Tevro는 서버 비밀키로 암호화해 저장하고 다시 보여 주지 않습니다.
          </p>
          <button type="submit" className="button primary" disabled={busy || token.trim().length < 8}>
            {busy ? 'Jira에 확인 중…' : status?.connected ? '바꾸기' : '등록'}
          </button>
        </form>
      )}
      <div className="modal__actions">
        {status?.connected && (
          <button type="button" className="button danger" onClick={() => void remove()}>
            연결 끊기
          </button>
        )}
        <button type="button" className="button" onClick={onClose}>
          닫기
        </button>
      </div>
    </Modal>
  );
}

// ───────────────────────── 프로젝트의 Jira 띠 ─────────────────────────

export function JiraStrip({
  jira,
  linkedCount,
  canEdit,
  busy,
  onRefresh,
  onSettings,
  onCreate,
}: {
  jira: ProjectJiraDto;
  linkedCount: number;
  canEdit: boolean;
  busy: boolean;
  onRefresh: () => void;
  onSettings: () => void;
  onCreate: () => void;
}) {
  return (
    <div className={`jira-strip${jira.lastRefreshError ? ' has-error' : ''}`}>
      <span className="jira-strip__label">Jira</span>
      <span className="jira-strip__project">{jira.projectKey ?? '프로젝트 미설정'}</span>
      <span className="jira-strip__meta">
        연결된 공정 {linkedCount} · 마지막 조회 {ago(jira.lastRefreshAt)}
        {jira.lastRefreshBy ? ` (${jira.lastRefreshBy})` : ''}
      </span>
      {jira.lastRefreshError && (
        <span className="jira-strip__error" title={jira.lastRefreshError}>
          <AlertIcon />
          {jira.lastRefreshError}
        </span>
      )}
      <span className="jira-strip__actions">
        <button type="button" className="button small" disabled={busy} onClick={onRefresh} title="5분을 기다리지 않고 지금 Jira에서 가져옵니다">
          <RefreshIcon />
          {busy ? '가져오는 중…' : 'Jira에서 새로고침'}
        </button>
        {canEdit && (
          <>
            <button type="button" className="button small" disabled={!jira.projectKey} onClick={onCreate} title={jira.projectKey ? '' : '먼저 Jira 설정에서 프로젝트를 정하세요'}>
              Jira 이슈 만들기
            </button>
            <button type="button" className="button small" onClick={onSettings}>
              Jira 설정
            </button>
          </>
        )}
      </span>
    </div>
  );
}

// ───────────────────────── 프로젝트 Jira 설정 ─────────────────────────

type Options = Awaited<ReturnType<typeof api.jiraOptions>>;

export function JiraSettingsDialog({ projectId, current, onClose, onSaved }: { projectId: string; current: ProjectJiraDto; onClose: () => void; onSaved: () => void }) {
  const [projectKey, setProjectKey] = useState(current.projectKey ?? '');
  const [options, setOptions] = useState<Options | null>(null);
  const [issueTypeId, setIssueTypeId] = useState(current.issueTypeId ?? '');
  const [statusMap, setStatusMap] = useState<ProjectJiraDto['statusMap']>(current.statusMap);
  const [linkType, setLinkType] = useState(current.linkType ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async (key: string, fresh: boolean) => {
    setError(null);
    setBusy(true);
    try {
      const next = await api.jiraOptions(projectId, key.trim().toUpperCase());
      setOptions(next);
      setProjectKey(next.projectKey);
      // 처음 고르는 프로젝트면 추천값으로 채운다
      if (fresh || !current.projectKey) {
        setIssueTypeId(next.suggested.issueTypeId ?? '');
        setStatusMap(next.suggested.statusMap);
        setLinkType(next.suggested.linkType ?? '');
      }
    } catch (failure) {
      setOptions(null);
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (current.projectKey) void load(current.projectKey, false);
  }, []);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.saveJiraSettings(projectId, { projectKey, issueTypeId: issueTypeId || null, statusMap, linkType: linkType || null });
      onSaved();
    } catch (failure) {
      setError(errorText(failure));
      setBusy(false);
    }
  };

  const byCategory = (status: TaskStatus) => {
    const category = status === 'todo' ? 'new' : status === 'in-progress' ? 'indeterminate' : 'done';
    return [...(options?.statuses ?? [])].sort((a, b) => Number(b.category === category) - Number(a.category === category));
  };

  return (
    <Modal labelledBy="jira-settings-title" onClose={onClose}>
      <h2 id="jira-settings-title" className="modal__title">
        Jira 설정
      </h2>
      <p className="panel-note">이 Tevro 프로젝트의 공정으로 이슈를 만들 Jira 프로젝트와, Tevro에서 상태를 바꿀 때 옮길 Jira 상태를 정합니다.</p>
      {error && (
        <p className="panel-note is-error" role="alert">
          {error}
        </p>
      )}
      <form
        className="jira-key-row"
        onSubmit={(event) => {
          event.preventDefault();
          void load(projectKey, projectKey.trim().toUpperCase() !== current.projectKey);
        }}
      >
        <label className="field-label" htmlFor="jira-project-key">
          Jira 프로젝트 키
        </label>
        <input id="jira-project-key" className="input" value={projectKey} placeholder="예: ABC" onChange={(event) => setProjectKey(event.target.value.toUpperCase())} />
        <button type="submit" className="button" disabled={busy || !projectKey.trim()}>
          불러오기
        </button>
      </form>
      {options && (
        <div className="jira-settings">
          <label className="field-label" htmlFor="jira-issue-type">
            기본 이슈 유형 <span className="panel-note is-small">(만들 때 이슈마다 바꿀 수 있음)</span>
          </label>
          <select id="jira-issue-type" className="select" value={issueTypeId} onChange={(event) => setIssueTypeId(event.target.value)}>
            {options.issueTypes.map((type) => (
              <option key={type.id} value={type.id}>
                {type.name}
              </option>
            ))}
          </select>

          <span className="field-label is-strong">Tevro에서 상태를 바꾸면 옮길 Jira 상태</span>
          <div className="jira-status-map">
            {TASK_STATUSES.map((status) => (
              <label key={status} className="jira-status-map__row">
                <span className={`status-text-${status}`}>{STATUS_LABELS[status]}</span>
                <span>→</span>
                <select
                  className="select"
                  value={statusMap[status]?.id ?? ''}
                  onChange={(event) => {
                    const found = options.statuses.find((item) => item.id === event.target.value);
                    setStatusMap((map) => ({ ...map, [status]: found ? { id: found.id, name: found.name } : undefined }));
                  }}
                >
                  <option value="">(그 분류의 첫 상태)</option>
                  {byCategory(status).map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                      {item.category ? ` · ${item.category === 'new' ? '할 일' : item.category === 'indeterminate' ? '진행 중' : '완료'}` : ''}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <p className="panel-note is-small">
            Jira에서 가져올 때는 상태 분류로 바꿉니다: 할 일 → 미착수, 진행 중 → 진행 중, 완료 → 완료. 완료 분류의 다른 상태(예: 안 함)도 Tevro에서는 완료로 보고 카드에 Jira 상태 이름을 함께 보입니다.
          </p>

          <label className="field-label" htmlFor="jira-link-type">
            선후관계를 남길 Jira 링크 유형
          </label>
          <select id="jira-link-type" className="select" value={linkType} onChange={(event) => setLinkType(event.target.value)}>
            <option value="">링크를 만들지 않음</option>
            {options.linkTypes.map((type) => (
              <option key={type.id} value={type.name}>
                {type.name} ({type.outward} / {type.inward})
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="modal__actions">
        <button type="button" className="button" onClick={onClose}>
          취소
        </button>
        <button type="button" className="button primary" disabled={busy || !options} onClick={() => void save()}>
          저장
        </button>
      </div>
    </Modal>
  );
}

// ───────────────────────── 이슈 만들기 ─────────────────────────

interface Row {
  checked: boolean;
  typeId: string;
  fields: Record<string, unknown>;
}

export function JiraCreateDialog({
  projectId,
  graph,
  initialTaskIds,
  onClose,
  onDone,
}: {
  projectId: string;
  graph: GraphDto;
  initialTaskIds?: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const candidates = useMemo(() => treeOrder(graph.tasks.filter((task) => !task.jiraUrl)), [graph]);
  const [metas, setMetas] = useState<Record<string, JiraCreateMetaDto>>({});
  const [defaultType, setDefaultType] = useState<string | null>(null);
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [links, setLinks] = useState(Boolean(graph.jira.linkType));
  const [result, setResult] = useState<JiraCreateResultDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fetchMeta = async (typeId?: string): Promise<JiraCreateMetaDto | null> => {
    if (typeId && metas[typeId]) return metas[typeId];
    try {
      const meta = await api.jiraCreateMeta(projectId, typeId);
      setMetas((current) => ({ ...current, [meta.issueTypeId]: meta }));
      return meta;
    } catch (failure) {
      setError(errorText(failure));
      return null;
    }
  };

  useEffect(() => {
    void (async () => {
      const meta = await fetchMeta(graph.jira.issueTypeId ?? undefined);
      if (!meta) return;
      setDefaultType(meta.issueTypeId);
      const chosen = new Set(initialTaskIds ?? candidates.filter(({ task }) => task.childCount === 0).map(({ task }) => task.id));
      setRows(
        Object.fromEntries(
          candidates.map(({ task }) => [task.id, { checked: chosen.has(task.id), typeId: meta.issueTypeId, fields: defaultsOf(meta) }]),
        ),
      );
    })();
  }, []);

  const setRow = (taskId: string, change: Partial<Row>) => {
    setResult(null);
    setRows((current) => ({ ...current, [taskId]: { ...current[taskId], ...change } }));
  };
  const changeType = async (taskIds: string[], typeId: string) => {
    const meta = await fetchMeta(typeId);
    if (!meta) return;
    setResult(null);
    setRows((current) => {
      const next = { ...current };
      for (const id of taskIds) next[id] = { ...next[id], typeId, fields: { ...defaultsOf(meta), ...pickKnown(next[id].fields, meta) } };
      return next;
    });
  };

  const selected = candidates.filter(({ task }) => rows[task.id]?.checked);
  const body = (dryRun: boolean) => ({
    dryRun,
    createLinks: links,
    items: selected.map(({ task }) => ({ taskId: task.id, issueTypeId: rows[task.id].typeId, fields: rows[task.id].fields })),
  });
  const run = async (dryRun: boolean) => {
    setBusy(true);
    setError(null);
    try {
      setResult(await api.createJiraIssues(projectId, body(dryRun)));
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };

  const anyMeta = defaultType ? metas[defaultType] : undefined;
  const done = result && !result.dryRun;
  return (
    <Modal labelledBy="jira-create-title" onClose={done ? onDone : onClose} wide>
      <h2 id="jira-create-title" className="modal__title">
        Jira 이슈 만들기 · {graph.jira.projectKey}
      </h2>
      {error && (
        <p className="panel-note is-error" role="alert">
          {error}
        </p>
      )}
      {!anyMeta && !error && <p className="panel-note">Jira에서 이슈 유형과 필수 입력 칸을 읽는 중…</p>}
      {anyMeta && !done && (
        <>
          <p className="panel-note">
            제목·설명{anyMeta.fills.duedate ? '·기한' : ''}
            {anyMeta.fills.assignee ? '·담당자' : ''}는 공정에서 가져가고, 보고자는 나입니다. 이미 진행 중이거나 완료인 공정은 만든 뒤 Jira 상태도 옮깁니다. Jira
            주소가 이미 있는 공정은 목록에 없습니다.
          </p>
          <div className="jira-create-toolbar">
            <label className="field-label" htmlFor="jira-type-all">
              고른 공정의 유형을 모두
            </label>
            <select
              id="jira-type-all"
              className="select"
              value=""
              onChange={(event) => event.target.value && void changeType(selected.map(({ task }) => task.id), event.target.value)}
            >
              <option value="">바꾸기…</option>
              {anyMeta.issueTypes.map((type) => (
                <option key={type.id} value={type.id}>
                  {type.name}
                </option>
              ))}
            </select>
            <label className="checkbox">
              <input type="checkbox" checked={links} disabled={!graph.jira.linkType} onChange={(event) => setLinks(event.target.checked)} />
              선후관계를 Jira 링크({graph.jira.linkType ?? 'Jira 설정에서 링크 유형을 정하세요'})로도 만들기
            </label>
          </div>
          <div className="jira-create-table">
            <table>
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      aria-label="모두 고르기"
                      checked={selected.length === candidates.length && candidates.length > 0}
                      onChange={(event) => {
                        setResult(null);
                        setRows((current) => Object.fromEntries(Object.entries(current).map(([id, row]) => [id, { ...row, checked: event.target.checked }])));
                      }}
                    />
                  </th>
                  <th>공정</th>
                  <th>상태</th>
                  <th>이슈 유형</th>
                  <th>필수 입력</th>
                </tr>
              </thead>
              <tbody>
                {candidates.map(({ task, depth }) => {
                  const row = rows[task.id];
                  if (!row) return null;
                  const meta = metas[row.typeId];
                  return (
                    <tr key={task.id} className={row.checked ? '' : 'is-off'}>
                      <td>
                        <input type="checkbox" aria-label={`${task.title} 고르기`} checked={row.checked} onChange={(event) => setRow(task.id, { checked: event.target.checked })} />
                      </td>
                      <td style={{ paddingLeft: `${8 + depth * 14}px` }}>
                        {task.title}
                        {task.childCount > 0 && <span className="panel-note is-small"> · 하위 {task.childCount}</span>}
                      </td>
                      <td className={`status-text-${task.status}`}>{STATUS_LABELS[task.status]}</td>
                      <td>
                        <select className="select small" value={row.typeId} disabled={!row.checked} onChange={(event) => void changeType([task.id], event.target.value)}>
                          {anyMeta.issueTypes.map((type) => (
                            <option key={type.id} value={type.id}>
                              {type.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        {meta?.unsupported.length ? (
                          <span className="panel-note is-error">이 유형은 Tevro가 채울 수 없는 필수 칸이 있습니다: {meta.unsupported.join(', ')}</span>
                        ) : (
                          <div className="jira-fields">
                            {meta?.fields.map((field) => (
                              <FieldInput key={field.id} field={field} value={row.fields[field.id]} disabled={!row.checked} onChange={(value) => setRow(task.id, { fields: { ...row.fields, [field.id]: value } })} />
                            ))}
                            {meta && meta.fields.length === 0 && <span className="panel-note is-small">없음</span>}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
      {result && <CreateResult result={result} graph={graph} />}
      <div className="modal__actions">
        {done ? (
          <button type="button" className="button primary" onClick={onDone}>
            닫기
          </button>
        ) : (
          <>
            <button type="button" className="button" onClick={onClose}>
              취소
            </button>
            <button type="button" className="button" disabled={busy || selected.length === 0} onClick={() => void run(true)}>
              미리 보기
            </button>
            <button type="button" className="button primary" disabled={busy || selected.length === 0} onClick={() => void run(false)}>
              {busy ? '만드는 중…' : `이슈 ${selected.length}개 만들기`}
            </button>
          </>
        )}
      </div>
    </Modal>
  );
}

function defaultsOf(meta: JiraCreateMetaDto): Record<string, unknown> {
  return Object.fromEntries(meta.fields.map((field) => [field.id, field.default ?? (field.type === 'options' ? [] : '')]));
}

function pickKnown(values: Record<string, unknown>, meta: JiraCreateMetaDto): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([id, value]) => meta.fields.some((field) => field.id === id) && value !== '' && value !== null));
}

function FieldInput({ field, value, disabled, onChange }: { field: JiraCreateFieldDto; value: unknown; disabled: boolean; onChange: (value: unknown) => void }) {
  const label = <span className="jira-fields__label">{field.name}</span>;
  if (field.type === 'option' || field.type === 'options') {
    return (
      <label className="jira-fields__item">
        {label}
        <select
          className="select small"
          multiple={field.type === 'options'}
          disabled={disabled}
          value={(field.type === 'options' ? ((value as string[]) ?? []) : String(value ?? '')) as string | string[]}
          onChange={(event) =>
            onChange(field.type === 'options' ? [...event.target.selectedOptions].map((option) => option.value) : event.target.value)
          }
        >
          {field.type === 'option' && <option value="">고르세요</option>}
          {field.options?.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <label className="jira-fields__item">
      {label}
      <input
        className={`input small${field.type === 'number' ? ' is-number' : ''}`}
        type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
        step="any"
        disabled={disabled}
        value={value === null || value === undefined ? '' : String(value)}
        onChange={(event) => onChange(field.type === 'number' && event.target.value !== '' ? Number(event.target.value) : event.target.value)}
      />
    </label>
  );
}

const ITEM_STATES: Record<string, string> = {
  'will-create': '만들 예정',
  created: '만듦',
  recovered: '찾아서 연결',
  skipped: '건너뜀',
  failed: '실패',
  unknown: '결과 미확인',
};
const LINK_STATES: Record<string, string> = {
  'will-create': '만들 예정',
  created: '만듦',
  exists: '이미 있음',
  skipped: '건너뜀',
  'needs-issue': '이슈가 없는 공정',
  failed: '실패',
};

function CreateResult({ result, graph }: { result: JiraCreateResultDto; graph: GraphDto }) {
  const titles = new Map(graph.tasks.map((task) => [task.id, task.title]));
  const count = (state: string) => result.items.filter((item) => item.state === state).length;
  return (
    <div className="jira-result">
      <span className="field-label is-strong">
        {result.dryRun ? '미리 보기 — 아직 아무것도 만들지 않았습니다' : '결과'} · 만듦 {count('created') + count('recovered')}
        {result.dryRun ? ` · 만들 예정 ${count('will-create')}` : ''} · 건너뜀 {count('skipped')} · 실패 {count('failed')}
        {count('unknown') > 0 ? ` · 결과 미확인 ${count('unknown')}` : ''}
      </span>
      <ul className="jira-result__list">
        {result.items.map((item) => (
          <li key={item.taskId} className={`is-${item.state}`}>
            <b>{ITEM_STATES[item.state]}</b> {item.title}
            {item.issueKey ? ` → ${item.issueKey}` : ''}
            {item.issueTypeName ? ` (${item.issueTypeName})` : ''}
            {item.detail && <span className="panel-note is-small"> {item.detail}</span>}
          </li>
        ))}
      </ul>
      {result.links.length > 0 && (
        <>
          <span className="field-label is-strong">선후관계 링크</span>
          <ul className="jira-result__list">
            {result.links.map((link) => (
              <li key={`${link.from}>${link.to}`} className={`is-${link.state}`}>
                <b>{LINK_STATES[link.state]}</b> {titles.get(link.from)} → {titles.get(link.to)}
                {link.detail && <span className="panel-note is-small"> {link.detail}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
      {count('unknown') > 0 && <p className="panel-note is-small">결과 미확인인 공정은 다시 만들면 먼저 Jira에서 같은 이슈를 찾아 연결합니다.</p>}
    </div>
  );
}

// ───────────────────────── Jira에서 바뀐 값 확인 ─────────────────────────

export function JiraChangedDialog({
  task,
  input,
  values,
  detail,
  people,
  onCancel,
  onConfirm,
}: {
  task: TaskDto;
  /** 사람이 바꾸려던 값(연결할 때는 jiraUrl만 있다) */
  input: TaskInput;
  values: JiraValuesDto;
  detail: string;
  people: PersonDto[];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const name = (id: string | null | undefined) => (id ? (people.find((person) => person.id === id)?.displayName ?? id) : '없음');
  const linking = input.jiraUrl !== undefined;
  const rows: { label: string; mine: string; theirs: string; wanted?: string; differs: boolean }[] = [
    {
      label: '상태',
      mine: STATUS_LABELS[task.status],
      theirs: values.status ? `${STATUS_LABELS[values.status]} (${values.statusName})` : values.statusName,
      wanted: input.status ? STATUS_LABELS[input.status] : undefined,
      differs: values.status !== null && values.status !== task.status,
    },
    {
      label: '기한',
      mine: task.deadline ?? '없음',
      theirs: values.deadline ?? '없음',
      wanted: input.deadline !== undefined ? (input.deadline || '없음') : undefined,
      differs: values.deadline !== task.deadline,
    },
    {
      label: '담당자',
      mine: task.assigneeName ?? name(task.assigneeId),
      theirs: values.assigneeId ? name(values.assigneeId) : (values.assigneeName ?? '없음'),
      wanted: input.assigneeId !== undefined ? name(input.assigneeId) : undefined,
      differs: values.assigneeId !== task.assigneeId,
    },
  ];
  const showWanted = rows.some((row) => row.wanted !== undefined);
  return (
    <Modal labelledBy="jira-changed-title" onClose={onCancel}>
      <h2 id="jira-changed-title" className="modal__title">
        Jira 값 확인 · {values.key}
      </h2>
      <p className="panel-note">{detail}</p>
      <table className="jira-compare">
        <thead>
          <tr>
            <th />
            <th>Tevro에 있는 값</th>
            <th>지금 Jira 값</th>
            {showWanted && <th>바꾸려는 값</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} className={row.differs ? 'is-diff' : ''}>
              <th>{row.label}</th>
              <td>{row.mine}</td>
              <td>{row.theirs}</td>
              {showWanted && <td className={row.wanted !== undefined ? 'is-wanted' : ''}>{row.wanted ?? '-'}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="panel-note is-small">
        {linking
          ? '연결하면 상태·기한·담당자가 지금 Jira 값으로 바뀝니다.'
          : '진행하면 바꾸려는 값을 Jira에 반영합니다. 나머지는 지금 Jira 값을 따릅니다.'}
      </p>
      <div className="modal__actions">
        <button type="button" className="button" onClick={onCancel}>
          취소
        </button>
        <button type="button" className="button primary" onClick={onConfirm}>
          {linking ? '연결' : '그래도 바꾸기'}
        </button>
      </div>
    </Modal>
  );
}

// ───────────────────────── 공정 패널의 Jira 정보 ─────────────────────────

export function TaskJiraBox({ task }: { task: TaskDto }) {
  const jira = task.jira!;
  return (
    <div className={`jira-box${jira.error ? ' has-error' : ''}`}>
      <div className="jira-box__head">
        <a href={jira.url} target="_blank" rel="noreferrer" className="jira-box__key">
          {jira.key}
          <ExternalIcon />
        </a>
        {jira.statusName && <span className={`chip jira-status is-${jira.statusCategory ?? 'unknown'}`}>{jira.statusName}</span>}
      </div>
      {jira.summary && jira.summary !== task.title && <p className="jira-box__summary">{jira.summary}</p>}
      {jira.assigneeUnmapped && (
        <p className="panel-note is-small">
          Jira 담당자: <b>{jira.assigneeName}</b> (Tevro 사용자와 짝지어지지 않아 Tevro 담당자는 비어 있습니다)
        </p>
      )}
      {jira.error && (
        <p className="panel-note is-small is-error">
          <AlertIcon /> 마지막 조회 실패: {jira.error}
        </p>
      )}
      <p className="panel-note is-small">
        상태·기한·담당자는 Jira와 주고받습니다. 여기서 바꾸면 Jira에 먼저 반영됩니다. 제목·설명은 따로 갑니다. · 조회 {ago(jira.fetchedAt)}
        {jira.fetchedBy ? ` (${jira.fetchedBy})` : ''}
      </p>
    </div>
  );
}
