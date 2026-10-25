import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startServer, type TestServer } from './helpers.ts';

const CLI = resolve(import.meta.dirname, '../src/cli/main.ts');

let server: TestServer;

before(async () => {
  server = await startServer();
});

after(() => server.close());

function tevro(args: string[], serverUrl = server.origin): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, TEVRO_SERVER: serverUrl } }, (error, stdout, stderr) => {
      done({ code: error ? Number(error.code) : 0, stdout, stderr });
    });
  });
}

async function json(args: string[]) {
  const result = await tevro([...args, '--json']);
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.schemaVersion, 1);
  return output.data;
}

describe('CLI', () => {
  let projectId: string;
  let a: string, b: string;

  before(async () => {
    projectId = (await json(['project', 'create', '--name', 'CLI 시험'])).id;
    a = (await json(['task', 'add', '--project', projectId, '--title', 'A', '--status', 'in-progress'])).task.id;
    b = (await json(['task', 'add', '--project', projectId, '--title', 'B'])).task.id;
    await json(['dependency', 'add', '--from', a, '--to', b]);
  });

  it('AC-13: CLI로 바꾼 내용이 GUI가 쓰는 API에 그대로 보인다', async () => {
    const fromCli = await json(['graph', 'show', '--project', projectId]);
    const fromApi = (await server.call('GET', `/projects/${projectId}/graph`)).data;
    assert.deepEqual(fromCli, fromApi);
    assert.deepEqual(fromApi.dependencies, [{ from: a, to: b }]);
  });

  it('선행이 미완료여도 상태 변경은 성공한다', async () => {
    const updated = await json(['task', 'status', b, '--set', 'done']);
    assert.equal(updated.task.status, 'done');
    assert.deepEqual(updated.task.unmetPrerequisiteIds, [a]);
  });

  it('AC-04: 순환 연결은 종료 코드 3과 오류 객체로 거부된다', async () => {
    const result = await tevro(['dependency', 'add', '--from', b, '--to', a, '--json']);
    assert.equal(result.code, 3);
    assert.equal(result.stdout, '');
    const output = JSON.parse(result.stderr);
    assert.equal(output.error.code, 'VALIDATION_CYCLE');
    assert.deepEqual(output.error.cycle, [b, a, b]);
  });

  it('없는 공정은 종료 코드 6이다', async () => {
    assert.equal((await tevro(['task', 'show', 'tsk_nothing'])).code, 6);
  });

  it('task delete는 --yes가 없으면 영향만 보여 주고 종료 코드 2로 끝난다', async () => {
    const preview = await tevro(['task', 'delete', a]);
    assert.equal(preview.code, 2);
    assert.match(preview.stderr, /함께 삭제되는 연결 1개/);
    assert.equal((await server.call('GET', `/tasks/${a}`)).status, 200);

    const deleted = await tevro(['task', 'delete', a, '--yes', '--json']);
    assert.equal(deleted.code, 0, deleted.stderr);
    assert.deepEqual(JSON.parse(deleted.stdout).data.removedDependencies, [{ from: a, to: b }]);
  });

  it('사용법 오류는 종료 코드 2, 서버에 닿지 못하면 8이다', async () => {
    assert.equal((await tevro(['task', 'status', b, '--set', 'blocked'])).code, 2);
    assert.equal((await tevro(['task', 'add', '--project', projectId])).code, 2);
    assert.equal((await tevro(['project', 'list'], 'http://127.0.0.1:9')).code, 8);
  });

  it('사람이 읽는 출력은 상태별 개수와 연결을 보여 준다', async () => {
    const result = await tevro(['graph', 'show', '--project', projectId]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /전체 1 · 미착수 0 · 진행 중 0 · 완료 1/);
    assert.match(result.stdout, /연결 0개/);
  });
});

