#!/usr/bin/env node
// Tevro CLI. GUI와 같은 서버 API만 호출하고, 로컬에 따로 상태를 두지 않는다(PRD F-C08).
import { Command, CommanderError, Option } from 'commander';
import {
  INCONSISTENCY_LABELS,
  STATUS_LABELS,
  TASK_STATUSES,
  TRANSITION_LABELS,
  ancestorIds,
  brokenPaths,
  descendantIds,
  hasPrerequisites,
  summarize,
  treeOrder,
  type Edge,
} from '../shared/domain.ts';
import type {
  AutoTransition,
  DeleteTaskResult,
  DependencyDto,
  GraphDto,
  MoveTaskResult,
  Problem,
  ProjectDto,
  TaskChangeResult,
  TaskDto,
} from '../shared/types.ts';

// ADR-0007 종료 코드 중 MVP에서 쓰는 것
const EXIT = { ok: 0, failure: 1, usage: 2, validation: 3, notFound: 6, unreachable: 8 } as const;

// VALIDATION_* 밖에서 종료 코드 3(검증 실패)으로 다루는 구조 검증 오류
const STRUCTURE_CODES = new Set([
  'REFERENCE_NOT_FOUND',
  'CROSS_PROJECT_REFERENCE',
  'HIERARCHY_CYCLE',
  'CROSS_LEVEL_DEPENDENCY',
  'HAS_DEPENDENCIES',
]);

interface GlobalOptions {
  server?: string;
  json?: boolean;
}

interface CliErrorBody {
  code: string;
  detail: string;
  [key: string]: unknown;
}

class CliFailure extends Error {
  readonly exitCode: number;
  readonly body: CliErrorBody;

  constructor(exitCode: number, body: CliErrorBody) {
    super(body.detail);
    this.exitCode = exitCode;
    this.body = body;
  }
}

const jsonRequested = process.argv.includes('--json');

// `tevro ... | head`처럼 읽는 쪽이 먼저 닫혀도 오류 없이 끝낸다.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(process.exitCode ?? 0);
  throw error;
});

const program = new Command('tevro')
  .description('Tevro CLI — 공정과 선후관계, 진행 상태를 서버 API로 조회·변경합니다.')
  .option('--server <url>', '서버 주소 (기본: TEVRO_SERVER 또는 http://localhost:4000)')
  .option('--json', '결과를 JSON으로 출력 (에이전트용)')
  .helpOption('-h, --help', '도움말 보기')
  .helpCommand('help [command]', '명령 도움말 보기')
  .showSuggestionAfterError()
  .exitOverride()
  .configureOutput({ outputError: (text, write) => (jsonRequested ? undefined : write(text)) })
  .addHelpText(
    'after',
    '\n종료 코드: 0 성공, 1 기타 오류, 2 사용법 오류·--yes 필요, 3 검증 실패, 6 대상 없음, 8 서버 연결 실패',
  );

const project = program.command('project').description('프로젝트');

project
  .command('list')
  .description('프로젝트 목록')
  .action(async (_options, command: Command) => {
    const api = client(command);
    const projects = await api.get<ProjectDto[]>('/api/v1/projects');
    emit(command, projects, () =>
      projects.length === 0
        ? '프로젝트가 없습니다.'
        : table([['이름', 'ID'], ...projects.map((item) => [item.name, item.id])]),
    );
  });

project
  .command('create')
  .description('프로젝트 만들기')
  .requiredOption('--name <name>', '프로젝트 이름')
  .option('--description <text>', '설명')
  .action(async (options: { name: string; description?: string }, command: Command) => {
    const created = await client(command).post<ProjectDto>('/api/v1/projects', options);
    emit(command, created, () => `프로젝트를 만들었습니다: ${created.name} (${created.id})`);
  });

const task = program.command('task').description('공정');

