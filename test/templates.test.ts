import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { GraphDto, ProjectDto, TemplateSummaryDto } from '../src/shared/types.ts';
import { createTrial, loadTemplates } from '../src/server/trial.ts';
import { startServer, startTrialServer, type TestServer } from './helpers.ts';

let server: TestServer;
const tokens: Record<string, string> = {};

before(async () => {
  server = await startServer();
  tokens.admin = server.token;
  for (const [username, role] of [
    ['editor', 'editor'],
    ['other', 'editor'],
    ['viewer', 'viewer'],
  ] as const) {
    const user = await server.accounts.createUser({ username, role, password: `${username} password` });
    tokens[username] = server.accounts.createToken({ user, via: 'session' }, { name: 'test', scope: role === 'viewer' ? 'read' : 'read-write' }).token;
  }
  // 열람자의 read-write 토큰은 발급할 수 없으므로, 열람자가 자기 템플릿을 고치는 시험은 세션으로 한다.
});

after(() => server.close());

function as(who: string) {
  const headers = { authorization: `Bearer ${tokens[who]}` };
  return <T = any>(method: string, path: string, body?: unknown) => server.callWith<T>(headers, method, path, body);
}

async function session(username: string) {
  const login = await server.callWith({}, 'POST', '/auth/login', { username, password: `${username} password` });
  assert.equal(login.status, 200);
  const headers = { cookie: login.headers.get('set-cookie')!.split(';')[0], 'x-tevro-csrf': login.data.csrfToken };
  return <T = any>(method: string, path: string, body?: unknown) => server.callWith<T>(headers, method, path, body);
}

/** 계층·연결·상태·링크가 있는 프로젝트 */
async function sampleProject(name: string) {
  const call = as('editor');
  const project: ProjectDto = (await call('POST', '/projects', { name })).data;
  const add = async (input: Record<string, unknown>) => (await call('POST', `/projects/${project.id}/tasks`, input)).data.task.id as string;
  const repo = await add({ title: '저장소 준비', status: 'done', jiraUrl: 'https://jira.example.com/browse/A-1' });
  const dev = await add({ title: '개발', confluenceUrl: 'https://wiki.example.com/dev', description: '개발 절차' });
  const online = await add({ title: '온라인', parentId: dev, status: 'in-progress' });
  const batch = await add({ title: '배치', parentId: dev });
  await call('POST', `/projects/${project.id}/dependencies`, { from: repo, to: dev });
  await call('POST', `/projects/${project.id}/dependencies`, { from: online, to: batch });
  return { project, ids: { repo, dev, online, batch } };
}

const graphOf = async (id: string, who = 'admin'): Promise<GraphDto> => (await as(who)('GET', `/projects/${id}/graph`)).data;

