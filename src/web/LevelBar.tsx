import { ancestorIds, type InheritedPredecessor } from '../shared/domain.ts';
import type { GraphDto } from '../shared/types.ts';
import { ChevronRightIcon, StackIcon, StatusChip } from './icons.tsx';

interface Props {
  graph: GraphDto;
  /** 보고 있는 층의 상위 공정 */
  levelId: string;
  /** 다른 층으로 간다. selected는 그 층에서 골라 둘 공정(방금 나온 공정) */
  onOpenLevel: (levelId: string | null, selected?: string | null) => void;
  /** 공정을 오른쪽 패널에 보여 준다(그 공정이 있는 층으로 가지 않음) */
  onShowTask: (taskId: string) => void;
  /** 공정이 있는 층으로 가서 고른다 */
  onFocusTask: (taskId: string) => void;
}

/** 하위 층에 들어갔을 때의 위치(경로)와, 이 층의 공정 모두가 물려받는 선행 공정(F-H04, F-H07). */
export function LevelBar({ graph, levelId, onOpenLevel, onShowTask, onFocusTask }: Props) {
  const byId = new Map(graph.tasks.map((task) => [task.id, task]));
  const owner = byId.get(levelId);
  if (!owner) return null;
  const chain = ancestorIds(graph.tasks, levelId).reverse(); // 최상위 쪽부터
  // 이 층 공정들이 물려받는 선행 = 상위 공정의 직접 선행 + 상위 공정이 물려받은 선행
  const inherited: InheritedPredecessor[] = [
    ...owner.predecessorIds.map((taskId) => ({ taskId, inheritedFrom: owner.id })),
    ...owner.inheritedPredecessors,
  ];
  return (
    <div className="levelbar">
      <nav className="breadcrumb" aria-label="공정 계층 위치">
        <ol>
          <li>
            <button type="button" className="crumb" onClick={() => onOpenLevel(null, chain[0] ?? levelId)}>
              {graph.project.name}
            </button>
          </li>
          {chain.map((id, index) => (
            <li key={id}>
              <ChevronRightIcon />
              <button type="button" className="crumb" onClick={() => onOpenLevel(id, chain[index + 1] ?? levelId)}>
                {byId.get(id)?.title}
              </button>
            </li>
          ))}
          <li className="breadcrumb__current">
            <ChevronRightIcon />
            <button
              type="button"
              className="crumb is-current"
              aria-current="location"
              title="이 상위 공정의 정보를 오른쪽에 봅니다"
              onClick={() => onShowTask(owner.id)}
            >
              {owner.title}
            </button>
            <StatusChip status={owner.status} />
            <span className="levelbar__count" title="완료된 하위 공정 / 전체 하위 공정">
              <StackIcon />
              하위 {owner.doneChildCount}/{owner.childCount}
            </span>
          </li>
        </ol>
      </nav>
      {inherited.length > 0 && (
        <div className="levelbar__inherited">
          <span className="field-label">이 층 전체의 선행</span>
          <ul>
            {inherited.map(({ taskId, inheritedFrom }) => {
              const predecessor = byId.get(taskId);
              if (!predecessor) return null;
              return (
                <li key={`${inheritedFrom}>${taskId}`}>
                  <button
                    type="button"
                    className="link-button is-small"
                    title={`${byId.get(inheritedFrom)?.title}의 선행 공정`}
                    onClick={() => onFocusTask(taskId)}
                  >
                    {predecessor.title}
                  </button>
                  <StatusChip status={predecessor.status} />
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
