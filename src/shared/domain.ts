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
  /** 상위 공정 ID. 최상위면 null이고, 생략해도 최상위로 본다. */
  parentId?: string | null;
}

/** 조상에 맺힌 선행관계에서 물려받은 선행 공정(PRD §5.3 상속) */
export interface InheritedPredecessor {
  taskId: string;
  /** 이 선행관계가 직접 맺힌 조상 공정 */
  inheritedFrom: string;
}

export interface Prerequisites {
  /** 같은 층의 직접 선행 공정 */
  predecessorIds: string[];
  successorIds: string[];
  /** 조상들의 선행 공정. 가까운 조상의 것부터 */
  inheritedPredecessors: InheritedPredecessor[];
  /** 아직 완료되지 않은 선행 공정. 직접 선행과 물려받은 선행을 함께 본다 */
  unmetPrerequisiteIds: string[];
  prerequisitesMet: boolean;
}

/** 상위·하위 상태의 어긋남. 막지 않고 표시만 한다(PRD §6.9, F-H06). */
export type Inconsistency = 'PARENT_DONE_CHILD_OPEN' | 'CHILDREN_DONE_PARENT_OPEN';

export const INCONSISTENCY_LABELS: Record<Inconsistency, string> = {
  PARENT_DONE_CHILD_OPEN: '완료로 되어 있지만 완료되지 않은 하위 공정이 있습니다.',
  CHILDREN_DONE_PARENT_OPEN: '하위 공정이 모두 완료됐지만 이 공정은 완료가 아닙니다.',
};

export interface Hierarchy {
  childCount: number;
  doneChildCount: number;
  inconsistency: Inconsistency | null;
}

export type TransitionCause = 'CHILDREN_DONE' | 'CHILD_STARTED';

export const TRANSITION_LABELS: Record<TransitionCause, string> = {
  CHILDREN_DONE: '하위 공정이 모두 완료됨',
  CHILD_STARTED: '하위 공정이 착수됨',
};

