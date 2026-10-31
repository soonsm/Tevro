// 서버 API(/api/v1)의 요청·응답 모양. 웹과 CLI가 같은 타입을 쓴다.
import type { Edge, Inconsistency, InheritedPredecessor, Summary, TaskStatus, TransitionCause } from './domain.ts';

export interface ProjectDto {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface TaskDto {
  id: string;
  projectId: string;
  /** 상위 공정 ID. 최상위면 null. 바꿀 때는 move를 쓴다 */
  parentId: string | null;
  title: string;
  description: string;
  status: TaskStatus;
  jiraUrl: string | null;
  /** jiraUrl에서 꺼낸 이슈 키. 저장하지 않고 응답할 때 계산한다. */
  jiraKey: string | null;
  confluenceUrl: string | null;
  // 여기서부터 updatedAt 앞까지는 저장하지 않고 응답할 때 계산한다.
  /** 같은 층의 직접 선행·후속 공정 */
  predecessorIds: string[];
  successorIds: string[];
  /** 조상에 맺힌 선행관계에서 물려받은 선행 공정 */
  inheritedPredecessors: InheritedPredecessor[];
  /** 완료되지 않은 선행 공정(직접 + 물려받은 것) */
  unmetPrerequisiteIds: string[];
  prerequisitesMet: boolean;
  /** 직접 하위 공정 수와 그중 완료 수 */
  childCount: number;
  doneChildCount: number;
  /** 상위·하위 상태 어긋남. 없으면 null */
  inconsistency: Inconsistency | null;
  createdAt: string;
  updatedAt: string;
}

export type DependencyDto = Edge;

export interface GraphDto {
  project: ProjectDto;
  tasks: TaskDto[];
  dependencies: DependencyDto[];
  /** 말단 공정(하위가 없는 공정) 기준 상태별 개수 */
  summary: Summary;
}

/** 하위 공정 때문에 자동으로 상태가 바뀐 상위 공정 */
export interface AutoTransition {
  taskId: string;
  title: string;
  status: TaskStatus;
  cause: TransitionCause;
}

/** 공정을 만들거나 고친 결과. 그 바람에 상위 공정이 자동으로 바뀌었으면 autoTransitions에 담는다. */
export interface TaskChangeResult {
  task: TaskDto;
  autoTransitions: AutoTransition[];
}

export interface MoveTaskResult extends TaskChangeResult {
  /** 이동과 함께 지운 연결 */
  removedDependencies: DependencyDto[];
}

export interface DeleteTaskResult {
  deletedTaskId: string;
  /** 함께 지워진 자손 공정 */
  removedTasks: { id: string; parentId: string | null; title: string }[];
  /** 지운 공정과 자손 공정의 연결 */
  removedDependencies: DependencyDto[];
  autoTransitions: AutoTransition[];
}

/** 공정을 만들거나 고칠 때 보내는 값. 링크는 빈 문자열이나 null을 보내면 지운다. */
export interface TaskInput {
  title?: string;
  description?: string;
  status?: TaskStatus;
  jiraUrl?: string | null;
  confluenceUrl?: string | null;
  /** 만들 때만 받는다. null이나 생략이면 최상위 */
  parentId?: string | null;
}

/** 상위 공정 바꾸기. 하위 공정도 함께 옮겨진다. */
export interface MoveTaskInput {
  /** 새 상위 공정. null이면 최상위 */
  parentId: string | null;
  /** 이동과 함께 지울 이 공정의 연결. 연결이 하나라도 남으면 HAS_DEPENDENCIES로 거부된다(F-H08) */
  removeDependencies?: DependencyDto[];
}

export type ErrorCode =
  | 'VALIDATION_INPUT'
  | 'VALIDATION_SELF_LOOP'
  | 'VALIDATION_DUPLICATE_EDGE'
  | 'VALIDATION_CYCLE'
  | 'REFERENCE_NOT_FOUND'
  | 'CROSS_PROJECT_REFERENCE'
  | 'HIERARCHY_CYCLE'
  | 'CROSS_LEVEL_DEPENDENCY'
  | 'HAS_DEPENDENCIES'
  | 'NOT_FOUND'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'ACCOUNT_LOCKED'
  | 'TRIAL_SESSION_REQUIRED'
  | 'INTERNAL';

/** 인스턴스 전체에 적용하는 역할(ADR-0004). 프로젝트별 권한은 없다. */
export type Role = 'viewer' | 'editor' | 'admin';

export interface UserDto {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  active: boolean;
  createdAt: string;
  lastLoginAt: string | null;
}

/** 지금 요청한 사람. 웹 세션이면 csrfToken이, 토큰이면 token이 있다. */
export interface MeDto {
  user: UserDto;
  /** 웹 세션: 상태를 바꾸는 요청의 x-tevro-csrf 머리글에 넣을 값 */
  csrfToken?: string;
  /** 개인 액세스 토큰으로 부른 경우 그 토큰 */
  token?: TokenDto;
}

/** 로그인 화면에 보일 로그인 방식. 지금은 로컬 계정만 있고, LDAP·SSO 등은 같은 자리에 더한다. */
export interface AuthConfigDto {
  providers: { id: string; label: string }[];
}

export type TokenScope = 'read' | 'read-write';

/** 개인 액세스 토큰(ADR-0004). 비밀값은 발급할 때 한 번만 CreatedTokenDto.token으로 준다. */
export interface TokenDto {
  id: string;
  name: string;
  scope: TokenScope;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
}

export interface CreatedTokenDto extends TokenDto {
  token: string;
}

/** 체험 모드(TEVRO_TRIAL=1): 고를 수 있는 예시 데이터와 이 창이 쓰는 것 */
export interface TrialStatus {
  datasets: { key: string; label: string }[];
  dataset: string;
  /** 이 창에서 데이터를 바꾼 적이 있는지. 예시 데이터를 다시 불러오기 전에 확인한다 */
  dirty: boolean;
}

/** 오류 응답(application/problem+json). 오류 종류에 따라 아래 확장 멤버가 붙는다. */
export interface Problem {
  status: number;
  code: ErrorCode;
  title: string;
  detail: string;
  /** VALIDATION_CYCLE: 순환 경로의 공정 ID */
  cycle?: string[];
  /** HIERARCHY_CYCLE: 새 상위부터 옮기려는 공정까지 거슬러 올라간 조상 경로 */
  path?: string[];
  /** CROSS_LEVEL_DEPENDENCY: 선행·후속 공정의 상위 ID(최상위면 null) */
  parentIds?: (string | null)[];
  /** HAS_DEPENDENCIES: 남아 있는 연결 */
  dependencies?: Edge[];
}
