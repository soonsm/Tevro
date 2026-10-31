import { join, resolve } from 'node:path';
import { createAccounts } from './accounts.ts';
import { createApp } from './app.ts';
import { createStore, openDatabase } from './store.ts';
import { createTrial, loadTemplates } from './trial.ts';

const port = Number(process.env.PORT ?? 4000);
// 기본으로는 이 컴퓨터에서만 접속할 수 있게 연다. 다른 PC에서 열려면 HOST=0.0.0.0(HTTPS 프록시 뒤에 둘 것).
const host = process.env.HOST ?? '127.0.0.1';
const databaseFile = join(resolve(process.env.TEVRO_DATA_DIR ?? 'data'), 'tevro.db');
// 체험 모드: 로그인 없이 열고, 브라우저 창마다 예시 데이터(trial/*.json)의 사본을 쓴다. 원본(데이터 파일)은 쓰지 않는다.
const trialMode = process.env.TEVRO_TRIAL === '1';
const webRoot = resolve(import.meta.dirname, '../../dist/web');

const trial = trialMode ? createTrial(loadTemplates(resolve(import.meta.dirname, '../../trial'))) : null;
const db = trial ? null : openDatabase(databaseFile, (message) => console.log(message));
const accounts = db ? createAccounts(db) : null;
const server = trial ? createApp({ trial, webRoot }) : createApp({ store: createStore(db!), accounts: accounts!, webRoot });

if (process.env.TEVRO_PASSWORD) {
  console.warn('TEVRO_PASSWORD는 더 이상 쓰지 않습니다. 사용자 계정으로 로그인합니다(README의 \'로그인과 권한\').');
}

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`포트 ${port}을(를) 이미 쓰고 있습니다. 예: PORT=4100 npm start`);
    process.exit(1);
  }
  throw error;
});

server.listen(port, host, () => {
  console.log(`Tevro 서버: http://${host === '127.0.0.1' ? 'localhost' : host}:${port}`);
  if (trial) {
    console.log(`체험 모드: 예시 데이터 ${trial.datasets.map((item) => item.label).join(', ')}. 창마다 사본을 쓰고 원본은 바뀌지 않습니다.`);
    return;
  }
  console.log(`데이터 파일: ${databaseFile}`);
  if (!accounts!.hasUsers()) {
    console.warn('아직 사용자가 없어 아무도 로그인할 수 없습니다. 이 서버에서 첫 관리자를 만드세요: npm run admin -- user create --username <아이디> --role admin');
  }
});

// 종료 신호를 받으면 새 요청을 받지 않고, 진행 중인 요청을 마친 뒤 DB를 닫는다(ADR-0002).
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      db?.close();
      trial?.close();
      process.exit(0);
    });
    server.closeIdleConnections();
  });
}