task
  .command('list')
  .description('프로젝트의 공정 목록 (하위 공정은 들여 씀)')
  .requiredOption('--project <project-id>', '프로젝트 ID')
  .option('--parent <task-id>', '이 공정의 직접 하위 공정만')
  .addOption(new Option('--top', '최상위 공정만').conflicts('parent'))
  .action(async (options: { project: string; parent?: string; top?: boolean }, command: Command) => {
    const graph = await client(command).get<GraphDto>(`/api/v1/projects/${segment(options.project)}/graph`);
    if (options.parent) requireTaskIn(graph, options.parent);
    const tasks =
      options.parent || options.top ? graph.tasks.filter((item) => item.parentId === (options.parent ?? null)) : graph.tasks;
    emit(command, tasks, () => (tasks.length === 0 ? '공정이 없습니다.' : taskTable(graph, tasks)));
  });

task
  .command('show')
  .description('공정 하나의 상세(선행 조건 포함)')
  .argument('<task-id>', '공정 ID')
  .action(async (taskId: string, _options, command: Command) => {
    const api = client(command);
    const found = await api.get<TaskDto>(`/api/v1/tasks/${segment(taskId)}`);
    if (globals(command).json) {
      emit(command, found, () => '');
      return;
    }
    const graph = await api.get<GraphDto>(`/api/v1/projects/${segment(found.projectId)}/graph`);
    emit(command, found, () => taskDetail(found, graph));
  });

task
  .command('add')
  .description('공정 추가')
  .requiredOption('--project <project-id>', '프로젝트 ID')
  .requiredOption('--title <title>', '제목')
  .option('--description <text>', '설명(작업 절차, 완료 기준 등)')
  .addOption(new Option('--status <status>', '실행 상태').choices(TASK_STATUSES))
  .option('--jira-url <url>', 'Jira 이슈 주소')
  .option('--confluence-url <url>', 'Confluence 문서 주소')
  .option('--parent <task-id>', '상위 공정 ID (생략하면 최상위)')
  .action(async (options: TaskOptions & { project: string; parent?: string }, command: Command) => {
    const result = await client(command).post<TaskChangeResult>(`/api/v1/projects/${segment(options.project)}/tasks`, {
      ...taskInput(options),
      parentId: options.parent,
    });
    emit(command, result, () =>
      [`공정을 추가했습니다: ${result.task.title} (${result.task.id})`, ...transitionLines(result.autoTransitions)].join('\n'),
    );
  });

task
  .command('update')
  .description('공정 내용·링크 수정 (링크에 빈 값을 주면 지움)')
  .argument('<task-id>', '공정 ID')
  .option('--title <title>', '제목')
  .option('--description <text>', '설명')
  .option('--jira-url <url>', 'Jira 이슈 주소')
  .option('--confluence-url <url>', 'Confluence 문서 주소')
  .action(async (taskId: string, options: TaskOptions, command: Command) => {
    const input = taskInput(options);
    if (Object.keys(input).length === 0) {
      throw new CliFailure(EXIT.usage, { code: 'USAGE', detail: '바꿀 값을 하나 이상 지정하세요. (tevro task update --help)' });
    }
    const result = await client(command).patch<TaskChangeResult>(`/api/v1/tasks/${segment(taskId)}`, input);
    emit(command, result, () => `공정을 고쳤습니다: ${result.task.title} (${result.task.id})`);
  });

task
  .command('status')
  .description('실행 상태 변경 (선행 조건이 미충족이어도 바꿀 수 있음)')
  .argument('<task-id>', '공정 ID')
  .addOption(new Option('--set <status>', '새 실행 상태').choices(TASK_STATUSES).makeOptionMandatory())
  .action(async (taskId: string, options: { set: TaskDto['status'] }, command: Command) => {
    const result = await client(command).patch<TaskChangeResult>(`/api/v1/tasks/${segment(taskId)}`, {
      status: options.set,
    });
    emit(command, result, () => {
      const updated = result.task;
      const lines = [`상태를 바꿨습니다: ${updated.title} → ${STATUS_LABELS[updated.status]}`];
      if (!updated.prerequisitesMet) {
        lines.push(`참고: 선행 조건 미충족 (완료되지 않은 선행 공정 ${updated.unmetPrerequisiteIds.length}개)`);
      }
      if (updated.inconsistency) lines.push(`참고: ${INCONSISTENCY_LABELS[updated.inconsistency]}`);
      return [...lines, ...transitionLines(result.autoTransitions)].join('\n');
    });
  });

