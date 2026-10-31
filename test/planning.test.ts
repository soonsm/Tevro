import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { isOverdue, lateChildren, localToday } from '../src/shared/domain.ts';
import type { GraphDto, PersonDto, ProjectDto } from '../src/shared/types.ts';
import { startServer, type TestServer } from './helpers.ts';

let server: TestServer;
const ids: Record<string, string> = {};
const tokens: Record<string, string> = {};

before(async () => {
  server = await startServer();
  tokens.admin = server.token;
  for (const [username, role, displayName] of [
    ['kim', 'editor', '김편집'],
    ['lee', 'editor', '이담당'],
    ['park', 'viewer', '박열람'],
  ] as const) {
    const user = await server.accounts.createUser({ username, role, displayName, password: `${username} password` });
    ids[username] = user.id;
    tokens[username] = server.accounts.createToken({ user, via: 'session' }, { name: 't', scope: role === 'viewer' ? 'read' : 'read-write' }).token;
  }
});

after(() => server.close());

function as(who: string) {
  return <T = any>(method: string, path: string, body?: unknown) => server.callWith<T>({ authorization: `Bearer ${tokens[who]}` }, method, path, body);
}

async function project(name: string) {
  const call = as('kim');
  const created: ProjectDto = (await call('POST', '/projects', { name })).data;
  const add = async (input: Record<string, unknown>) => (await call('POST', `/projects/${created.id}/tasks`, input)).data.task.id as string;
  return { id: created.id, add, call };
}

const graphOf = async (id: string): Promise<GraphDto> => (await as('admin')('GET', `/projects/${id}/graph`)).data;

describe('기한', () => {
  it('날짜(YYYY-MM-DD)로 정하고, 빈 값이나 null로 지우며, 없는 날짜는 거부한다', async () => {
    const p = await project('기한 프로젝트');
    const task = await p.add({ title: '설계', deadline: '2026-11-15' });
    assert.equal((await graphOf(p.id)).tasks[0].deadline, '2026-11-15');
    for (const bad of ['2026-02-30', '2026/11/15', '20261115', 'tomorrow', 20261115]) {
      assert.equal((await p.call('PATCH', `/tasks/${task}`, { deadline: bad })).status, 422, String(bad));
    }
    await p.call('PATCH', `/tasks/${task}`, { deadline: '' });
    assert.equal((await graphOf(p.id)).tasks[0].deadline, null);
    await p.call('PATCH', `/tasks/${task}`, { deadline: '2027-01-31' });
    await p.call('PATCH', `/tasks/${task}`, { title: '설계 검토' }); // 다른 값을 바꿔도 기한은 그대로
    assert.equal((await graphOf(p.id)).tasks[0].deadline, '2027-01-31');
    await p.call('PATCH', `/tasks/${task}`, { deadline: null });
    assert.equal((await graphOf(p.id)).tasks[0].deadline, null);
  });

  it('지연은 기한 다음 날부터, 끝난 공정은 지연이 아니며, 상위보다 늦은 하위 기한을 찾는다', () => {
    assert.equal(isOverdue({ deadline: '2026-11-01', status: 'todo' }, '2026-11-01'), false);
    assert.equal(isOverdue({ deadline: '2026-11-01', status: 'in-progress' }, '2026-11-02'), true);
    assert.equal(isOverdue({ deadline: '2026-11-01', status: 'done' }, '2026-11-02'), false);
    assert.equal(isOverdue({ deadline: null, status: 'todo' }, '2026-11-02'), false);
    assert.equal(localToday(new Date(2026, 0, 5, 23, 30)), '2026-01-05');
    type Item = { id: string; parentId: string | null; deadline: string | null };
    const parent: Item = { id: 'p', parentId: null, deadline: '2026-11-10' };
    const tasks: Item[] = [parent, { id: 'a', parentId: 'p', deadline: '2026-11-09' }, { id: 'b', parentId: 'p', deadline: '2026-11-12' }, { id: 'c', parentId: 'p', deadline: null }];
    assert.deepEqual(lateChildren(tasks, parent).map((task) => task.id), ['b']);
    assert.deepEqual(lateChildren(tasks, { ...parent, deadline: null }), []);
  });
});

