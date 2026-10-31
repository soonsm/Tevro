import type {
  AuthConfigDto,
  CreatedTokenDto,
  DeleteTaskResult,
  DependencyDto,
  GraphDto,
  MeDto,
  MoveTaskInput,
  MoveTaskResult,
  Problem,
  ProjectDto,
  TaskChangeResult,
  Role,
  TaskInput,
  TemplateSummaryDto,
  TokenDto,
  TokenScope,
  TrialStatus,
  UserDto,
} from '../shared/types.ts';

/** 서버가 거부했거나 서버에 닿지 못한 요청. 서버 오류면 problem에 서버 응답이 그대로 들어 있다. */
export class ApiFailure extends Error {
  readonly problem: Pick<Problem, 'status' | 'detail' | 'cycle'> & { code: string };

  constructor(problem: ApiFailure['problem']) {
    super(problem.detail);
    this.problem = problem;
  }
}

// 체험 서버(TEVRO_TRIAL=1)는 브라우저 창마다 예시 데이터의 사본을 따로 둔다. 창마다 다른 체험 ID를 sessionStorage에 두어
// 새로고침해도 같은 사본을 쓰고, 창을 닫으면 버린다. 체험 서버가 아니면 서버가 이 머리글을 보지 않는다.
const SANDBOX_KEY = 'tevro.trial.sandbox';
const DATASET_KEY = 'tevro.trial.dataset';

function readSession(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSession(key: string, value: string): void {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // 저장소를 못 쓰면 이 페이지를 연 동안만 같은 사본을 쓴다.
  }
}

