import type { AddressInfo } from 'node:net';
import { createAccounts, type Accounts } from '../src/server/accounts.ts';
import { createApp } from '../src/server/app.ts';
import { createStore, openDatabase, type Db } from '../src/server/store.ts';
import type { Trial } from '../src/server/trial.ts';

export interface TestServer {
  origin: string;
  db: Db;
  accounts: Accounts;
  /** 시험용 관리자(admin)의 read-write 토큰. call은 이 토큰으로 부른다 */
  token: string;
  call: <T = any>(method: string, path: string, body?: unknown) => Promise<{ status: number; data: T }>;
  /** 머리글을 직접 정해 부른다(토큰 없이, 다른 토큰, 쿠키 등) */
  callWith: <T = any>(headers: Record<string, string>, method: string, path: string, body?: unknown) => Promise<{ status: number; data: T; headers: Headers }>;
  close: () => Promise<void>;
}

export const ADMIN_PASSWORD = 'admin password 1';

/**
 * 빈 DB로 서버를 띄운다. 파일 경로를 주면 그 파일을 쓴다(재시작 시험용).
 * 관리자 admin(비밀번호 ADMIN_PASSWORD)과 그 read-write 토큰을 만들어 둔다. now를 주면 계정 시각을 그 시계로 잰다.
 */
export async function startServer(databaseFile = ':memory:', webRoot?: string, options: { now?: () => number } = {}): Promise<TestServer> {
  const db = openDatabase(databaseFile);
  const accounts = createAccounts(db, { now: options.now });
  const admin = accounts.findUser('admin') ?? (await accounts.createUser({ username: 'admin', role: 'admin', password: ADMIN_PASSWORD }));
  const token = accounts.createToken({ user: admin, via: 'session' }, { name: 'test', scope: 'read-write' }).token;
  const server = createApp({ store: createStore(db), accounts, webRoot });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function callWith(headers: Record<string, string>, method: string, path: string, body?: unknown) {
    const response = await fetch(`${origin}/api/v1${path}`, {
      method,
      headers: body === undefined ? headers : { ...headers, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, data: text ? JSON.parse(text) : undefined, headers: response.headers };
  }
  return {
    origin,
    db,
    accounts,
    token,
    callWith,
    async call(method, path, body) {
      const { status, data } = await callWith({ authorization: `Bearer ${token}` }, method, path, body);
      return { status, data };
    },
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          db.close();
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}

export interface TrialServer {
  origin: string;
  /** sandbox를 주면 그 체험 ID로(화면처럼), 안 주면 체험 ID 없이(CLI처럼) 부른다 */
  call: <T = any>(method: string, path: string, options?: { sandbox?: string; dataset?: string; body?: unknown }) => Promise<{ status: number; data: T }>;
  close: () => Promise<void>;
}

/** 체험 모드 서버를 띄운다. */
export async function startTrialServer(trial: Trial): Promise<TrialServer> {
  const server = createApp({ trial });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    async call(method, path, { sandbox, dataset, body } = {}) {
      const headers: Record<string, string> = {};
      if (sandbox) headers['x-tevro-sandbox'] = sandbox;
      if (dataset) headers['x-tevro-dataset'] = dataset;
      if (body !== undefined) headers['content-type'] = 'application/json';
      const response = await fetch(`${origin}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await response.text();
      return { status: response.status, data: text ? JSON.parse(text) : undefined };
    },
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          trial.close();
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}
