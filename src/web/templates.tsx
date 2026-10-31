// 템플릿 화면: 새 프로젝트 창(빈 프로젝트 / 템플릿에서 시작), 템플릿 관리(회사 템플릿·내 템플릿), 템플릿 편집 띠.
import { useEffect, useState, type FormEvent } from 'react';
import type { GraphDto, ProjectDto, TemplateSummaryDto, UserDto } from '../shared/types.ts';
import { ApiFailure, api } from './api.ts';
import { Modal } from './dialogs.tsx';
import { PlusIcon } from './icons.tsx';

function errorText(error: unknown): string {
  if (error instanceof ApiFailure) return error.problem.detail;
  return error instanceof Error ? error.message : String(error);
}

function meta(item: TemplateSummaryDto): string {
  return `공정 ${item.taskCount} · 연결 ${item.dependencyCount} · ${item.template.version}판 · ${item.updatedAt.slice(5, 10).replace('-', '/')} 수정`;
}

/** 템플릿 목록을 회사 템플릿, 내 템플릿, (관리자에게만 보이는) 다른 사람의 템플릿으로 나눈다. */
export function groupTemplates(templates: TemplateSummaryDto[], user: UserDto | null) {
  return {
    company: templates.filter((item) => item.template.official),
    mine: templates.filter((item) => !item.template.official && (!user || item.template.ownerId === user.id)),
    others: templates.filter((item) => !item.template.official && user && item.template.ownerId !== user.id),
  };
}

export function TemplateChip({ official }: { official: boolean }) {
  return <span className={`template-chip${official ? ' is-official' : ''}`}>{official ? '회사 템플릿' : '내 템플릿'}</span>;
}

interface NewProjectProps {
  templates: TemplateSummaryDto[];
  user: UserDto | null;
  /** 처음부터 '템플릿에서 시작'으로 열고 이 템플릿을 골라 둔다 */
  initialTemplateId?: string;
  onCancel: () => void;
  onCreateBlank: (name: string) => void;
  onCreateFromTemplate: (templateId: string, name: string) => void;
}

