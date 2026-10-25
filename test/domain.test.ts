import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  analyzeHierarchy,
  analyzePrerequisites,
  ancestorIds,
  autoTransitions,
  brokenPaths,
  descendantIds,
  findCycle,
  findHierarchyCycle,
  isHttpUrl,
  jiraKeyFromUrl,
  reachable,
  summarize,
  treeOrder,
  type TaskLike,
} from '../src/shared/domain.ts';

describe('findCycle', () => {
  it('순환이 없으면 null', () => {
    assert.equal(findCycle([{ from: 'A', to: 'B' }], 'B', 'C'), null);
  });

  it('반대 방향 연결은 [새 선행, 새 후속, …, 새 선행] 경로로 알려 준다', () => {
    assert.deepEqual(findCycle([{ from: 'A', to: 'B' }], 'B', 'A'), ['B', 'A', 'B']);
  });

  it('여러 단계를 거치는 순환도 전체 경로를 돌려준다', () => {
    const edges = [
      { from: 'A', to: 'B' },
      { from: 'B', to: 'C' },
    ];
    assert.deepEqual(findCycle(edges, 'C', 'A'), ['C', 'A', 'B', 'C']);
  });

  it('갈래가 있어도 순환이 아니면 통과한다', () => {
    const edges = [
      { from: 'A', to: 'C' },
      { from: 'B', to: 'C' },
    ];
    assert.equal(findCycle(edges, 'A', 'B'), null);
  });
});

describe('analyzePrerequisites', () => {
  // PRD §5.1 예: A 완료, B 진행 중, C 미착수, A → C, B → C, D는 독립 공정
  const tasks: TaskLike[] = [
    { id: 'A', status: 'done' },
    { id: 'B', status: 'in-progress' },
    { id: 'C', status: 'todo' },
    { id: 'D', status: 'todo' },
  ];
  const edges = [
    { from: 'A', to: 'C' },
    { from: 'B', to: 'C' },
  ];

  it('완료되지 않은 직접 선행만 미충족으로 센다', () => {
    const c = analyzePrerequisites(tasks, edges).get('C')!;
    assert.deepEqual(c.predecessorIds, ['A', 'B']);
    assert.deepEqual(c.unmetPrerequisiteIds, ['B']);
    assert.equal(c.prerequisitesMet, false);
  });

  it('선행 공정이 없으면 충족으로 본다', () => {
    const d = analyzePrerequisites(tasks, edges).get('D')!;
    assert.deepEqual(d.predecessorIds, []);
    assert.equal(d.prerequisitesMet, true);
  });

  it('후속 공정도 함께 계산한다', () => {
    assert.deepEqual(analyzePrerequisites(tasks, edges).get('A')!.successorIds, ['C']);
  });
});

describe('reachable', () => {
  const edges = [
    { from: 'A', to: 'B' },
    { from: 'B', to: 'C' },
    { from: 'X', to: 'C' },
  ];

  it('선행 쪽으로 따라 올라간다', () => {
    assert.deepEqual([...reachable(edges, 'C', 'up')].sort(), ['A', 'B', 'X']);
  });

  it('후속 쪽으로 따라 내려간다', () => {
    assert.deepEqual([...reachable(edges, 'A', 'down')].sort(), ['B', 'C']);
  });
});

describe('brokenPaths', () => {
  it('A → B → C에서 B를 지우면 (A, C)가 끊긴다', () => {
    const edges = [
      { from: 'A', to: 'B' },
      { from: 'B', to: 'C' },
    ];
    assert.deepEqual(brokenPaths(edges, 'B'), [{ from: 'A', to: 'C' }]);
  });

  it('다른 경로가 남아 있으면 끊기지 않는다', () => {
    const edges = [
      { from: 'A', to: 'B' },
      { from: 'B', to: 'C' },
      { from: 'A', to: 'X' },
      { from: 'X', to: 'C' },
    ];
    assert.deepEqual(brokenPaths(edges, 'B'), []);
  });
});