describe('템플릿 저장과 적용', () => {
  it('프로젝트를 템플릿으로 저장하면 구조만 새 ID로 복사하고, 진행 상태와 Jira 링크는 빼고 Confluence 링크는 남긴다', async () => {
    const { project, ids } = await sampleProject('원본 프로젝트');
    const saved = await as('editor')('POST', '/templates/from', { sourceId: project.id, name: '원본 템플릿', description: '설명' });
    assert.equal(saved.status, 201);
    assert.match(saved.data.id, /^tpl_/);
    assert.equal(saved.data.kind, 'template');
    assert.deepEqual(saved.data.template, { official: false, ownerId: server.accounts.findUser('editor')!.id, ownerName: 'editor', version: 1 });

    const graph = await graphOf(saved.data.id);
    assert.equal(graph.tasks.length, 4);
    assert.ok(graph.tasks.every((task) => task.status === 'todo' && task.jiraUrl === null));
    assert.ok(graph.tasks.every((task) => !Object.values(ids).includes(task.id)));
    const byTitle = new Map(graph.tasks.map((task) => [task.title, task]));
    assert.equal(byTitle.get('개발')!.confluenceUrl, 'https://wiki.example.com/dev');
    assert.equal(byTitle.get('개발')!.description, '개발 절차');
    assert.equal(byTitle.get('온라인')!.parentId, byTitle.get('개발')!.id);
    assert.deepEqual(
      graph.dependencies.map((edge) => [byTitle.get('저장소 준비')!.id === edge.from || byTitle.get('온라인')!.id === edge.from]),
      [[true], [true]],
    );
    // 프로젝트 목록에는 템플릿이 섞이지 않는다.
    assert.ok(!(await as('editor')('GET', '/projects')).data.some((item: ProjectDto) => item.id === saved.data.id));
  });

  it('템플릿으로 만든 프로젝트 X·Y는 서로, 그리고 템플릿과 독립이고 출처(이름·판)가 남는다 (AC-07, AC-08, AC-30)', async () => {
    const call = as('editor');
    const { project } = await sampleProject('출처 확인용');
    const template = (await call('POST', '/templates/from', { sourceId: project.id, name: '독립 템플릿' })).data;
    const x: ProjectDto = (await call('POST', `/templates/${template.id}/instantiate`, { name: 'X' })).data;
    const y: ProjectDto = (await call('POST', `/templates/${template.id}/instantiate`, { name: 'Y' })).data;
    assert.match(x.id, /^prj_/);
    assert.equal(x.kind, 'project');
    assert.deepEqual({ ...x.source, appliedAt: undefined }, { templateId: template.id, name: '독립 템플릿', version: 1, appliedAt: undefined });

    const gx = await graphOf(x.id);
    const gy = await graphOf(y.id);
    assert.equal(gx.tasks.length, 4);
    assert.equal(new Set([...gx.tasks, ...gy.tasks].map((task) => task.id)).size, 8);
    // X를 바꿔도 Y와 템플릿은 그대로
    await call('PATCH', `/tasks/${gx.tasks[0].id}`, { status: 'done', title: 'X에서 바꿈' });
    assert.ok((await graphOf(y.id)).tasks.every((task) => task.status === 'todo' && task.title !== 'X에서 바꿈'));
    assert.ok((await graphOf(template.id)).tasks.every((task) => task.title !== 'X에서 바꿈'));
    // 템플릿을 고쳐도 X·Y는 그대로이고, 고친 뒤 처음 만든 프로젝트부터 새 판(2판)으로 기록된다.
    const tt = await graphOf(template.id);
    await call('PATCH', `/tasks/${tt.tasks[0].id}`, { title: '템플릿에서 바꿈' });
    await call('PATCH', `/tasks/${tt.tasks[1].id}`, { title: '한 번 더 바꿈' });
    assert.equal((await graphOf(template.id)).project.template!.version, 1);
    assert.ok((await graphOf(x.id)).tasks.every((task) => task.title !== '템플릿에서 바꿈'));
    const z: ProjectDto = (await call('POST', `/templates/${template.id}/instantiate`, { name: 'Z' })).data;
    const w: ProjectDto = (await call('POST', `/templates/${template.id}/instantiate`, { name: 'W' })).data;
    assert.deepEqual([z.source!.version, w.source!.version], [2, 2]);
    assert.equal((await graphOf(template.id)).project.template!.version, 2);
    const list: TemplateSummaryDto[] = (await call('GET', '/templates')).data;
    assert.equal(list.find((item) => item.id === template.id)!.usedBy, 4);
  });

  it('템플릿을 지워도 그것으로 만든 프로젝트와 출처 기록은 남는다 (AC-22)', async () => {
    const call = as('editor');
    const template = (await call('POST', '/templates', { name: '곧 지울 템플릿' })).data;
    await call('POST', `/projects/${template.id}/tasks`, { title: '할 일' });
    const made: ProjectDto = (await call('POST', `/templates/${template.id}/instantiate`, { name: '남을 프로젝트' })).data;
    assert.equal((await call('DELETE', `/templates/${template.id}`)).status, 200);
    assert.equal((await call('GET', `/projects/${template.id}/graph`)).status, 404);
    const graph = await graphOf(made.id);
    assert.equal(graph.tasks.length, 1);
    assert.deepEqual([graph.project.source!.name, graph.project.source!.version], ['곧 지울 템플릿', 1]);
  });

  it('템플릿 공정에는 진행 상태와 Jira 링크를 넣을 수 없다', async () => {
    const call = as('editor');
    const template = (await call('POST', '/templates', { name: '상태 없는 템플릿' })).data;
    assert.equal((await call('POST', `/projects/${template.id}/tasks`, { title: 'x', status: 'done' })).status, 422);
    assert.equal((await call('POST', `/projects/${template.id}/tasks`, { title: 'x', jiraUrl: 'https://jira.example.com/browse/A-1' })).status, 422);
    const task = (await call('POST', `/projects/${template.id}/tasks`, { title: 'x', confluenceUrl: 'https://wiki.example.com/x' })).data.task;
    const denied = await call('PATCH', `/tasks/${task.id}`, { status: 'in-progress' });
    assert.equal(denied.status, 422);
    assert.match(denied.data.detail, /진행 상태가 없습니다/);
    assert.equal((await call('PATCH', `/tasks/${task.id}`, { status: 'todo', title: 'y' })).status, 200);
  });
});

