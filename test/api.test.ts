import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { GraphDto, TaskDto } from '../src/shared/types.ts';
import { startServer, type TestServer } from './helpers.ts';

let server: TestServer;

before(async () => {
  server = await startServer();
});

after(() => server.close());

async function newProject(name = '시험 프로젝트'): Promise<string> {
  const { status, data } = await server.call('POST', '/projects', { name });
  assert.equal(status, 201);
  return data.id;
}

async function newTask(projectId: string, title: string, extra: Record<string, unknown> = {}): Promise<TaskDto> {
  const { status, data } = await server.call('POST', `/projects/${projectId}/tasks`, { title, ...extra });
  assert.equal(status, 201, JSON.stringify(data));
  return data.task;
}

async function link(projectId: string, from: string, to: string) {
  return server.call('POST', `/projects/${projectId}/dependencies`, { from, to });
}

async function graphOf(projectId: string): Promise<GraphDto> {
  return (await server.call('GET', `/projects/${projectId}/graph`)).data;
}

describe('공정과 선후관계 (AC-01~05, AC-16)', () => {
  let projectId: string;
  let a: TaskDto, b: TaskDto, c: TaskDto, d: TaskDto;

  before(async () => {
    projectId = await newProject();
    a = await newTask(projectId, 'A 저장소 준비', { status: 'done' });
    b = await newTask(projectId, 'B 실행환경 구성', { status: 'in-progress' });
    c = await newTask(projectId, 'C 배포 준비');
    d = await newTask(projectId, 'D 참고 문서 정리');
    assert.equal((await link(projectId, a.id, c.id)).status, 201);
    assert.equal((await link(projectId, b.id, c.id)).status, 201);
  });

  it('AC-01: 독립 공정까지 모두 조회되고 연결 방향이 그대로다', async () => {
    const graph = await graphOf(projectId);
    assert.deepEqual(graph.tasks.map((task) => task.title), ['A 저장소 준비', 'B 실행환경 구성', 'C 배포 준비', 'D 참고 문서 정리']);
    assert.deepEqual(graph.dependencies, [
      { from: a.id, to: c.id },
      { from: b.id, to: c.id },
    ]);
    assert.deepEqual(graph.summary, { total: 4, todo: 2, inProgress: 1, done: 1 });
  });

  it('AC-02: C의 미완료 선행 공정은 B다', async () => {
    const graph = await graphOf(projectId);
    const taskC = graph.tasks.find((task) => task.id === c.id)!;
    assert.equal(taskC.prerequisitesMet, false);
    assert.deepEqual(taskC.unmetPrerequisiteIds, [b.id]);
    assert.equal(graph.tasks.find((task) => task.id === d.id)!.prerequisitesMet, true);
  });

  it('AC-03: 선행이 미완료여도 C를 진행 중으로 바꿀 수 있고 미충족 정보는 남는다', async () => {
    const { status, data } = await server.call('PATCH', `/tasks/${c.id}`, { status: 'in-progress' });
    assert.equal(status, 200);
    assert.equal(data.task.status, 'in-progress');
    assert.deepEqual(data.task.unmetPrerequisiteIds, [b.id]);
  });

  it('AC-04: 순환을 만드는 연결은 경로와 함께 거부되고 기존 데이터는 그대로다', async () => {
    const { status, data } = await link(projectId, c.id, a.id);
    assert.equal(status, 422);
    assert.equal(data.code, 'VALIDATION_CYCLE');
    assert.deepEqual(data.cycle, [c.id, a.id, c.id]);
    assert.match(data.detail, /C 배포 준비 → A 저장소 준비 → C 배포 준비/);
    assert.equal((await graphOf(projectId)).dependencies.length, 2);
  });

  it('AC-16: 자기 자신 연결과 중복 연결을 거부한다', async () => {
    assert.equal((await link(projectId, a.id, a.id)).data.code, 'VALIDATION_SELF_LOOP');
    assert.equal((await link(projectId, a.id, c.id)).data.code, 'VALIDATION_DUPLICATE_EDGE');
  });

  it('AC-05: 제목을 바꿔도 ID와 연결은 유지된다', async () => {
    const { data } = await server.call('PATCH', `/tasks/${a.id}`, { title: 'A 저장소 준비(변경)' });
    assert.equal(data.task.id, a.id);
    assert.deepEqual(data.task.successorIds, [c.id]);
  });

  it('없는 공정이나 다른 프로젝트의 공정과는 연결하지 않는다', async () => {
    assert.equal((await link(projectId, a.id, 'tsk_nothing')).data.code, 'REFERENCE_NOT_FOUND');
    const other = await newProject('다른 프로젝트');
    const foreign = await newTask(other, '다른 프로젝트 공정');
    assert.equal((await link(projectId, a.id, foreign.id)).data.code, 'CROSS_PROJECT_REFERENCE');
  });

  it('연결을 지울 수 있고, 없는 연결은 NOT_FOUND다', async () => {
    const path = `/projects/${projectId}/dependencies?from=${b.id}&to=${c.id}`;
    assert.equal((await server.call('DELETE', path)).status, 200);
    assert.equal((await server.call('DELETE', path)).data.code, 'NOT_FOUND');
    assert.equal((await link(projectId, b.id, c.id)).status, 201);
  });
});

