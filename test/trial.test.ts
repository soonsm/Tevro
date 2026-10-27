import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { GraphDto, ProjectDto, TrialStatus } from '../src/shared/types.ts';
import { createTrial, loadTemplates, type Template } from '../src/server/trial.ts';
import { startServer, startTrialServer, type TrialServer } from './helpers.ts';

const TRIAL_DIR = resolve(import.meta.dirname, '../trial');
const A = 'aaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbb';

let templates: Template[];
let server: TrialServer;

before(async () => {
  templates = loadTemplates(TRIAL_DIR);
  server = await startTrialServer(createTrial(templates));
});

after(() => server.close());

async function projectsOf(sandbox: string): Promise<ProjectDto[]> {
  const { status, data } = await server.call<ProjectDto[]>('GET', '/projects', { sandbox });
  assert.equal(status, 200, JSON.stringify(data));
  return data;
}

async function graphOf(sandbox: string): Promise<GraphDto> {
  const [project] = await projectsOf(sandbox);
  return (await server.call<GraphDto>('GET', `/projects/${project.id}/graph`, { sandbox })).data;
}

describe('체험 모드 예시 데이터', () => {
  it('trial 폴더의 예시 데이터를 order 순서로 읽는다', () => {
    assert.deepEqual(
      templates.map(({ key, label }) => [key, label]),
      [
        ['developer', '개발자용 데이터'],
        ['general', '일반직용 데이터'],
      ],
    );
  });

  it('개발자용 데이터는 예시 프로젝트와 같고, 하위 공정 상태에 따른 자동 변경도 적용돼 있다', async () => {
    const graph = await graphOf('dddddddddddddddd');
    assert.equal(graph.project.name, '신규 서비스 준비');
    assert.equal(graph.tasks.length, 12);
    assert.equal(graph.dependencies.length, 10);
    const dev = graph.tasks.find((task) => task.title === '애플리케이션 개발')!;
    assert.equal(dev.status, 'in-progress');
    assert.equal(dev.childCount, 3);
  });

  it('잘못된 파일은 어느 파일의 무엇이 틀렸는지 알리고 멈춘다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tevro-trial-'));
    const project = (tasks: unknown[], dependencies: unknown[] = []) => ({ label: '시험', projects: [{ name: '시험', tasks, dependencies }] });
    const cases: [unknown, RegExp][] = [
      [project([{ key: 'a', title: 'A', stauts: 'done' }]), /모르는 항목이 있습니다: stauts/],
      [project([{ key: 'a', title: 'A', status: 'finished' }]), /status는 todo, in-progress, done 중 하나/],
      [project([{ key: 'a', title: 'A', parent: 'x' }]), /a의 상위 공정 x이\(가\) 없습니다/],
      [project([{ key: 'a', title: 'A' }, { key: 'a', title: 'B' }]), /key가 a인 공정이 둘 이상/],
      [project([{ key: 'a', title: 'A' }], [['a', 'z']]), /없는 공정 key가 있습니다: z/],
      [project([{ key: 'a', title: 'A', parent: 'b' }, { key: 'b', title: 'B', parent: 'a' }]), /상위 공정이 고리를 이룹니다/],
      [
        project(
          [
            { key: 'a', title: 'A' },
            { key: 'b', title: 'B' },
          ],
          [
            ['a', 'b'],
            ['b', 'a'],
          ],
        ),
        /연결 b → a: 이 연결을 추가하면 순환이 생깁니다/,
      ],
      [{ label: '시험', projects: [] }, /projects에 프로젝트가 하나 이상/],
    ];
    try {
      for (const [content, message] of cases) {
        writeFileSync(join(dir, 'bad.json'), JSON.stringify(content));
        assert.throws(() => loadTemplates(dir), (error: Error) => error.message.includes('bad.json') && message.test(error.message), message.source);
      }
      writeFileSync(join(dir, 'bad.json'), '{ "label": ');
      assert.throws(() => loadTemplates(dir), /JSON으로 읽지 못했습니다/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('체험 모드 서버', () => {
  it('창(체험 ID)마다 사본이 따로라서 한 창에서 바꾼 내용이 다른 창에 보이지 않는다', async () => {
    const [project] = await projectsOf(A);
    const created = await server.call('POST', `/projects/${project.id}/tasks`, { sandbox: A, body: { title: '성능 테스트' } });
    assert.equal(created.status, 201);
    assert.ok((await graphOf(A)).tasks.some((task) => task.title === '성능 테스트'));
    assert.ok(!(await graphOf(B)).tasks.some((task) => task.title === '성능 테스트'));
    // 원본에서 만든 사본이므로 프로젝트 ID는 같다(주소를 다른 창에 붙여 넣어도 열린다).
    assert.equal((await projectsOf(B))[0].id, project.id);
  });

  it('체험 ID가 없으면(CLI 등 화면 밖) 화면에서만 쓸 수 있다고 알린다', async () => {
    const { status, data } = await server.call('GET', '/projects');
    assert.equal(status, 400);
    assert.equal(data.code, 'TRIAL_SESSION_REQUIRED');
    assert.equal((await server.call('GET', '/projects', { sandbox: 'short' })).status, 400);
  });

  it('바꾼 적이 있는지 알려 주고, 예시 데이터를 바꾸거나 처음 상태로 되돌린다', async () => {
    const before = await server.call<TrialStatus>('GET', '/trial', { sandbox: A });
    assert.deepEqual(before.data, {
      datasets: [
        { key: 'developer', label: '개발자용 데이터' },
        { key: 'general', label: '일반직용 데이터' },
      ],
      dataset: 'developer',
      dirty: true,
    });

    const general = await server.call<TrialStatus>('POST', '/trial/reset', { sandbox: A, body: { dataset: 'general' } });
    assert.equal(general.status, 200);
    assert.deepEqual([general.data.dataset, general.data.dirty], ['general', false]);
    assert.equal((await projectsOf(A))[0].name, '신입사원 입사 준비');

    await server.call('POST', '/trial/reset', { sandbox: A, body: { dataset: 'developer' } });
    const graph = await graphOf(A);
    assert.equal(graph.tasks.length, 12);
    assert.ok(!graph.tasks.some((task) => task.title === '성능 테스트'));
  });

  it('새 창은 화면이 알려 준 예시 데이터로 시작한다', async () => {
    const [project] = (await server.call<ProjectDto[]>('GET', '/projects', { sandbox: 'cccccccccccccccc', dataset: 'general' })).data;
    assert.equal(project.name, '신입사원 입사 준비');
  });

  it('모르는 예시 데이터를 고르면 거부한다', async () => {
    const { status, data } = await server.call('POST', '/trial/reset', { sandbox: A, body: { dataset: 'nope' } });
    assert.equal(status, 422);
    assert.match(data.detail, /모르는 예시 데이터/);
    assert.equal((await server.call('POST', '/trial/reset', { sandbox: A, body: {} })).status, 422);
  });

  it('체험 모드가 아니면 체험 상태는 내용 없음(204)이고 예시 데이터를 바꿀 수 없다', async () => {
    const normal = await startServer();
    try {
      assert.deepEqual(await normal.call('GET', '/trial'), { status: 204, data: undefined });
      assert.equal((await normal.call('POST', '/trial/reset', { dataset: 'developer' })).status, 404);
    } finally {
      await normal.close();
    }
  });
});

describe('사본 정리', () => {
  it('오래 안 쓴 사본과, 너무 많을 때 가장 오래 안 쓴 사본부터 지운다(지운 창은 처음 상태로 다시 시작)', () => {
    let clock = 0;
    const trial = createTrial(templates, { maxSandboxes: 2, idleMs: 1000, now: () => clock });
    const projectOf = (id: string) => trial.sandbox(id).store.listProjects()[0].id;
    const addTask = (id: string) => trial.sandbox(id).store.createTask(projectOf(id), { title: '추가' });
    const hasTask = (id: string) => trial.sandbox(id).store.getGraph(projectOf(id)).tasks.some((task) => task.title === '추가');
    try {
      addTask(A);
      clock = 10;
      addTask(B);
      clock = 20;
      assert.ok(hasTask(A)); // A를 다시 써서 B가 가장 오래 안 쓴 사본이 됐다.
      trial.sandbox('cccccccccccccccc');
      assert.ok(hasTask(A));
      assert.ok(!hasTask(B));

      clock = 5000;
      trial.sandbox('dddddddddddddddd'); // 새 사본을 만들 때 오래된 것을 먼저 정리한다.
      assert.ok(!hasTask(A));
    } finally {
      trial.close();
    }
  });
});
