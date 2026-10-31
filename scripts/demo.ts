// 예시 프로젝트를 CLI로 만든다. 에이전트가 CLI로 공정을 등록하는 흐름을 그대로 따른다.
// 데이터는 체험 모드와 같은 trial/<이름>.json을 쓴다(기본: developer). 형식은 trial/README.md
// 사용법: 서버를 켠 뒤(npm start) 다른 터미널에서 TEVRO_TOKEN=<read-write 토큰> npm run demo (일반직용: npm run demo -- general)
// 토큰은 웹 화면 [내 토큰]에서 발급한다(편집자·관리자).
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readDataset } from '../src/server/trial.ts';

const cliPath = resolve(import.meta.dirname, '../src/cli/main.ts');
const name = process.argv[2] ?? 'developer';
if (!/^[a-z0-9-]+$/.test(name)) {
  console.error(`예시 데이터 이름은 trial 폴더의 파일 이름(확장자 빼고)입니다: ${name}`);
  process.exit(2);
}
const dataset = readDataset(resolve(import.meta.dirname, `../trial/${name}.json`));

function tevro<T>(args: string[]): T {
  console.log(`$ tevro ${args.map((arg) => (/[\s"]/.test(arg) ? JSON.stringify(arg) : arg)).join(' ')}`);
  const result = spawnSync(process.execPath, [cliPath, ...args, '--json'], { encoding: 'utf8' });
  if (result.status !== 0) {
    const reason = result.stderr.trim();
    console.error(
      result.status === 8
        ? '서버에 연결하지 못했습니다. 먼저 다른 터미널에서 npm start를 실행하세요.'
        : result.status === 4
          ? `${reason}\n웹 화면 [내 토큰]에서 read-write 토큰을 발급해 TEVRO_TOKEN에 넣고 다시 실행하세요.`
          : reason,
    );
    process.exit(1);
  }
  return JSON.parse(result.stdout).data;
}

const projectIds: string[] = [];
for (const project of dataset.projects) {
  const projectId = tevro<{ id: string }>([
    'project',
    'create',
    '--name',
    project.name,
    ...(project.description ? ['--description', project.description] : []),
  ]).id;
  projectIds.push(projectId);
  // 상위 공정은 하위보다 먼저 만든다(readDataset이 정렬해 둠). 상위의 진행 상태는 하위가 착수되면서 자동으로 바뀔 수 있다.
  const ids = new Map<string, string>();
  for (const task of project.tasks) {
    const args = ['task', 'add', '--project', projectId, '--title', task.title];
    if (task.status) args.push('--status', task.status);
    if (task.parent) args.push('--parent', ids.get(task.parent)!);
    if (task.description) args.push('--description', task.description);
    if (task.jiraUrl) args.push('--jira-url', task.jiraUrl);
    if (task.confluenceUrl) args.push('--confluence-url', task.confluenceUrl);
    ids.set(task.key, tevro<{ task: { id: string } }>(args).task.id);
  }
  for (const [from, to] of project.dependencies) {
    tevro(['dependency', 'add', '--project', projectId, '--from', ids.get(from)!, '--to', ids.get(to)!]);
  }
}

const server = process.env.TEVRO_SERVER ?? 'http://localhost:4000';
console.log(`\n예시 프로젝트를 만들었습니다(${dataset.label}). 브라우저에서 ${server}/?project=${projectIds[0]} 를 여세요.`);
console.log(`CLI로 보기: node src/cli/main.ts graph show --project ${projectIds[0]}`);
