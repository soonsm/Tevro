import Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { TASK_STATUSES, type TaskStatus } from '../shared/domain.ts';
import type { TrialStatus } from '../shared/types.ts';
import { ApiError, invalidInput } from './errors.ts';
import { createStore, openDatabase, type Db, type Store } from './store.ts';

// 체험 모드: 서버를 켤 때 예시 데이터(trial/*.json)를 메모리 DB로 만들어 두고, 브라우저 창(체험 ID)마다 그 사본을 하나씩 준다.
// 창에서 바꾼 내용은 그 사본에만 남고 원본은 바뀌지 않는다. 화면은 창마다 다른 체험 ID를 sessionStorage에 둔다(src/web/api.ts).

/** 예시 데이터 파일 하나. 형식은 trial/README.md */
export interface Dataset {
  label: string;
  order: number;
  projects: DatasetProject[];
  /** 회사 템플릿으로 넣는다. 공정에 진행 상태와 Jira 링크를 쓸 수 없다 */
  templates: DatasetProject[];
}

export interface DatasetProject {
  name: string;
  description?: string;
  /** 상위 공정이 하위 공정보다 앞에 오게 정렬해 둔다 */
  tasks: DatasetTask[];
  /** [선행 key, 후속 key] */
  dependencies: [string, string][];
}

export interface DatasetTask {
  key: string;
  title: string;
  status?: TaskStatus;
  parent?: string;
  description?: string;
  jiraUrl?: string;
  confluenceUrl?: string;
}

/** 서버를 켤 때 만든 예시 데이터의 처음 상태(직렬화한 메모리 DB) */
export interface Template {
  key: string;
  label: string;
  order: number;
  image: Buffer;
}

/** 창 하나의 사본 */
export interface Sandbox {
  store: Store;
  dataset: string;
  /** 이 창에서 데이터를 바꾼 적이 있는지 */
  dirty: boolean;
}

export interface Trial {
  datasets: TrialStatus['datasets'];
  /** 체험 ID의 사본. 없으면(처음이거나 오래 안 써서 지웠으면) dataset의 처음 상태로 만든다. 모르는 dataset이면 첫 예시 */
  sandbox(id: string, dataset?: string): Sandbox;
  /** 사본을 그 예시 데이터의 처음 상태로 바꾼다 */
  reset(id: string, dataset: string): Sandbox;
  status(sandbox: Sandbox): TrialStatus;
  close(): void;
}

export interface TrialOptions {
  /** 동시에 두는 사본 수. 넘으면 가장 오래 안 쓴 것부터 지운다 */
  maxSandboxes?: number;
  /** 이 시간 동안 안 쓴 사본은 지운다(밀리초) */
  idleMs?: number;
  now?: () => number;
}

const SANDBOX_ID = /^[A-Za-z0-9_-]{16,64}$/;
const DATASET_FILE = /^[a-z0-9-]+\.json$/;

/** 폴더의 예시 데이터를 모두 읽어 처음 상태를 만든다. 잘못된 파일이 있으면 어느 파일의 무엇이 틀렸는지 알리고 멈춘다. */
export function loadTemplates(dir: string): Template[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    throw new Error(`체험 모드의 예시 데이터 폴더가 없습니다: ${dir}`);
  }
  const files = names.filter((name) => DATASET_FILE.test(name)).sort();
  if (files.length === 0) throw new Error(`체험 모드의 예시 데이터(*.json)가 없습니다: ${dir}`);
  return files
    .map((name) => buildTemplate(basename(name, '.json'), join(dir, name)))
    .sort((a, b) => a.order - b.order || a.key.localeCompare(b.key));
}

/** 서버 검증을 그대로 거치도록 저장소 기능으로 넣는다. 하위 공정의 상태에 따른 상위 공정 자동 변경도 화면에서와 같이 적용된다. */
function buildTemplate(key: string, file: string): Template {
  const dataset = readDataset(file);
  const db = openDatabase(':memory:');
  try {
    const store = createStore(db);
    const graphs = [
      ...dataset.projects.map((project) => ({ project, kind: 'project' as const })),
      ...dataset.templates.map((project) => ({ project, kind: 'template' as const })),
    ];
    for (const { project, kind } of graphs) {
      const step = <T>(what: string, action: () => T): T => {
        try {
          return action();
        } catch (error) {
          if (error instanceof ApiError) throw new Error(`예시 데이터 ${file}: ‘${project.name}’의 ${what}: ${error.message}`);
          throw error;
        }
      };
      const input = { name: project.name, description: project.description };
      // 체험 모드에는 계정이 없어 템플릿은 모두 회사 템플릿(공식)으로 넣는다.
      const projectId = step(kind === 'project' ? '프로젝트' : '템플릿', () =>
        kind === 'project' ? store.createProject(input) : store.createTemplate(input, { ownerId: null, official: true }),
      ).id;
      const ids = new Map<string, string>();
      for (const task of project.tasks) {
        const created = step(`공정 ${task.key}`, () =>
          store.createTask(projectId, {
            title: task.title,
            status: task.status,
            description: task.description,
            jiraUrl: task.jiraUrl,
            confluenceUrl: task.confluenceUrl,
            parentId: task.parent === undefined ? undefined : ids.get(task.parent),
          }),
        );
        ids.set(task.key, created.task.id);
      }
      for (const [from, to] of project.dependencies) {
        step(`연결 ${from} → ${to}`, () => store.addDependency(projectId, { from: ids.get(from), to: ids.get(to) }));
      }
    }
    return { key, label: dataset.label, order: dataset.order, image: db.serialize() };
  } finally {
    db.close();
  }
}

