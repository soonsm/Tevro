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
  return data;
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
    assert.equal(data.status, 'in-progress');
    assert.deepEqual(data.unmetPrerequisiteIds, [b.id]);
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
    assert.equal(data.id, a.id);
    assert.deepEqual(data.successorIds, [c.id]);
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
    assert.equal(data.jiraUrl, null);
    assert.equal(data.jiraKey, null);
    assert.equal(data.confluenceUrl, 'https://wiki.example.com/display/SVC/Page');
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
