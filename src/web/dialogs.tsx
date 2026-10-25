import { useEffect, useRef, useState, type ReactNode } from 'react';
import { brokenPaths } from '../shared/domain.ts';
import type { GraphDto, TaskDto } from '../shared/types.ts';
import { WarnIcon } from './icons.tsx';

function Modal({ labelledBy, onClose, children }: { labelledBy: string; onClose: () => void; children: ReactNode }) {
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

/** 공정 삭제 전에 함께 지워지는 연결과 순서가 끊기는 공정을 보여 준다(PRD F-P06, ADR-0005). */
export function DeleteTaskDialog({ task, graph, onCancel, onConfirm }: { task: TaskDto; graph: GraphDto; onCancel: () => void; onConfirm: () => void }) {
  const titles = new Map(graph.tasks.map((item) => [item.id, item.title]));
  const removed = graph.dependencies.filter((edge) => edge.from === task.id || edge.to === task.id);
  const broken = brokenPaths(graph.dependencies, task.id);
  return (
    <Modal labelledBy="delete-title" onClose={onCancel}>
      <h2 id="delete-title" className="modal__title">
        ‘{task.title}’ 공정을 삭제할까요?
      </h2>
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
