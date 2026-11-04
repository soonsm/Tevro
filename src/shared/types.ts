// 서버 API(/api/v1)의 요청·응답 모양. 웹과 CLI가 같은 타입을 쓴다.
import type { Edge, Inconsistency, InheritedPredecessor, Summary, TaskStatus, TransitionCause } from './domain.ts';

export interface ProjectDto {
  id: string;
  name: string;
  description: string;
  /** project: 실제 프로젝트, template: 템플릿(진행 상태가 없고, 프로젝트를 만드는 데 씀) */
  kind: 'project' | 'template';
  /** 템플릿일 때만 */
  template?: TemplateInfo;
  /** 템플릿으로 만든 프로젝트면 그 출처(F-T09). 템플릿을 지워도 남는다 */
  source: TemplateSource | null;
  createdAt: string;
  updatedAt: string;
}

export interface TemplateInfo {
  /** 공용 템플릿(공식). 모두가 보고 쓰며 관리자만 고친다. false면 owner의 개인 템플릿 */
  official: boolean;
  /** 만든 사람(개인 템플릿의 주인). 체험 모드나 주인이 없으면 null */
  ownerId: string | null;
  ownerName: string | null;
  /** 판. 공정·연결·이름을 바꿀 때마다 1씩 오른다 */
  version: number;
}

export interface TemplateSource {
  templateId: string;
  name: string;
  version: number;
  appliedAt: string;
}

/** 템플릿 목록의 한 줄 */
export interface TemplateSummaryDto extends ProjectDto {
  kind: 'template';
  template: TemplateInfo;
  taskCount: number;
  dependencyCount: number;
  /** 이 템플릿으로 만든 프로젝트 수 */
  usedBy: number;
  /** 지금 사람이 고칠 수 있는지(공용 템플릿은 관리자, 내 템플릿은 주인) */
  canEdit: boolean;
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
  /** 기한(YYYY-MM-DD, 날짜만). 없으면 null */
  deadline: string | null;
  /** 담당자(Tevro 사용자). 없으면 null */
  assigneeId: string | null;
  assigneeName: string | null;
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
  /** 이 서버의 Jira 사이트 이슈에 연결돼 있으면 마지막 조회 결과. 상태·기한·담당자는 Jira가 원본이다 */
  jira: TaskJiraDto | null;
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
  /** 사람이 끌어서 옮겨 저장한 카드 위치. 없는 공정은 자동 배치 */
  positions: Record<string, { x: number; y: number }>;
  /** Jira 연결 설정과 마지막 조회(템플릿·체험 모드는 enabled: false) */
  jira: ProjectJiraDto;
}

/** 담당자로 고를 수 있는 사람(활성 사용자) */
export interface PersonDto {
  id: string;
  username: string;
  displayName: string;
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
  /** YYYY-MM-DD. null이나 빈 문자열이면 지움 */
  deadline?: string | null;
  /** 담당자 사용자 ID. null이나 빈 문자열이면 지움 */
  assigneeId?: string | null;
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
  | 'RATE_LIMITED'
  | 'JIRA_NOT_CONFIGURED'
  | 'JIRA_TOKEN_REQUIRED'
  | 'JIRA_AUTH'
  | 'JIRA_UNAVAILABLE'
  | 'JIRA_REJECTED'
  | 'JIRA_TRANSITION'
  | 'JIRA_CHANGED'
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
  /** 짝지은 Jira 사용자(name). Jira 토큰을 등록하면 채워지고, 관리자가 정할 수도 있다 */
  jiraName: string | null;
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
  /** 사용자가 아직 없어 첫 관리자를 만들어야 한다(웹은 로그인 대신 첫 설정 화면을 띄운다) */
  setupRequired: boolean;
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
  /** RATE_LIMITED: 다시 시도할 수 있을 때까지 남은 초(Retry-After 머리글과 같음) */
  retryAfter?: number;
  /** VALIDATION_CYCLE: 순환 경로의 공정 ID */
  cycle?: string[];
  /** HIERARCHY_CYCLE: 새 상위부터 옮기려는 공정까지 거슬러 올라간 조상 경로 */
  path?: string[];
  /** CROSS_LEVEL_DEPENDENCY: 선행·후속 공정의 상위 ID(최상위면 null) */
  parentIds?: (string | null)[];
  /** HAS_DEPENDENCIES: 남아 있는 연결 */
  dependencies?: Edge[];
  /** JIRA_UNAVAILABLE: 시간 초과였는지(만들기는 '결과 미확인'으로 둔다) */
  timeout?: boolean;
  /** JIRA_REJECTED: Jira의 HTTP 상태와 메시지 */
  jiraStatus?: number;
  jiraMessages?: string[];
  /** JIRA_CHANGED: 지금 Jira에 있는 값. 확인한 뒤 jiraConfirm: true로 다시 보낸다 */
  jira?: JiraValuesDto;
}