describe('summarize', () => {
  it('상태별 개수를 센다', () => {
    const tasks: TaskLike[] = [
      { id: 'A', status: 'done' },
      { id: 'B', status: 'in-progress' },
      { id: 'C', status: 'todo' },
      { id: 'D', status: 'todo' },
    ];
    assert.deepEqual(summarize(tasks), { total: 4, todo: 2, inProgress: 1, done: 1 });
  });

  it('하위가 있는 공정은 빼고 말단 공정만 센다 (F-H09)', () => {
    const tasks: TaskLike[] = [
      { id: 'DEV', status: 'in-progress' },
      { id: 'X', status: 'done', parentId: 'DEV' },
      { id: 'Y', status: 'todo', parentId: 'DEV' },
    ];
    assert.deepEqual(summarize(tasks), { total: 2, todo: 1, inProgress: 0, done: 1 });
  });
});

// PRD §5.3 예: A → 개발, 개발 → B, 개발 아래 X·Y, X 아래 X1
const tree: TaskLike[] = [
  { id: 'A', status: 'todo' },
  { id: 'DEV', status: 'todo' },
  { id: 'B', status: 'todo' },
  { id: 'X', status: 'todo', parentId: 'DEV' },
  { id: 'Y', status: 'todo', parentId: 'DEV' },
  { id: 'X1', status: 'todo', parentId: 'X' },
];
const treeEdges = [
  { from: 'A', to: 'DEV' },
  { from: 'DEV', to: 'B' },
  { from: 'X', to: 'Y' },
];

describe('계층: 선행 상속 (F-H04, AC-28)', () => {
  const result = analyzePrerequisites(tree, treeEdges);

  it('하위는 조상의 선행을 가까운 조상부터 물려받는다', () => {
    assert.deepEqual(result.get('X1')!.inheritedPredecessors, [{ taskId: 'A', inheritedFrom: 'DEV' }]);
    assert.deepEqual(result.get('Y')!.predecessorIds, ['X']);
    assert.deepEqual(result.get('Y')!.inheritedPredecessors, [{ taskId: 'A', inheritedFrom: 'DEV' }]);
    assert.deepEqual(result.get('Y')!.unmetPrerequisiteIds, ['X', 'A']);
  });

  it('상위 자신과 상위를 선행으로 둔 공정은 직접 선행만 본다', () => {
    assert.deepEqual(result.get('DEV')!.inheritedPredecessors, []);
    assert.deepEqual(result.get('B')!.unmetPrerequisiteIds, ['DEV']);
  });

  it('물려받은 선행이 완료되면 충족이다', () => {
    const done = tree.map((task) => (task.id === 'A' ? { ...task, status: 'done' as const } : task));
    assert.equal(analyzePrerequisites(done, treeEdges).get('X')!.prerequisitesMet, true);
  });
});

describe('계층: 구조', () => {
  it('조상은 가까운 상위부터, 자손은 위층부터 돌려준다', () => {
    assert.deepEqual(ancestorIds(tree, 'X1'), ['X', 'DEV']);
    assert.deepEqual(descendantIds(tree, 'DEV'), ['X', 'Y', 'X1']);
    assert.deepEqual(descendantIds(tree, 'A'), []);
  });

  it('자기 자신이나 자손을 상위로 지정하면 고리 경로를 돌려준다 (AC-29)', () => {
    assert.deepEqual(findHierarchyCycle(tree, 'DEV', 'X1'), ['X1', 'X', 'DEV']);
    assert.deepEqual(findHierarchyCycle(tree, 'DEV', 'DEV'), ['DEV']);
    assert.equal(findHierarchyCycle(tree, 'X1', 'Y'), null);
  });

  it('트리 순서로 펼치고, 목록에 없는 상위의 하위는 맨 위층으로 본다', () => {
    assert.deepEqual(
      treeOrder(tree).map(({ task, depth }) => `${depth}:${task.id}`),
      ['0:A', '0:DEV', '1:X', '2:X1', '1:Y', '0:B'],
    );
    assert.deepEqual(
      treeOrder(tree.filter((task) => task.parentId === 'DEV')).map(({ task, depth }) => `${depth}:${task.id}`),
      ['0:X', '0:Y'],
    );
  });

  it('하위 수·완료 수와 상위·하위 모순을 계산한다 (F-H06)', () => {
    const tasks: TaskLike[] = [
      { id: 'P', status: 'done' },
      { id: 'P1', status: 'todo', parentId: 'P' },
      { id: 'Q', status: 'in-progress' },
      { id: 'Q1', status: 'done', parentId: 'Q' },
    ];
    const result = analyzeHierarchy(tasks);
    assert.deepEqual(result.get('P'), { childCount: 1, doneChildCount: 0, inconsistency: 'PARENT_DONE_CHILD_OPEN' });
    assert.deepEqual(result.get('Q'), { childCount: 1, doneChildCount: 1, inconsistency: 'CHILDREN_DONE_PARENT_OPEN' });
    assert.deepEqual(result.get('P1'), { childCount: 0, doneChildCount: 0, inconsistency: null });
  });
});

