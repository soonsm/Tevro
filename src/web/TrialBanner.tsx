import type { TrialStatus } from '../shared/types.ts';
import { InfoIcon } from './icons.tsx';

/** 체험 서버에서만 보이는 띠. 예시 데이터를 고르면 이 창의 데이터를 그 예시의 처음 상태로 바꾼다(지금 것을 다시 누르면 처음으로). */
export function TrialBanner({ trial, onChoose }: { trial: TrialStatus; onChoose: (dataset: string) => void }) {
  return (
    <div className="trial-bar" role="region" aria-label="체험 모드">
      <InfoIcon />
      <p className="trial-bar__text">
        <strong>체험 모드</strong>
        바꾼 내용은 이 창에서만 유지되고, 창을 닫았다 다시 열면 처음 데이터로 돌아갑니다.
      </p>
      <div className="trial-bar__choices" role="group" aria-label="예시 데이터">
        <span className="trial-bar__label">예시 데이터</span>
        {trial.datasets.map((dataset) => {
          const active = dataset.key === trial.dataset;
          return (
            <button
              key={dataset.key}
              type="button"
              className="trial-choice"
              aria-pressed={active}
              title={active ? '처음 상태로 다시 불러옵니다' : '이 예시 데이터로 바꿉니다'}
              onClick={() => onChoose(dataset.key)}
            >
              {dataset.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
