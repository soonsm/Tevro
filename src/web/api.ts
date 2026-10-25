import type {
  DeleteTaskResult,
  DependencyDto,
  GraphDto,
  Problem,
  ProjectDto,
  TaskDto,
  TaskInput,
} from '../shared/types.ts';

/** 서버가 거부했거나 서버에 닿지 못한 요청. 서버 오류면 problem에 서버 응답이 그대로 들어 있다. */
export class ApiFailure extends Error {
  readonly problem: Pick<Problem, 'status' | 'detail' | 'cycle'> & { code: string };

  constructor(problem: ApiFailure['problem']) {
    super(problem.detail);
    this.problem = problem;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
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

export const api = {
  listProjects: () => request<ProjectDto[]>('GET', '/api/v1/projects'),
  createProject: (name: string) => request<ProjectDto>('POST', '/api/v1/projects', { name }),
  getGraph: (projectId: string) => request<GraphDto>('GET', `/api/v1/projects/${id(projectId)}/graph`),
  createTask: (projectId: string, input: TaskInput) =>
    request<TaskDto>('POST', `/api/v1/projects/${id(projectId)}/tasks`, input),
  updateTask: (taskId: string, input: TaskInput) => request<TaskDto>('PATCH', `/api/v1/tasks/${id(taskId)}`, input),
  deleteTask: (taskId: string) => request<DeleteTaskResult>('DELETE', `/api/v1/tasks/${id(taskId)}`),
  addDependency: (projectId: string, from: string, to: string) =>
    request<DependencyDto>('POST', `/api/v1/projects/${id(projectId)}/dependencies`, { from, to }),
  removeDependency: (projectId: string, from: string, to: string) =>
    request<DependencyDto>(
      'DELETE',
      `/api/v1/projects/${id(projectId)}/dependencies?${new URLSearchParams({ from, to })}`,
    ),
};
