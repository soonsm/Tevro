import { join, resolve } from 'node:path';
import { createApp } from './app.ts';
import { createStore, openDatabase } from './store.ts';
import { createTrial, loadTemplates } from './trial.ts';

const port = Number(process.env.PORT ?? 4000);
// 인증이 없는 MVP라 기본으로는 이 컴퓨터에서만 접속할 수 있게 연다. 다른 PC에서 열려면 HOST=0.0.0.0.
const host = process.env.HOST ?? '127.0.0.1';
const databaseFile = join(resolve(process.env.TEVRO_DATA_DIR ?? 'data'), 'tevro.db');
// 정식 로그인(ADR-0004) 전까지 인터넷에 올릴 때 쓰는 임시 공용 비밀번호. 비워 두면 묻지 않는다.
const password = process.env.TEVRO_PASSWORD || undefined;
// 체험 모드: 비밀번호 없이 열고, 브라우저 창마다 예시 데이터(trial/*.json)의 사본을 쓴다. 원본(데이터 파일)은 쓰지 않는다.
const trialMode = process.env.TEVRO_TRIAL === '1';
const localOnly = ['127.0.0.1', 'localhost', '::1'].includes(host);
const webRoot = resolve(import.meta.dirname, '../../dist/web');

if (!trialMode && password !== undefined && password.length < 12) {
  console.error('TEVRO_PASSWORD는 12자 이상이어야 합니다. 예: openssl rand -base64 18');
  process.exit(1);
}

const trial = trialMode ? createTrial(loadTemplates(resolve(import.meta.dirname, '../../trial'))) : null;
const db = trial ? null : openDatabase(databaseFile, (message) => console.log(message));
const server = trial ? createApp({ trial, webRoot }) : createApp({ store: createStore(db!), webRoot, password });

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
    if (password) console.log('체험 모드에서는 TEVRO_PASSWORD를 쓰지 않습니다.');
    return;
  }
  console.log(`데이터 파일: ${databaseFile}`);
  console.log(`비밀번호 보호: ${password ? '켜짐' : '꺼짐'}`);
  if (!password && !localOnly) {
    console.warn('주의: 로그인이 없는 서버를 다른 PC에서도 접속할 수 있게 열었습니다. 누구나 고치고 지울 수 있습니다. TEVRO_PASSWORD를 설정하세요.');
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
