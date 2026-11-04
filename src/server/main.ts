import { join, resolve } from 'node:path';
import { createAccounts } from './accounts.ts';
import { createApp } from './app.ts';
import { createJiraService } from './jiraService.ts';
import { createSecretBox, readSecretKey } from './secrets.ts';
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

// Jira 연동(ADR-0009): TEVRO_JIRA_URL이 있으면 켠다. 사람마다의 Jira 토큰은 TEVRO_SECRET_KEY로 암호화해 저장한다.
const jiraSite = readJiraUrl(process.env.TEVRO_JIRA_URL);
const secret = readSecretKey(process.env.TEVRO_SECRET_KEY);
const box = 'key' in secret ? createSecretBox(secret.key) : null;
const store = db ? createStore(db, { jiraSite: trial ? null : jiraSite }) : null;
const jira = db && store && jiraSite ? createJiraService({ db, store, site: jiraSite, box, boxProblem: 'error' in secret ? secret.error : undefined }) : undefined;
const server = trial ? createApp({ trial, webRoot }) : createApp({ store: store!, accounts: accounts!, jira, webRoot });

function readJiraUrl(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error();
    return url.toString().replace(/\/+$/, '');
  } catch {
    console.error(`TEVRO_JIRA_URL이 올바른 주소가 아닙니다: ${value}. Jira 연동을 끕니다.`);
    return null;
  }
}

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
  const shown = host === '127.0.0.1' || host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  console.log(`Tevro 서버: http://${shown}:${port}${host === '0.0.0.0' || host === '::' ? ' (모든 네트워크 주소에서 받음)' : ''}`);
  if (trial) {
    console.log(`체험 모드: 예시 데이터 ${trial.datasets.map((item) => item.label).join(', ')}. 창마다 사본을 쓰고 원본은 바뀌지 않습니다.`);
    return;
  }
  console.log(`데이터 파일: ${databaseFile}`);
  if (jiraSite) {
    console.log(`Jira 연동: ${jiraSite}${box ? '' : ` (토큰 저장 불가: ${'error' in secret ? secret.error : ''} 예: TEVRO_SECRET_KEY=$(openssl rand -base64 32))`}`);
  }
  const setupCode = accounts!.beginSetup();
  if (setupCode) {
    console.warn(
      [
        '아직 사용자가 없습니다. 브라우저로 이 서버에 들어가 첫 관리자를 만드세요.',
        `  설정 코드: ${setupCode}`,
        '  (이 코드는 서버를 다시 켤 때마다 바뀌고, 첫 관리자를 만들면 더는 쓸 수 없습니다.)',
        `  화면 대신 명령으로 만들 수도 있습니다: ${
          process.env.TEVRO_IN_DOCKER === '1'
            ? 'docker exec -it <컨테이너> node src/server/admin.ts user create --username <아이디> --role admin'
            : 'npm run admin -- user create --username <아이디> --role admin'
        }`,
      ].join('\n'),
    );
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