task
  .command('move')
  .description('상위 공정 바꾸기 (하위 공정도 함께 옮겨짐). 연결이 있는 공정은 --detach --yes로 연결을 지우고 옮김')
  .argument('<task-id>', '옮길 공정 ID')
  .option('--parent <task-id>', '새 상위 공정 ID')
  .addOption(new Option('--top', '최상위로 옮김').conflicts('parent'))
  .option('--detach', '이 공정의 연결을 모두 지우고 옮김 (--yes 필요)')
  .option('--yes', '지워질 연결을 확인했고 이동을 실행합니다')
  .action(
    async (
      taskId: string,
      options: { parent?: string; top?: boolean; detach?: boolean; yes?: boolean },
      command: Command,
    ) => {
      if (!options.parent && !options.top) {
        throw new CliFailure(EXIT.usage, { code: 'USAGE', detail: '--parent <task-id>나 --top 중 하나를 지정하세요.' });
      }
      const api = client(command);
      const parentId = options.parent ?? null;
      const target = await api.get<TaskDto>(`/api/v1/tasks/${segment(taskId)}`);
      const graph = await api.get<GraphDto>(`/api/v1/projects/${segment(target.projectId)}/graph`);
      // 연결은 같은 층 안에서만 맺으므로, 다른 층으로 옮기려면 이 공정의 연결을 함께 지워야 한다(F-H08).
      const attached =
        options.detach && parentId !== target.parentId
          ? graph.dependencies.filter((edge) => edge.from === taskId || edge.to === taskId)
          : [];
      if (attached.length > 0 && !options.yes) {
        throw new CliFailure(EXIT.usage, {
          code: 'CONFIRMATION_REQUIRED',
          detail: movePreview(target, graph, attached),
          impact: { removedDependencies: attached },
        });
      }
      let result: MoveTaskResult;
      try {
        result = await api.post<MoveTaskResult>(`/api/v1/tasks/${segment(taskId)}/move`, {
          parentId,
          removeDependencies: attached,
        });
      } catch (error) {
        if (error instanceof CliFailure && error.body.code === 'HAS_DEPENDENCIES' && !jsonRequested) {
          error.body.detail += '\n연결을 지우고 옮기려면 --detach --yes를 붙이세요.';
        }
        throw error;
      }
      emit(command, result, () => {
        const titles = titleMap(graph);
        const place = result.task.parentId ? `${titles.get(result.task.parentId) ?? result.task.parentId} 아래` : '최상위';
        const lines = [`공정을 옮겼습니다: ${result.task.title} → ${place}`];
        if (result.removedDependencies.length > 0) {
          lines.push(`함께 지운 연결 ${result.removedDependencies.length}개`, ...result.removedDependencies.map((edge) => edgeLine(edge, titles)));
        }
        return [...lines, ...transitionLines(result.autoTransitions)].join('\n');
      });
    },
  );