describe('계층: 자동 전이 (F-H05, §13-16)', () => {
  const family = (statuses: Record<string, TaskLike['status']>): TaskLike[] => [
    { id: 'TOP', status: statuses.TOP ?? 'todo' },
    { id: 'P', status: statuses.P ?? 'todo', parentId: 'TOP' },
    { id: 'C1', status: statuses.C1 ?? 'todo', parentId: 'P' },
    { id: 'C2', status: statuses.C2 ?? 'todo', parentId: 'P' },
  ];

  it('하위가 모두 완료되면 상위를 완료로 바꾸고 그 위로 이어 간다', () => {
    assert.deepEqual(autoTransitions(family({ C1: 'done', C2: 'done' }), ['P']), [
      { taskId: 'P', status: 'done', cause: 'CHILDREN_DONE' },
      { taskId: 'TOP', status: 'done', cause: 'CHILDREN_DONE' },
    ]);
  });

  it('(a) 하위 하나가 착수되면 미착수 상위를 진행 중으로 바꾼다', () => {
    assert.deepEqual(autoTransitions(family({ C1: 'in-progress' }), ['P']), [
      { taskId: 'P', status: 'in-progress', cause: 'CHILD_STARTED' },
      { taskId: 'TOP', status: 'in-progress', cause: 'CHILD_STARTED' },
    ]);
  });

  it('(b) 완료된 상위는 하위가 다시 열려도 되돌리지 않는다', () => {
    assert.deepEqual(autoTransitions(family({ TOP: 'done', P: 'done', C1: 'todo', C2: 'done' }), ['P']), []);
  });

  it('하위가 새로 들어온 상위에는 착수 규칙만 적용한다', () => {
    assert.deepEqual(autoTransitions(family({ C1: 'done', C2: 'done' }), [], ['P']), [
      { taskId: 'P', status: 'in-progress', cause: 'CHILD_STARTED' },
      { taskId: 'TOP', status: 'in-progress', cause: 'CHILD_STARTED' },
    ]);
  });

  it('하위가 없는 공정과 최상위(null)는 건드리지 않는다', () => {
    assert.deepEqual(autoTransitions(family({}), ['C1', null, undefined]), []);
  });
});

describe('링크', () => {
  it('Jira 주소에서 이슈 키를 꺼낸다', () => {
    assert.equal(jiraKeyFromUrl('https://jira.example.com/browse/SVC-142'), 'SVC-142');
    assert.equal(jiraKeyFromUrl('https://jira.example.com/projects/SVC/issues/SVC-7?filter=all'), 'SVC-7');
    assert.equal(jiraKeyFromUrl('https://jira.example.com/secure/Dashboard.jspa'), null);
  });

  it('http·https 주소만 링크로 받는다', () => {
    assert.equal(isHttpUrl('https://wiki.example.com/display/SVC/Page'), true);
    assert.equal(isHttpUrl('javascript:alert(1)'), false);
    assert.equal(isHttpUrl('wiki.example.com'), false);
  });
});