describe('회사 템플릿과 내 템플릿', () => {
  it('내 템플릿은 나만(관리자는 모두) 보고, 회사 템플릿은 모두 보며 관리자만 만든다', async () => {
    const mine = (await as('editor')('POST', '/templates', { name: '편집자의 개인 템플릿' })).data;
    assert.equal((await as('editor')('POST', '/templates', { name: '몰래 공식', official: true })).status, 403);
    const company = (await as('admin')('POST', '/templates', { name: '회사 표준', official: true })).data;
    assert.equal(company.template.official, true);

    const seen = async (who: string) => ((await as(who)('GET', '/templates')).data as TemplateSummaryDto[]).map((item) => item.id);
    assert.ok((await seen('editor')).includes(mine.id));
    assert.ok(!(await seen('other')).includes(mine.id));
    assert.ok((await seen('admin')).includes(mine.id));
    for (const who of ['editor', 'other', 'viewer']) assert.ok((await seen(who)).includes(company.id));
    // 남의 개인 템플릿은 없는 것처럼
    assert.equal((await as('other')('GET', `/projects/${mine.id}/graph`)).status, 404);
    assert.equal((await as('other')('POST', `/projects/${mine.id}/tasks`, { title: 'x' })).status, 404);
    assert.equal((await as('other')('POST', `/templates/${mine.id}/instantiate`, { name: 'x' })).status, 404);
    assert.equal((await as('other')('POST', '/templates/from', { sourceId: mine.id, name: 'x' })).status, 404);
  });

  it('회사 템플릿은 관리자만 고치고 지우며, 다른 사람은 내 템플릿으로 복사해 고쳐 쓴다', async () => {
    const company = (await as('admin')('POST', '/templates', { name: '복사해 쓸 회사 템플릿', official: true })).data;
    await as('admin')('POST', `/projects/${company.id}/tasks`, { title: '회사 공정' });
    const denied = await as('editor')('POST', `/projects/${company.id}/tasks`, { title: 'x' });
    assert.equal(denied.status, 403);
    assert.match(denied.data.detail, /내 템플릿으로 복사/);
    assert.equal((await as('editor')('DELETE', `/templates/${company.id}`)).status, 403);
    assert.equal((await as('editor')('PATCH', `/templates/${company.id}`, { name: 'x' })).status, 403);
    const list: TemplateSummaryDto[] = (await as('editor')('GET', '/templates')).data;
    assert.equal(list.find((item) => item.id === company.id)!.canEdit, false);

    const copy = await as('editor')('POST', '/templates/from', { sourceId: company.id, name: '내 수정본' });
    assert.equal(copy.status, 201);
    assert.deepEqual([copy.data.template.official, copy.data.template.ownerId], [false, server.accounts.findUser('editor')!.id]);
    assert.equal((await as('editor')('POST', `/projects/${copy.data.id}/tasks`, { title: '내가 더한 공정' })).status, 201);
    assert.deepEqual((await graphOf(company.id)).tasks.map((task) => task.title), ['회사 공정']);
    assert.deepEqual((await graphOf(copy.data.id)).tasks.map((task) => task.title), ['회사 공정', '내가 더한 공정']);
  });

  it('관리자는 개인 템플릿을 회사 템플릿으로 지정·해제하고, 편집자는 지정할 수 없다', async () => {
    const mine = (await as('editor')('POST', '/templates', { name: '올릴 템플릿' })).data;
    assert.equal((await as('editor')('PATCH', `/templates/${mine.id}`, { official: true })).status, 403);
    const promoted = await as('admin')('PATCH', `/templates/${mine.id}`, { official: true });
    assert.equal(promoted.data.template.official, true);
    assert.equal(promoted.data.template.version, 1); // 회사 템플릿 지정은 내용을 바꾸지 않는다
    // 회사 템플릿이 되면 만든 사람도 못 고친다
    assert.equal((await as('editor')('POST', `/projects/${mine.id}/tasks`, { title: 'x' })).status, 403);
    await as('admin')('PATCH', `/templates/${mine.id}`, { official: false });
    assert.equal((await as('editor')('POST', `/projects/${mine.id}/tasks`, { title: '다시 내 것' })).status, 201);
    assert.equal((await as('other')('GET', `/projects/${mine.id}/graph`)).status, 404);
  });

  it('열람자도 웹에서 내 템플릿을 만들고 고치지만, 템플릿으로 프로젝트를 만들거나 프로젝트를 고칠 수는 없다', async () => {
    const viewer = await session('viewer');
    const mine = await viewer('POST', '/templates', { name: '열람자의 템플릿' });
    assert.equal(mine.status, 201);
    assert.equal((await viewer('POST', `/projects/${mine.data.id}/tasks`, { title: '열람자 공정' })).status, 201);
    const denied = await viewer('POST', `/templates/${mine.data.id}/instantiate`, { name: 'x' });
    assert.equal(denied.status, 403);
    const { project } = await sampleProject('열람자가 못 고치는 프로젝트');
    assert.equal((await viewer('POST', `/projects/${project.id}/tasks`, { title: 'x' })).status, 403);
    // 열람자의 read 토큰으로는 자기 템플릿도 못 고친다
    assert.equal((await as('viewer')('POST', '/templates', { name: 'x' })).status, 403);
    assert.equal((await as('viewer')('GET', `/projects/${mine.data.id}/graph`)).status, 200);
  });

  it('내 템플릿은 만든 사람이 지우고, 관리자는 누구의 템플릿이든 지운다', async () => {
    const a = (await as('editor')('POST', '/templates', { name: '지울 내 템플릿' })).data;
    const b = (await as('editor')('POST', '/templates', { name: '관리자가 지울 템플릿' })).data;
    assert.equal((await as('editor')('DELETE', `/templates/${a.id}`)).status, 200);
    assert.equal((await as('admin')('DELETE', `/templates/${b.id}`)).status, 200);
    assert.equal((await as('editor')('DELETE', `/templates/${b.id}`)).status, 404);
    // 프로젝트를 템플릿 경로로 지울 수는 없다
    const { project } = await sampleProject('템플릿 아님');
    assert.equal((await as('admin')('DELETE', `/templates/${project.id}`)).status, 404);
  });
});

