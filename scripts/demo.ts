// 예시 프로젝트를 CLI로 만든다. 에이전트가 CLI로 공정을 등록하는 흐름을 그대로 따른다.
// 사용법: 서버를 켠 뒤(npm start) 다른 터미널에서 npm run demo
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const cliPath = resolve(import.meta.dirname, '../src/cli/main.ts');

const TASKS = [
  { key: 'repo', title: '저장소 준비', status: 'done' },
  { key: 'ci', title: 'CI 구성', status: 'in-progress', confluence: 'https://wiki.example.com/display/SVC/CI+구성+절차' },
  { key: 'env', title: '실행환경 구성', status: 'in-progress' },
  { key: 'db', title: '데이터베이스 작업', status: 'done' },
  {
    key: 'gitops',
    title: 'GitOps 설정',
    status: 'todo',
    jira: 'https://jira.example.com/browse/SVC-142',
    confluence: 'https://wiki.example.com/display/SVC/GitOps+설정+절차',
  },
  { key: 'verify', title: '통합 검증', status: 'todo', jira: 'https://jira.example.com/browse/SVC-143' },
  { key: 'deploy', title: '배포', status: 'todo' },
  { key: 'docs', title: '참고 문서 정리', status: 'todo' },
];

const DEPENDENCIES = [
  ['repo', 'ci'],
  ['ci', 'gitops'],
  ['env', 'gitops'],
  ['gitops', 'verify'],
  ['db', 'verify'],
  ['verify', 'deploy'],
];

function tevro(args: string[]): { id: string } {
  console.log(`$ tevro ${args.map((arg) => (/[\s"]/.test(arg) ? JSON.stringify(arg) : arg)).join(' ')}`);
  const result = spawnSync(process.execPath, [cliPath, ...args, '--json'], { encoding: 'utf8' });
  if (result.status !== 0) {
    const reason = result.stderr.trim();
    console.error(result.status === 8 ? '서버에 연결하지 못했습니다. 먼저 다른 터미널에서 npm start를 실행하세요.' : reason);
    process.exit(1);
  }
  return JSON.parse(result.stdout).data;
}

const project = tevro(['project', 'create', '--name', '신규 서비스 준비']);
const ids = new Map<string, string>();
for (const item of TASKS) {
  const args = ['task', 'add', '--project', project.id, '--title', item.title, '--status', item.status];
  if (item.jira) args.push('--jira-url', item.jira);
  if (item.confluence) args.push('--confluence-url', item.confluence);
  ids.set(item.key, tevro(args).id);
}
for (const [from, to] of DEPENDENCIES) {
  tevro(['dependency', 'add', '--project', project.id, '--from', ids.get(from)!, '--to', ids.get(to)!]);
}

const server = process.env.TEVRO_SERVER ?? 'http://localhost:4000';
console.log(`\n예시 프로젝트를 만들었습니다. 브라우저에서 ${server}/?project=${project.id} 를 여세요.`);
console.log(`CLI로 보기: node src/cli/main.ts graph show --project ${project.id}`);