task
  .command('delete')
  .description('공정 삭제 (하위 공정과 연결도 함께 삭제). --yes가 없으면 영향만 보여 줌')
  .argument('<task-id>', '공정 ID')
  .option('--yes', '영향을 확인했고 삭제를 실행합니다')
  .action(async (taskId: string, options: { yes?: boolean }, command: Command) => {
    const api = client(command);
    if (!options.yes) {
      const target = await api.get<TaskDto>(`/api/v1/tasks/${segment(taskId)}`);
      const graph = await api.get<GraphDto>(`/api/v1/projects/${segment(target.projectId)}/graph`);
      const descendants = descendantIds(graph.tasks, taskId);
      const removed = new Set([taskId, ...descendants]);
      const removedDependencies = graph.dependencies.filter((edge) => removed.has(edge.from) || removed.has(edge.to));
      const broken = brokenPaths(graph.dependencies, taskId);
      throw new CliFailure(EXIT.usage, {
        code: 'CONFIRMATION_REQUIRED',
        detail: deletePreview(target, graph, descendants, removedDependencies, broken),
        impact: { removedTasks: descendants, removedDependencies, brokenPaths: broken },
      });
    }
    const result = await api.delete<DeleteTaskResult>(`/api/v1/tasks/${segment(taskId)}`);
    emit(command, result, () => {
      const lines = [`공정을 삭제했습니다: ${result.deletedTaskId}`];
      if (result.removedTasks.length > 0) lines.push(`함께 삭제된 하위 공정 ${result.removedTasks.length}개`);
      lines.push(`함께 삭제된 연결 ${result.removedDependencies.length}개`, ...transitionLines(result.autoTransitions));
      return lines.join('\n');
    });
  });

const dependency = program.command('dependency').alias('dep').description('선후관계(연결)');

dependency
  .command('add')
  .description('연결 추가: --from 공정이 --to 공정의 선행 공정이 됨')
  .option('--project <project-id>', '프로젝트 ID (생략하면 --from 공정의 프로젝트)')
  .requiredOption('--from <task-id>', '선행 공정 ID')
  .requiredOption('--to <task-id>', '후속 공정 ID')
  .action(async (options: DependencyOptions, command: Command) => {
    const api = client(command);
    const projectId = options.project ?? (await api.get<TaskDto>(`/api/v1/tasks/${segment(options.from)}`)).projectId;
    const added = await api.post<DependencyDto>(`/api/v1/projects/${segment(projectId)}/dependencies`, {
      from: options.from,
      to: options.to,
    });
    await emitEdge(command, api, projectId, added, '연결했습니다');
  });

dependency
  .command('remove')
  .description('연결 삭제 (연결 하나는 --yes 없이 바로 지움)')
  .option('--project <project-id>', '프로젝트 ID (생략하면 --from 공정의 프로젝트)')
  .requiredOption('--from <task-id>', '선행 공정 ID')
  .requiredOption('--to <task-id>', '후속 공정 ID')
  .action(async (options: DependencyOptions, command: Command) => {
    const api = client(command);
    const projectId = options.project ?? (await api.get<TaskDto>(`/api/v1/tasks/${segment(options.from)}`)).projectId;
    const query = new URLSearchParams({ from: options.from, to: options.to });
    const removed = await api.delete<DependencyDto>(`/api/v1/projects/${segment(projectId)}/dependencies?${query}`);
    await emitEdge(command, api, projectId, removed, '연결을 지웠습니다');
  });

const graph = program.command('graph').description('그래프 전체');

graph
  .command('show')
  .description('공정·연결·상태를 한 번에 조회 (하위 공정은 들여 씀)')
  .requiredOption('--project <project-id>', '프로젝트 ID')
  .option('--root <task-id>', '이 공정 안의 층(직접 하위 공정과 그 사이 연결)만')
  .action(async (options: { project: string; root?: string }, command: Command) => {
    const full = await client(command).get<GraphDto>(`/api/v1/projects/${segment(options.project)}/graph`);
    const result = options.root ? levelOf(full, options.root) : full;
    emit(command, result, () => graphText(result, full, options.root));
  });

interface TaskOptions {
  title?: string;
  description?: string;
  status?: TaskDto['status'];
  jiraUrl?: string;
  confluenceUrl?: string;
}

interface DependencyOptions {
  project?: string;
  from: string;
  to: string;
}

try {
  await program.parseAsync(process.argv);
} catch (error) {
  process.exitCode = report(error);
}