/** 예시 데이터 파일을 읽고 모양을 검사한다. 오타로 무시되는 값이 없도록 모르는 항목도 오류로 본다. */
export function readDataset(file: string): Dataset {
  const fail = (message: string): never => {
    throw new Error(`예시 데이터 ${file}: ${message}`);
  };
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return fail(`JSON으로 읽지 못했습니다. ${(error as Error).message}`);
  }
  const root = record(data, '파일', ['label', 'order', 'projects', 'templates'], fail);
  const label = text(root.label, 'label', fail);
  const order = root.order === undefined ? 0 : typeof root.order === 'number' ? root.order : fail('order는 숫자여야 합니다');
  if (!Array.isArray(root.projects) || root.projects.length === 0) fail('projects에 프로젝트가 하나 이상 있어야 합니다');
  if (root.templates !== undefined && !Array.isArray(root.templates)) fail('templates는 목록이어야 합니다');
  const projects = (root.projects as unknown[]).map((value, index) => readGraph(value, `projects[${index}]`, false, fail));
  const templates = ((root.templates ?? []) as unknown[]).map((value, index) => readGraph(value, `templates[${index}]`, true, fail));
  return { label, order, projects, templates };
}

/** 프로젝트·템플릿 하나. 템플릿 공정에는 진행 상태와 Jira 링크를 쓸 수 없다(템플릿에는 실행 정보가 없음). */
function readGraph(value: unknown, where: string, template: boolean, fail: (message: string) => never): DatasetProject {
  const project = record(value, where, ['name', 'description', 'tasks', 'dependencies'], fail);
  const name = text(project.name, `${where}.name`, fail);
  if (!Array.isArray(project.tasks)) fail(`${where}.tasks는 목록이어야 합니다`);
  const tasks = (project.tasks as unknown[]).map((item, position): DatasetTask => {
    const at = `${where}.tasks[${position}]`;
    const task = record(
      item,
      at,
      template ? ['key', 'title', 'parent', 'description', 'confluenceUrl'] : ['key', 'title', 'status', 'parent', 'description', 'jiraUrl', 'confluenceUrl'],
      fail,
    );
    const status = task.status;
    if (status !== undefined && !(TASK_STATUSES as readonly unknown[]).includes(status)) {
      fail(`${at}.status는 ${TASK_STATUSES.join(', ')} 중 하나여야 합니다`);
    }
    return {
      key: text(task.key, `${at}.key`, fail),
      title: text(task.title, `${at}.title`, fail),
      status: status as TaskStatus | undefined,
      parent: optionalText(task.parent, `${at}.parent`, fail),
      description: optionalText(task.description, `${at}.description`, fail),
      jiraUrl: optionalText(task.jiraUrl, `${at}.jiraUrl`, fail),
      confluenceUrl: optionalText(task.confluenceUrl, `${at}.confluenceUrl`, fail),
    };
  });
  const keys = new Set<string>();
  for (const task of tasks) {
    if (keys.has(task.key)) fail(`‘${name}’에 key가 ${task.key}인 공정이 둘 이상 있습니다`);
    keys.add(task.key);
  }
  const dependencies = (project.dependencies ?? []) as unknown;
  if (!Array.isArray(dependencies)) fail(`${where}.dependencies는 목록이어야 합니다`);
  const pairs = (dependencies as unknown[]).map((pair, position): [string, string] => {
    const ok = Array.isArray(pair) && pair.length === 2 && pair.every((item) => typeof item === 'string');
    if (!ok) fail(`${where}.dependencies[${position}]은(는) ["선행 key", "후속 key"] 모양이어야 합니다`);
    for (const item of pair as string[]) if (!keys.has(item)) fail(`‘${name}’의 연결에 없는 공정 key가 있습니다: ${item}`);
    return pair as [string, string];
  });
  return { name, description: optionalText(project.description, `${where}.description`, fail), tasks: parentsFirst(tasks, name, fail), dependencies: pairs };
}

