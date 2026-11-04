import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { GraphDto, ProjectDto, TaskDto } from '../src/shared/types.ts';
import { STATUSES, startFakeJira, type FakeJira } from './fakeJira.ts';
import { startServer, type TestServer } from './helpers.ts';

let fake: FakeJira;
let server: TestServer;
const ids: Record<string, string> = {};
const tokens: Record<string, string> = {};

before(async () => {
  fake = await startFakeJira();
  server = await startServer(':memory:', undefined, { jira: { site: fake.url } });
  for (const [username, role, displayName] of [
    ['kim', 'editor', '김편집'],
    ['lee', 'editor', '이담당'],
    ['park', 'editor', '박토큰없음'],
  ] as const) {
    const user = await server.accounts.createUser({ username, role, displayName, password: `${username} password` });
    ids[username] = user.id;
    tokens[username] = server.accounts.createToken({ user, via: 'session' }, { name: 't', scope: 'read-write' }).token;
  }
  // 김·이는 Jira 토큰을 등록한다. 박은 등록하지 않는다.
  assert.equal((await as('kim')('PUT', '/jira/token', { token: 'token-kim' })).status, 200);
  assert.equal((await as('lee')('PUT', '/jira/token', { token: 'token-lee' })).status, 200);
});

after(async () => {
  await server.close();
  await fake.close();
});

beforeEach(() => {
  fake.issues.clear();
  fake.links.length = 0;
});

function as(who: string) {
  return <T = any>(method: string, path: string, body?: unknown) => server.callWith<T>({ authorization: `Bearer ${tokens[who]}` }, method, path, body);
}

async function project(name: string) {
  const call = as('kim');
  const created: ProjectDto = (await call('POST', '/projects', { name })).data;
  const add = async (input: Record<string, unknown>) => (await call('POST', `/projects/${created.id}/tasks`, input)).data.task as TaskDto;
  return { id: created.id, add, call };
}

const browse = (key: string) => `${fake.url}/browse/${key}`;
const graph = async (who: string, id: string): Promise<GraphDto> => (await as(who)('GET', `/projects/${id}/graph`)).data;
const taskOf = (g: GraphDto, id: string) => g.tasks.find((task) => task.id === id)!;
/** 마지막 조회를 오래전으로 돌려 다음 읽기에서 다시 조회하게 한다 */
const ageRefresh = (projectId: string) =>
  server.db.prepare("UPDATE jira_projects SET last_refresh_at = '2000-01-01T00:00:00.000Z' WHERE project_id = ?").run(projectId);

describe('Jira 토큰', () => {
  it('Jira에 확인한 뒤 암호화해 저장하고, 내 Jira 사용자를 계정에 짝짓는다. 토큰 값은 어디에도 돌려주지 않는다', async () => {
    const status = (await as('kim')('GET', '/jira/token')).data;
    assert.deepEqual(
      { enabled: status.enabled, storage: status.storage, connected: status.connected, jiraName: status.jiraName, problem: status.problem },
      { enabled: true, storage: true, connected: true, jiraName: 'kim.jira', problem: null },
    );
    assert.doesNotMatch(JSON.stringify(status), /token-kim/);
    const stored = server.db.prepare('SELECT sealed FROM jira_tokens WHERE user_id = ?').get(ids.kim) as { sealed: string };
    assert.match(stored.sealed, /^v1\./);
    assert.doesNotMatch(stored.sealed, /token-kim/);
    assert.equal(server.accounts.getUser(ids.kim).jiraName, 'kim.jira');
  });

  it('Jira가 받지 않는 토큰은 저장하지 않는다', async () => {
    const bad = await as('park')('PUT', '/jira/token', { token: 'token-nobody-xyz' });
    assert.equal(bad.status, 424);
    assert.equal(bad.data.code, 'JIRA_AUTH');
    assert.equal((await as('park')('GET', '/jira/token')).data.connected, false);
  });

  it('서버 비밀키가 없으면 토큰을 저장할 수 없다고 알린다', async () => {
    const noKey = await startServer(':memory:', undefined, { jira: { site: fake.url, secret: false } });
    try {
      const response = await noKey.call('PUT', '/jira/token', { token: 'token-kim' });
      assert.equal(response.status, 409);
      assert.equal(response.data.code, 'JIRA_NOT_CONFIGURED');
      assert.match((await noKey.call('GET', '/jira/token')).data.problem, /TEVRO_SECRET_KEY/);
    } finally {
      await noKey.close();
    }
  });
});

