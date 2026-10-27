import type {
  DeleteTaskResult,
  DependencyDto,
  GraphDto,
  MoveTaskInput,
  MoveTaskResult,
  Problem,
  ProjectDto,
  TaskChangeResult,
  TaskInput,
  TrialStatus,
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

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  const dataset = readSession(DATASET_KEY);
  try {
    response = await fetch(path, {
      method,
      headers: {
        'x-tevro-sandbox': sandboxId,
        ...(dataset ? { 'x-tevro-dataset': dataset } : {}),
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
    throw new ApiFailure((data as Problem | undefined) ?? { status: response.status, code: 'INTERNAL', detail: response.statusText });
  }
  return data as T;
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
  trialStatus: () => trialRequest('GET', '/api/v1/trial'),
  /** 이 창의 데이터를 그 예시 데이터의 처음 상태로 바꾼다 */
  resetTrial: (dataset: string) => trialRequest('POST', '/api/v1/trial/reset', { dataset }),
};