function report(error: unknown): number {
  if (error instanceof CommanderError) {
    if (error.code === 'commander.helpDisplayed' || error.code === 'commander.version') return EXIT.ok;
    if (jsonRequested) writeJsonError({ code: 'USAGE', detail: error.message });
    return EXIT.usage;
  }
  const failure =
    error instanceof CliFailure
      ? error
      : new CliFailure(EXIT.failure, { code: 'CLI_ERROR', detail: error instanceof Error ? error.message : String(error) });
  if (jsonRequested) writeJsonError(failure.body);
  else process.stderr.write(failure.body.code === 'CONFIRMATION_REQUIRED' ? `${failure.body.detail}\n` : `오류 [${failure.body.code}] ${failure.body.detail}\n`);
  return failure.exitCode;
}

function writeJsonError(body: CliErrorBody | Problem): void {
  process.stderr.write(`${JSON.stringify({ schemaVersion: 1, error: body })}\n`);
}

function globals(command: Command): GlobalOptions {
  return command.optsWithGlobals<GlobalOptions>();
}

function emit(command: Command, data: unknown, human: () => string): void {
  const output = globals(command).json ? JSON.stringify({ schemaVersion: 1, data }) : human();
  process.stdout.write(`${output}\n`);
}

async function emitEdge(command: Command, api: Client, projectId: string, edge: Edge, verb: string): Promise<void> {
  if (globals(command).json) {
    emit(command, edge, () => '');
    return;
  }
  const titles = titleMap(await api.get<GraphDto>(`/api/v1/projects/${segment(projectId)}/graph`));
  emit(command, edge, () => `${verb}: ${titles.get(edge.from) ?? edge.from} → ${titles.get(edge.to) ?? edge.to}`);
}

type Client = ReturnType<typeof client>;

function client(command: Command) {
  const base = (globals(command).server ?? process.env.TEVRO_SERVER ?? 'http://localhost:4000').replace(/\/+$/, '');

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await fetch(base + path, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new CliFailure(EXIT.unreachable, {
        code: 'SERVER_UNREACHABLE',
        detail: `서버에 연결하지 못했습니다: ${base} (서버가 켜져 있는지, --server 또는 TEVRO_SERVER가 맞는지 확인하세요)`,
      });
    }
    const text = await response.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      throw new CliFailure(EXIT.failure, { code: 'BAD_RESPONSE', detail: `서버 응답을 해석할 수 없습니다: ${base}${path}` });
    }
    if (!response.ok) {
      const problem = data as Problem;
      throw new CliFailure(exitCodeOf(problem.code), problem as unknown as CliErrorBody);
    }
    return data as T;
  }

  return {
    get: <T>(path: string) => call<T>('GET', path),
    post: <T>(path: string, body: unknown) => call<T>('POST', path, body),
    patch: <T>(path: string, body: unknown) => call<T>('PATCH', path, body),
    delete: <T>(path: string) => call<T>('DELETE', path),
  };
}

function exitCodeOf(code: string): number {
  if (code.startsWith('VALIDATION_') || STRUCTURE_CODES.has(code)) return EXIT.validation;
  return code === 'NOT_FOUND' ? EXIT.notFound : EXIT.failure;
}

function segment(id: string): string {
  return encodeURIComponent(id);
}

function taskInput(options: TaskOptions): Record<string, string> {
  const input: Record<string, string> = {};
  for (const key of ['title', 'description', 'status', 'jiraUrl', 'confluenceUrl'] as const) {
    const value = options[key];
    if (value !== undefined) input[key] = value;
  }
  return input;
}

function titleMap(graph: GraphDto): Map<string, string> {
  return new Map(graph.tasks.map((item) => [item.id, item.title]));
}

function requireTaskIn(graph: GraphDto, taskId: string): TaskDto {
  const found = graph.tasks.find((item) => item.id === taskId);
  if (!found) throw new CliFailure(EXIT.notFound, { code: 'NOT_FOUND', detail: `이 프로젝트에 그 공정이 없습니다: ${taskId}` });
  return found;
}

