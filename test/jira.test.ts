import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

describe('이슈 만들기', () => {
  async function configured(name: string) {
    const p = await project(name);
    const saved = await p.call('PUT', `/projects/${p.id}/jira`, {
      projectKey: 'ABC',
      issueTypeId: '10001',
      statusMap: {
        todo: { id: STATUSES.open.id, name: '열림' },
        'in-progress': { id: STATUSES.progress.id, name: '진행 중' },
        done: { id: STATUSES.done.id, name: '완료' },
      },
      linkType: 'Blocks',
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    return p;
  }

  it('Tevro가 채우지 못하는 필수 필드를 이슈 유형별로 알려 준다', async () => {
    const p = await configured('필수 필드');
    const task = (await p.call('GET', `/projects/${p.id}/jira/create-meta`)).data;
    assert.equal(task.issueTypeId, '10001');
    assert.deepEqual(task.issueTypes.map((type: { name: string }) => type.name), ['작업', '이야기']);
    assert.deepEqual(task.fields, [{ id: 'customfield_10106', name: 'Story Points', type: 'number', default: 0 }]);
    assert.deepEqual(task.fills, { description: true, duedate: true, assignee: true, reporter: true });
    const story = (await p.call('GET', `/projects/${p.id}/jira/create-meta?issueTypeId=10002`)).data;
    assert.deepEqual(story.fields.map((field: { name: string; type: string }) => `${field.name}:${field.type}`), ['Story Points:number', '난이도:option']);
    assert.equal((await p.call('GET', `/projects/${p.id}/jira/create-meta?issueTypeId=10003`)).status, 422);
  });

  it('미리 보기는 아무것도 만들지 않고 만들 것·건너뛸 것·만들 링크를 보인다', async () => {
    fake.addIssue({ key: 'ABC-90' });
    const p = await configured('미리 보기');
    const a = await p.add({ title: 'A' });
    const b = await p.add({ title: 'B' });
    const c = await p.add({ title: 'C' });
    const linked = await p.add({ title: '이미 연결' });
    await p.call('POST', `/projects/${p.id}/dependencies`, { from: a.id, to: b.id });
    await p.call('POST', `/projects/${p.id}/dependencies`, { from: b.id, to: c.id });
    await p.call('PATCH', `/tasks/${linked.id}`, { jiraUrl: browse('ABC-90'), jiraConfirm: true });
    const before = fake.issues.size;
    const preview = (await p.call('POST', `/projects/${p.id}/jira/issues`, { dryRun: true, items: [{ taskId: a.id }, { taskId: b.id }, { taskId: linked.id }] })).data;
    assert.equal(fake.issues.size, before);
    assert.deepEqual(preview.items.map((item: { title: string; state: string }) => `${item.title}:${item.state}`), ['A:will-create', 'B:will-create', '이미 연결:skipped']);
    assert.deepEqual(preview.links.map((link: { state: string }) => link.state), ['will-create', 'needs-issue']);
  });

  it('만들면 제목·설명·기한·담당자·보고자와 필수 필드를 넘기고, 진행된 공정은 Jira 상태도 옮기며, 선후관계를 링크로 남긴다', async () => {
    const p = await configured('만들기');
    const a = await p.add({ title: '설계', description: '설계 문서 작성' });
    const b = await p.add({ title: '구현', deadline: '2026-12-10', assigneeId: ids.lee });
    await p.call('PATCH', `/tasks/${a.id}`, { status: 'done' });
    await p.call('POST', `/projects/${p.id}/dependencies`, { from: a.id, to: b.id });
    const created = await p.call('POST', `/projects/${p.id}/jira/issues`, { items: [{ taskId: a.id, fields: { customfield_10106: 3 } }, { taskId: b.id }] });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const [ra, rb] = created.data.items;
    assert.deepEqual([ra.state, rb.state], ['created', 'created']);
    const ia = fake.issues.get(ra.issueKey)!;
    const ib = fake.issues.get(rb.issueKey)!;
    assert.deepEqual([ia.summary, ia.description, ia.reporter, ia.fields.customfield_10106, ia.statusId], ['설계', '설계 문서 작성', 'kim.jira', 3, STATUSES.done.id]);
    assert.deepEqual([ib.duedate, ib.assignee, ib.fields.customfield_10106], ['2026-12-10', 'lee.jira', 0]);
    const g = created.data.graph as GraphDto;
    assert.deepEqual([taskOf(g, a.id).jira!.key, taskOf(g, a.id).status, taskOf(g, a.id).jira!.statusName], [ra.issueKey, 'done', '완료']);
    // A가 B를 막는다: A 이슈에서 보면 outwardIssue가 B
    assert.deepEqual(created.data.links.map((link: { state: string }) => link.state), ['created']);
    assert.deepEqual(fake.links.map((link) => [link.type, link.inward, link.outward]), [['Blocks', ra.issueKey, rb.issueKey]]);
    // 다시 반영하면 이미 있다
    const again = (await p.call('POST', `/projects/${p.id}/jira/links`, {})).data;
    assert.deepEqual(again.links.map((link: { state: string }) => link.state), ['exists']);
    assert.equal(fake.links.length, 1);
    // 마지막에 쓴 필수 필드 값이 다음 기본값이 된다
    const c = await p.add({ title: '시험' });
    await p.call('POST', `/projects/${p.id}/jira/issues`, { items: [{ taskId: c.id, fields: { customfield_10106: 5 } }] });
    assert.equal((await p.call('GET', `/projects/${p.id}/jira/create-meta`)).data.fields[0].default, 5);
  });

  it('Jira가 링크 방향을 반대로 해석하면 읽어서 확인한 뒤 바로잡고 그 방식을 기억한다', async () => {
    fake.linkReversed = true;
    try {
      const p = await configured('링크 방향');
      const a = await p.add({ title: 'A' });
      const b = await p.add({ title: 'B' });
      const c = await p.add({ title: 'C' });
      await p.call('POST', `/projects/${p.id}/dependencies`, { from: a.id, to: b.id });
      await p.call('POST', `/projects/${p.id}/dependencies`, { from: b.id, to: c.id });
      const created = (await p.call('POST', `/projects/${p.id}/jira/issues`, { items: [a, b, c].map((task) => ({ taskId: task.id })) })).data;
      const [ka, kb, kc] = created.items.map((item: { issueKey: string }) => item.issueKey);
      assert.deepEqual(created.links.map((link: { state: string; detail: string }) => link.detail ?? link.state), ['created', 'created']);
      // 반대로 해석하는 Jira에서는 inward=to, outward=from으로 요청해야 'from blocks to'가 된다
      assert.deepEqual(fake.links.map((link) => [link.inward, link.outward]), [[kb, ka], [kc, kb]]);
      assert.equal((server.db.prepare('SELECT link_reversed FROM jira_projects WHERE project_id = ?').get(p.id) as { link_reversed: number }).link_reversed, 1);
    } finally {
      fake.linkReversed = false;
    }
  });

  it('필수 필드가 비면 그 공정만 실패하고, 고를 값은 이름으로도 받는다', async () => {
    const p = await configured('필수 누락');
    const a = await p.add({ title: '이야기 A' });
    const b = await p.add({ title: '이야기 B' });
    const result = (await p.call('POST', `/projects/${p.id}/jira/issues`, {
      items: [
        { taskId: a.id, issueTypeId: '10002' },
        { taskId: b.id, issueTypeId: '10002', fields: { customfield_20000: '어려움' } },
      ],
    })).data;
    assert.equal(result.items[0].state, 'failed');
    assert.match(result.items[0].detail, /난이도: 값을 넣으세요/);
    assert.equal(result.items[1].state, 'created');
    assert.deepEqual(fake.issues.get(result.items[1].issueKey)!.fields.customfield_20000, { id: '2' });
  });

  it('응답을 받지 못한 생성은 "결과 미확인"으로 두고, 다시 시도하면 먼저 Jira에서 찾아 연결한다', async () => {
    const p = await configured('결과 미확인');
    const a = await p.add({ title: '시간 초과 공정' });
    fake.hangNext('POST /rest/api/2/issue');
    const first = (await p.call('POST', `/projects/${p.id}/jira/issues`, { items: [{ taskId: a.id }] })).data;
    assert.equal(first.items[0].state, 'unknown');
    // 실제로는 Jira에 만들어졌다고 하자
    fake.addIssue({ key: 'ABC-777', summary: '시간 초과 공정', reporter: 'kim.jira' });
    const before = fake.issues.size;
    const retry = (await p.call('POST', `/projects/${p.id}/jira/issues`, { items: [{ taskId: a.id }] })).data;
    assert.deepEqual([retry.items[0].state, retry.items[0].issueKey], ['recovered', 'ABC-777']);
    assert.equal(fake.issues.size, before, '새로 만들지 않았다');
  });

  it('Jira 설정이 없으면 만들 수 없다고 알린다', async () => {
    const p = await project('설정 없음');
    const a = await p.add({ title: 'x' });
    const response = await p.call('POST', `/projects/${p.id}/jira/issues`, { items: [{ taskId: a.id }] });
    assert.equal(response.status, 409);
    assert.equal(response.data.code, 'JIRA_NOT_CONFIGURED');
  });
});

describe('CLI', () => {
  const CLI = resolve(import.meta.dirname, '../src/cli/main.ts');
  let home: string;
  before(() => {
    home = mkdtempSync(join(tmpdir(), 'tevro-jira-cli-'));
  });
  after(() => rmSync(home, { recursive: true, force: true }));
  const tevro = (who: string, args: string[], stdin?: string): Promise<{ code: number; stdout: string; stderr: string }> =>
    new Promise((done) => {
      const child = execFile(
        process.execPath,
        [CLI, ...args],
        { env: { ...process.env, TEVRO_SERVER: server.origin, TEVRO_TOKEN: tokens[who], XDG_CONFIG_HOME: home } },
        (error, stdout, stderr) => done({ code: error ? Number(error.code) : 0, stdout, stderr }),
      );
      if (stdin !== undefined) child.stdin!.end(stdin);
    });

  it('토큰 등록, 프로젝트 연결, 미리 보기, 만들기, 새로고침, 충돌 시 종료 코드 5와 --jira-confirm', async () => {
    assert.match((await tevro('park', ['jira', 'status'])).stdout, /내 Jira 토큰이 없습니다/);
    const set = await tevro('park', ['jira', 'token', 'set', '--stdin'], 'token-lee\n');
    assert.equal(set.code, 0, set.stderr);
    assert.match(set.stdout, /Lee Jira/);

    const p = await project('CLI Jira');
    const a = await p.add({ title: '분석' });
    const b = await p.add({ title: '개발' });
    await p.call('POST', `/projects/${p.id}/dependencies`, { from: a.id, to: b.id });
    const setup = await tevro('kim', ['jira', 'setup', '--project', p.id, '--jira-project', 'abc', '--status', '완료=완료']);
    assert.equal(setup.code, 0, setup.stderr);
    assert.match(setup.stdout, /상태 짝\s+미착수→열림, 진행 중→진행 중, 완료→완료/);
    assert.match(setup.stdout, /링크 유형\s+Blocks/);

    const dry = await tevro('kim', ['jira', 'create', '--project', p.id, '--dry-run']);
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /미리 보기[\s\S]*만들 예정\s+분석[\s\S]*만들 예정\s+개발/);
    const before = fake.issues.size;
    const created = await tevro('kim', ['jira', 'create', '--project', p.id, '--field', 'Story Points=2', '--json']);
    assert.equal(created.code, 0, created.stderr);
    const result = JSON.parse(created.stdout).data;
    assert.equal(fake.issues.size, before + 2);
    assert.equal(fake.issues.get(result.items[0].issueKey)!.fields.customfield_10106, 2);
    assert.deepEqual(result.links.map((link: { state: string }) => link.state), ['created']);

    const key = result.items[1].issueKey as string;
    fake.issues.get(key)!.statusId = STATUSES.review.id;
    const refreshed = await tevro('kim', ['jira', 'refresh', '--project', p.id]);
    assert.match(refreshed.stdout, new RegExp(`개발\\s+${key}\\s+검토 중\\s+진행 중`));

    fake.issues.get(key)!.duedate = '2027-02-01';
    const conflict = await tevro('kim', ['task', 'update', b.id, '--deadline', '2027-03-01']);
    assert.equal(conflict.code, 5);
    assert.match(conflict.stderr, /지금 Jira: 상태 검토 중, 기한 2027-02-01[\s\S]*--jira-confirm/);
    const confirmed = await tevro('kim', ['task', 'update', b.id, '--deadline', '2027-03-01', '--jira-confirm']);
    assert.equal(confirmed.code, 0, confirmed.stderr);
    assert.equal(fake.issues.get(key)!.duedate, '2027-03-01');
    assert.match((await tevro('kim', ['task', 'show', b.id])).stdout, new RegExp(`Jira\\s+${key} · 검토 중`));

    // Jira 토큰이 없는 사람은 종료 코드 4
    await tevro('park', ['jira', 'token', 'remove']);
    assert.equal((await tevro('park', ['task', 'status', b.id, '--set', 'done'])).code, 4);
  });
});