describe('담당자', () => {
  it('활성 사용자만 담당자로 지정하고, 이름을 함께 돌려주며, 비활성화돼도 기록은 남는다', async () => {
    const p = await project('담당자 프로젝트');
    const task = await p.add({ title: '배포 준비', assigneeId: ids.lee });
    let dto = (await graphOf(p.id)).tasks[0];
    assert.deepEqual([dto.assigneeId, dto.assigneeName], [ids.lee, '이담당']);
    assert.equal((await p.call('PATCH', `/tasks/${task}`, { assigneeId: 'usr_nobody' })).status, 422);

    server.accounts.updateUser(ids.lee, { active: false });
    dto = (await graphOf(p.id)).tasks[0];
    assert.deepEqual([dto.assigneeId, dto.assigneeName], [ids.lee, '이담당']);
    const inactive = await p.call('POST', `/projects/${p.id}/tasks`, { title: 'x', assigneeId: ids.lee });
    assert.equal(inactive.status, 422);
    assert.match(inactive.data.detail, /비활성화된 사용자/);
    server.accounts.updateUser(ids.lee, { active: true });

    await p.call('PATCH', `/tasks/${task}`, { assigneeId: '' });
    assert.equal((await graphOf(p.id)).tasks[0].assigneeId, null);
  });

  it('담당자로 고를 사람 목록은 열람자도 보며, 활성 사용자의 이름·아이디만 준다', async () => {
    server.accounts.updateUser(ids.park, { active: true });
    const people: PersonDto[] = (await as('park')('GET', '/people')).data;
    assert.ok(people.some((person) => person.username === 'kim' && person.displayName === '김편집'));
    assert.deepEqual(Object.keys(people[0]).sort(), ['displayName', 'id', 'username']);
    assert.equal((await server.callWith({}, 'GET', '/people')).status, 401);
  });
});

describe('카드 위치', () => {
  it('저장한 위치를 그래프와 함께 돌려주고, 지우면 자동 배치로 돌아가며, 공정을 지우면 함께 지워진다', async () => {
    const p = await project('위치 프로젝트');
    const a = await p.add({ title: 'A' });
    const b = await p.add({ title: 'B' });
    const saved = await p.call('PUT', `/projects/${p.id}/positions`, { set: [{ taskId: a, x: 120.04, y: -40 }, { taskId: b, x: 400, y: 80 }] });
    assert.deepEqual(saved.data, { saved: 2, cleared: 0 });
    assert.deepEqual((await graphOf(p.id)).positions, { [a]: { x: 120, y: -40 }, [b]: { x: 400, y: 80 } });
    await p.call('PUT', `/projects/${p.id}/positions`, { set: [{ taskId: a, x: 10, y: 20 }] });
    assert.deepEqual((await graphOf(p.id)).positions[a], { x: 10, y: 20 });
    assert.deepEqual((await p.call('PUT', `/projects/${p.id}/positions`, { clear: [a] })).data, { saved: 0, cleared: 1 });
    assert.deepEqual(Object.keys((await graphOf(p.id)).positions), [b]);
    await p.call('DELETE', `/tasks/${b}`);
    assert.deepEqual((await graphOf(p.id)).positions, {});
  });

  it('바꿀 수 있는 사람만 저장하고, 다른 프로젝트의 공정이나 이상한 좌표는 거부한다', async () => {
    const p = await project('위치 권한');
    const a = await p.add({ title: 'A' });
    const other = await project('다른 프로젝트');
    const foreign = await other.add({ title: '남의 공정' });
    assert.equal((await as('park')('PUT', `/projects/${p.id}/positions`, { set: [{ taskId: a, x: 1, y: 1 }] })).status, 403);
    assert.equal((await p.call('PUT', `/projects/${p.id}/positions`, { set: [{ taskId: foreign, x: 1, y: 1 }] })).status, 422);
    assert.equal((await p.call('PUT', `/projects/${p.id}/positions`, { set: [{ taskId: a, x: 'left', y: 1 }] })).status, 422);
    assert.equal((await p.call('PUT', `/projects/${p.id}/positions`, { set: 'x' })).status, 422);
  });
});