/** 공정 안의 층(직접 하위 공정과 그 사이 연결). 요약은 그 공정 아래 말단 공정 기준이다. */
function levelOf(graph: GraphDto, rootId: string): GraphDto {
  requireTaskIn(graph, rootId);
  const tasks = graph.tasks.filter((item) => item.parentId === rootId);
  const ids = new Set(tasks.map((item) => item.id));
  const subtree = new Set(descendantIds(graph.tasks, rootId));
  return {
    project: graph.project,
    tasks,
    dependencies: graph.dependencies.filter((edge) => ids.has(edge.from) && ids.has(edge.to)),
    summary: summarize(graph.tasks.filter((item) => subtree.has(item.id))),
  };
}

/** 최상위부터 taskId까지의 제목 경로(예: 개발 › 배치 개발) */
function pathText(graph: GraphDto, taskId: string): string {
  const titles = titleMap(graph);
  return [...ancestorIds(graph.tasks, taskId).reverse(), taskId].map((id) => titles.get(id) ?? id).join(' › ');
}

function edgeLine(edge: Edge, titles: Map<string, string>): string {
  return `    ${titles.get(edge.from) ?? edge.from} → ${titles.get(edge.to) ?? edge.to}`;
}

function transitionLines(transitions: AutoTransition[]): string[] {
  return transitions.map((item) => `자동 변경: ${item.title} → ${STATUS_LABELS[item.status]} (${TRANSITION_LABELS[item.cause]})`);
}

function prerequisiteText(item: TaskDto, titles: Map<string, string>): string {
  if (!hasPrerequisites(item)) return '-';
  if (item.prerequisitesMet) return '충족';
  return `미충족: ${item.unmetPrerequisiteIds.map((id) => titles.get(id) ?? id).join(', ')}`;
}

/** 공정 표. 하위 공정은 상위 아래에 들여 쓰고, 상위에는 하위 완료 수를 붙인다. */
function taskTable(graph: GraphDto, tasks: TaskDto[] = graph.tasks): string {
  const titles = titleMap(graph);
  return table([
    ['상태', '공정', 'ID', '선행 조건'],
    ...treeOrder(tasks).map(({ task: item, depth }) => [
      STATUS_LABELS[item.status],
      `${'  '.repeat(depth)}${item.title}${item.childCount > 0 ? ` (하위 ${item.doneChildCount}/${item.childCount})` : ''}`,
      item.id,
      prerequisiteText(item, titles),
    ]),
  ]);
}

function graphText(graph: GraphDto, full: GraphDto, rootId?: string): string {
  const titles = titleMap(full);
  const { total, todo, inProgress, done } = graph.summary;
  // 연결은 같은 층 안에만 있으므로 최상위가 아닌 층의 연결에는 그 층의 상위를 앞에 적는다.
  const parentOf = new Map(full.tasks.map((item) => [item.id, item.parentId]));
  const edgeText = (edge: Edge) => {
    const parent = rootId ? null : parentOf.get(edge.from);
    return `  ${parent ? `[${titles.get(parent)}] ` : ''}${titles.get(edge.from)} → ${titles.get(edge.to)}`;
  };
  const lines = [
    rootId ? `${graph.project.name} › ${pathText(full, rootId)} (${rootId})` : `${graph.project.name} (${graph.project.id})`,
    `전체 ${total} · 미착수 ${todo} · 진행 중 ${inProgress} · 완료 ${done} (말단 공정 기준)`,
    '',
    graph.tasks.length === 0 ? '공정이 없습니다.' : taskTable(full, graph.tasks),
    '',
    `연결 ${graph.dependencies.length}개`,
    ...graph.dependencies.map(edgeText),
  ];
  return lines.join('\n');
}

