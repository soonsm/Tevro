import { join, resolve } from 'node:path';
import { createApp } from './app.ts';
import { createStore, openDatabase } from './store.ts';

const port = Number(process.env.PORT ?? 4000);
// 인증이 없는 MVP라 기본으로는 이 컴퓨터에서만 접속할 수 있게 연다. 다른 PC에서 열려면 HOST=0.0.0.0.
const host = process.env.HOST ?? '127.0.0.1';
const databaseFile = join(resolve(process.env.TEVRO_DATA_DIR ?? 'data'), 'tevro.db');

const db = openDatabase(databaseFile);
const server = createApp({ store: createStore(db), webRoot: resolve(import.meta.dirname, '../../dist/web') });

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`포트 ${port}을(를) 이미 쓰고 있습니다. 예: PORT=4100 npm start`);
    process.exit(1);
  }
  throw error;
});

server.listen(port, host, () => {
  console.log(`Tevro 서버: http://${host === '127.0.0.1' ? 'localhost' : host}:${port}`);
  console.log(`데이터 파일: ${databaseFile}`);
});

// 종료 신호를 받으면 새 요청을 받지 않고, 진행 중인 요청을 마친 뒤 DB를 닫는다(ADR-0002).
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
    server.closeIdleConnections();
  });
}
