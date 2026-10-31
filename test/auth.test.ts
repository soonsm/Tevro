import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { POLICY } from '../src/server/accounts.ts';
import { ADMIN_PASSWORD, startServer, type TestServer } from './helpers.ts';

const HOUR = 60 * 60 * 1000;
let clock = Date.parse('2026-11-01T00:00:00Z');
let server: TestServer;

before(async () => {
  server = await startServer(':memory:', undefined, { now: () => clock });
  await server.accounts.createUser({ username: 'editor', role: 'editor', password: 'editor password' });
  await server.accounts.createUser({ username: 'viewer', role: 'viewer', password: 'viewer password' });
});

after(() => server.close());

beforeEach(() => {
  clock += 24 * HOUR; // 시험끼리 잠금·세션이 섞이지 않게
});

/** 웹 화면처럼 로그인한 세션 */
async function login(username: string, password: string) {
  const response = await server.callWith({}, 'POST', '/auth/login', { username, password });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  const setCookie = response.headers.get('set-cookie')!;
  const cookie = setCookie.split(';')[0];
  const csrf: string = response.data.csrfToken;
  return {
    setCookie,
    cookie,
    csrf,
    get: (path: string) => server.callWith({ cookie }, 'GET', path),
    send: (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
      server.callWith({ cookie, 'x-tevro-csrf': csrf, ...extra }, method, path, body),
  };
}

function bearer(token: string) {
  return {
    get: (path: string) => server.callWith({ authorization: `Bearer ${token}` }, 'GET', path),
    send: (method: string, path: string, body?: unknown) => server.callWith({ authorization: `Bearer ${token}` }, method, path, body),
  };
}

describe('로그인과 세션', () => {
  it('로그인하면 HttpOnly·SameSite 세션 쿠키와 CSRF 값을 주고, 내 정보를 볼 수 있다', async () => {
    const session = await login('editor', 'editor password');
    assert.match(session.setCookie, /^tevro_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=604800$/);
    const me = await session.get('/auth/me');
    assert.equal(me.status, 200);
    assert.equal(me.data.user.username, 'editor');
    assert.equal(me.data.user.role, 'editor');
    assert.equal(me.data.csrfToken, session.csrf);
    assert.equal(me.data.token, undefined);
    assert.ok(me.data.user.lastLoginAt);
  });

  it('HTTPS 프록시(X-Forwarded-Proto: https) 뒤에서는 쿠키에 Secure를 붙인다', async () => {
    const response = await server.callWith({ 'x-forwarded-proto': 'https' }, 'POST', '/auth/login', { username: 'editor', password: 'editor password' });
    assert.match(response.headers.get('set-cookie')!, /; Secure$/);
  });

  it('틀린 아이디와 틀린 비밀번호는 같은 오류이고, 아이디는 대소문자를 가리지 않는다', async () => {
    const wrongPassword = await server.callWith({}, 'POST', '/auth/login', { username: 'viewer', password: 'nope nope nope' });
    const wrongUser = await server.callWith({}, 'POST', '/auth/login', { username: 'nobody', password: 'nope nope nope' });
    assert.equal(wrongPassword.status, 401);
    assert.deepEqual(wrongPassword.data, wrongUser.data);
    assert.equal((await server.callWith({}, 'POST', '/auth/login', { username: 'VIEWER', password: 'viewer password' })).status, 200);
    assert.equal((await server.callWith({}, 'POST', '/auth/login', {})).status, 422);
  });

  it('같은 계정으로 5번 틀리면 15분 동안 맞는 비밀번호로도 못 들어온다', async () => {
    await server.accounts.createUser({ username: 'locky', role: 'viewer', password: 'locky password' });
    for (let i = 1; i < POLICY.lockAfterFailures; i += 1) {
      assert.equal((await server.callWith({}, 'POST', '/auth/login', { username: 'locky', password: 'wrong password' })).status, 401);
    }
    const fifth = await server.callWith({}, 'POST', '/auth/login', { username: 'locky', password: 'wrong password' });
    assert.equal(fifth.status, 429);
    assert.equal(fifth.data.code, 'ACCOUNT_LOCKED');
    assert.match(fifth.data.detail, /15분 뒤/);
    assert.equal((await server.callWith({}, 'POST', '/auth/login', { username: 'locky', password: 'locky password' })).status, 429);
    clock += POLICY.lockMs;
    assert.equal((await server.callWith({}, 'POST', '/auth/login', { username: 'locky', password: 'locky password' })).status, 200);
  });

  it('세션으로 바꾸는 요청은 CSRF 값이 맞아야 하고, 다른 출처(Origin)에서 온 요청은 거부한다', async () => {
    const session = await login('editor', 'editor password');
    const noCsrf = await server.callWith({ cookie: session.cookie }, 'POST', '/projects', { name: 'x' });
    assert.equal(noCsrf.status, 403);
    assert.equal(noCsrf.data.code, 'FORBIDDEN');
    const evil = await session.send('POST', '/projects', { name: 'x' }, { origin: 'https://evil.example' });
    assert.equal(evil.status, 403);
    assert.equal((await session.send('POST', '/projects', { name: '세션으로 만든 프로젝트' }, { origin: server.origin })).status, 201);
  });

  it('8시간 안 쓰면 세션이 끝나고, 계속 써도 7일이 지나면 끝난다', async () => {
    const idle = await login('viewer', 'viewer password');
    clock += POLICY.sessionIdleMs - 60_000;
    assert.equal((await idle.get('/projects')).status, 200);
    clock += POLICY.sessionIdleMs - 60_000;
    assert.equal((await idle.get('/projects')).status, 200); // 쓰는 동안은 연장
    clock += POLICY.sessionIdleMs;
    assert.equal((await idle.get('/projects')).status, 401);

    const busy = await login('viewer', 'viewer password');
    for (let elapsed = 0; elapsed < POLICY.sessionMaxMs; elapsed += 6 * HOUR) {
      clock += 6 * HOUR;
      if (elapsed + 6 * HOUR < POLICY.sessionMaxMs) assert.equal((await busy.get('/projects')).status, 200);
    }
    assert.equal((await busy.get('/projects')).status, 401);
  });

  it('로그아웃하면 그 세션은 더 쓸 수 없고 쿠키를 지운다', async () => {
    const session = await login('viewer', 'viewer password');
    const out = await session.send('POST', '/auth/logout');
    assert.equal(out.status, 204);
    assert.match(out.headers.get('set-cookie')!, /^tevro_session=; .*Max-Age=0/);
    assert.equal((await session.get('/auth/me')).status, 401);
  });

  it('비밀번호를 바꾸면 지금 세션만 남고 다른 세션은 끊기며, 예전 비밀번호로는 못 들어온다', async () => {
    await server.accounts.createUser({ username: 'changer', role: 'viewer', password: 'first password' });
    const here = await login('changer', 'first password');
    const elsewhere = await login('changer', 'first password');
    assert.equal((await here.send('POST', '/auth/password', { currentPassword: 'wrong one', newPassword: 'second password' })).status, 422);
    assert.equal((await here.send('POST', '/auth/password', { currentPassword: 'first password', newPassword: 'short' })).status, 422);
    assert.equal((await here.send('POST', '/auth/password', { currentPassword: 'first password', newPassword: 'second password' })).status, 204);
    assert.equal((await here.get('/auth/me')).status, 200);
    assert.equal((await elsewhere.get('/auth/me')).status, 401);
    assert.equal((await server.callWith({}, 'POST', '/auth/login', { username: 'changer', password: 'first password' })).status, 401);
    await login('changer', 'second password');
  });

  it('로그인 화면에 보일 로그인 방식은 로그인 없이 볼 수 있다', async () => {
    const config = await server.callWith({}, 'GET', '/auth/config');
    assert.deepEqual(config.data, { providers: [{ id: 'local', label: 'Tevro 계정' }] });
  });
});

describe('역할', () => {
  it('열람자는 보기만, 편집자는 바꾸기까지, 사용자 관리는 관리자만', async () => {
    const viewer = await login('viewer', 'viewer password');
    const editor = await login('editor', 'editor password');
    const admin = await login('admin', ADMIN_PASSWORD);
    assert.equal((await viewer.get('/projects')).status, 200);
    const denied = await viewer.send('POST', '/projects', { name: 'x' });
    assert.equal(denied.status, 403);
    assert.match(denied.data.detail, /열람자/);
    assert.equal((await editor.send('POST', '/projects', { name: '편집자 프로젝트' })).status, 201);
    assert.equal((await editor.get('/users')).status, 403);
    assert.equal((await admin.get('/users')).status, 200);
  });

  it('관리자는 사용자를 만들고 역할을 바꾸며, 역할이 바뀌거나 비활성화되면 그 사람의 세션이 끊긴다', async () => {
    const admin = await login('admin', ADMIN_PASSWORD);
    const created = await admin.send('POST', '/users', { username: 'newbie', displayName: '새 사람', role: 'viewer', password: 'newbie password' });
    assert.equal(created.status, 201);
    assert.equal(created.data.displayName, '새 사람');
    assert.equal((await admin.send('POST', '/users', { username: 'NEWBIE', role: 'viewer', password: 'newbie password' })).status, 422);
    assert.equal((await admin.send('POST', '/users', { username: 'bad name', role: 'viewer', password: 'newbie password' })).status, 422);

    const newbie = await login('newbie', 'newbie password');
    const promoted = await admin.send('PATCH', `/users/${created.data.id}`, { role: 'editor' });
    assert.equal(promoted.data.role, 'editor');
    assert.equal((await newbie.get('/auth/me')).status, 401);

    const again = await login('newbie', 'newbie password');
    assert.equal((await admin.send('PATCH', `/users/${created.data.id}`, { active: false })).status, 200);
    assert.equal((await again.get('/auth/me')).status, 401);
    const blocked = await server.callWith({}, 'POST', '/auth/login', { username: 'newbie', password: 'newbie password' });
    assert.equal(blocked.status, 403);
    assert.match(blocked.data.detail, /비활성/);

    assert.equal((await admin.send('POST', `/users/${created.data.id}/password`, { password: 'reset password 1' })).status, 204);
    await admin.send('PATCH', `/users/${created.data.id}`, { active: true });
    await login('newbie', 'reset password 1');
  });

  it('마지막 활성 관리자는 강등하거나 비활성화할 수 없다', async () => {
    const admin = await login('admin', ADMIN_PASSWORD);
    const adminId = server.accounts.findUser('admin')!.id;
    const demote = await admin.send('PATCH', `/users/${adminId}`, { role: 'editor' });
    assert.equal(demote.status, 422);
    assert.match(demote.data.detail, /관리자가 한 명뿐/);
    assert.equal((await admin.send('PATCH', `/users/${adminId}`, { active: false })).status, 422);
  });
});

describe('개인 액세스 토큰', () => {
  it('발급할 때만 값을 보여 주고, 목록에는 값이 없으며, DB에는 해시만 남는다', async () => {
    const editor = await login('editor', 'editor password');
    const created = await editor.send('POST', '/tokens', { name: '내 에이전트', scope: 'read-write', expiresInDays: 30 });
    assert.equal(created.status, 201);
    assert.match(created.data.token, /^tevro_pat_[A-Za-z0-9_-]{43}$/);
    assert.match(created.data.id, /^tok_/);
    assert.equal(Date.parse(created.data.expiresAt) - Date.parse(created.data.createdAt), 30 * 24 * HOUR);
    const list = await editor.get('/tokens');
    assert.deepEqual(list.data.map((t: { id: string }) => t.id), [created.data.id]);
    assert.equal(JSON.stringify(list.data).includes('tevro_pat_'), false);

    const stored = server.db.prepare('SELECT secret_hash FROM access_tokens WHERE id = ?').get(created.data.id) as { secret_hash: string };
    assert.match(stored.secret_hash, /^[0-9a-f]{64}$/);
    const password = server.db.prepare("SELECT secret_hash FROM auth_identities WHERE subject = 'editor'").get() as { secret_hash: string };
    assert.match(password.secret_hash, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    const sessions = server.db.prepare('SELECT id_hash FROM sessions').all() as { id_hash: string }[];
    assert.ok(sessions.every((row) => !editor.cookie.includes(row.id_hash)));
  });

  it('토큰 범위와 역할의 교집합만 할 수 있다', async () => {
    const editor = await login('editor', 'editor password');
    const read = bearer((await editor.send('POST', '/tokens', { name: 'read', scope: 'read' })).data.token);
    const write = bearer((await editor.send('POST', '/tokens', { name: 'write', scope: 'read-write' })).data.token);
    assert.equal((await read.get('/projects')).status, 200);
    const readOnly = await read.send('POST', '/projects', { name: 'x' });
    assert.equal(readOnly.status, 403);
    assert.match(readOnly.data.detail, /read-write/);
    assert.equal((await write.send('POST', '/projects', { name: '토큰 프로젝트' })).status, 201);

    // 역할이 열람자로 내려가면 read-write 토큰도 바꿀 수 없다.
    const editorId = server.accounts.findUser('editor')!.id;
    server.accounts.updateUser(editorId, { role: 'viewer' });
    assert.equal((await write.send('POST', '/projects', { name: 'x' })).status, 403);
    server.accounts.updateUser(editorId, { role: 'editor' });
    assert.equal((await write.send('POST', '/projects', { name: '다시 편집자' })).status, 201);
  });

  it('열람자는 read 토큰만, 토큰으로는 토큰 발급·사용자 관리를 못 한다', async () => {
    const viewer = await login('viewer', 'viewer password');
    assert.equal((await viewer.send('POST', '/tokens', { name: 'x', scope: 'read-write' })).status, 403);
    const token = bearer((await viewer.send('POST', '/tokens', { name: 'x' })).data.token);
    assert.equal((await token.get('/projects')).status, 200);
    assert.equal((await token.send('POST', '/tokens', { name: 'y' })).status, 403);
    assert.equal((await bearer(server.token).get('/users')).status, 403);
    const me = await token.get('/auth/me');
    assert.equal(me.data.token.scope, 'read');
    assert.equal(me.data.csrfToken, undefined);
  });

  it('만료일은 1~365일이고, 만료·폐기된 토큰은 401이며 오류에 토큰 값을 되돌려 보내지 않는다', async () => {
    const editor = await login('editor', 'editor password');
    assert.equal((await editor.send('POST', '/tokens', { name: 'x', expiresInDays: 366 })).status, 422);
    assert.equal((await editor.send('POST', '/tokens', { name: 'x', expiresInDays: 0 })).status, 422);
    assert.equal((await editor.send('POST', '/tokens', { name: '' })).status, 422);
    const short = (await editor.send('POST', '/tokens', { name: 'short', expiresInDays: 1 })).data;
    const revoked = (await editor.send('POST', '/tokens', { name: 'revoked' })).data;
    assert.equal((await bearer(short.token).get('/projects')).status, 200);
    assert.equal((await editor.send('DELETE', `/tokens/${revoked.id}`)).status, 200);
    const denied = await bearer(revoked.token).get('/projects');
    assert.equal(denied.status, 401);
    assert.equal(JSON.stringify(denied.data).includes(revoked.token), false);
    clock += 24 * HOUR;
    assert.equal((await bearer(short.token).get('/projects')).status, 401);
    assert.equal((await bearer('not-a-token').get('/projects')).status, 401);
  });

  it('남의 토큰은 폐기할 수 없지만 관리자는 할 수 있고, 비활성화된 계정의 토큰은 바로 막힌다', async () => {
    await server.accounts.createUser({ username: 'owner', role: 'editor', password: 'owner password' });
    const owner = await login('owner', 'owner password');
    const editor = await login('editor', 'editor password');
    const admin = await login('admin', ADMIN_PASSWORD);
    const token = (await owner.send('POST', '/tokens', { name: 'agent', scope: 'read-write' })).data;
    assert.equal((await editor.send('DELETE', `/tokens/${token.id}`)).status, 404);
    const ownerId = server.accounts.findUser('owner')!.id;
    assert.deepEqual((await admin.get(`/users/${ownerId}/tokens`)).data.map((t: { id: string }) => t.id), [token.id]);

    await admin.send('PATCH', `/users/${ownerId}`, { active: false });
    assert.equal((await bearer(token.token).get('/projects')).status, 401);
    await admin.send('PATCH', `/users/${ownerId}`, { active: true });
    assert.equal((await bearer(token.token).get('/projects')).status, 200);
    assert.equal((await admin.send('DELETE', `/tokens/${token.id}`)).status, 200);
    assert.equal((await bearer(token.token).get('/projects')).status, 401);
  });
});

describe('관리 명령(npm run admin)', () => {
  const ADMIN = resolve(import.meta.dirname, '../src/server/admin.ts');
  let directory: string;

  before(() => {
    directory = mkdtempSync(join(tmpdir(), 'tevro-admin-'));
  });

  after(() => rmSync(directory, { recursive: true, force: true }));

  function admin(args: string[], input = ''): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((done) => {
      const child = execFile(process.execPath, [ADMIN, ...args], { env: { ...process.env, TEVRO_DATA_DIR: directory } }, (error, stdout, stderr) =>
        done({ code: error ? Number(error.code) : 0, stdout, stderr }),
      );
      child.stdin!.end(input);
    });
  }

  it('첫 관리자를 표준 입력의 비밀번호로 만들고, 목록·비밀번호 재설정·역할 변경을 한다', async () => {
    assert.match((await admin(['user', 'list'])).stdout, /사용자가 없습니다/);
    assert.equal((await admin(['user', 'create', '--username', 'boss', '--role', 'admin'])).code, 1); // 비밀번호 없음
    assert.equal((await admin(['user', 'create', '--username', 'boss', '--role', 'admin'], 'short\n')).code, 3);
    const created = await admin(['user', 'create', '--username', 'boss', '--role', 'admin', '--display-name', '대장'], 'boss password\n');
    assert.equal(created.code, 0, created.stderr);
    assert.match(created.stdout, /boss \(관리자, usr_/);
    assert.equal((await admin(['user', 'create', '--username', 'worker', '--role', 'editor'], 'worker password\n')).code, 0);
    assert.match((await admin(['user', 'list'])).stdout, /boss\t관리자\t활성[\s\S]*worker\t편집자\t활성/);
    assert.equal((await admin(['user', 'reset-password', 'worker'], 'new worker password\n')).code, 0);
    assert.match((await admin(['user', 'set-role', 'worker', 'viewer'])).stdout, /열람자/);
    assert.match((await admin(['user', 'deactivate', 'worker'])).stdout, /비활성/);
    assert.equal((await admin(['user', 'set-role', 'boss', 'viewer'])).code, 3); // 마지막 관리자
    assert.equal((await admin(['user', 'reset-password', 'ghost'], 'whatever password\n')).code, 1);
    assert.equal((await admin(['user', 'create', '--username', 'x', '--role', 'king'], 'x password 12\n')).code, 3);
  });
});