const sandboxId =
  readSession(SANDBOX_KEY) ??
  (() => {
    const id = [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    writeSession(SANDBOX_KEY, id);
    return id;
  })();

// 로그인 세션의 CSRF 값(ADR-0004). 로그인·내 정보 응답에서 받아 상태를 바꾸는 요청에 붙인다. 쿠키는 브라우저가 알아서 보낸다.
let csrfToken: string | null = null;
// 세션이 끝났을 때(401) 로그인 화면으로 돌려보낼 곳. App이 정한다.
let onSessionEnded: (() => void) | null = null;

export function whenSessionEnds(handler: (() => void) | null): void {
  onSessionEnded = handler;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  const dataset = readSession(DATASET_KEY);
  try {
    response = await fetch(path, {
      method,
      headers: {
        'x-tevro-sandbox': sandboxId,
        ...(dataset ? { 'x-tevro-dataset': dataset } : {}),
        ...(csrfToken && method !== 'GET' ? { 'x-tevro-csrf': csrfToken } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiFailure({ status: 0, code: 'NETWORK', detail: '서버가 켜져 있는지 확인한 뒤 새로고침하세요.' });
  }
  const text = await response.text();
  const data: unknown = text ? JSON.parse(text) : undefined;
  if (!response.ok) {
    const problem = (data as Problem | undefined) ?? { status: response.status, code: 'INTERNAL', detail: response.statusText };
    if (problem.code === 'UNAUTHENTICATED' && path !== '/api/v1/auth/login' && path !== '/api/v1/auth/me') onSessionEnded?.();
    throw new ApiFailure(problem);
  }
  return data as T;
}

async function session<T extends { csrfToken?: string }>(promise: Promise<T>): Promise<T> {
  const result = await promise;
  csrfToken = result.csrfToken ?? null;
  return result;
}

const id = encodeURIComponent;

/** 체험 서버가 아니면 null. 고른 예시 데이터를 기억해 두면, 사본이 지워졌을 때 서버가 같은 예시로 다시 만든다. */
async function trialRequest(method: string, path: string, body?: unknown): Promise<TrialStatus | null> {
  const status = await request<TrialStatus | undefined>(method, path, body);
  if (!status) return null;
  writeSession(DATASET_KEY, status.dataset);
  return status;
}

export const api = {
  listProjects: () => request<ProjectDto[]>('GET', '/api/v1/projects'),
  createProject: (name: string) => request<ProjectDto>('POST', '/api/v1/projects', { name }),
  getGraph: (projectId: string) => request<GraphDto>('GET', `/api/v1/projects/${id(projectId)}/graph`),
  createTask: (projectId: string, input: TaskInput) =>
    request<TaskChangeResult>('POST', `/api/v1/projects/${id(projectId)}/tasks`, input),
  updateTask: (taskId: string, input: TaskInput) =>
    request<TaskChangeResult>('PATCH', `/api/v1/tasks/${id(taskId)}`, input),
  moveTask: (taskId: string, input: MoveTaskInput) =>
    request<MoveTaskResult>('POST', `/api/v1/tasks/${id(taskId)}/move`, input),
  deleteTask: (taskId: string) => request<DeleteTaskResult>('DELETE', `/api/v1/tasks/${id(taskId)}`),
  addDependency: (projectId: string, from: string, to: string) =>
    request<DependencyDto>('POST', `/api/v1/projects/${id(projectId)}/dependencies`, { from, to }),
  removeDependency: (projectId: string, from: string, to: string) =>
    request<DependencyDto>(
      'DELETE',
      `/api/v1/projects/${id(projectId)}/dependencies?${new URLSearchParams({ from, to })}`,
    ),
  authConfig: () => request<AuthConfigDto>('GET', '/api/v1/auth/config'),
  /** 로그인한 사람. 로그인하지 않았으면 UNAUTHENTICATED로 실패한다 */
  me: () => session(request<MeDto>('GET', '/api/v1/auth/me')),
  login: (username: string, password: string) =>
    session(request<{ user: UserDto; csrfToken: string }>('POST', '/api/v1/auth/login', { username, password })),
  logout: async () => {
    await request<void>('POST', '/api/v1/auth/logout');
    csrfToken = null;
  },
  changePassword: (currentPassword: string, newPassword: string) =>
    request<void>('POST', '/api/v1/auth/password', { currentPassword, newPassword }),
  listTokens: () => request<TokenDto[]>('GET', '/api/v1/tokens'),
  createToken: (name: string, scope: TokenScope, expiresInDays: number) =>
    request<CreatedTokenDto>('POST', '/api/v1/tokens', { name, scope, expiresInDays }),
  revokeToken: (tokenId: string) => request<TokenDto>('DELETE', `/api/v1/tokens/${id(tokenId)}`),
  listUsers: () => request<UserDto[]>('GET', '/api/v1/users'),
  createUser: (input: { username: string; displayName: string; role: Role; password: string }) =>
    request<UserDto>('POST', '/api/v1/users', input),
  updateUser: (userId: string, input: { role?: Role; active?: boolean; displayName?: string }) =>
    request<UserDto>('PATCH', `/api/v1/users/${id(userId)}`, input),
  resetPassword: (userId: string, password: string) => request<void>('POST', `/api/v1/users/${id(userId)}/password`, { password }),
  listTemplates: () => request<TemplateSummaryDto[]>('GET', '/api/v1/templates'),
  createTemplate: (input: { name: string; description?: string; official?: boolean }) =>
    request<ProjectDto>('POST', '/api/v1/templates', input),
  /** 프로젝트나 템플릿을 복사해 새 템플릿으로 저장 */
  saveAsTemplate: (sourceId: string, input: { name: string; description?: string; official?: boolean }) =>
    request<ProjectDto>('POST', '/api/v1/templates/from', { sourceId, ...input }),
  updateTemplate: (templateId: string, input: { name?: string; description?: string; official?: boolean }) =>
    request<ProjectDto>('PATCH', `/api/v1/templates/${id(templateId)}`, input),
  deleteTemplate: (templateId: string) => request<ProjectDto>('DELETE', `/api/v1/templates/${id(templateId)}`),
  instantiate: (templateId: string, name: string) =>
    request<ProjectDto>('POST', `/api/v1/templates/${id(templateId)}/instantiate`, { name }),
  trialStatus: () => trialRequest('GET', '/api/v1/trial'),
  /** 이 창의 데이터를 그 예시 데이터의 처음 상태로 바꾼다 */
  resetTrial: (dataset: string) => trialRequest('POST', '/api/v1/trial/reset', { dataset }),
};
