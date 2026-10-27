import type { ErrorCode, Problem } from '../shared/types.ts';

const TITLES: Record<ErrorCode, string> = {
  VALIDATION_INPUT: '입력 오류',
  VALIDATION_SELF_LOOP: '자기 자신 연결',
  VALIDATION_DUPLICATE_EDGE: '중복 연결',
  VALIDATION_CYCLE: '순환 연결',
  REFERENCE_NOT_FOUND: '참조한 공정 없음',
  CROSS_PROJECT_REFERENCE: '다른 프로젝트의 공정',
  HIERARCHY_CYCLE: '계층 고리',
  CROSS_LEVEL_DEPENDENCY: '다른 층 공정 연결',
  HAS_DEPENDENCIES: '연결이 남은 공정 이동',
  NOT_FOUND: '대상 없음',
  UNAUTHORIZED: '인증 필요',
  TRIAL_SESSION_REQUIRED: '체험 창 정보 없음',
  INTERNAL: '서버 오류',
};

/** 클라이언트에 그대로 돌려줄 오류. 응답은 application/problem+json 모양이다. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly extra: Partial<Problem>;

  constructor(status: number, code: ErrorCode, detail: string, extra: Partial<Problem> = {}) {
    super(detail);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }

  toProblem(): Problem {
    return { status: this.status, code: this.code, title: TITLES[this.code], detail: this.message, ...this.extra };
  }
}

export function invalidInput(detail: string): ApiError {
  return new ApiError(422, 'VALIDATION_INPUT', detail);
}

export function internalError(): ApiError {
  return new ApiError(500, 'INTERNAL', '서버에서 예상하지 못한 오류가 났습니다. 서버 로그를 확인하세요.');
}
