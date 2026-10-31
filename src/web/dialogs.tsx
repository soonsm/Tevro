import { useEffect, useRef, useState, type ReactNode } from 'react';
import { brokenPaths, descendantIds, treeOrder, type Edge } from '../shared/domain.ts';
import type { GraphDto, TaskDto } from '../shared/types.ts';
import { WarnIcon } from './icons.tsx';

export function Modal({ labelledBy, onClose, children }: { labelledBy: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby={labelledBy}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      {children}
    </dialog>
  );
}

/** 공정 삭제 전에 함께 지워지는 하위 공정·연결과 순서가 끊기는 공정을 보여 준다(PRD F-P06, ADR-0005). */
export function DeleteTaskDialog({ task, graph, onCancel, onConfirm }: { task: TaskDto; graph: GraphDto; onCancel: () => void; onConfirm: () => void }) {
  const titles = new Map(graph.tasks.map((item) => [item.id, item.title]));
  const subtree = new Set(descendantIds(graph.tasks, task.id));
  const descendants = treeOrder(graph.tasks.filter((item) => subtree.has(item.id)));
  const removed = graph.dependencies.filter(
    (edge) => edge.from === task.id || edge.to === task.id || subtree.has(edge.from) || subtree.has(edge.to),
  );
  const broken = brokenPaths(graph.dependencies, task.id);
  return (
    <Modal labelledBy="delete-title" onClose={onCancel}>
      <h2 id="delete-title" className="modal__title">
        ‘{task.title}’ 공정을 삭제할까요?
      </h2>
      {descendants.length > 0 && (
        <div className="modal__block">
          <span className="field-label is-strong">함께 삭제되는 하위 공정 {descendants.length}개</span>
          <ul className="edge-list">
            {descendants.map(({ task: item, depth }) => (
              <li key={item.id} style={{ paddingLeft: 10 + depth * 16 }}>
                {item.title}
              </li>
            ))}
          </ul>
        </div>
      )}
      {removed.length === 0 ? (
        <p className="panel-note">연결된 공정이 없습니다.</p>
      ) : (
        <div className="modal__block">
          <span className="field-label is-strong">함께 삭제되는 연결 {removed.length}개</span>
          <ul className="edge-list">
            {removed.map((edge) => (
              <li key={`${edge.from}>${edge.to}`}>
                {titles.get(edge.from)} → {titles.get(edge.to)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {broken.length > 0 && (
        <div className="warning-box">
          <WarnIcon />
          <div>
            <p>이 공정을 지우면 아래 공정 사이의 순서 정보가 사라집니다. 필요하면 삭제 후 직접 다시 연결하세요.</p>
            <ul>
              {broken.map((edge) => (
                <li key={`${edge.from}>${edge.to}`}>
                  {titles.get(edge.from)} → {titles.get(edge.to)}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      <p className="panel-note">삭제는 되돌릴 수 없습니다.</p>
      <div className="modal__actions">
        <button type="button" className="button" onClick={onCancel} autoFocus>
          취소
        </button>
        <button type="button" className="button danger-solid" onClick={onConfirm}>
          삭제
        </button>
      </div>
    </Modal>
  );
}

interface MoveTaskDialogProps {
  task: TaskDto;
  graph: GraphDto;
  onCancel: () => void;
  onConfirm: (parentId: string | null, removeDependencies: Edge[]) => void;
}

/** 상위 공정 바꾸기. 연결은 같은 층 안에서만 맺으므로 연결이 있으면 지워질 연결을 먼저 보여 준다(F-H08, AC-32). */
export function MoveTaskDialog({ task, graph, onCancel, onConfirm }: MoveTaskDialogProps) {
  const [target, setTarget] = useState(task.parentId ?? '');
  const titles = new Map(graph.tasks.map((item) => [item.id, item.title]));
  // 자기 자신과 자기 하위 공정은 상위가 될 수 없다(F-H02).
  const excluded = new Set([task.id, ...descendantIds(graph.tasks, task.id)]);
  const options = treeOrder(graph.tasks).filter(({ task: item }) => !excluded.has(item.id));
  const parentId = target === '' ? null : target;
  const unchanged = parentId === task.parentId;
  const attached = graph.dependencies.filter((edge) => edge.from === task.id || edge.to === task.id);
  const detach = unchanged ? [] : attached;
  return (
    <Modal labelledBy="move-title" onClose={onCancel}>
      <h2 id="move-title" className="modal__title">
        ‘{task.title}’ 옮기기
      </h2>
      <div className="panel-section is-tight">
        <label className="field-label" htmlFor="move-target">
          새 상위 공정
        </label>
        <select id="move-target" className="select" value={target} onChange={(event) => setTarget(event.target.value)}>
          <option value="">최상위 (상위 공정 없음){task.parentId === null ? ' · 지금 위치' : ''}</option>
          {options.map(({ task: item, depth }) => (
            <option key={item.id} value={item.id}>
              {'\u00a0\u00a0\u00a0'.repeat(depth + 1)}
              {item.title}
              {item.id === task.parentId ? ' · 지금 위치' : ''}
            </option>
          ))}
        </select>
        <p className="panel-note is-small">하위 공정도 함께 옮겨집니다. 자기 자신과 그 하위 공정은 고를 수 없습니다.</p>
      </div>
      {detach.length > 0 && (
        <div className="warning-box">
          <WarnIcon />
          <div>
            <p>연결은 같은 상위 아래의 공정끼리만 맺을 수 있어, 옮기면 이 연결 {detach.length}개가 지워집니다.</p>
            <ul>
              {detach.map((edge) => (
                <li key={`${edge.from}>${edge.to}`}>
                  {titles.get(edge.from)} → {titles.get(edge.to)}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      <div className="modal__actions">
        <button type="button" className="button" onClick={onCancel}>
          취소
        </button>
        <button
          type="button"
          className={`button ${detach.length > 0 ? 'danger-solid' : 'primary'}`}
          disabled={unchanged}
          onClick={() => onConfirm(parentId, detach)}
        >
          {detach.length > 0 ? '연결 지우고 옮기기' : '옮기기'}
        </button>
      </div>
    </Modal>
  );
}

/** 체험 모드: 이 창에서 바꾼 내용이 있을 때, 예시 데이터를 새로 불러오기 전에 확인한다. */
export function SwitchDatasetDialog({ label, onCancel, onConfirm }: { label: string; onCancel: () => void; onConfirm: () => void }) {
  return (
    <Modal labelledBy="switch-dataset-title" onClose={onCancel}>
      <h2 id="switch-dataset-title" className="modal__title">
        예시 데이터를 새로 불러올까요?
      </h2>
      <p className="panel-note">‘{label}’의 처음 상태로 바뀌고, 이 창에서 바꾼 내용은 사라집니다.</p>
      <div className="modal__actions">
        <button type="button" className="button" onClick={onCancel} autoFocus>
          취소
        </button>
        <button type="button" className="button primary" onClick={onConfirm}>
          불러오기
        </button>
      </div>
    </Modal>
  );
}

export function NewProjectDialog({ onCancel, onCreate }: { onCancel: () => void; onCreate: (name: string) => void }) {
  const [name, setName] = useState('');
  return (
    <Modal labelledBy="new-project-title" onClose={onCancel}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim()) onCreate(name.trim());
        }}
      >
        <h2 id="new-project-title" className="modal__title">
          새 프로젝트
        </h2>
        <div className="panel-section is-tight">
          <label className="field-label" htmlFor="new-project-name">
            프로젝트 이름
          </label>
          <input
            id="new-project-name"
            className="input"
            value={name}
            maxLength={100}
            placeholder="예: 신규 서비스 준비"
            autoFocus
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="modal__actions">
          <button type="button" className="button" onClick={onCancel}>
            취소
          </button>
          <button type="submit" className="button primary" disabled={!name.trim()}>
            만들기
          </button>
        </div>
      </form>
    </Modal>
  );
}