describe('공정 삭제', () => {
  it('연결이 함께 지워지고, 지운 공정은 NOT_FOUND다', async () => {
    const projectId = await newProject();
    const a = await newTask(projectId, 'A');
    const b = await newTask(projectId, 'B');
    const c = await newTask(projectId, 'C');
    await link(projectId, a.id, b.id);
    await link(projectId, b.id, c.id);

    const { status, data } = await server.call('DELETE', `/tasks/${b.id}`);
    assert.equal(status, 200);
    assert.deepEqual(data.removedDependencies, [
      { from: a.id, to: b.id },
      { from: b.id, to: c.id },
    ]);
    assert.deepEqual((await graphOf(projectId)).dependencies, []);
    assert.equal((await server.call('GET', `/tasks/${b.id}`)).status, 404);
  });
});

describe('공정 계층 (AC-25~29, AC-32, F-H09)', () => {
  async function setStatus(taskId: string, status: string) {
    const { status: code, data } = await server.call('PATCH', `/tasks/${taskId}`, { status });
    assert.equal(code, 200, JSON.stringify(data));
    return data as { task: TaskDto; autoTransitions: { taskId: string; title: string; status: string; cause: string }[] };
  }

  async function taskOf(taskId: string): Promise<TaskDto> {
    return (await server.call('GET', `/tasks/${taskId}`)).data;
  }

  async function move(taskId: string, body: Record<string, unknown>) {
    return server.call('POST', `/tasks/${taskId}/move`, body);
  }

  it('AC-25: 하위 하나가 착수되면 상위가 진행 중, 모두 완료되면 상위가 자동 완료된다', async () => {
    const projectId = await newProject();
    const dev = await newTask(projectId, '개발');
    const x = await newTask(projectId, 'X', { parentId: dev.id });
    const y = await newTask(projectId, 'Y', { parentId: dev.id });
    const z = await newTask(projectId, 'Z', { parentId: dev.id });
    assert.equal(x.parentId, dev.id);

    const started = await setStatus(x.id, 'in-progress');
    assert.deepEqual(started.autoTransitions, [{ taskId: dev.id, title: '개발', status: 'in-progress', cause: 'CHILD_STARTED' }]);
    await setStatus(x.id, 'done');
    assert.deepEqual((await setStatus(y.id, 'done')).autoTransitions, []);
    const parent = await taskOf(dev.id);
    assert.equal(parent.status, 'in-progress');
    assert.deepEqual([parent.childCount, parent.doneChildCount], [3, 2]);

    const finished = await setStatus(z.id, 'done');
    assert.deepEqual(finished.autoTransitions, [{ taskId: dev.id, title: '개발', status: 'done', cause: 'CHILDREN_DONE' }]);
    assert.equal((await taskOf(dev.id)).status, 'done');
  });

  it('자동 전이는 여러 층을 거슬러 올라간다', async () => {
    const projectId = await newProject();
    const top = await newTask(projectId, '상위');
    const middle = await newTask(projectId, '중간', { parentId: top.id });
    const leaf = await newTask(projectId, '말단', { parentId: middle.id });
    const result = await setStatus(leaf.id, 'done');
    assert.deepEqual(
      result.autoTransitions.map((item) => [item.title, item.status]),
      [
        ['중간', 'done'],
        ['상위', 'done'],
      ],
    );
  });

  it('AC-26: 상위를 직접 완료로 바꿀 수 있고, 하위가 미완료면 모순으로 표시된다', async () => {
    const projectId = await newProject();
    const dev = await newTask(projectId, '개발');
    await newTask(projectId, 'X', { parentId: dev.id });
    const result = await setStatus(dev.id, 'done');
    assert.equal(result.task.status, 'done');
    assert.equal(result.task.inconsistency, 'PARENT_DONE_CHILD_OPEN');
  });

  it('(b) 자동 완료된 상위는 하위를 다시 열어도 완료로 남고 모순으로 표시된다. 직접 되돌린 상위는 덮어쓰지 않는다', async () => {
    const projectId = await newProject();
    const dev = await newTask(projectId, '개발');
    const x = await newTask(projectId, 'X', { parentId: dev.id });
    await setStatus(x.id, 'done');
    assert.equal((await taskOf(dev.id)).status, 'done');

    assert.deepEqual((await setStatus(x.id, 'in-progress')).autoTransitions, []);
    const reopened = await taskOf(dev.id);
    assert.equal(reopened.status, 'done');
    assert.equal(reopened.inconsistency, 'PARENT_DONE_CHILD_OPEN');

    await setStatus(x.id, 'done');
    const reverted = await setStatus(dev.id, 'in-progress');
    assert.equal(reverted.task.status, 'in-progress');
    assert.equal(reverted.task.inconsistency, 'CHILDREN_DONE_PARENT_OPEN');
  });

  it('(c) 하위를 지우거나 옮겨 남은 하위가 모두 완료되면 상위가 자동 완료된다', async () => {
    const projectId = await newProject();
    const dev = await newTask(projectId, '개발');
    const x = await newTask(projectId, 'X', { parentId: dev.id, status: 'done' });
    const y = await newTask(projectId, 'Y', { parentId: dev.id });
    const deleted = (await server.call('DELETE', `/tasks/${y.id}`)).data;
    assert.deepEqual(deleted.autoTransitions, [{ taskId: dev.id, title: '개발', status: 'done', cause: 'CHILDREN_DONE' }]);

    const ops = await newTask(projectId, '운영');
    await move(x.id, { parentId: ops.id });
    const z = await newTask(projectId, 'Z', { parentId: ops.id });
    const moved = (await move(z.id, { parentId: null })).data;
    assert.deepEqual(moved.autoTransitions, [{ taskId: ops.id, title: '운영', status: 'done', cause: 'CHILDREN_DONE' }]);
    assert.equal(moved.task.parentId, null);
  });

  it('하위를 새로 넣는 것만으로는 상위가 완료되지 않고 착수만 반영된다', async () => {
    const projectId = await newProject();
    const dev = await newTask(projectId, '개발');
    const created = await server.call('POST', `/projects/${projectId}/tasks`, { title: 'X', parentId: dev.id, status: 'done' });
    assert.deepEqual(created.data.autoTransitions, [{ taskId: dev.id, title: '개발', status: 'in-progress', cause: 'CHILD_STARTED' }]);
    assert.equal((await taskOf(dev.id)).inconsistency, 'CHILDREN_DONE_PARENT_OPEN');

    const ops = await newTask(projectId, '운영');
    const done = await newTask(projectId, 'Y', { status: 'done' });
    const moved = (await move(done.id, { parentId: ops.id })).data;
    assert.deepEqual(moved.autoTransitions, [{ taskId: ops.id, title: '운영', status: 'in-progress', cause: 'CHILD_STARTED' }]);
  });

  it('AC-27: 다른 층의 공정끼리는 연결할 수 없다', async () => {
    const projectId = await newProject();
    const a = await newTask(projectId, 'A');
    const dev = await newTask(projectId, '개발');
    const x = await newTask(projectId, 'X', { parentId: dev.id });
    const y = await newTask(projectId, 'Y', { parentId: dev.id });
    const { status, data } = await link(projectId, a.id, x.id);
    assert.equal(status, 422);
    assert.equal(data.code, 'CROSS_LEVEL_DEPENDENCY');
    assert.deepEqual(data.parentIds, [null, dev.id]);
    assert.match(data.detail, /A\(최상위\) → X\(개발 아래\)/);
    assert.equal((await link(projectId, x.id, y.id)).status, 201);
  });

  it('AC-28: 상위의 선행은 하위가 물려받고, 상위를 선행으로 둔 공정은 상위의 완료를 기다린다', async () => {
    const projectId = await newProject();
    const a = await newTask(projectId, 'A');
    const dev = await newTask(projectId, '개발');
    const b = await newTask(projectId, 'B');
    const x = await newTask(projectId, 'X', { parentId: dev.id });
    const y = await newTask(projectId, 'Y', { parentId: dev.id });
    await link(projectId, a.id, dev.id);
    await link(projectId, dev.id, b.id);

    const before = await taskOf(x.id);
    assert.deepEqual(before.predecessorIds, []);
    assert.deepEqual(before.inheritedPredecessors, [{ taskId: a.id, inheritedFrom: dev.id }]);
    assert.deepEqual(before.unmetPrerequisiteIds, [a.id]);
    assert.equal(before.prerequisitesMet, false);
    assert.deepEqual((await taskOf(b.id)).unmetPrerequisiteIds, [dev.id]);

    await setStatus(a.id, 'done');
    assert.equal((await taskOf(x.id)).prerequisitesMet, true);
    await setStatus(x.id, 'done');
    await setStatus(y.id, 'done');
    assert.equal((await taskOf(b.id)).prerequisitesMet, true);
  });

  it('AC-29: 자기 자신이나 자손을 상위로 지정하면 거부되고 구조가 그대로다', async () => {
    const projectId = await newProject();
    const dev = await newTask(projectId, '개발');
    const x = await newTask(projectId, 'X', { parentId: dev.id });
    const x1 = await newTask(projectId, 'X1', { parentId: x.id });

    const descendant = await move(dev.id, { parentId: x1.id });
    assert.equal(descendant.status, 422);
    assert.equal(descendant.data.code, 'HIERARCHY_CYCLE');
    assert.deepEqual(descendant.data.path, [x1.id, x.id, dev.id]);
    assert.match(descendant.data.detail, /개발 › X › X1/);
    assert.deepEqual((await move(dev.id, { parentId: dev.id })).data.path, [dev.id]);
    assert.equal((await taskOf(dev.id)).parentId, null);
  });

  it('상위는 같은 프로젝트의 있는 공정만 지정할 수 있고, 상위 변경은 이동으로만 한다', async () => {
    const projectId = await newProject();
    const task = await newTask(projectId, '공정');
    const create = (body: Record<string, unknown>) => server.call('POST', `/projects/${projectId}/tasks`, body);
    assert.equal((await create({ title: '하위', parentId: 'tsk_nothing' })).data.code, 'REFERENCE_NOT_FOUND');
    const other = await newTask(await newProject('다른 프로젝트'), '다른 프로젝트 공정');
    assert.equal((await create({ title: '하위', parentId: other.id })).data.code, 'CROSS_PROJECT_REFERENCE');
    assert.equal((await move(task.id, { parentId: other.id })).data.code, 'CROSS_PROJECT_REFERENCE');
    assert.equal((await move(task.id, {})).data.code, 'VALIDATION_INPUT');
    assert.equal((await move('tsk_nothing', { parentId: null })).status, 404);
    assert.equal((await server.call('PATCH', `/tasks/${task.id}`, { parentId: null })).data.code, 'VALIDATION_INPUT');
  });

  it('AC-32: 연결이 있는 공정은 끊길 연결을 알려 주고, 그 연결을 함께 지울 때만 옮긴다', async () => {
    const projectId = await newProject();
    const a = await newTask(projectId, 'A');
    const b = await newTask(projectId, 'B');
    const c = await newTask(projectId, 'C');
    const dev = await newTask(projectId, '개발');
    await link(projectId, a.id, b.id);
    await link(projectId, b.id, c.id);

    const refused = await move(b.id, { parentId: dev.id });
    assert.equal(refused.status, 422);
    assert.equal(refused.data.code, 'HAS_DEPENDENCIES');
    assert.deepEqual(refused.data.dependencies, [
      { from: a.id, to: b.id },
      { from: b.id, to: c.id },
    ]);
    const partial = await move(b.id, { parentId: dev.id, removeDependencies: [{ from: a.id, to: b.id }] });
    assert.deepEqual(partial.data.dependencies, [{ from: b.id, to: c.id }]);
    assert.equal((await graphOf(projectId)).dependencies.length, 2);
    const unrelated = await move(b.id, { parentId: dev.id, removeDependencies: [{ from: a.id, to: c.id }] });
    assert.equal(unrelated.data.code, 'VALIDATION_INPUT');

    const moved = await move(b.id, {
      parentId: dev.id,
      removeDependencies: [
        { from: a.id, to: b.id },
        { from: b.id, to: c.id },
      ],
    });
    assert.equal(moved.status, 200, JSON.stringify(moved.data));
    assert.equal(moved.data.task.parentId, dev.id);
    assert.equal(moved.data.removedDependencies.length, 2);
    assert.deepEqual((await graphOf(projectId)).dependencies, []);
  });

  it('하위가 있는 공정을 지우면 자손과 그 연결이 함께 지워진다', async () => {
    const projectId = await newProject();
    const a = await newTask(projectId, 'A');
    const dev = await newTask(projectId, '개발');
    const x = await newTask(projectId, 'X', { parentId: dev.id });
    const y = await newTask(projectId, 'Y', { parentId: dev.id });
    const x1 = await newTask(projectId, 'X1', { parentId: x.id });
    await link(projectId, a.id, dev.id);
    await link(projectId, x.id, y.id);

    const { data } = await server.call('DELETE', `/tasks/${dev.id}`);
    assert.deepEqual(
      data.removedTasks.map((task: { title: string }) => task.title),
      ['X', 'Y', 'X1'],
    );
    assert.deepEqual(data.removedDependencies, [
      { from: a.id, to: dev.id },
      { from: x.id, to: y.id },
    ]);
    const graph = await graphOf(projectId);
    assert.deepEqual(graph.tasks.map((task) => task.title), ['A']);
    assert.equal((await server.call('GET', `/tasks/${x1.id}`)).status, 404);
  });

  it('F-H09: 상태 요약은 하위가 있는 공정을 빼고 말단 공정만 센다', async () => {
    const projectId = await newProject();
    const dev = await newTask(projectId, '개발');
    await newTask(projectId, 'X', { parentId: dev.id, status: 'done' });
    await newTask(projectId, 'Y', { parentId: dev.id });
    await newTask(projectId, 'A');
    assert.deepEqual((await graphOf(projectId)).summary, { total: 3, todo: 2, inProgress: 0, done: 1 });
  });
});