describe('기존 이슈 연결과 조회', () => {
  it('연결하면 Jira 값이 Tevro 값을 덮는다. 다르면 먼저 확인을 받는다', async () => {
    fake.addIssue({ key: 'ABC-1', summary: 'Jira 쪽 제목', statusId: STATUSES.review.id, duedate: '2026-12-01', assignee: 'lee.jira' });
    const p = await project('연결');
    const task = await p.add({ title: '설계' });
    const first = await p.call('PATCH', `/tasks/${task.id}`, { jiraUrl: browse('ABC-1') });
    assert.equal(first.status, 409);
    assert.equal(first.data.code, 'JIRA_CHANGED');
    assert.deepEqual(first.data.jira, { key: 'ABC-1', status: 'in-progress', statusName: '검토 중', deadline: '2026-12-01', assigneeId: ids.lee, assigneeName: 'Lee Jira' });
    assert.equal(taskOf(await graph('kim', p.id), task.id).jiraUrl, null, '확인 전에는 연결하지 않는다');

    const linked = await p.call('PATCH', `/tasks/${task.id}`, { jiraUrl: browse('ABC-1'), jiraConfirm: true });
    assert.equal(linked.status, 200, JSON.stringify(linked.data));
    const t = linked.data.task as TaskDto;
    assert.deepEqual([t.status, t.deadline, t.assigneeId], ['in-progress', '2026-12-01', ids.lee]);
    assert.deepEqual(
      { key: t.jira!.key, statusName: t.jira!.statusName, summary: t.jira!.summary, fetchedBy: t.jira!.fetchedBy },
      { key: 'ABC-1', statusName: '검토 중', summary: 'Jira 쪽 제목', fetchedBy: '김편집' },
    );
  });

  it('프로젝트를 읽을 때 마지막 조회 뒤 5분이 지났으면 읽는 사람의 토큰으로 다시 가져온다', async () => {
    fake.addIssue({ key: 'ABC-2', statusId: STATUSES.open.id });
    const p = await project('조회');
    const task = await p.add({ title: '배포' });
    await p.call('PATCH', `/tasks/${task.id}`, { jiraUrl: browse('ABC-2'), jiraConfirm: true });
    await as('lee')('POST', `/projects/${p.id}/jira/refresh`);

    // Jira에서 카드를 옮기고 기한·담당자를 바꾼다
    Object.assign(fake.issues.get('ABC-2')!, { statusId: STATUSES.done.id, duedate: '2027-01-15', assignee: 'outsider' });
    assert.equal(taskOf(await graph('lee', p.id), task.id).status, 'todo', '5분이 안 지났으면 저장된 값');
    ageRefresh(p.id);
    const fresh = taskOf(await graph('lee', p.id), task.id);
    assert.deepEqual([fresh.status, fresh.deadline, fresh.assigneeId], ['done', '2027-01-15', null]);
    assert.deepEqual([fresh.jira!.assigneeName, fresh.jira!.assigneeUnmapped, fresh.jira!.fetchedBy], ['Outsider', true, '이담당']);
    const g = await graph('lee', p.id);
    assert.equal(g.jira.lastRefreshBy, '이담당');
    assert.equal(g.jira.lastRefreshError, null);
  });

  it('토큰이 없는 사람이 읽으면 조회하지 않고 저장된 값을 준다', async () => {
    fake.addIssue({ key: 'ABC-3' });
    const p = await project('토큰 없이 읽기');
    const task = await p.add({ title: 'x' });
    await p.call('PATCH', `/tasks/${task.id}`, { jiraUrl: browse('ABC-3'), jiraConfirm: true });
    fake.issues.get('ABC-3')!.statusId = STATUSES.progress.id;
    ageRefresh(p.id);
    const before = fake.calls.length;
    assert.equal(taskOf(await graph('park', p.id), task.id).status, 'todo');
    assert.equal(fake.calls.length, before);
  });

  it('없는 이슈는 그 공정만 실패로 표시하고, 나머지는 반영한다. Jira가 죽어도 읽기는 된다', async () => {
    fake.addIssue({ key: 'ABC-4', statusId: STATUSES.progress.id });
    const p = await project('일부 실패');
    const ok = await p.add({ title: '있는 이슈' });
    const gone = await p.add({ title: '없는 이슈' });
    await p.call('PATCH', `/tasks/${ok.id}`, { jiraUrl: browse('ABC-4'), jiraConfirm: true });
    await as('park')('PATCH', `/tasks/${gone.id}`, { jiraUrl: browse('ABC-404') }); // 토큰 없는 사람은 확인 없이 연결만 한다
    const refreshed = (await as('kim')('POST', `/projects/${p.id}/jira/refresh`)).data as GraphDto;
    assert.equal(taskOf(refreshed, ok.id).status, 'in-progress');
    assert.match(taskOf(refreshed, gone.id).jira!.error!, /찾을 수 없거나/);

    fake.failNext('/search', 503);
    const down = await as('kim')('POST', `/projects/${p.id}/jira/refresh`);
    assert.equal(down.status, 502);
    assert.equal(down.data.code, 'JIRA_UNAVAILABLE');
    ageRefresh(p.id);
    fake.failNext('/search', 503);
    const g = await graph('kim', p.id);
    assert.match(g.jira.lastRefreshError!, /요청을 잠시 받지 않습니다/);
    assert.equal(taskOf(g, ok.id).status, 'in-progress', '실패해도 이전 값은 그대로');
  });

  it('연결을 끊으면 Jira 정보는 사라지고 상태·기한은 마지막 값으로 남는다', async () => {
    fake.addIssue({ key: 'ABC-5', statusId: STATUSES.done.id, duedate: '2026-11-30' });
    const p = await project('해제');
    const task = await p.add({ title: 'x' });
    await p.call('PATCH', `/tasks/${task.id}`, { jiraUrl: browse('ABC-5'), jiraConfirm: true });
    const cut = (await p.call('PATCH', `/tasks/${task.id}`, { jiraUrl: '' })).data.task as TaskDto;
    assert.deepEqual([cut.jira, cut.status, cut.deadline], [null, 'done', '2026-11-30']);
    // 이제 Tevro에서 바로 바꾼다(Jira를 부르지 않는다)
    const before = fake.calls.length;
    assert.equal((await p.call('PATCH', `/tasks/${task.id}`, { status: 'todo' })).status, 200);
    assert.equal(fake.calls.length, before);
  });

  it('다른 사이트의 Jira 주소는 링크로만 둔다', async () => {
    const p = await project('다른 사이트');
    const task = (await p.add({ title: 'x', jiraUrl: 'https://other-jira.example.com/browse/XYZ-9' })) as TaskDto;
    assert.equal(task.jira, null);
    assert.equal(task.jiraKey, 'XYZ-9');
  });
});