describe('CLI 공정 계층', () => {
  let projectId: string;
  let dev: string, x: string, y: string, outside: string;

  before(async () => {
    projectId = (await json(['project', 'create', '--name', 'CLI 계층 시험'])).id;
    dev = (await json(['task', 'add', '--project', projectId, '--title', '개발'])).task.id;
    x = (await json(['task', 'add', '--project', projectId, '--title', '온라인 거래 개발', '--parent', dev])).task.id;
    y = (await json(['task', 'add', '--project', projectId, '--title', '배치 개발', '--parent', dev])).task.id;
    outside = (await json(['task', 'add', '--project', projectId, '--title', '배포'])).task.id;
  });

  it('AC-31: --parent로 만든 공정은 GUI가 쓰는 API에서도 그 상위 아래에 같은 ID로 보인다', async () => {
    const graph = (await server.call('GET', `/projects/${projectId}/graph`)).data;
    const child = graph.tasks.find((task: { id: string }) => task.id === x);
    assert.equal(child.parentId, dev);
    const parent = graph.tasks.find((task: { id: string }) => task.id === dev);
    assert.deepEqual([parent.childCount, parent.doneChildCount], [2, 0]);
    assert.deepEqual(
      (await json(['task', 'list', '--project', projectId, '--parent', dev])).map((task: { id: string }) => task.id),
      [x, y],
    );
  });

  it('AC-27: 다른 층의 공정끼리 연결하면 종료 코드 3으로 거부된다', async () => {
    const result = await tevro(['dependency', 'add', '--from', x, '--to', outside, '--json']);
    assert.equal(result.code, 3);
    assert.equal(JSON.parse(result.stderr).error.code, 'CROSS_LEVEL_DEPENDENCY');
  });

  it('상태를 바꾸다 상위가 자동으로 바뀌면 함께 알려 준다', async () => {
    const started = await tevro(['task', 'status', x, '--set', 'done']);
    assert.equal(started.code, 0, started.stderr);
    assert.match(started.stdout, /자동 변경: 개발 → 진행 중 \(하위 공정이 착수됨\)/);
    const finished = await json(['task', 'status', y, '--set', 'done']);
    assert.deepEqual(finished.autoTransitions, [{ taskId: dev, title: '개발', status: 'done', cause: 'CHILDREN_DONE' }]);
  });

  it('graph show는 하위 공정을 들여 쓰고 상위의 하위 완료 수를 보여 준다', async () => {
    const result = await tevro(['graph', 'show', '--project', projectId]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /개발 \(하위 2\/2\)/);
    assert.match(result.stdout, /\n완료 {2,}  온라인 거래 개발/);
    assert.match(result.stdout, /전체 3 · 미착수 1 · 진행 중 0 · 완료 2/);
    const level = await json(['graph', 'show', '--project', projectId, '--root', dev]);
    assert.deepEqual(level.tasks.map((task: { id: string }) => task.id), [x, y]);
  });

  it('AC-32: 연결이 있는 공정은 --detach 없이는 3, --yes 없이는 미리 보기와 2로 끝나고, --yes면 옮겨진다', async () => {
    await json(['dependency', 'add', '--from', x, '--to', y]);
    const refused = await tevro(['task', 'move', x, '--top']);
    assert.equal(refused.code, 3);
    assert.match(refused.stderr, /HAS_DEPENDENCIES/);
    assert.match(refused.stderr, /--detach --yes/);

    const preview = await tevro(['task', 'move', x, '--top', '--detach']);
    assert.equal(preview.code, 2);
    assert.match(preview.stderr, /연결 1개가 지워집니다/);
    assert.match(preview.stderr, /온라인 거래 개발 → 배치 개발/);
    assert.equal((await server.call('GET', `/tasks/${x}`)).data.parentId, dev);

    const moved = await json(['task', 'move', x, '--top', '--detach', '--yes']);
    assert.equal(moved.task.parentId, null);
    assert.deepEqual(moved.removedDependencies, [{ from: x, to: y }]);
  });

  it('AC-29: 자기 하위로 옮기면 종료 코드 3, 위치를 안 주면 2다', async () => {
    const result = await tevro(['task', 'move', dev, '--parent', y, '--json']);
    assert.equal(result.code, 3);
    assert.equal(JSON.parse(result.stderr).error.code, 'HIERARCHY_CYCLE');
    assert.equal((await tevro(['task', 'move', dev])).code, 2);
    assert.equal((await tevro(['task', 'move', dev, '--top', '--parent', y])).code, 2);
  });

  it('task show는 위치, 물려받은 선행, 하위 공정을 보여 준다', async () => {
    const before = (await json(['task', 'add', '--project', projectId, '--title', '요건 확정'])).task.id;
    await json(['dependency', 'add', '--from', before, '--to', dev]);
    const result = await tevro(['task', 'show', y]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /위치 +개발 아래/);
    assert.match(result.stdout, /물려받은 선행 +요건 확정\(미착수, 개발의 선행\)/);
    const parent = await tevro(['task', 'show', dev]);
    assert.match(parent.stdout, /하위 공정 +1\/1 완료 — 배치 개발\(완료\)/);
  });

  it('하위가 있는 공정의 삭제 미리 보기는 함께 지워질 하위 공정을 보여 준다', async () => {
    const preview = await tevro(['task', 'delete', dev]);
    assert.equal(preview.code, 2);
    assert.match(preview.stderr, /함께 삭제되는 하위 공정 1개\n {4}배치 개발/);
  });
});
