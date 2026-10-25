import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  analyzePrerequisites,
  findCycle,
  isHttpUrl,
  isTaskStatus,
  jiraKeyFromUrl,
  summarize,
  type Edge,
  type Prerequisites,
  type TaskStatus,
} from '../shared/domain.ts';
import type { DeleteTaskResult, DependencyDto, GraphDto, ProjectDto, TaskDto } from '../shared/types.ts';
import { ApiError, invalidInput } from './errors.ts';
import { newId } from './ids.ts';

export type Db = Database.Database;
export type Store = ReturnType<typeof createStore>;
type Input = Record<string, unknown>;

// 순환은 DB 제약으로 막을 수 없어 서버가 쓰기 트랜잭션 안에서 검사하고, 나머지는 DB 제약으로 한 번 더 막는다(ADR-0003).
// 테이블·컬럼 설명은 Tevro/db-schema.md에 있다. 스키마를 바꾸면 그 문서도 함께 고친다.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in-progress', 'done')),
  jira_url TEXT,
  confluence_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, id)
);
CREATE INDEX IF NOT EXISTS tasks_by_project ON tasks (project_id);
CREATE TABLE IF NOT EXISTS dependencies (
  project_id TEXT NOT NULL,
  from_task_id TEXT NOT NULL,
  to_task_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, from_task_id, to_task_id),
  CHECK (from_task_id <> to_task_id),
  FOREIGN KEY (project_id, from_task_id) REFERENCES tasks (project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, to_task_id) REFERENCES tasks (project_id, id) ON DELETE CASCADE
);
`;

const MAX_LENGTH = { name: 100, title: 200, description: 10_000, url: 2_000, id: 64 };

interface ProjectRow {
  id: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
}

interface TaskRow {
  id: string;
  project_id: string;
  title: string;
  description: string;
  status: TaskStatus;
  jira_url: string | null;
  confluence_url: string | null;
  created_at: string;
  updated_at: string;
}

interface DependencyRow {
  from_task_id: string;
  to_task_id: string;
}

export function openDatabase(file: string): Db {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}

export function createStore(db: Db) {
  const sql = {
    listProjects: db.prepare<[], ProjectRow>('SELECT * FROM projects ORDER BY rowid'),
    getProject: db.prepare<[string], ProjectRow>('SELECT * FROM projects WHERE id = ?'),
    insertProject: db.prepare<[ProjectRow]>(
      'INSERT INTO projects (id, name, description, created_at, updated_at) VALUES (@id, @name, @description, @created_at, @updated_at)',
    ),
    listTasks: db.prepare<[string], TaskRow>('SELECT * FROM tasks WHERE project_id = ? ORDER BY rowid'),
    getTask: db.prepare<[string], TaskRow>('SELECT * FROM tasks WHERE id = ?'),
    insertTask: db.prepare<[TaskRow]>(
      `INSERT INTO tasks (id, project_id, title, description, status, jira_url, confluence_url, created_at, updated_at)
       VALUES (@id, @project_id, @title, @description, @status, @jira_url, @confluence_url, @created_at, @updated_at)`,
    ),
    updateTask: db.prepare<[TaskRow]>(
      `UPDATE tasks SET title = @title, description = @description, status = @status, jira_url = @jira_url,
       confluence_url = @confluence_url, updated_at = @updated_at WHERE id = @id`,
    ),
    deleteTask: db.prepare<[string]>('DELETE FROM tasks WHERE id = ?'),
    listDependencies: db.prepare<[string], DependencyRow>(
      'SELECT from_task_id, to_task_id FROM dependencies WHERE project_id = ? ORDER BY rowid',
    ),
    insertDependency: db.prepare<[string, string, string, string]>(
      'INSERT INTO dependencies (project_id, from_task_id, to_task_id, created_at) VALUES (?, ?, ?, ?)',
    ),
    deleteDependency: db.prepare<[string, string, string]>(
      'DELETE FROM dependencies WHERE project_id = ? AND from_task_id = ? AND to_task_id = ?',
    ),
  };

  /** 모든 쓰기를 BEGIN IMMEDIATE 트랜잭션 하나로 처리한다. 읽고 검증하고 쓰는 사이에 다른 쓰기가 끼어들지 않는다. */
  function write<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    const transaction = db.transaction(fn);
    return (...args: A) => transaction.immediate(...args);
  }

  function requireProject(projectId: string): ProjectRow {
    const project = sql.getProject.get(projectId);
    if (!project) throw new ApiError(404, 'NOT_FOUND', `프로젝트를 찾을 수 없습니다: ${projectId}`);
    return project;
  }

  function requireTask(taskId: string): TaskRow {
    const task = sql.getTask.get(taskId);
    if (!task) throw new ApiError(404, 'NOT_FOUND', `공정을 찾을 수 없습니다: ${taskId}`);
    return task;
  }

  function dependenciesOf(projectId: string): Edge[] {
    return sql.listDependencies.all(projectId).map((row) => ({ from: row.from_task_id, to: row.to_task_id }));
  }

  function graphOf(project: ProjectRow): GraphDto {
    const rows = sql.listTasks.all(project.id);
    const dependencies = dependenciesOf(project.id);
    const prerequisites = analyzePrerequisites(rows, dependencies);
    return {
      project: toProjectDto(project),
      tasks: rows.map((row) => toTaskDto(row, prerequisites.get(row.id)!)),
      dependencies,
      summary: summarize(rows),
    };
  }

  function getTask(taskId: string): TaskDto {
    const task = requireTask(taskId);
    return graphOf(requireProject(task.project_id)).tasks.find((dto) => dto.id === taskId)!;
  }

  return {
    listProjects(): ProjectDto[] {
      return sql.listProjects.all().map(toProjectDto);
    },

    createProject: write((input: Input): ProjectDto => {
      const now = new Date().toISOString();
      const row: ProjectRow = {
        id: newId('prj'),
        name: readText(input.name, '프로젝트 이름', MAX_LENGTH.name, { required: true, trim: true }),
        description: readText(input.description, '설명', MAX_LENGTH.description) ?? '',
        created_at: now,
        updated_at: now,
      };
      sql.insertProject.run(row);
      return toProjectDto(row);
    }),

    getGraph(projectId: string): GraphDto {
      return graphOf(requireProject(projectId));
    },

    getTask,

    createTask: write((projectId: string, input: Input): TaskDto => {
      requireProject(projectId);
      const now = new Date().toISOString();
      const row: TaskRow = {
        id: newId('tsk'),
        project_id: projectId,
        title: readText(input.title, '제목', MAX_LENGTH.title, { required: true, trim: true }),
        description: readText(input.description, '설명', MAX_LENGTH.description) ?? '',
        status: readStatus(input.status) ?? 'todo',
        jira_url: readLink(input.jiraUrl, 'Jira 링크') ?? null,
        confluence_url: readLink(input.confluenceUrl, 'Confluence 링크') ?? null,
        created_at: now,
        updated_at: now,
      };
      sql.insertTask.run(row);
      return getTask(row.id);
    }),

    updateTask: write((taskId: string, input: Input): TaskDto => {
      const task = requireTask(taskId);
      const jiraUrl = readLink(input.jiraUrl, 'Jira 링크');
      const confluenceUrl = readLink(input.confluenceUrl, 'Confluence 링크');
      sql.updateTask.run({
        ...task,
        title:
          input.title === undefined
            ? task.title
            : readText(input.title, '제목', MAX_LENGTH.title, { required: true, trim: true }),
        description: readText(input.description, '설명', MAX_LENGTH.description) ?? task.description,
        status: readStatus(input.status) ?? task.status,
        jira_url: jiraUrl === undefined ? task.jira_url : jiraUrl,
        confluence_url: confluenceUrl === undefined ? task.confluence_url : confluenceUrl,
        updated_at: new Date().toISOString(),
      });
      return getTask(taskId);
    }),

    deleteTask: write((taskId: string): DeleteTaskResult => {
      const task = requireTask(taskId);
      const removedDependencies = dependenciesOf(task.project_id).filter(
        (edge) => edge.from === taskId || edge.to === taskId,
      );
      // 연결은 외래 키 CASCADE로 함께 지워진다.
      sql.deleteTask.run(taskId);
      return { deletedTaskId: taskId, removedDependencies };
    }),

    addDependency: write((projectId: string, input: Input): DependencyDto => {
      const from = readText(input.from, '선행 공정(from)', MAX_LENGTH.id, { required: true, trim: true });
      const to = readText(input.to, '후속 공정(to)', MAX_LENGTH.id, { required: true, trim: true });
      requireProject(projectId);
      if (from === to) {
        throw new ApiError(422, 'VALIDATION_SELF_LOOP', '공정을 자기 자신에게 연결할 수 없습니다.');
      }
      const fromTask = sql.getTask.get(from);
      const toTask = sql.getTask.get(to);
      if (!fromTask || !toTask) {
        const missing = [fromTask ? null : from, toTask ? null : to].filter(Boolean).join(', ');
        throw new ApiError(422, 'REFERENCE_NOT_FOUND', `연결할 공정을 찾을 수 없습니다: ${missing}`);
      }
      if (fromTask.project_id !== projectId || toTask.project_id !== projectId) {
        throw new ApiError(422, 'CROSS_PROJECT_REFERENCE', '다른 프로젝트의 공정과는 연결할 수 없습니다.');
      }
      const edges = dependenciesOf(projectId);
      if (edges.some((edge) => edge.from === from && edge.to === to)) {
        throw new ApiError(422, 'VALIDATION_DUPLICATE_EDGE', `이미 있는 연결입니다: ${fromTask.title} → ${toTask.title}`);
      }
      const cycle = findCycle(edges, from, to);
      if (cycle) {
        const titles = new Map(sql.listTasks.all(projectId).map((task) => [task.id, task.title]));
        const path = cycle.map((id) => titles.get(id) ?? id).join(' → ');
        throw new ApiError(422, 'VALIDATION_CYCLE', `이 연결을 추가하면 순환이 생깁니다: ${path}`, { cycle });
      }
      sql.insertDependency.run(projectId, from, to, new Date().toISOString());
      return { from, to };
    }),

    removeDependency: write((projectId: string, input: Input): DependencyDto => {
      const from = readText(input.from, '선행 공정(from)', MAX_LENGTH.id, { required: true, trim: true });
      const to = readText(input.to, '후속 공정(to)', MAX_LENGTH.id, { required: true, trim: true });
      requireProject(projectId);
      if (sql.deleteDependency.run(projectId, from, to).changes === 0) {
        throw new ApiError(404, 'NOT_FOUND', '해당 연결이 없습니다.');
      }
      return { from, to };
    }),
  };
}

function toProjectDto(row: ProjectRow): ProjectDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toTaskDto(row: TaskRow, prerequisites: Prerequisites): TaskDto {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    status: row.status,
    jiraUrl: row.jira_url,
    jiraKey: row.jira_url ? jiraKeyFromUrl(row.jira_url) : null,
    confluenceUrl: row.confluence_url,
    ...prerequisites,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function readText(value: unknown, label: string, max: number, options: { required: true; trim?: boolean }): string;
function readText(value: unknown, label: string, max: number, options?: { trim?: boolean }): string | undefined;
function readText(
  value: unknown,
  label: string,
  max: number,
  options: { required?: boolean; trim?: boolean } = {},
): string | undefined {
  if (value === undefined || value === null) {
    if (options.required) throw invalidInput(`${label}: 값을 입력하세요.`);
    return undefined;
  }
  if (typeof value !== 'string') throw invalidInput(`${label}: 문자열이어야 합니다.`);
  const text = options.trim ? value.trim() : value;
  if (options.required && text === '') throw invalidInput(`${label}: 값을 입력하세요.`);
  if (text.length > max) throw invalidInput(`${label}: ${max}자까지 입력할 수 있습니다.`);
  return text;
}

function readStatus(value: unknown): TaskStatus | undefined {
  if (value === undefined) return undefined;
  if (!isTaskStatus(value)) throw invalidInput('실행 상태: todo, in-progress, done 중 하나여야 합니다.');
  return value;
}

/** 값이 없으면 undefined(바꾸지 않음), 빈 문자열이나 null이면 null(지움), 그 밖에는 http(s) 주소. */
function readLink(value: unknown, label: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const url = readText(value, label, MAX_LENGTH.url, { trim: true })!;
  if (url === '') return null;
  if (!isHttpUrl(url)) throw invalidInput(`${label}: http 또는 https 주소를 입력하세요.`);
  return url;
}
