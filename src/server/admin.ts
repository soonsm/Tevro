// 서버 호스트에서 실행하는 관리 명령(ADR-0004). 첫 관리자 만들기, 비밀번호 재설정처럼 웹에 로그인할 수 없을 때 쓴다.
// 서버와 같은 데이터 파일(TEVRO_DATA_DIR/tevro.db)을 직접 연다. 서버가 켜져 있어도 된다.
// 비밀번호는 명령행 인자로 받지 않는다. 터미널이면 두 번 묻고, 아니면 표준 입력의 첫 줄을 읽는다.
// 사용법: npm run admin -- user create --username admin --role admin
import { Command, CommanderError } from 'commander';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Role, UserDto } from '../shared/types.ts';
import { createAccounts, readRole } from './accounts.ts';
import { ApiError } from './errors.ts';
import { openDatabase } from './store.ts';

const databaseFile = join(resolve(process.env.TEVRO_DATA_DIR ?? 'data'), 'tevro.db');

const program = new Command('tevro-admin')
  .description(`Tevro 서버 관리 명령. 데이터 파일: ${databaseFile} (TEVRO_DATA_DIR로 바꿈)`)
  .helpOption('-h, --help', '도움말 보기')
  .helpCommand('help [command]', '명령 도움말 보기')
  .exitOverride();

const user = program.command('user').description('사용자');

user
  .command('create')
  .description('사용자 만들기. 비밀번호는 터미널에서 묻거나 표준 입력으로 받음')
  .requiredOption('--username <name>', '아이디 (영문, 숫자와 . _ @ -)')
  .option('--role <role>', 'viewer(열람자) | editor(편집자) | admin(관리자)', 'viewer')
  .option('--display-name <name>', '화면에 보일 이름 (기본: 아이디)')
  .action(async (options: { username: string; role: string; displayName?: string }) => {
    const role = readRole(options.role);
    const password = await readNewPassword();
    const created = await withAccounts((accounts) =>
      accounts.createUser({ username: options.username, displayName: options.displayName, role, password }),
    );
    console.log(`사용자를 만들었습니다: ${created.username} (${ROLE_LABELS[created.role]}, ${created.id})`);
  });

user
  .command('list')
  .description('사용자 목록')
  .action(async () => {
    const users = await withAccounts((accounts) => accounts.listUsers());
    if (users.length === 0) {
      console.log('사용자가 없습니다. 첫 관리자: user create --username <아이디> --role admin');
      return;
    }
    for (const item of users) console.log(`${item.username}\t${ROLE_LABELS[item.role]}\t${item.active ? '활성' : '비활성'}\t${item.id}`);
  });

user
  .command('reset-password')
  .description('비밀번호 재설정(잠금도 풀고, 그 사람의 로그인 세션을 끊음)')
  .argument('<username>', '아이디')
  .action(async (username: string) => {
    const password = await readNewPassword();
    await withAccounts(async (accounts) => accounts.setPassword(requireUser(accounts.findUser(username), username).id, password));
    console.log(`비밀번호를 바꿨습니다: ${username}`);
  });

user
  .command('set-role')
  .description('역할 바꾸기')
  .argument('<username>', '아이디')
  .argument('<role>', 'viewer | editor | admin')
  .action(async (username: string, role: string) => {
    const updated = await withAccounts((accounts) => accounts.updateUser(requireUser(accounts.findUser(username), username).id, { role }));
    console.log(`역할을 바꿨습니다: ${updated.username} → ${ROLE_LABELS[updated.role]}`);
  });

for (const [name, active, label] of [
  ['activate', true, '활성화'],
  ['deactivate', false, '비활성화(로그인·토큰 모두 막힘)'],
] as const) {
  user
    .command(name)
    .description(label)
    .argument('<username>', '아이디')
    .action(async (username: string) => {
      const updated = await withAccounts((accounts) => accounts.updateUser(requireUser(accounts.findUser(username), username).id, { active }));
      console.log(`${updated.username}: ${updated.active ? '활성' : '비활성'}`);
    });
}

const ROLE_LABELS: Record<Role, string> = { viewer: '열람자', editor: '편집자', admin: '관리자' };

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof CommanderError) {
    process.exitCode = error.code === 'commander.helpDisplayed' ? 0 : 2;
  } else {
    process.stderr.write(`오류: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error instanceof ApiError && error.status === 422 ? 3 : 1;
  }
}

async function withAccounts<T>(fn: (accounts: ReturnType<typeof createAccounts>) => T | Promise<T>): Promise<T> {
  const db = openDatabase(databaseFile, (message) => console.log(message));
  try {
    return await fn(createAccounts(db));
  } finally {
    db.close();
  }
}

function requireUser(found: UserDto | null, username: string): UserDto {
  if (!found) throw new Error(`사용자가 없습니다: ${username}`);
  return found;
}

/** 터미널이면 화면에 보이지 않게 두 번 묻고, 아니면 표준 입력의 첫 줄을 읽는다. */
async function readNewPassword(): Promise<string> {
  if (!process.stdin.isTTY) {
    const line = await firstLine();
    if (!line) throw new Error('표준 입력으로 비밀번호를 넣으세요. 예: printf "%s\\n" "$PW" | npm run admin -- ...');
    return line;
  }
  const first = await askHidden('새 비밀번호(10자 이상): ');
  const second = await askHidden('한 번 더: ');
  if (first !== second) throw new Error('두 비밀번호가 다릅니다.');
  return first;
}

function firstLine(): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin });
    let done = false;
    rl.once('line', (line) => {
      done = true;
      rl.close();
      resolve(line.replace(/\r$/, ''));
    });
    rl.once('close', () => {
      if (!done) resolve('');
    });
  });
}

function askHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // 입력한 글자를 화면에 다시 쓰지 않는다.
    (rl as unknown as { _writeToOutput: (text: string) => void })._writeToOutput = (text) => {
      if (text.includes(prompt)) process.stdout.write(prompt);
    };
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}