/** 하위 공정의 상태 때문에 자동으로 바뀌는 상위 공정의 상태 */
export interface StatusTransition {
  taskId: string;
  status: TaskStatus;
  cause: TransitionCause;
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

/**
 * 각 공정의 직접 선행·후속, 조상에게서 물려받은 선행, 선행 조건 충족 여부. 실행 상태와 별개로 계산한다(PRD §6.4).
 * 하위 공정은 조상의 선행까지 완료돼야 충족이다. 상위 공정 자신은 직접 선행만 본다(F-H04).
 */
export function analyzePrerequisites(tasks: readonly TaskLike[], edges: readonly Edge[]): Map<string, Prerequisites> {
  const statusById = new Map(tasks.map((task) => [task.id, task.status]));
  const result = new Map<string, Prerequisites>(
    tasks.map((task) => [
      task.id,
      { predecessorIds: [], successorIds: [], inheritedPredecessors: [], unmetPrerequisiteIds: [], prerequisitesMet: true },
    ]),
  );
  for (const { from, to } of edges) {
    result.get(from)?.successorIds.push(to);
    result.get(to)?.predecessorIds.push(from);
  }
  const { parentOf } = hierarchyIndex(tasks);
  for (const task of tasks) {
    const info = result.get(task.id)!;
    for (const ancestor of ancestorChain(parentOf, task.id)) {
      for (const taskId of result.get(ancestor)!.predecessorIds) info.inheritedPredecessors.push({ taskId, inheritedFrom: ancestor });
    }
    const all = [...info.predecessorIds, ...info.inheritedPredecessors.map((item) => item.taskId)];
    info.unmetPrerequisiteIds = [...new Set(all.filter((id) => statusById.get(id) !== 'done'))];
    info.prerequisitesMet = info.unmetPrerequisiteIds.length === 0;
  }
  return result;
}

/** 직접이든 물려받았든 선행 공정이 하나라도 있는지 */
export function hasPrerequisites(prerequisites: Pick<Prerequisites, 'predecessorIds' | 'inheritedPredecessors'>): boolean {
  return prerequisites.predecessorIds.length > 0 || prerequisites.inheritedPredecessors.length > 0;
}

/** 상태별 공정 수. 하위가 있는 공정은 하위와 겹쳐 세지 않도록 빼고 말단 공정만 센다(F-H09). */
export function summarize(tasks: readonly TaskLike[]): Summary {
  const parents = new Set(tasks.map((task) => task.parentId).filter((id) => id != null));
  const summary: Summary = { total: 0, todo: 0, inProgress: 0, done: 0 };
  for (const task of tasks) {
    if (parents.has(task.id)) continue;
    summary.total += 1;
    if (task.status === 'todo') summary.todo += 1;
    else if (task.status === 'in-progress') summary.inProgress += 1;
    else summary.done += 1;
  }
  return summary;
}

/** 각 공정의 직접 하위 수와 완료 수, 상위·하위 상태 어긋남 */
export function analyzeHierarchy(tasks: readonly TaskLike[]): Map<string, Hierarchy> {
  const { childrenOf } = hierarchyIndex(tasks);
  const statusById = new Map(tasks.map((task) => [task.id, task.status]));
  return new Map(
    tasks.map((task) => {
      const children = childrenOf.get(task.id) ?? [];
      const doneChildCount = children.filter((id) => statusById.get(id) === 'done').length;
      let inconsistency: Inconsistency | null = null;
      if (children.length > 0 && task.status === 'done' && doneChildCount < children.length) {
        inconsistency = 'PARENT_DONE_CHILD_OPEN';
      } else if (children.length > 0 && task.status !== 'done' && doneChildCount === children.length) {
        inconsistency = 'CHILDREN_DONE_PARENT_OPEN';
      }
      return [task.id, { childCount: children.length, doneChildCount, inconsistency }];
    }),
  );
}

/**
 * 하위 상태에 맞춰 상위 상태를 앞으로만 옮긴다(PRD §6.9 자동 전이, §13-16 결정).
 * - 하위가 모두 완료되면 상위를 완료로(CHILDREN_DONE)
 * - 하위가 하나라도 진행 중이거나 완료인데 상위가 미착수면 진행 중으로(CHILD_STARTED)
 * 상위를 뒤로 되돌리지는 않는다. 어긋남은 analyzeHierarchy의 inconsistency로 표시한다.
 * changedParentIds: 하위의 상태가 바뀌었거나 하위가 빠진(삭제·이동) 상위. 두 규칙을 모두 적용한다.
 * addedParentIds: 하위가 새로 들어온(생성·이동) 상위. 하위가 늘었다고 일이 끝난 것은 아니므로 착수 규칙만 적용한다.
 *   완료 상태 하위를 먼저 넣었다고 상위가 완료되면, 나머지 하위를 넣기도 전에 후속 공정의 선행 조건이 충족돼 버린다.
 * 상위가 바뀌면 그 위 상위도 다시 본다.
 */
export function autoTransitions(
  tasks: readonly TaskLike[],
  changedParentIds: readonly (string | null | undefined)[],
  addedParentIds: readonly (string | null | undefined)[] = [],
): StatusTransition[] {
  const { parentOf, childrenOf } = hierarchyIndex(tasks);
  const statusById = new Map(tasks.map((task) => [task.id, task.status]));
  const changes = new Map<string, StatusTransition>();
  const known = (id: string | null | undefined): id is string => id != null && statusById.has(id);
  const queue = [
    ...changedParentIds.filter(known).map((id) => ({ id, startOnly: false })),
    ...addedParentIds.filter(known).map((id) => ({ id, startOnly: true })),
  ];
  while (queue.length > 0) {
    const { id, startOnly } = queue.shift()!;
    const childStatuses = (childrenOf.get(id) ?? []).map((child) => statusById.get(child));
    if (childStatuses.length === 0) continue;
    const current = statusById.get(id);
    let next: StatusTransition | null = null;
    if (!startOnly && current !== 'done' && childStatuses.every((status) => status === 'done')) {
      next = { taskId: id, status: 'done', cause: 'CHILDREN_DONE' };
    } else if (current === 'todo' && childStatuses.some((status) => status !== 'todo')) {
      next = { taskId: id, status: 'in-progress', cause: 'CHILD_STARTED' };
    }
    if (!next) continue;
    // 상태는 앞으로만 가므로 공정마다 최대 두 번 바뀌고 반복이 끝난다.
    statusById.set(id, next.status);
    changes.delete(id);
    changes.set(id, next);
    const parent = parentOf.get(id);
    if (parent) queue.push({ id: parent, startOnly: false });
  }
  return [...changes.values()];
}

/** taskId의 조상 ID. 가까운 상위부터 최상위 쪽으로 */
export function ancestorIds(tasks: readonly TaskLike[], taskId: string): string[] {
  return ancestorChain(hierarchyIndex(tasks).parentOf, taskId);
}

/** taskId 아래의 모든 공정 ID(taskId 제외). 위층부터 차례로 */
export function descendantIds(tasks: readonly TaskLike[], taskId: string): string[] {
  const { childrenOf } = hierarchyIndex(tasks);
  const found: string[] = [];
  const queue = [taskId];
  const seen = new Set(queue);
  while (queue.length > 0) {
    for (const child of childrenOf.get(queue.shift()!) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

/**
 * parentId를 taskId의 상위로 정하면 생기는 계층 고리. 없으면 null.
 * 경로는 새 상위에서 taskId까지 거슬러 올라간 조상 순서다(예: X 아래의 G로 X를 옮기면 [G, …, X]).
 */
export function findHierarchyCycle(tasks: readonly TaskLike[], taskId: string, parentId: string): string[] | null {
  if (parentId === taskId) return [taskId];
  const chain = ancestorIds(tasks, parentId);
  const index = chain.indexOf(taskId);
  return index === -1 ? null : [parentId, ...chain.slice(0, index + 1)];
}

/** 계층을 위에서부터 깊이 우선으로 펼친 순서. 같은 층 안에서는 받은 순서를 지키고, 상위가 목록에 없으면 맨 위층으로 본다. */
export function treeOrder<T extends TaskLike>(tasks: readonly T[]): { task: T; depth: number }[] {
  const ids = new Set(tasks.map((task) => task.id));
  const childrenOf = new Map<string | null, T[]>();
  for (const task of tasks) {
    const key = task.parentId != null && ids.has(task.parentId) ? task.parentId : null;
    const list = childrenOf.get(key);
    if (list) list.push(task);
    else childrenOf.set(key, [task]);
  }
  const rows: { task: T; depth: number }[] = [];
  const visit = (parent: string | null, depth: number) => {
    for (const task of childrenOf.get(parent) ?? []) {
      rows.push({ task, depth });
      visit(task.id, depth + 1);
    }
  };
  visit(null, 0);
  return rows;
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

function hierarchyIndex(tasks: readonly TaskLike[]) {
  const parentOf = new Map(tasks.map((task) => [task.id, task.parentId ?? null]));
  const childrenOf = new Map<string, string[]>();
  for (const task of tasks) {
    if (task.parentId == null) continue;
    const list = childrenOf.get(task.parentId);
    if (list) list.push(task.id);
    else childrenOf.set(task.parentId, [task.id]);
  }
  return { parentOf, childrenOf };
}

/** 가까운 상위부터 조상 ID. 데이터가 잘못돼 고리가 있어도 멈춘다. */
function ancestorChain(parentOf: ReadonlyMap<string, string | null>, taskId: string): string[] {
  const chain: string[] = [];
  let current = parentOf.get(taskId) ?? null;
  while (current !== null && parentOf.has(current) && current !== taskId && !chain.includes(current)) {
    chain.push(current);
    current = parentOf.get(current) ?? null;
  }
  return chain;
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
