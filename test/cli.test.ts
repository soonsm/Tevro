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
    a = (await json(['task', 'add', '--project', projectId, '--title', 'A', '--status', 'in-progress'])).id;
    b = (await json(['task', 'add', '--project', projectId, '--title', 'B'])).id;
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
    assert.equal(updated.status, 'done');
    assert.deepEqual(updated.unmetPrerequisiteIds, [a]);
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
