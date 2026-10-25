// 서버·웹·CLI가 함께 쓰는 공정 규칙. 저장 여부는 서버만 판정하고, 웹·CLI는 같은 함수를 표시에만 쓴다.

export const TASK_STATUSES = ['todo', 'in-progress', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: '미착수',
  'in-progress': '진행 중',
  done: '완료',
};

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value);
}

/** `from → to`는 from이 to의 선행 공정이라는 뜻이다. */
export interface Edge {
  from: string;
  to: string;
}

export interface TaskLike {
  id: string;
  status: TaskStatus;
}

export interface Prerequisites {
  predecessorIds: string[];
  successorIds: string[];
  /** 아직 완료되지 않은 직접 선행 공정 */
  unmetPrerequisiteIds: string[];
  prerequisitesMet: boolean;
}

export interface Summary {
  total: number;
  todo: number;
  inProgress: number;
  done: number;
}

/**
 * from → to 연결을 더했을 때 생기는 순환 경로를 돌려준다. 순환이 없으면 null.
 * 경로는 [from, to, …, from] 꼴이다(예: A → B가 있을 때 B → A를 더하면 [B, A, B]).
 */
export function findCycle(edges: readonly Edge[], from: string, to: string): string[] | null {
  if (from === to) return [from, to];
  const successors = adjacency(edges, 'down');
  // to에서 출발해 from에 닿으면 새 연결과 합쳐 순환이 된다.
  const previous = new Map<string, string>();
  const queue = [to];
  const seen = new Set([to]);
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (node === from) {
      const path = [from];
      for (let step = from; step !== to; ) {
        step = previous.get(step)!;
        path.push(step);
      }
      return [from, ...path.reverse()];
    }
    for (const next of successors.get(node) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      previous.set(next, node);
      queue.push(next);
    }
  }
  return null;
}

/** start에서 연결을 따라 닿는 공정들(start 제외). 'up'은 선행 쪽, 'down'은 후속 쪽이다. */
export function reachable(edges: readonly Edge[], start: string, direction: 'up' | 'down'): Set<string> {
  const next = adjacency(edges, direction);
  const found = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    for (const id of next.get(stack.pop()!) ?? []) {
      if (id === start || found.has(id)) continue;
      found.add(id);
      stack.push(id);
    }
  }
  return found;
}

/** 각 공정의 직접 선행·후속과 선행 조건 충족 여부. 실행 상태와 별개로 계산한다(PRD §6.4). */
export function analyzePrerequisites(tasks: readonly TaskLike[], edges: readonly Edge[]): Map<string, Prerequisites> {
  const statusById = new Map(tasks.map((task) => [task.id, task.status]));
  const result = new Map<string, Prerequisites>(
    tasks.map((task) => [
      task.id,
      { predecessorIds: [], successorIds: [], unmetPrerequisiteIds: [], prerequisitesMet: true },
    ]),
  );
  for (const { from, to } of edges) {
    result.get(from)?.successorIds.push(to);
    const target = result.get(to);
    if (!target) continue;
    target.predecessorIds.push(from);
    if (statusById.get(from) !== 'done') target.unmetPrerequisiteIds.push(from);
  }
  for (const info of result.values()) info.prerequisitesMet = info.unmetPrerequisiteIds.length === 0;
  return result;
}

export function summarize(tasks: readonly TaskLike[]): Summary {
  const summary: Summary = { total: tasks.length, todo: 0, inProgress: 0, done: 0 };
  for (const task of tasks) {
    if (task.status === 'todo') summary.todo += 1;
    else if (task.status === 'in-progress') summary.inProgress += 1;
    else summary.done += 1;
  }
  return summary;
}

/** taskId를 지우면 순서 정보가 사라지는 (직접 선행, 직접 후속) 쌍. 자동으로 다시 잇지는 않는다(ADR-0005). */
export function brokenPaths(edges: readonly Edge[], taskId: string): Edge[] {
  const predecessors = edges.filter((edge) => edge.to === taskId).map((edge) => edge.from);
  const successors = edges.filter((edge) => edge.from === taskId).map((edge) => edge.to);
  const remaining = edges.filter((edge) => edge.from !== taskId && edge.to !== taskId);
  const broken: Edge[] = [];
  for (const from of predecessors) {
    const stillReached = reachable(remaining, from, 'down');
    for (const to of successors) {
      if (!stillReached.has(to)) broken.push({ from, to });
    }
  }
  return broken;
}

/** Jira 이슈 주소에서 이슈 키(예: SVC-142)를 꺼낸다. 찾지 못하면 null. */
export function jiraKeyFromUrl(url: string): string | null {
  return /[A-Z][A-Z0-9_]+-\d+/.exec(url)?.[0] ?? null;
}

export function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function adjacency(edges: readonly Edge[], direction: 'up' | 'down'): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const { from, to } of edges) {
    const [key, value] = direction === 'down' ? [from, to] : [to, from];
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  }
  return map;
}