/** 새 프로젝트 창(A안): 빈 프로젝트 또는 템플릿에서 시작. 템플릿을 고르면 구조를 미리 본다. */
export function NewProjectDialog({ templates, user, initialTemplateId, onCancel, onCreateBlank, onCreateFromTemplate }: NewProjectProps) {
  const { company, mine } = groupTemplates(templates, user);
  const usable = [...company, ...mine];
  const [mode, setMode] = useState<'blank' | 'template'>(initialTemplateId || usable.length > 0 ? 'template' : 'blank');
  const [selected, setSelected] = useState<string | null>(initialTemplateId ?? usable[0]?.id ?? null);
  const [name, setName] = useState('');
  const chosen = usable.find((item) => item.id === selected) ?? null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    if (mode === 'blank') onCreateBlank(trimmed);
    else if (chosen) onCreateFromTemplate(chosen.id, trimmed);
  };
  return (
    <Modal labelledBy="new-project-title" onClose={onCancel} wide>
      <form onSubmit={submit}>
        <h2 id="new-project-title" className="modal__title">
          새 프로젝트
        </h2>
        <div className="segmented-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={mode === 'blank'} onClick={() => setMode('blank')}>
            빈 프로젝트
          </button>
          <button type="button" role="tab" aria-selected={mode === 'template'} onClick={() => setMode('template')}>
            템플릿에서 시작
          </button>
        </div>
        {mode === 'template' &&
          (usable.length === 0 ? (
            <p className="panel-note">
              아직 템플릿이 없습니다. 상단의 [템플릿]에서 만들거나, 지금 프로젝트를 템플릿으로 저장하세요.
            </p>
          ) : (
            <div className="template-pick">
              <div className="template-pick__list" role="listbox" aria-label="템플릿">
                {[
                  { title: '회사 템플릿', items: company },
                  { title: '내 템플릿', items: mine },
                ]
                  .filter((group) => group.items.length > 0)
                  .map((group) => (
                    <div key={group.title} className="template-pick__group">
                      <span className="field-label">{group.title}</span>
                      {group.items.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          role="option"
                          aria-selected={item.id === selected}
                          className="template-option"
                          onClick={() => setSelected(item.id)}
                        >
                          <b>{item.name}</b>
                          <span className="template-option__meta">{meta(item)}</span>
                          {item.description && <span className="template-option__desc">{item.description}</span>}
                        </button>
                      ))}
                    </div>
                  ))}
              </div>
              {chosen && <TemplatePreview key={chosen.id} templateId={chosen.id} />}
            </div>
          ))}
        <div className="panel-section is-tight">
          <label className="field-label" htmlFor="new-project-name">
            프로젝트 이름
          </label>
          <input
            id="new-project-name"
            className="input"
            value={name}
            maxLength={100}
            placeholder={mode === 'template' && chosen ? `예: ${chosen.name} — 결제 모듈` : '예: 신규 서비스 준비'}
            autoFocus
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        {mode === 'template' && chosen && (
          <ul className="copy-rules">
            <li>공정·연결·하위 구조 복사(새 ID)</li>
            <li>진행 상태는 모두 미착수</li>
            <li>Confluence 링크 복사</li>
            <li className="is-off">Jira 링크는 비움</li>
          </ul>
        )}
        <div className="modal__actions">
          <button type="button" className="button" onClick={onCancel}>
            취소
          </button>
          <button type="submit" className="button primary" disabled={!name.trim() || (mode === 'template' && !chosen)}>
            프로젝트 만들기
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** 고른 템플릿의 최상위 공정을 선후관계 깊이에 따라 열로 놓아 보여 준다. 하위가 있는 공정은 겹친 카드로. */
function TemplatePreview({ templateId }: { templateId: string }) {
  const [graph, setGraph] = useState<GraphDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.getGraph(templateId).then(setGraph, (failure) => setError(errorText(failure)));
  }, [templateId]);
  if (error) return <div className="template-preview is-empty">{error}</div>;
  if (!graph) return <div className="template-preview is-empty">불러오는 중…</div>;
  const top = graph.tasks.filter((task) => task.parentId === null);
  const edges = graph.dependencies.filter((edge) => top.some((t) => t.id === edge.from) && top.some((t) => t.id === edge.to));
  // 열 = 앞선 공정을 따라 거슬러 올라간 가장 긴 경로의 길이(순환은 서버가 막으므로 없다).
  const rank = new Map<string, number>();
  const rankOf = (id: string): number => {
    if (rank.has(id)) return rank.get(id)!;
    const preds = edges.filter((edge) => edge.to === id);
    const value = preds.length === 0 ? 0 : Math.max(...preds.map((edge) => rankOf(edge.from) + 1));
    rank.set(id, value);
    return value;
  };
  const columns: (typeof top)[] = [];
  for (const task of top) (columns[rankOf(task.id)] ??= []).push(task);
  return (
    <div className="template-preview">
      <span className="template-preview__cap">
        구조 미리 보기 · 최상위 {top.length}개{graph.tasks.length > top.length ? ` · 하위 포함 ${graph.tasks.length}개` : ''}
      </span>
      {top.length === 0 ? (
        <p className="panel-note">공정이 없는 템플릿입니다.</p>
      ) : (
        <div className="template-preview__cols">
          {columns.map((column, index) => (
            <div key={index} className="template-preview__col">
              {column?.map((task) => (
                <span key={task.id} className={`template-preview__card${task.childCount > 0 ? ' is-parent' : ''}`} title={task.title}>
                  {task.title}
                  {task.childCount > 0 && <small> ⧉{task.childCount}</small>}
                </span>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface SaveTemplateProps {
  /** 창 제목과 버튼 글자 */
  heading: string;
  submitLabel: string;
  initialName: string;
  initialDescription?: string;
  /** 관리자에게만 '회사 템플릿으로' 칸을 보인다 */
  canMakeOfficial: boolean;
  initialOfficial?: boolean;
  note?: string;
  onCancel: () => void;
  onSave: (input: { name: string; description: string; official: boolean }) => void;
}

/** 템플릿 이름·설명을 정하는 창. 새 템플릿, 프로젝트를 템플릿으로 저장, 내 템플릿으로 복사, 이름 바꾸기에 함께 쓴다. */
export function SaveTemplateDialog({ heading, submitLabel, initialName, initialDescription = '', canMakeOfficial, initialOfficial = false, note, onCancel, onSave }: SaveTemplateProps) {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [official, setOfficial] = useState(initialOfficial);
  return (
    <Modal labelledBy="save-template-title" onClose={onCancel}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) onSave({ name: name.trim(), description, official });
        }}
      >
        <h2 id="save-template-title" className="modal__title">
          {heading}
        </h2>
        {note && <p className="panel-note">{note}</p>}
        <div className="panel-section is-tight">
          <label className="field-label" htmlFor="template-name">
            템플릿 이름
          </label>
          <input id="template-name" className="input" value={name} maxLength={100} autoFocus onChange={(event) => setName(event.target.value)} />
        </div>
        <div className="panel-section is-tight">
          <label className="field-label" htmlFor="template-description">
            설명
          </label>
          <textarea
            id="template-description"
            className="input"
            rows={2}
            value={description}
            placeholder="어떤 일에 쓰는 템플릿인지"
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>
        {canMakeOfficial && (
          <label className="check-row">
            <input type="checkbox" checked={official} onChange={(event) => setOfficial(event.target.checked)} />
            회사 템플릿으로 (모든 사람이 보고 쓰며, 관리자만 고침)
          </label>
        )}
        <div className="modal__actions">
          <button type="button" className="button" onClick={onCancel}>
            취소
          </button>
          <button type="submit" className="button primary" disabled={!name.trim()}>
            {submitLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

interface ManagerProps {
  templates: TemplateSummaryDto[];
  user: UserDto | null;
  /** 지금 보고 있는 프로젝트(템플릿으로 저장할 대상). 템플릿을 보고 있으면 null */
  currentProject: ProjectDto | null;
  onClose: () => void;
  onOpen: (templateId: string) => void;
  onNew: () => void;
  onSaveProject: () => void;
  onCopy: (template: TemplateSummaryDto) => void;
  onDelete: (template: TemplateSummaryDto) => void;
}

/** 템플릿 관리: 회사 템플릿과 내 템플릿을 탭으로 나눠 보고, 열기·복사·삭제한다. */
export function TemplatesDialog({ templates, user, currentProject, onClose, onOpen, onNew, onSaveProject, onCopy, onDelete }: ManagerProps) {
  const { company, mine, others } = groupTemplates(templates, user);
  const tabs = [
    { key: 'company', title: '회사 템플릿', hint: '모든 사람이 보고 씁니다. 관리자만 고칩니다.', items: company, empty: '회사 템플릿이 없습니다.' },
    { key: 'mine', title: '내 템플릿', hint: '나만 보고 고칩니다.', items: mine, empty: '내 템플릿이 없습니다. 새로 만들거나 회사 템플릿을 복사해 고쳐 쓰세요.' },
    ...(others.length > 0 ? [{ key: 'others', title: '다른 사람의 템플릿', hint: '관리자에게만 보입니다.', items: others, empty: '' }] : []),
  ];
  const [active, setActive] = useState(company.length === 0 && mine.length > 0 ? 'mine' : 'company');
  const tab = tabs.find((item) => item.key === active) ?? tabs[0];
  return (
    <Modal labelledBy="templates-title" onClose={onClose} wide>
      <h2 id="templates-title" className="modal__title">
        템플릿
      </h2>
      <div className="template-manager__top">
        <div className="segmented-tabs" role="tablist" aria-label="템플릿 구분">
          {tabs.map((item) => (
            <button key={item.key} type="button" role="tab" aria-selected={item.key === tab.key} onClick={() => setActive(item.key)}>
              {item.title} {item.items.length}
            </button>
          ))}
        </div>
        <div className="button-row">
          <button type="button" className="button" onClick={onNew}>
            <PlusIcon />새 템플릿
          </button>
          {currentProject && (
            <button type="button" className="button" onClick={onSaveProject} title={`‘${currentProject.name}’의 공정과 연결을 템플릿으로 저장합니다`}>
              지금 프로젝트를 템플릿으로 저장
            </button>
          )}
        </div>
      </div>
      <section className="modal__block" role="tabpanel" aria-label={tab.title}>
        <p className="panel-note is-small">{tab.hint}</p>
        {tab.items.length === 0 ? (
          <p className="panel-note">{tab.empty}</p>
        ) : (
          <ul className="template-rows">
            {tab.items.map((item) => (
              <li key={item.id}>
                <div className="template-rows__main">
                  <b>{item.name}</b>
                  <span className="panel-note is-small">
                    {meta(item)} · 이 템플릿으로 만든 프로젝트 {item.usedBy}개
                    {tab.key === 'others' && item.template.ownerName ? ` · ${item.template.ownerName}` : ''}
                  </span>
                </div>
                {/* 줄마다 버튼 수가 달라도 같은 자리에 오도록 칸을 고정한다(삭제가 없으면 빈 칸) */}
                <div className="template-rows__actions">
                  <button type="button" className="button small" onClick={() => onOpen(item.id)}>
                    {item.canEdit ? '열어서 고치기' : '열어 보기'}
                  </button>
                  <button type="button" className="button small" onClick={() => onCopy(item)}>
                    내 템플릿으로 복사
                  </button>
                  {item.canEdit ? (
                    <button type="button" className="button small danger" onClick={() => onDelete(item)}>
                      삭제
                    </button>
                  ) : (
                    <span aria-hidden="true" />
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <div className="modal__actions">
        <button type="button" className="button" onClick={onClose}>
          닫기
        </button>
      </div>
    </Modal>
  );
}

/** 템플릿 삭제 확인 */
export function DeleteTemplateDialog({ template, onCancel, onConfirm }: { template: TemplateSummaryDto; onCancel: () => void; onConfirm: () => void }) {
  return (
    <Modal labelledBy="delete-template-title" onClose={onCancel}>
      <h2 id="delete-template-title" className="modal__title">
        ‘{template.name}’ 템플릿을 삭제할까요?
      </h2>
      <p className="panel-note">
        {template.template.official ? '회사 템플릿' : '내 템플릿'}이며 공정 {template.taskCount}개가 들어 있습니다. 이 템플릿으로 만든 프로젝트{' '}
        {template.usedBy}개는 그대로 남고, 어느 템플릿으로 만들었는지도 계속 보입니다.
      </p>
      <div className="modal__actions">
        <button type="button" className="button" onClick={onCancel}>
          취소
        </button>
        <button type="button" className="button danger-solid" onClick={onConfirm}>
          삭제
        </button>
      </div>
    </Modal>
  );
}

interface TemplateBarProps {
  template: TemplateSummaryDto;
  user: UserDto | null;
  onNewProject: () => void;
  onCopy: () => void;
  onEditInfo: () => void;
  onToggleOfficial: () => void;
  onDelete: () => void;
}

/** 템플릿을 열었을 때 그래프 위에 뜨는 띠. 판, 독립성 안내, 이 템플릿으로 할 수 있는 일. */
export function TemplateBar({ template, user, onNewProject, onCopy, onEditInfo, onToggleOfficial, onDelete }: TemplateBarProps) {
  const { official, version } = template.template;
  const canCreateProject = !user || user.role !== 'viewer';
  return (
    <div className="template-bar">
      <TemplateChip official={official} />
      <span className="template-bar__text">
        {template.canEdit ? <b>템플릿 편집 중 · {version}판</b> : <b>{official ? '회사 템플릿' : '템플릿'} · {version}판 · 보기 전용</b>}
        {template.canEdit
          ? ` — 고쳐도 이 템플릿으로 이미 만든 프로젝트${template.usedBy > 0 ? ` ${template.usedBy}개` : ''}는 바뀌지 않습니다.`
          : ' — 관리자만 고칠 수 있습니다. 고쳐 쓰려면 내 템플릿으로 복사하세요.'}
      </span>
      <span className="template-bar__actions">
        {canCreateProject && (
          <button type="button" className="button small template-primary" onClick={onNewProject}>
            이 템플릿으로 새 프로젝트
          </button>
        )}
        <button type="button" className="button small" onClick={onCopy}>
          내 템플릿으로 복사
        </button>
        {template.canEdit && (
          <button type="button" className="button small" onClick={onEditInfo}>
            이름·설명
          </button>
        )}
        {user?.role === 'admin' && (
          <button type="button" className="button small" onClick={onToggleOfficial}>
            {official ? '회사 템플릿 해제' : '회사 템플릿으로 지정'}
          </button>
        )}
        {template.canEdit && (
          <button type="button" className="button small danger" onClick={onDelete}>
            삭제
          </button>
        )}
      </span>
    </div>
  );
}