/** 상위 공정을 하위보다 먼저 만들 수 있게 정렬한다. 나머지 순서는 파일 순서 그대로 */
function parentsFirst(tasks: DatasetTask[], project: string, fail: (message: string) => never): DatasetTask[] {
  const byKey = new Map(tasks.map((task) => [task.key, task]));
  const state = new Map<string, 'visiting' | 'done'>();
  const ordered: DatasetTask[] = [];
  const visit = (task: DatasetTask, path: string[]) => {
    if (state.get(task.key) === 'done') return;
    if (state.get(task.key) === 'visiting') fail(`‘${project}’의 상위 공정이 고리를 이룹니다: ${[...path, task.key].join(' → ')}`);
    state.set(task.key, 'visiting');
    if (task.parent !== undefined) {
      const parent = byKey.get(task.parent) ?? fail(`‘${project}’에서 ${task.key}의 상위 공정 ${task.parent}이(가) 없습니다`);
      visit(parent, [...path, task.key]);
    }
    state.set(task.key, 'done');
    ordered.push(task);
  };
  for (const task of tasks) visit(task, []);
  return ordered;
}

function record(value: unknown, where: string, allowed: string[], fail: (message: string) => never): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${where}은(는) 객체({ … })여야 합니다`);
  const unknown = Object.keys(value as object).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) fail(`${where}에 모르는 항목이 있습니다: ${unknown.join(', ')} (쓸 수 있는 항목: ${allowed.join(', ')})`);
  return value as Record<string, unknown>;
}

function text(value: unknown, where: string, fail: (message: string) => never): string {
  if (typeof value !== 'string' || value.trim() === '') fail(`${where}에 글자를 넣어야 합니다`);
  return value as string;
}

function optionalText(value: unknown, where: string, fail: (message: string) => never): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') fail(`${where}은(는) 글자여야 합니다`);
  return value as string;
}

/** 창마다 사본을 준다. 사본은 메모리에만 있으므로 서버를 다시 켜면 모두 처음 상태로 돌아간다. */
export function createTrial(templates: Template[], { maxSandboxes = 500, idleMs = 2 * 60 * 60 * 1000, now = Date.now }: TrialOptions = {}): Trial {
  if (templates.length === 0) throw new Error('체험 모드에는 예시 데이터가 하나 이상 필요합니다.');
  const byKey = new Map(templates.map((template) => [template.key, template]));
  // 가장 오래 안 쓴 사본이 앞에 오도록, 쓸 때마다 맨 뒤로 옮긴다.
  const sandboxes = new Map<string, Sandbox & { db: Db; lastUsed: number }>();

  const drop = (id: string) => {
    sandboxes.get(id)?.db.close();
    sandboxes.delete(id);
  };
  const sweep = () => {
    const limit = now() - idleMs;
    for (const [id, sandbox] of sandboxes) {
      if (sandbox.lastUsed >= limit) break;
      drop(id);
    }
  };
  const create = (id: string, key: string) => {
    sweep();
    while (sandboxes.size >= maxSandboxes) drop(sandboxes.keys().next().value!);
    const db = new Database(byKey.get(key)!.image);
    db.pragma('foreign_keys = ON');
    const sandbox = { db, store: createStore(db), dataset: key, dirty: false, lastUsed: now() };
    sandboxes.set(id, sandbox);
    return sandbox;
  };
  const timer = setInterval(sweep, Math.min(idleMs, 5 * 60 * 1000));
  timer.unref();

  const datasets = templates.map(({ key, label }) => ({ key, label }));
  return {
    datasets,
    sandbox(id, dataset) {
      const existing = sandboxes.get(id);
      if (!existing) return create(id, dataset !== undefined && byKey.has(dataset) ? dataset : templates[0].key);
      sandboxes.delete(id);
      existing.lastUsed = now();
      sandboxes.set(id, existing);
      return existing;
    },
    reset(id, dataset) {
      if (!byKey.has(dataset)) throw invalidInput(`모르는 예시 데이터입니다: ${dataset}`);
      drop(id);
      return create(id, dataset);
    },
    status: (sandbox) => ({ datasets, dataset: sandbox.dataset, dirty: sandbox.dirty }),
    close() {
      clearInterval(timer);
      for (const id of [...sandboxes.keys()]) drop(id);
    },
  };
}

/** 요청의 체험 ID. 화면만 보내므로, 없으면 CLI 등 화면 밖에서 온 요청이다. */
export function readSandboxId(value: string | string[] | undefined): string {
  const id = Array.isArray(value) ? value[0] : value;
  if (id === undefined || !SANDBOX_ID.test(id)) {
    throw new ApiError(400, 'TRIAL_SESSION_REQUIRED', '체험 서버는 웹 화면에서만 쓸 수 있습니다. 브라우저로 여세요.');
  }
  return id;
}