describe('동시 요청 (AC-18)', () => {
  it('A → B와 B → A가 동시에 와도 하나만 저장된다', async () => {
    const projectId = await newProject();
    const a = await newTask(projectId, 'A');
    const b = await newTask(projectId, 'B');
    const results = await Promise.all([link(projectId, a.id, b.id), link(projectId, b.id, a.id)]);
    assert.deepEqual(results.map((result) => result.status).sort(), [201, 422]);
    assert.equal(results.find((result) => result.status === 422)!.data.code, 'VALIDATION_CYCLE');
    assert.equal((await graphOf(projectId)).dependencies.length, 1);
  });

  it('하위 두 개의 완료가 동시에 와도 상위 자동 완료를 놓치지 않는다 (ADR-0003 1.7)', async () => {
    const projectId = await newProject();
    const dev = await newTask(projectId, '개발');
    const x = await newTask(projectId, 'X', { parentId: dev.id });
    const y = await newTask(projectId, 'Y', { parentId: dev.id });
    const results = await Promise.all([
      server.call('PATCH', `/tasks/${x.id}`, { status: 'done' }),
      server.call('PATCH', `/tasks/${y.id}`, { status: 'done' }),
    ]);
    assert.deepEqual(
      results.flatMap((result) => result.data.autoTransitions.map((item: { status: string }) => item.status)).sort(),
      ['done', 'in-progress'],
    );
    assert.equal((await server.call('GET', `/tasks/${dev.id}`)).data.status, 'done');
  });
});