describe('체험 모드의 템플릿', () => {
  it('예시 데이터의 템플릿은 회사 템플릿으로 보이고, 로그인 없이 프로젝트를 만들 수 있다', async () => {
    const trialServer = await startTrialServer(createTrial(loadTemplates(resolve(import.meta.dirname, '../trial'))));
    try {
      const sandbox = 'templates-test-sandbox-1';
      const list: TemplateSummaryDto[] = (await trialServer.call('GET', '/templates', { sandbox })).data;
      assert.deepEqual(list.map((item) => [item.name, item.template.official, item.canEdit]), [['표준 서비스 준비', true, true]]);
      assert.equal(list[0].taskCount, 12);
      const made = await trialServer.call('POST', `/templates/${list[0].id}/instantiate`, { sandbox, body: { name: '체험 프로젝트' } });
      assert.equal(made.status, 201);
      assert.equal(made.data.source.name, '표준 서비스 준비');
      const copy = await trialServer.call('POST', '/templates/from', { sandbox, body: { sourceId: list[0].id, name: '체험 내 템플릿' } });
      assert.equal(copy.status, 201);
      const general: TemplateSummaryDto[] = (await trialServer.call('GET', '/templates', { sandbox: 'templates-test-sandbox-2', dataset: 'general' })).data;
      assert.deepEqual(general.map((item) => item.name), ['신입사원 입사 준비 표준']);
    } finally {
      await trialServer.close();
    }
  });
});