describe('Tevro에서 바꾸면 Jira에 먼저 반영', () => {
  async function linkedTask(key: string, issue: Parameters<FakeJira['addIssue']>[0] = { key }) {
    fake.addIssue(issue);
    const p = await project(`반영 ${key}`);
    const task = await p.add({ title: key });
    const r = await p.call('PATCH', `/tasks/${task.id}`, { jiraUrl: browse(key), jiraConfirm: true });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return { p, task };
  }

  it('완료로 바꾸면 Jira에서 열림 → 진행 중 → 검토 중 → 완료로 옮긴다(완료 분류의 "안 함"으로 가지 않는다)', async () => {
    const { p, task } = await linkedTask('ABC-10');
    const done = await p.call('PATCH', `/tasks/${task.id}`, { status: 'done' });
    assert.equal(done.status, 200, JSON.stringify(done.data));
    assert.equal(fake.issues.get('ABC-10')!.statusId, STATUSES.done.id);
    assert.equal(done.data.task.status, 'done');
    assert.equal(done.data.task.jira.statusName, '완료');
  });

  it('상태 짝을 정해 두면 그 상태로 옮긴다', async () => {
    const { p, task } = await linkedTask('ABC-11', { key: 'ABC-11', statusId: STATUSES.progress.id });
    await p.call('PUT', `/projects/${p.id}/jira`, { projectKey: 'ABC', statusMap: { done: { id: STATUSES.wontdo.id, name: '안 함' } } });
    assert.equal((await p.call('PATCH', `/tasks/${task.id}`, { status: 'done' })).status, 200);
    assert.equal(fake.issues.get('ABC-11')!.statusId, STATUSES.wontdo.id);
  });

  it('기한과 담당자를 Jira에 반영한다. Jira 사용자와 짝짓지 않은 사람은 담당자로 넘길 수 없다', async () => {
    const { p, task } = await linkedTask('ABC-12');
    const changed = await p.call('PATCH', `/tasks/${task.id}`, { deadline: '2026-12-24', assigneeId: ids.lee });
    assert.equal(changed.status, 200, JSON.stringify(changed.data));
    assert.deepEqual([fake.issues.get('ABC-12')!.duedate, fake.issues.get('ABC-12')!.assignee], ['2026-12-24', 'lee.jira']);
    const unmapped = await p.call('PATCH', `/tasks/${task.id}`, { assigneeId: ids.park });
    assert.equal(unmapped.status, 422);
    assert.match(unmapped.data.detail, /짝지어지지 않아/);
    assert.equal(fake.issues.get('ABC-12')!.assignee, 'lee.jira');

    // 관리자가 짝지어 주면 넘길 수 있다
    server.jira!.setUserJiraName(ids.park, 'outsider');
    assert.equal((await p.call('PATCH', `/tasks/${task.id}`, { assigneeId: ids.park })).status, 200);
    assert.equal(fake.issues.get('ABC-12')!.assignee, 'outsider');
    server.jira!.setUserJiraName(ids.park, null);
  });

  it('Jira 토큰이 없는 사람은 연결된 공정의 상태·기한·담당자를 바꿀 수 없다. 제목은 바꿀 수 있다', async () => {
    const { task } = await linkedTask('ABC-13');
    const denied = await as('park')('PATCH', `/tasks/${task.id}`, { status: 'in-progress' });
    assert.equal(denied.status, 403);
    assert.equal(denied.data.code, 'JIRA_TOKEN_REQUIRED');
    assert.equal(fake.issues.get('ABC-13')!.statusId, STATUSES.open.id);
    assert.equal((await as('park')('PATCH', `/tasks/${task.id}`, { title: '제목만' })).status, 200);
  });

  it('마지막 조회 뒤 Jira에서 바뀌었으면 덮어쓰지 않고 지금 값을 알린다. 확인하면 반영한다', async () => {
    const { p, task } = await linkedTask('ABC-14');
    fake.issues.get('ABC-14')!.duedate = '2026-11-20'; // 누가 Jira에서 기한을 바꿨다
    const conflict = await p.call('PATCH', `/tasks/${task.id}`, { deadline: '2026-12-31' });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.data.code, 'JIRA_CHANGED');
    assert.equal(conflict.data.jira.deadline, '2026-11-20');
    assert.equal(fake.issues.get('ABC-14')!.duedate, '2026-11-20');
    assert.equal((await p.call('PATCH', `/tasks/${task.id}`, { deadline: '2026-12-31', jiraConfirm: true })).status, 200);
    assert.equal(fake.issues.get('ABC-14')!.duedate, '2026-12-31');
  });

  it('Jira가 실패하면 Tevro 값도 바꾸지 않는다', async () => {
    const { p, task } = await linkedTask('ABC-15');
    fake.failNext('PUT /rest/api/2/issue/ABC-15', 400, { errors: { duedate: '기한을 바꿀 수 없습니다' } });
    const failed = await p.call('PATCH', `/tasks/${task.id}`, { deadline: '2026-12-01' });
    assert.equal(failed.status, 424);
    assert.equal(failed.data.code, 'JIRA_REJECTED');
    assert.match(failed.data.detail, /기한을 바꿀 수 없습니다/);
    assert.equal(taskOf(await graph('kim', p.id), task.id).deadline, null);
  });

  it('Jira에 연결된 상위 공정은 하위가 모두 끝나도 자동 완료하지 않고 어긋남으로 보인다', async () => {
    fake.addIssue({ key: 'ABC-16', statusId: STATUSES.progress.id });
    const p = await project('상위 연결');
    const parent = await p.add({ title: '상위' });
    await p.call('PATCH', `/tasks/${parent.id}`, { jiraUrl: browse('ABC-16'), jiraConfirm: true });
    const child = await p.add({ title: '하위', parentId: parent.id });
    await p.call('PATCH', `/tasks/${child.id}`, { status: 'done' });
    const g = await graph('kim', p.id);
    assert.equal(taskOf(g, parent.id).status, 'in-progress');
    assert.equal(taskOf(g, parent.id).inconsistency, 'CHILDREN_DONE_PARENT_OPEN');
  });
});