function taskDetail(item: TaskDto, graph: GraphDto): string {
  const titles = titleMap(graph);
  const statusOf = new Map(graph.tasks.map((other) => [other.id, other.status]));
  const named = (ids: string[]) =>
    ids.length === 0 ? '없음' : ids.map((id) => `${titles.get(id)}(${STATUS_LABELS[statusOf.get(id)!]})`).join(', ');
  const prerequisite = !hasPrerequisites(item)
    ? '선행 공정 없음'
    : item.prerequisitesMet
      ? '충족'
      : `미충족 — 완료 안 됨: ${named(item.unmetPrerequisiteIds)}`;
  const inherited = item.inheritedPredecessors.map(
    ({ taskId, inheritedFrom }) =>
      `${titles.get(taskId)}(${STATUS_LABELS[statusOf.get(taskId)!]}, ${titles.get(inheritedFrom)}의 선행)`,
  );
  const children = graph.tasks.filter((other) => other.parentId === item.id).map((other) => other.id);
  const rows = [
    ['위치', item.parentId ? `${pathText(graph, item.parentId)} 아래` : '최상위'],
    ['상태', STATUS_LABELS[item.status]],
    ...(item.inconsistency ? [['상태 모순', INCONSISTENCY_LABELS[item.inconsistency]]] : []),
    ['선행 조건', prerequisite],
    ['직접 선행', named(item.predecessorIds)],
    ...(item.parentId ? [['물려받은 선행', inherited.length === 0 ? '없음' : inherited.join(', ')]] : []),
    ['후속 공정', named(item.successorIds)],
    ['하위 공정', item.childCount === 0 ? '없음' : `${item.doneChildCount}/${item.childCount} 완료 — ${named(children)}`],
    ['Jira', item.jiraUrl ? `${item.jiraKey ?? ''} ${item.jiraUrl}`.trim() : '-'],
    ['Confluence', item.confluenceUrl ?? '-'],
    ['설명', item.description === '' ? '-' : item.description.replace(/\n/g, '\n' + ' '.repeat(18))],
  ];
  return [`${item.title} (${item.id})`, ...rows.map(([label, value]) => `  ${pad(label, 16)}${value}`)].join('\n');
}

function deletePreview(item: TaskDto, graph: GraphDto, descendants: string[], removed: Edge[], broken: Edge[]): string {
  const titles = titleMap(graph);
  const lines = [`‘${item.title}’ 공정을 삭제하면:`];
  if (descendants.length > 0) {
    const subtree = new Set(descendants);
    lines.push(
      `  함께 삭제되는 하위 공정 ${descendants.length}개`,
      ...treeOrder(graph.tasks.filter((other) => subtree.has(other.id))).map(
        ({ task: other, depth }) => `    ${'  '.repeat(depth)}${other.title}`,
      ),
    );
  }
  lines.push(`  함께 삭제되는 연결 ${removed.length}개`, ...removed.map((edge) => edgeLine(edge, titles)));
  if (broken.length > 0) {
    lines.push('  순서 정보가 사라지는 공정 (자동으로 다시 잇지 않음)', ...broken.map((edge) => edgeLine(edge, titles)));
  }
  lines.push('삭제하려면 --yes를 붙여 다시 실행하세요.');
  return lines.join('\n');
}

function movePreview(item: TaskDto, graph: GraphDto, removed: Edge[]): string {
  const titles = titleMap(graph);
  return [
    `‘${item.title}’ 공정을 옮기면 연결 ${removed.length}개가 지워집니다 (연결은 같은 층 안에서만 맺을 수 있음):`,
    ...removed.map((edge) => edgeLine(edge, titles)),
    '옮기려면 --yes를 붙여 다시 실행하세요.',
  ].join('\n');
}

/** 한글처럼 두 칸을 차지하는 글자를 고려해 열을 맞춘다. */
function table(rows: string[][]): string {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => displayWidth(row[column]))));
  return rows
    .map((row) =>
      row
        .map((cell, column) => (column === row.length - 1 ? cell : pad(cell, widths[column] + 2)))
        .join('')
        .trimEnd(),
    )
    .join('\n');
}

function pad(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6);
    width += wide ? 2 : 1;
  }
  return width;
}
