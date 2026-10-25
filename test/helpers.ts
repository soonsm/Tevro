import type { AddressInfo } from 'node:net';
import { createApp } from '../src/server/app.ts';
import { createStore, openDatabase } from '../src/server/store.ts';

export interface TestServer {
  origin: string;
  call: <T = any>(method: string, path: string, body?: unknown) => Promise<{ status: number; data: T }>;
  close: () => Promise<void>;
}

/** 빈 DB로 서버를 띄운다. 파일 경로를 주면 그 파일을 쓴다(재시작 시험용). */
export async function startServer(databaseFile = ':memory:', webRoot?: string): Promise<TestServer> {
  const db = openDatabase(databaseFile);
  const server = createApp({ store: createStore(db), webRoot });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    async call(method, path, body) {
      const response = await fetch(`${origin}/api/v1${path}`, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      return { status: response.status, data: text ? JSON.parse(text) : undefined };
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