describe('링크와 입력 검증', () => {
  it('Jira·Confluence 링크를 저장하고 이슈 키를 계산한다. 빈 값은 지운다', async () => {
    const projectId = await newProject();
    const task = await newTask(projectId, '링크 공정', {
      jiraUrl: 'https://jira.example.com/browse/SVC-142',
      confluenceUrl: 'https://wiki.example.com/display/SVC/Page',
    });
    assert.equal(task.jiraKey, 'SVC-142');
    const { data } = await server.call('PATCH', `/tasks/${task.id}`, { jiraUrl: '' });
    assert.equal(data.task.jiraUrl, null);
    assert.equal(data.task.jiraKey, null);
    assert.equal(data.task.confluenceUrl, 'https://wiki.example.com/display/SVC/Page');
  });

  it('http(s)가 아닌 링크, 빈 제목, 모르는 상태값은 거부한다', async () => {
    const projectId = await newProject();
    const bad = async (body: Record<string, unknown>) =>
      (await server.call('POST', `/projects/${projectId}/tasks`, body)).data.code;
    assert.equal(await bad({ title: '공정', jiraUrl: 'javascript:alert(1)' }), 'VALIDATION_INPUT');
    assert.equal(await bad({ title: '   ' }), 'VALIDATION_INPUT');
    assert.equal(await bad({ title: '공정', status: 'blocked' }), 'VALIDATION_INPUT');
  });

  it('JSON이 아닌 본문과 없는 경로를 구분해 알려 준다', async () => {
    const response = await fetch(`${server.origin}/api/v1/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('content-type'), 'application/problem+json; charset=utf-8');
    assert.equal((await server.call('GET', '/nothing')).status, 404);
  });
});

describe('저장과 웹 제공', () => {
  it('서버를 다시 켜도 데이터가 남는다 (F-P08)', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tevro-test-'));
    try {
      const file = join(directory, 'tevro.db');
      const first = await startServer(file);
      const created = (await first.call('POST', '/projects', { name: '유지되는 프로젝트' })).data;
      await first.call('POST', `/projects/${created.id}/tasks`, { title: '남아 있어야 할 공정' });
      await first.close();

      const second = await startServer(file);
      const graph: GraphDto = (await second.call('GET', `/projects/${created.id}/graph`)).data;
      assert.deepEqual(graph.tasks.map((task) => task.title), ['남아 있어야 할 공정']);
      await second.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('TEVRO_PASSWORD를 설정하면 상태 확인 말고는 비밀번호가 맞아야 열린다', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tevro-auth-'));
    const locked = await startServer(':memory:', directory, 'correct horse battery');
    try {
      writeFileSync(join(directory, 'index.html'), '<!doctype html><title>Tevro</title>');
      const basic = (credentials: string) => ({ authorization: `Basic ${Buffer.from(credentials).toString('base64')}` });

      const anonymous = await fetch(`${locked.origin}/api/v1/projects`);
      assert.equal(anonymous.status, 401);
      assert.match(anonymous.headers.get('www-authenticate') ?? '', /^Basic realm="Tevro"/);
      assert.equal((await anonymous.json()).code, 'UNAUTHORIZED');
      assert.equal((await fetch(`${locked.origin}/`)).status, 401);
      const wrong = await fetch(`${locked.origin}/api/v1/projects`, { headers: basic('tevro:wrong password') });
      assert.equal(wrong.status, 401);
      assert.equal((await fetch(`${locked.origin}/api/v1/projects`, { headers: basic('no-colon') })).status, 401);

      // 사용자 이름은 보지 않는다.
      assert.equal((await fetch(`${locked.origin}/api/v1/projects`, { headers: basic('tevro:correct horse battery') })).status, 200);
      assert.equal((await fetch(`${locked.origin}/`, { headers: basic(':correct horse battery') })).status, 200);
      assert.equal((await fetch(`${locked.origin}/healthz`)).status, 200);
    } finally {
      await locked.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('화면 주소는 index.html로 돌려주고 외부 자원을 막는 CSP를 붙인다', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tevro-web-'));
    try {
      writeFileSync(join(directory, 'index.html'), '<!doctype html><title>Tevro</title>');
      const web = await startServer(':memory:', directory);
      const response = await fetch(`${web.origin}/?project=prj_x`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'self'/);
      assert.match(await response.text(), /<title>Tevro<\/title>/);
      // 인코딩한 ../로 웹 폴더 밖의 파일을 읽으려 해도 index.html만 돌려준다.
      const traversal = await fetch(`${web.origin}/%2e%2e/%2e%2e/%2e%2e/etc/passwd`);
      assert.match(await traversal.text(), /<title>Tevro<\/title>/);
      await web.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