export type JiraStatusCategory = 'new' | 'indeterminate' | 'done';

/** 연결된 공정에서 Jira가 원본인 값(상태·기한·담당자)을 Tevro 쪽 값으로 바꾼 것 */
export interface JiraValuesDto {
  key: string;
  status: TaskStatus | null;
  statusName: string;
  deadline: string | null;
  /** 짝지은 Tevro 사용자. 짝이 없으면 null이고 assigneeName에 Jira 표시 이름 */
  assigneeId: string | null;
  assigneeName: string | null;
}

/** 공정에 연결된 Jira 이슈(이 서버의 Jira 사이트 이슈일 때만). 마지막 조회 결과다 */
export interface TaskJiraDto {
  key: string;
  url: string;
  statusName: string | null;
  statusCategory: JiraStatusCategory | null;
  summary: string | null;
  /** Jira 담당자 표시 이름(짝지은 Tevro 사용자가 없어도 보인다) */
  assigneeName: string | null;
  /** Jira 담당자가 Tevro 사용자와 짝지어지지 않았는지 */
  assigneeUnmapped: boolean;
  fetchedAt: string | null;
  fetchedBy: string | null;
  /** 마지막 조회에서 이 이슈만 실패했으면 그 이유 */
  error: string | null;
}

/** 프로젝트의 Jira 연결 설정과 마지막 조회. 서버에 Jira가 없으면 enabled: false */
export interface ProjectJiraDto {
  enabled: boolean;
  siteUrl: string | null;
  projectKey: string | null;
  issueTypeId: string | null;
  issueTypeName: string | null;
  /** Tevro 상태 → Jira 상태(Tevro에서 바꿀 때 이 상태로 옮긴다) */
  statusMap: Partial<Record<TaskStatus, { id: string; name: string }>>;
  /** 선후관계를 남길 링크 유형 이름. 없으면 링크를 만들지 않는다 */
  linkType: string | null;
  lastRefreshAt: string | null;
  lastRefreshBy: string | null;
  lastRefreshError: string | null;
}

/** 이슈를 만들 때 Tevro가 채우지 못해 사람에게 묻는 Jira 필수 필드(사이트마다 다르다) */
export interface JiraCreateFieldDto {
  id: string;
  name: string;
  type: 'number' | 'string' | 'date' | 'option' | 'options';
  /** option·options에서 고를 값 */
  options?: { id: string; name: string }[];
  /** 기본값: 이 프로젝트에서 마지막에 쓴 값, 없으면 Jira 기본값 */
  default: unknown;
}

export interface JiraCreateMetaDto {
  projectKey: string;
  /** 고를 수 있는 이슈 유형(하위 작업 유형 제외) */
  issueTypes: { id: string; name: string }[];
  issueTypeId: string;
  fields: JiraCreateFieldDto[];
  /** Tevro가 다룰 수 없는 형식의 필수 필드(있으면 이 유형으로는 만들 수 없다) */
  unsupported: string[];
  /** 만들기 화면에 있어 Tevro가 넘기는 값 */
  fills: { description: boolean; duedate: boolean; assignee: boolean; reporter: boolean };
}

export interface JiraCreateItemResult {
  taskId: string;
  title: string;
  /** will-create: 미리 보기에서 만들 예정. recovered: 응답을 못 받았던 생성을 찾아 연결함. unknown: 시간 초과로 결과를 모름 */
  state: 'will-create' | 'created' | 'recovered' | 'skipped' | 'failed' | 'unknown';
  issueKey: string | null;
  issueTypeName: string | null;
  detail: string | null;
}

export interface JiraLinkResult {
  from: string;
  to: string;
  fromKey: string | null;
  toKey: string | null;
  state: 'will-create' | 'created' | 'exists' | 'skipped' | 'needs-issue' | 'failed';
  detail: string | null;
}

export interface JiraCreateResultDto {
  dryRun: boolean;
  projectKey: string;
  items: JiraCreateItemResult[];
  links: JiraLinkResult[];
  /** 실제로 만들었으면 바뀐 그래프 */
  graph?: GraphDto;
}

/** 내 Jira 연결(개인 액세스 토큰). 토큰 값은 주지 않는다 */
export interface JiraTokenStatusDto {
  /** 서버에 Jira 사이트가 설정됐는지 */
  enabled: boolean;
  siteUrl: string | null;
  /** 서버에 비밀키가 있어 토큰을 저장할 수 있는지 */
  storage: boolean;
  connected: boolean;
  jiraName: string | null;
  jiraDisplayName: string | null;
  registeredAt: string | null;
  lastUsedAt: string | null;
  /** 저장한 토큰을 풀 수 없을 때(서버 비밀키가 바뀜) */
  problem: string | null;
}