describe('CLI 템플릿 명령', () => {
  const CLI = resolve(import.meta.dirname, '../src/cli/main.ts');
  let configHome: string;
  before(() => {
    configHome = mkdtempSync(join(tmpdir(), 'tevro-tpl-cli-'));
  });
  after(() => rmSync(configHome, { recursive: true, force: true }));

  function tevro(args: string[], who = 'editor'): Promise<{ code: number; stdout: string; stderr: string }> {
    const env: NodeJS.ProcessEnv = { ...process.env, TEVRO_SERVER: server.origin, TEVRO_TOKEN: tokens[who], XDG_CONFIG_HOME: configHome };
    return new Promise((done) =>
      execFile(process.execPath, [CLI, ...args], { env }, (error, stdout, stderr) => done({ code: error ? Number(error.code) : 0, stdout, stderr })),
    );
  }
  const json = async (args: string[], who = 'editor') => {
    const result = await tevro([...args, '--json'], who);
    assert.equal(result.code, 0, result.stderr);
    return JSON.parse(result.stdout).data;
  };

  it('create → task add → list → use → save → delete 흐름', async () => {
    const created = await json(['template', 'create', '--name', 'CLI 템플릿', '--description', 'CLI로 만듦']);
    await json(['task', 'add', '--project', created.id, '--title', 'CLI 공정']);
    const list = await json(['template', 'list']);
    const row = list.find((item: TemplateSummaryDto) => item.id === created.id);
    assert.deepEqual([row.taskCount, row.template.version], [1, 1]);
    const human = await tevro(['template', 'list']);
    assert.match(human.stdout, /내 것\s+CLI 템플릿/);
    assert.match((await tevro(['template', 'show', created.id])).stdout, /내 템플릿 \(editor\) · 1판 · 공정 1[\s\S]*CLI 공정/);

    const project = await json(['template', 'use', created.id, '--name', 'CLI 프로젝트']);
    assert.deepEqual([project.kind, project.source.name], ['project', 'CLI 템플릿']);
    const saved = await json(['template', 'save', '--from', project.id, '--name', '프로젝트에서 저장']);
    assert.equal(saved.kind, 'template');
    assert.equal((await tevro(['template', 'create', '--name', 'x', '--official'])).code, 4);

    const confirm = await tevro(['template', 'delete', created.id]);
    assert.equal(confirm.code, 2);
    assert.match(confirm.stderr, /--yes/);
    assert.equal((await tevro(['template', 'delete', created.id, '--yes'])).code, 0);
    assert.equal((await tevro(['template', 'show', created.id])).code, 6);
    // 열람자는 템플릿으로 프로젝트를 만들 수 없다(read 토큰이기도 함)
    assert.equal((await tevro(['template', 'use', saved.id, '--name', 'x'], 'viewer')).code, 4);
  });
});