describe('템플릿과 기한·담당자·위치', () => {
  it('템플릿에는 기한·담당자를 넣을 수 없고, 템플릿으로 만들 때 기한·담당자는 가져오지 않지만 카드 위치는 가져간다', async () => {
    const p = await project('원본');
    const a = await p.add({ title: 'A', deadline: '2026-12-01', assigneeId: ids.kim });
    await p.call('PUT', `/projects/${p.id}/positions`, { set: [{ taskId: a, x: 50, y: 60 }] });
    const template = (await p.call('POST', '/templates/from', { sourceId: p.id, name: '위치 있는 템플릿' })).data;
    const tg = await graphOf(template.id);
    assert.deepEqual([tg.tasks[0].deadline, tg.tasks[0].assigneeId], [null, null]);
    assert.deepEqual(Object.values(tg.positions), [{ x: 50, y: 60 }]);
    assert.equal((await p.call('PATCH', `/tasks/${tg.tasks[0].id}`, { deadline: '2026-12-01' })).status, 422);
    assert.equal((await p.call('POST', `/projects/${template.id}/tasks`, { title: 'x', assigneeId: ids.kim })).status, 422);
    const made = (await p.call('POST', `/templates/${template.id}/instantiate`, { name: '새 프로젝트' })).data;
    const mg = await graphOf(made.id);
    assert.deepEqual([mg.tasks[0].deadline, mg.tasks[0].assigneeId], [null, null]);
    assert.deepEqual(mg.positions, { [mg.tasks[0].id]: { x: 50, y: 60 } });
  });
});

describe('CLI 기한·담당자', () => {
  const CLI = resolve(import.meta.dirname, '../src/cli/main.ts');
  let home: string;
  before(() => {
    home = mkdtempSync(join(tmpdir(), 'tevro-plan-cli-'));
  });
  after(() => rmSync(home, { recursive: true, force: true }));
  const tevro = (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
    new Promise((done) =>
      execFile(
        process.execPath,
        [CLI, ...args],
        { env: { ...process.env, TEVRO_SERVER: server.origin, TEVRO_TOKEN: tokens.kim, XDG_CONFIG_HOME: home } },
        (error, stdout, stderr) => done({ code: error ? Number(error.code) : 0, stdout, stderr }),
      ),
    );

  it('task add·update의 --deadline·--assignee(아이디로), 목록·상세 표시, people, 빈 값으로 지우기', async () => {
    const p = await project('CLI 기한');
    const added = JSON.parse((await tevro(['task', 'add', '--project', p.id, '--title', '문서화', '--deadline', '2020-01-01', '--assignee', 'LEE', '--json'])).stdout).data;
    assert.deepEqual([added.task.deadline, added.task.assigneeName], ['2020-01-01', '이담당']);
    const list = await tevro(['task', 'list', '--project', p.id]);
    assert.match(list.stdout, /기한\s+담당/);
    assert.match(list.stdout, /2020-01-01 지연\s+이담당/);
    assert.match((await tevro(['task', 'show', added.task.id])).stdout, /기한\s+2020-01-01 \(지연\)[\s\S]*담당\s+이담당/);
    assert.equal((await tevro(['task', 'update', added.task.id, '--assignee', 'ghost'])).code, 3);
    assert.equal((await tevro(['task', 'update', added.task.id, '--deadline', '2020-02-30'])).code, 3);
    assert.equal((await tevro(['task', 'update', added.task.id, '--deadline', '', '--assignee', ''])).code, 0);
    const cleared = (await graphOf(p.id)).tasks[0];
    assert.deepEqual([cleared.deadline, cleared.assigneeId], [null, null]);
    assert.doesNotMatch((await tevro(['task', 'list', '--project', p.id])).stdout, /기한/);
    assert.match((await tevro(['people'])).stdout, /김편집\s+kim\s+usr_/);
  });
});
