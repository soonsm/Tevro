import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { POLICY, createAccounts, type Accounts } from '../src/server/accounts.ts';
import { createApp } from '../src/server/app.ts';
import { createStore, openDatabase, type Db } from '../src/server/store.ts';
import { startServer } from './helpers.ts';

// 사용자가 하나도 없는 서버의 첫 설정(웹에서 첫 관리자 만들기)
let db: Db;
let accounts: Accounts;
let origin: string;
let close: () => Promise<void>;

before(async () => {
  db = openDatabase(':memory:');
  accounts = createAccounts(db);
  const server = createApp({ store: createStore(db), accounts, trustProxy: true });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () =>
    new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
});

after(async () => {
  await close();
  db.close();
});

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`${origin}/api/v1${path}`, {
    method,
    headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : undefined, headers: response.headers };
}

describe('첫 설정', () => {
  it('설정 코드가 생기기 전에는 만들 수 없고, 사용자가 없으면 화면에 첫 설정을 알린다', async () => {
    assert.equal((await call('GET', '/auth/config')).data.setupRequired, true);
    const early = await call('POST', '/auth/setup', { code: 'AAAA-BBBB-CCCC-DDDD', username: 'root', password: 'root password 1' });
    assert.equal(early.status, 403);
    assert.match(early.data.detail, /설정 코드가 아직 없습니다/);
  });

  it('틀린 코드는 거부하고, 짧은 비밀번호면 아무도 만들지 않으며, 맞는 코드면 관리자를 만들고 바로 로그인한다', async () => {
    const code = accounts.beginSetup()!;
    assert.match(code, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
    assert.equal(accounts.beginSetup(), code, '다시 불러도 같은 코드');
    const wrong = await call('POST', '/auth/setup', { code: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ', username: 'root', password: 'root password 1' });
    assert.equal(wrong.status, 403);
    assert.equal((await call('POST', '/auth/setup', { code, username: 'root', password: 'short' })).status, 422);
    assert.equal(accounts.hasUsers(), false);

    // 소문자로, 하이픈 없이 넣어도 된다.
    const done = await call('POST', '/auth/setup', { code: code.toLowerCase().replaceAll('-', ''), username: 'root', displayName: '관리자', password: 'root password 1' });
    assert.equal(done.status, 201, JSON.stringify(done.data));
    assert.equal(done.data.user.role, 'admin');
    assert.equal(done.data.user.displayName, '관리자');
    const cookie = done.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await call('GET', '/auth/me', undefined, { cookie })).data.user.username, 'root');

    assert.equal((await call('GET', '/auth/config')).data.setupRequired, false);
    const again = await call('POST', '/auth/setup', { code, username: 'intruder', password: 'intruder password' });
    assert.equal(again.status, 403);
    assert.match(again.data.detail, /이미 사용자가 있어/);
    assert.equal(accounts.beginSetup(), null);
  });
});

describe('설정 코드 맞히기 막기', () => {
  it('한 곳에서 코드를 20번 틀리면 그곳에서는 맞는 코드도 막힌다', async () => {
    const fresh = openDatabase(':memory:');
    const freshAccounts = createAccounts(fresh);
    const code = freshAccounts.beginSetup()!;
    for (let i = 0; i < POLICY.failuresPerClient; i += 1) {
      await assert.rejects(freshAccounts.completeSetup({ code: 'WRONG', username: 'x', password: 'x password 12' }, '203.0.113.9'));
    }
    await assert.rejects(freshAccounts.completeSetup({ code, username: 'root', password: 'root password 1' }, '203.0.113.9'), /잠시 시도할 수 없습니다/);
    assert.equal((await freshAccounts.completeSetup({ code, username: 'root', password: 'root password 1' }, '198.51.100.1')).user.role, 'admin');
    fresh.close();
  });
});

describe('프록시 주소', () => {
  it('프록시를 믿지 않으면(기본) X-Forwarded-For를 무시하고 접속 주소로 센다', async () => {
    const server = await startServer();
    try {
      await server.accounts.createUser({ username: 'kim', role: 'viewer', password: 'kim password 1' });
      for (let i = 0; i < POLICY.failuresPerUser; i += 1) {
        await server.callWith({ 'x-forwarded-for': `203.0.113.${i}` }, 'POST', '/auth/login', { username: 'kim', password: 'wrong password' });
      }
      const blocked = await server.callWith({ 'x-forwarded-for': '203.0.113.200' }, 'POST', '/auth/login', { username: 'kim', password: 'kim password 1' });
      assert.equal(blocked.status, 429);
    } finally {
      await server.close();
    }
  });
});
