import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createTrial, loadTemplates } from '../src/server/trial.ts';
import { startServer, startTrialServer, type TestServer } from './helpers.ts';

const CLI = resolve(import.meta.dirname, '../src/cli/main.ts');

let server: TestServer;
// 이 컴퓨터의 ~/.config/tevro/token을 읽지 않게 설정 폴더를 따로 둔다.
const configHome = mkdtempSync(join(tmpdir(), 'tevro-cli-config-'));

before(async () => {
  server = await startServer();
});

after(async () => {
  await server.close();
  rmSync(configHome, { recursive: true, force: true });
});

function tevro(
  args: string[],
  serverUrl = server.origin,
  extraEnv: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  // 기본은 시험 서버 관리자의 read-write 토큰. extraEnv에 TEVRO_TOKEN을 ''로 주면 토큰 없이 부른다.
  const env: NodeJS.ProcessEnv = { ...process.env, TEVRO_SERVER: serverUrl, TEVRO_TOKEN: server.token, XDG_CONFIG_HOME: configHome, ...extraEnv };
  if (env.TEVRO_TOKEN === '') delete env.TEVRO_TOKEN;
  return run(args, env);
}

function run(args: string[], env: NodeJS.ProcessEnv, input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = execFile(process.execPath, [CLI, ...args], { env }, (error, stdout, stderr) => {
      done({ code: error ? Number(error.code) : 0, stdout, stderr });
    });
    if (input !== undefined) child.stdin!.end(input);
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

describe('CLI 인증', () => {
  it('토큰이 없으면 종료 코드 4와 발급 안내, 틀린 토큰도 4이며 토큰 값은 출력하지 않는다', async () => {
    const missing = await tevro(['project', 'list'], server.origin, { TEVRO_TOKEN: '' });
    assert.equal(missing.code, 4);
    assert.match(missing.stderr, /TEVRO_TOKEN/);
    const wrong = await tevro(['project', 'list', '--json'], server.origin, { TEVRO_TOKEN: 'tevro_pat_wrong-secret-value' });
    assert.equal(wrong.code, 4);
    assert.equal(JSON.parse(wrong.stderr).error.code, 'UNAUTHENTICATED');
    assert.doesNotMatch(wrong.stderr + wrong.stdout, /wrong-secret-value/);
  });

  it('read 토큰으로는 조회만 되고 바꾸려 하면 종료 코드 4(FORBIDDEN)', async () => {
    const admin = server.accounts.findUser('admin')!;
    const read = server.accounts.createToken({ user: admin, via: 'session' }, { name: 'agent', scope: 'read' }).token;
    assert.equal((await tevro(['project', 'list'], server.origin, { TEVRO_TOKEN: read })).code, 0);
    const denied = await tevro(['project', 'create', '--name', '안 됨', '--json'], server.origin, { TEVRO_TOKEN: read });
    assert.equal(denied.code, 4);
    assert.equal(JSON.parse(denied.stderr).error.code, 'FORBIDDEN');
    const me = JSON.parse((await tevro(['whoami', '--json'], server.origin, { TEVRO_TOKEN: read })).stdout).data;
    assert.equal(me.user.username, 'admin');
    assert.equal(me.token.scope, 'read');
    assert.equal(me.token.name, 'agent');
  });

  it('config set-token --stdin은 권한 600 파일에 저장하고, 다른 사람이 읽을 수 있는 토큰 파일은 거부한다', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tevro-cli-home-'));
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, TEVRO_SERVER: server.origin, XDG_CONFIG_HOME: home };
      delete env.TEVRO_TOKEN;
      assert.equal((await run(['config', 'set-token', '--stdin'], env, 'not-a-token\n')).code, 2);
      const saved = await run(['config', 'set-token', '--stdin'], env, `${server.token}\n`);
      assert.equal(saved.code, 0, saved.stderr);
      const file = join(home, 'tevro', 'token');
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal((await run(['project', 'list'], env)).code, 0);
      const shown = await run(['config', 'show'], env);
      assert.match(shown.stdout, /토큰 {2}파일 /);
      assert.doesNotMatch(shown.stdout, /tevro_pat_/);

      const loose = join(home, 'loose-token');
      writeFileSync(loose, server.token, { mode: 0o644 });
      const refused = await run(['--token-file', loose, 'project', 'list'], env);
      assert.equal(refused.code, 4);
      assert.match(refused.stderr, /chmod 600/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('CLI 체험 서버', () => {
  it('체험 서버(TEVRO_TRIAL=1)는 웹 화면에서만 쓸 수 있다고 알리고 종료 코드 1로 끝난다', async () => {
    const trialServer = await startTrialServer(createTrial(loadTemplates(resolve(import.meta.dirname, '../trial'))));
    try {
      const result = await tevro(['project', 'list'], trialServer.origin);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /체험 서버는 웹 화면에서만 쓸 수 있습니다/);
    } finally {
      await trialServer.close();
    }
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
