import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  analyzePrerequisites,
  brokenPaths,
  findCycle,
  isHttpUrl,
  jiraKeyFromUrl,
  reachable,
  summarize,
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