describe('프로젝트 연결 설정', () => {
  it('이슈 유형(하위 작업 제외)·상태·링크 유형과 추천값을 주고, 설정을 저장한다', async () => {
    const p = await project('설정');
    const options = (await p.call('GET', `/projects/${p.id}/jira/options?projectKey=ABC`)).data;
    assert.deepEqual(options.issueTypes.map((type: { name: string }) => type.name), ['작업', '이야기']);
    assert.deepEqual(options.suggested.statusMap, {
      todo: { id: STATUSES.open.id, name: '열림' },
      'in-progress': { id: STATUSES.progress.id, name: '진행 중' },
      done: { id: STATUSES.done.id, name: '완료' },
    });
    assert.equal(options.suggested.linkType, 'Blocks');
    const saved = await p.call('PUT', `/projects/${p.id}/jira`, {
      projectKey: 'ABC',
      issueTypeId: '10001',
      statusMap: options.suggested.statusMap,
      linkType: 'Blocks',
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    assert.deepEqual([saved.data.projectKey, saved.data.issueTypeName, saved.data.linkType], ['ABC', '작업', 'Blocks']);
    assert.equal((await p.call('PUT', `/projects/${p.id}/jira`, { projectKey: 'ABC', issueTypeId: '10003' })).status, 422, '하위 작업 유형은 고를 수 없다');
    assert.equal((await p.call('GET', `/projects/${p.id}/jira/options?projectKey=NOPE`)).status, 424);
  });

  it('Jira가 없는 서버에서는 Jira 경로가 없고, 그래프의 jira.enabled는 false다', async () => {
    const plain = await startServer();
    try {
      const created = (await plain.call('POST', '/projects', { name: 'x' })).data as ProjectDto;
      assert.equal((await plain.call('GET', `/projects/${created.id}/graph`)).data.jira.enabled, false);
      assert.equal((await plain.call('GET', '/jira/token')).status, 404);
    } finally {
      await plain.close();
    }
  });
});
