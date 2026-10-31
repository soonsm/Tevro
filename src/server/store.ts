import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  analyzeHierarchy,
  analyzePrerequisites,
  autoTransitions,
  descendantIds,
  findCycle,
  findHierarchyCycle,
  isHttpUrl,
  isTaskStatus,
  jiraKeyFromUrl,
  summarize,
  type Edge,
  type Hierarchy,
  type Prerequisites,
  type TaskLike,
  type TaskStatus,
} from '../shared/domain.ts';
import type {
  AutoTransition,
  DeleteTaskResult,
  DependencyDto,
  GraphDto,
  MoveTaskResult,
  ProjectDto,
  TaskChangeResult,
  TaskDto,
  TemplateSummaryDto,
} from '../shared/types.ts';
import { ApiError, invalidInput } from './errors.ts';
import { newId } from './ids.ts';

export type Db = Database.Database;
export type Store = ReturnType<typeof createStore>;
type Input = Record<string, unknown>;

/**
 * 스키마 버전(PRAGMA user_version).
 * 1: 첫 MVP. user_version을 쓰지 않아 0으로 남아 있다.
 * 2: 공정 계층(tasks.parent_id)
 * 3: 사용자·로그인 수단·세션·개인 액세스 토큰(ADR-0004)
 * 4: 템플릿(projects.kind 등)과 프로젝트의 템플릿 출처
 */
const SCHEMA_VERSION = 4;

// 템플릿은 공정·연결 테이블을 그대로 쓰도록 projects의 한 종류(kind = 'template')로 둔다. 그래프 편집과 검증이 프로젝트와 같다(F-T03).
// 출처(source_*)는 템플릿을 지워도 남게 외래 키 없이 이름·판까지 복사해 둔다(F-T09, AC-22).
const TEMPLATE_COLUMNS = `
ALTER TABLE projects ADD COLUMN kind TEXT NOT NULL DEFAULT 'project' CHECK (kind IN ('project', 'template'));
ALTER TABLE projects ADD COLUMN owner_user_id TEXT REFERENCES users (id) ON DELETE SET NULL;
ALTER TABLE projects ADD COLUMN official INTEGER NOT NULL DEFAULT 0 CHECK (official IN (0, 1));
ALTER TABLE projects ADD COLUMN template_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE projects ADD COLUMN template_dirty INTEGER NOT NULL DEFAULT 0 CHECK (template_dirty IN (0, 1));
ALTER TABLE projects ADD COLUMN source_template_id TEXT;
ALTER TABLE projects ADD COLUMN source_template_name TEXT;
ALTER TABLE projects ADD COLUMN source_template_version INTEGER;
ALTER TABLE projects ADD COLUMN source_applied_at TEXT;
CREATE INDEX projects_by_kind ON projects (kind);
`;

// 사용자와 로그인 수단을 나눈다. 로컬 비밀번호로 시작해도 나중에 LDAP·SSO 주체를 같은 사용자에 붙일 수 있다(ADR-0004).
// 세션과 토큰은 비밀값의 해시만 둔다.
const ACCOUNT_TABLES = `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('viewer', 'editor', 'admin')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT
);
CREATE TABLE auth_identities (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL COLLATE NOCASE,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  secret_hash TEXT,
  failed_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX auth_identities_by_user ON auth_identities (user_id);
CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX sessions_by_user ON sessions (user_id);
CREATE TABLE access_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('read', 'read-write')),
  secret_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX access_tokens_by_user ON access_tokens (user_id);
`;

// 새 DB에 만드는 최신 스키마. 순환은 DB 제약으로 막을 수 없어 서버가 쓰기 트랜잭션 안에서 검사하고, 나머지는 DB 제약으로 한 번 더 막는다(ADR-0003).
// 테이블·컬럼 설명은 Tevro/db-schema.md에 있다. 스키마를 바꾸면 SCHEMA_VERSION과 MIGRATIONS, 그 문서를 함께 고친다.
const SCHEMA = `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  parent_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in-progress', 'done')),
  jira_url TEXT,
  confluence_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, id),
  CHECK (parent_id IS NULL OR parent_id <> id),
  FOREIGN KEY (project_id, parent_id) REFERENCES tasks (project_id, id) ON DELETE CASCADE
);
CREATE INDEX tasks_by_project ON tasks (project_id);
CREATE INDEX tasks_by_parent ON tasks (project_id, parent_id);
CREATE TABLE dependencies (
  project_id TEXT NOT NULL,
  from_task_id TEXT NOT NULL,
  to_task_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, from_task_id, to_task_id),
  CHECK (from_task_id <> to_task_id),
  FOREIGN KEY (project_id, from_task_id) REFERENCES tasks (project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, to_task_id) REFERENCES tasks (project_id, id) ON DELETE CASCADE
);
${ACCOUNT_TABLES}${TEMPLATE_COLUMNS}`;

/** 예전 DB를 한 단계씩 올리는 SQL. 키는 올린 뒤의 버전이다. 한 번 배포한 단계는 고치지 않고 새 단계를 더한다. */
const MIGRATIONS: Record<number, string> = {
  // 공정 계층. 복합 외래 키는 ALTER TABLE로 더할 수 없어 tasks를 새로 만들어 옮긴다(SQLite ALTER TABLE 문서의 12단계 절차).
  2: `
CREATE TABLE tasks_new (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  parent_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in-progress', 'done')),
  jira_url TEXT,
  confluence_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, id),
  CHECK (parent_id IS NULL OR parent_id <> id),
  FOREIGN KEY (project_id, parent_id) REFERENCES tasks (project_id, id) ON DELETE CASCADE
);
INSERT INTO tasks_new (rowid, id, project_id, title, description, status, jira_url, confluence_url, created_at, updated_at)
  SELECT rowid, id, project_id, title, description, status, jira_url, confluence_url, created_at, updated_at FROM tasks;
DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;
CREATE INDEX tasks_by_project ON tasks (project_id);
CREATE INDEX tasks_by_parent ON tasks (project_id, parent_id);
`,
  3: ACCOUNT_TABLES,
  4: TEMPLATE_COLUMNS,
};

const MAX_LENGTH = { name: 100, title: 200, description: 10_000, url: 2_000, id: 64 };

interface ProjectRow {
  id: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
  kind: 'project' | 'template';
  owner_user_id: string | null;
  official: number;
  template_version: number;
  template_dirty: number;
  source_template_id: string | null;
  source_template_name: string | null;
  source_template_version: number | null;
  source_applied_at: string | null;
}

interface TemplateRow extends ProjectRow {
  owner_name: string | null;
  task_count: number;
  dependency_count: number;
  used_by: number;
}

interface TaskRow {
  id: string;
  project_id: string;
  parent_id: string | null;
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

/** DB 파일을 열고 스키마를 최신으로 맞춘다. 예전 버전을 올렸으면 onMigrated로 알린다. */
export function openDatabase(file: string, onMigrated?: (message: string) => void): Db {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  try {
    migrate(db, file, onMigrated);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

function migrate(db: Db, file: string, onMigrated?: (message: string) => void): void {
  let version = db.pragma('user_version', { simple: true }) as number;
  if (version === 0) {
    const empty = !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projects'").get();
    if (empty) {
      db.transaction(() => {
        db.exec(SCHEMA);
        db.pragma(`user_version = ${SCHEMA_VERSION}`);
      }).immediate();
      return;
    }
    version = 1; // 첫 MVP는 user_version을 쓰지 않았다.
  }
  if (version > SCHEMA_VERSION) {
    throw new Error(
      `데이터 파일의 스키마 버전(${version})이 이 Tevro가 아는 버전(${SCHEMA_VERSION})보다 새롭습니다. 더 새 버전의 Tevro로 실행하세요: ${file}`,
    );
  }
  if (version === SCHEMA_VERSION) return;
  // 올리기 전 파일을 같은 폴더에 남긴다. 각 단계는 트랜잭션이라 실패하면 되돌려지지만, 올린 뒤에 문제가 드러날 때를 대비한다.
  const backup = file === ':memory:' ? null : `${file}.schema${version}-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
  if (backup) db.prepare('VACUUM INTO ?').run(backup);
  for (let next = version + 1; next <= SCHEMA_VERSION; next += 1) {
    // 외래 키 검사는 트랜잭션 안에서 끌 수 없다. 밖에서 끄고, 커밋 전에 foreign_key_check로 직접 확인한다.
    db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(MIGRATIONS[next]);
        const violations = db.pragma('foreign_key_check') as unknown[];
        if (violations.length > 0) {
          throw new Error(`스키마 ${next}로 올린 뒤 외래 키 위반이 ${violations.length}건 있어 되돌렸습니다: ${file}`);
        }
        db.pragma(`user_version = ${next}`);
      }).immediate();
    } finally {
      db.pragma('foreign_keys = ON');
    }
  }
  onMigrated?.(`데이터 파일을 스키마 ${version}에서 ${SCHEMA_VERSION}로 올렸습니다.${backup ? ` 올리기 전 파일: ${backup}` : ''}`);
}

export function createStore(db: Db) {
  const sql = {
    listProjects: db.prepare<[], ProjectRow>("SELECT * FROM projects WHERE kind = 'project' ORDER BY rowid"),
    getProject: db.prepare<[string], ProjectRow>('SELECT * FROM projects WHERE id = ?'),
    insertProject: db.prepare<[ProjectRow]>(
      `INSERT INTO projects (id, name, description, created_at, updated_at, kind, owner_user_id, official, template_version,
         template_dirty, source_template_id, source_template_name, source_template_version, source_applied_at)
       VALUES (@id, @name, @description, @created_at, @updated_at, @kind, @owner_user_id, @official, @template_version,
         @template_dirty, @source_template_id, @source_template_name, @source_template_version, @source_applied_at)`,
    ),
    // 계정 테이블이 없는 체험 모드에서도 같은 SQL을 쓰도록 users는 LEFT JOIN한다(체험 사본도 같은 스키마).
    listTemplates: db.prepare<[], TemplateRow>(
      `SELECT p.*, u.display_name AS owner_name,
         (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS task_count,
         (SELECT COUNT(*) FROM dependencies d WHERE d.project_id = p.id) AS dependency_count,
         (SELECT COUNT(*) FROM projects q WHERE q.source_template_id = p.id) AS used_by
       FROM projects p LEFT JOIN users u ON u.id = p.owner_user_id
       WHERE p.kind = 'template' ORDER BY p.official DESC, p.name COLLATE NOCASE`,
    ),
    ownerName: db.prepare<[string], { display_name: string }>('SELECT display_name FROM users WHERE id = ?'),
    updateTemplateMeta: db.prepare<[string, string, number, number, string, string]>(
      'UPDATE projects SET name = ?, description = ?, official = ?, template_dirty = ?, updated_at = ? WHERE id = ?',
    ),
    markTemplateChanged: db.prepare<[string, string]>(
      "UPDATE projects SET template_dirty = 1, updated_at = ? WHERE id = ? AND kind = 'template'",
    ),
    // 지금 판으로 이미 만든 프로젝트가 있는지. 있으면 그 뒤에 고친 내용은 새 판이다.
    usedAtVersion: db.prepare<[string, number], { used: number }>(
      'SELECT EXISTS (SELECT 1 FROM projects WHERE source_template_id = ? AND source_template_version = ?) AS used',
    ),
    setTemplateVersion: db.prepare<[number, string]>('UPDATE projects SET template_version = ?, template_dirty = 0 WHERE id = ?'),
    deleteProject: db.prepare<[string]>('DELETE FROM projects WHERE id = ?'),
    listTasks: db.prepare<[string], TaskRow>('SELECT * FROM tasks WHERE project_id = ? ORDER BY rowid'),
    getTask: db.prepare<[string], TaskRow>('SELECT * FROM tasks WHERE id = ?'),
    insertTask: db.prepare<[TaskRow]>(
      `INSERT INTO tasks (id, project_id, parent_id, title, description, status, jira_url, confluence_url, created_at, updated_at)
       VALUES (@id, @project_id, @parent_id, @title, @description, @status, @jira_url, @confluence_url, @created_at, @updated_at)`,
    ),
    updateTask: db.prepare<[TaskRow]>(
      `UPDATE tasks SET title = @title, description = @description, status = @status, jira_url = @jira_url,
       confluence_url = @confluence_url, updated_at = @updated_at WHERE id = @id`,
    ),
    setParent: db.prepare<[string | null, string, string]>('UPDATE tasks SET parent_id = ?, updated_at = ? WHERE id = ?'),
    setStatus: db.prepare<[TaskStatus, string, string]>('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?'),
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

  function requireTemplate(templateId: string): ProjectRow {
    const row = sql.getProject.get(templateId);
    if (!row || row.kind !== 'template') throw new ApiError(404, 'NOT_FOUND', `템플릿을 찾을 수 없습니다: ${templateId}`);
    return row;
  }

  function ownerNameOf(row: ProjectRow): string | null {
    return row.owner_user_id ? (sql.ownerName.get(row.owner_user_id)?.display_name ?? null) : null;
  }

  function dto(row: ProjectRow): ProjectDto {
    return toProjectDto(row, row.kind === 'template' ? ownerNameOf(row) : null);
  }

  /**
   * 템플릿의 공정·연결을 바꾸면 '바뀜'으로 표시한다. 프로젝트면 아무것도 하지 않는다.
   * 판(F-T09: 적용 당시 정의의 식별)은 고칠 때마다 올리지 않고, 바뀐 뒤 처음 프로젝트를 만들 때 하나 올린다(instantiate).
   * 그래서 같은 판으로 만든 프로젝트들은 같은 정의에서 나왔고, 판 번호는 실제로 쓰인 정의만 센다.
   */
  function touch(projectId: string): void {
    sql.markTemplateChanged.run(new Date().toISOString(), projectId);
  }

  /** 템플릿에는 진행 상태와 Jira 링크가 없다(F-T06: 실행 정보는 프로젝트마다 따로). */
  function checkTemplateInput(projectId: string, input: Input, current?: TaskRow): void {
    if (sql.getProject.get(projectId)?.kind !== 'template') return;
    if (input.status !== undefined && input.status !== (current?.status ?? 'todo')) {
      throw invalidInput('템플릿 공정에는 진행 상태가 없습니다. 템플릿으로 프로젝트를 만든 뒤 바꾸세요.');
    }
    if (input.jiraUrl !== undefined && input.jiraUrl !== null && input.jiraUrl !== '') {
      throw invalidInput('템플릿에는 Jira 링크를 넣지 않습니다. 이슈는 프로젝트마다 다르므로 프로젝트를 만든 뒤 연결하세요.');
    }
  }

  /**
   * 한 그래프(프로젝트 또는 템플릿)의 공정·포함관계·연결을 새 ID로 다른 그래프에 복사한다(F-T05, F-H10).
   * 진행 상태와 Jira 링크는 가져오지 않고(F-T06), 제목·설명·Confluence 링크는 가져온다.
   */
  function copyGraph(fromId: string, toId: string, now: string): number {
    const rows = sql.listTasks.all(fromId);
    const ids = new Map(rows.map((row) => [row.id, newId('tsk')]));
    const depth = (row: TaskRow): number => {
      let d = 0;
      for (let parent = row.parent_id; parent; parent = rows.find((r) => r.id === parent)?.parent_id ?? null) d += 1;
      return d;
    };
    // 상위를 하위보다 먼저 넣어야 외래 키가 맞는다. 같은 깊이는 원래 순서(rowid)대로.
    const ordered = rows.map((row, index) => ({ row, index, depth: depth(row) })).sort((a, b) => a.depth - b.depth || a.index - b.index);
    for (const { row } of ordered) {
      sql.insertTask.run({
        id: ids.get(row.id)!,
        project_id: toId,
        parent_id: row.parent_id ? ids.get(row.parent_id)! : null,
        title: row.title,
        description: row.description,
        status: 'todo',
        jira_url: null,
        confluence_url: row.confluence_url,
        created_at: now,
        updated_at: now,
      });
    }
    for (const edge of dependenciesOf(fromId)) sql.insertDependency.run(toId, ids.get(edge.from)!, ids.get(edge.to)!, now);
    return rows.length;
  }

  function newGraphRow(kind: 'project' | 'template', input: Input, now: string): ProjectRow {
    return {
      id: newId(kind === 'project' ? 'prj' : 'tpl'),
      name: readText(input.name, kind === 'project' ? '프로젝트 이름' : '템플릿 이름', MAX_LENGTH.name, { required: true, trim: true }),
      description: readText(input.description, '설명', MAX_LENGTH.description) ?? '',
      created_at: now,
      updated_at: now,
      kind,
      owner_user_id: null,
      official: 0,
      template_version: 1,
      template_dirty: 0,
      source_template_id: null,
      source_template_name: null,
      source_template_version: null,
      source_applied_at: null,
    };
  }

  function requireTask(taskId: string): TaskRow {
    const task = sql.getTask.get(taskId);
    if (!task) throw new ApiError(404, 'NOT_FOUND', `공정을 찾을 수 없습니다: ${taskId}`);
    return task;
  }

  /** 상위로 지정할 공정. 없거나 다른 프로젝트의 공정이면 거부한다(F-H02). */
  function requireParent(projectId: string, parentId: string): TaskRow {
    const parent = sql.getTask.get(parentId);
    if (!parent) throw new ApiError(422, 'REFERENCE_NOT_FOUND', `상위 공정을 찾을 수 없습니다: ${parentId}`);
    if (parent.project_id !== projectId) {
      throw new ApiError(422, 'CROSS_PROJECT_REFERENCE', '다른 프로젝트의 공정은 상위로 지정할 수 없습니다.');
    }
    return parent;
  }

  function dependenciesOf(projectId: string): Edge[] {
    return sql.listDependencies.all(projectId).map((row) => ({ from: row.from_task_id, to: row.to_task_id }));
  }

  function titlesOf(projectId: string): Map<string, string> {
    return new Map(sql.listTasks.all(projectId).map((task) => [task.id, task.title]));
  }

  function graphOf(project: ProjectRow): GraphDto {
    const rows = sql.listTasks.all(project.id);
    const tasks = rows.map(toTaskLike);
    const dependencies = dependenciesOf(project.id);
    const prerequisites = analyzePrerequisites(tasks, dependencies);
    const hierarchy = analyzeHierarchy(tasks);
    return {
      project: dto(project),
      tasks: rows.map((row) => toTaskDto(row, prerequisites.get(row.id)!, hierarchy.get(row.id)!)),
      dependencies,
      summary: summarize(tasks),
    };
  }

  function getTask(taskId: string): TaskDto {
    const task = requireTask(taskId);
    return graphOf(requireProject(task.project_id)).tasks.find((dto) => dto.id === taskId)!;
  }

  /** 하위가 바뀐 상위들부터 자동 전이를 적용하고, 바뀐 상위를 돌려준다(PRD §6.9). 인자의 뜻은 domain의 autoTransitions와 같다. */
  function applyAutoTransitions(
    projectId: string,
    changedParentIds: (string | null)[],
    addedParentIds: (string | null)[] = [],
  ): AutoTransition[] {
    const rows = sql.listTasks.all(projectId);
    const titles = new Map(rows.map((row) => [row.id, row.title]));
    const now = new Date().toISOString();
    return autoTransitions(rows.map(toTaskLike), changedParentIds, addedParentIds).map(({ taskId, status, cause }) => {
      sql.setStatus.run(status, now, taskId);
      return { taskId, title: titles.get(taskId)!, status, cause };
    });
  }

  return {
    listProjects(): ProjectDto[] {
      return sql.listProjects.all().map(dto);
    },

    createProject: write((input: Input): ProjectDto => {
      const row = newGraphRow('project', input, new Date().toISOString());
      sql.insertProject.run(row);
      return dto(row);
    }),

    /** 프로젝트 또는 템플릿 하나(권한 검사용). 없으면 NOT_FOUND */
    getProject: (projectId: string): ProjectDto => dto(requireProject(projectId)),
    /** 공정이 속한 프로젝트·템플릿 ID */
    projectIdOfTask: (taskId: string): string => requireTask(taskId).project_id,

    /** 모든 템플릿(보이는지 거르는 것은 호출하는 쪽 몫). canEdit은 false로 두고 호출하는 쪽이 채운다. */
    listTemplates(): TemplateSummaryDto[] {
      return sql.listTemplates.all().map((row) => ({
        ...(toProjectDto(row, row.owner_name) as TemplateSummaryDto),
        taskCount: row.task_count,
        dependencyCount: row.dependency_count,
        usedBy: row.used_by,
        canEdit: false,
      }));
    },

    /** 빈 템플릿. ownerId가 있으면 그 사람의 개인 템플릿, official이면 회사 템플릿 */
    createTemplate: write((input: Input, owner: { ownerId: string | null; official: boolean }): ProjectDto => {
      const row = { ...newGraphRow('template', input, new Date().toISOString()), owner_user_id: owner.ownerId, official: owner.official ? 1 : 0 };
      sql.insertProject.run(row);
      return dto(row);
    }),

    /** 프로젝트나 다른 템플릿의 공정·연결을 복사해 새 템플릿으로 저장한다(F-T02, 회사 템플릿을 내 템플릿으로 복사). */
    saveAsTemplate: write((sourceId: string, input: Input, owner: { ownerId: string | null; official: boolean }): ProjectDto => {
      requireProject(sourceId);
      const now = new Date().toISOString();
      const row = { ...newGraphRow('template', input, now), owner_user_id: owner.ownerId, official: owner.official ? 1 : 0 };
      sql.insertProject.run(row);
      copyGraph(sourceId, row.id, now);
      return dto(row);
    }),

    /** 템플릿으로 새 프로젝트를 만든다(F-T04~F-T06). 출처로 템플릿 ID·이름·판을 남긴다(F-T09). */
    instantiate: write((templateId: string, input: Input): ProjectDto => {
      const template = requireTemplate(templateId);
      const now = new Date().toISOString();
      // 지금 판으로 만든 프로젝트가 이미 있고 그 뒤에 고쳤다면 새 판으로 기록한다.
      if (template.template_dirty === 1) {
        const used = sql.usedAtVersion.get(template.id, template.template_version)!.used === 1;
        if (used) template.template_version += 1;
        sql.setTemplateVersion.run(template.template_version, template.id);
      }
      const row: ProjectRow = {
        ...newGraphRow('project', input, now),
        source_template_id: template.id,
        source_template_name: template.name,
        source_template_version: template.template_version,
        source_applied_at: now,
      };
      if (input.description === undefined) row.description = template.description;
      sql.insertProject.run(row);
      copyGraph(templateId, row.id, now);
      return dto(row);
    }),

    /** 템플릿 이름·설명·회사 템플릿 여부를 바꾼다. */
    updateTemplate: write((templateId: string, input: Input): ProjectDto => {
      const row = requireTemplate(templateId);
      const name = input.name === undefined ? row.name : readText(input.name, '템플릿 이름', MAX_LENGTH.name, { required: true, trim: true });
      const description = readText(input.description, '설명', MAX_LENGTH.description) ?? row.description;
      if (input.official !== undefined && typeof input.official !== 'boolean') throw invalidInput('회사 템플릿(official): true 또는 false여야 합니다.');
      const official = input.official === undefined ? row.official : input.official ? 1 : 0;
      // 이름·설명이 바뀌면 정의가 바뀐 것으로 본다. 회사 템플릿 지정·해제는 정의를 바꾸지 않는다.
      const changed = name !== row.name || description !== row.description ? 1 : row.template_dirty;
      sql.updateTemplateMeta.run(name, description, official, changed, new Date().toISOString(), templateId);
      return dto(requireTemplate(templateId));
    }),

    /** 템플릿을 지운다. 그 템플릿으로 만든 프로젝트는 그대로이고 출처 기록도 남는다(F-T10, AC-22). */
    deleteTemplate: write((templateId: string): ProjectDto => {
      const row = requireTemplate(templateId);
      sql.deleteProject.run(templateId);
      return dto(row);
    }),

    getGraph(projectId: string): GraphDto {
      return graphOf(requireProject(projectId));
    },

    getTask,

    createTask: write((projectId: string, input: Input): TaskChangeResult => {
      requireProject(projectId);
      checkTemplateInput(projectId, input);
      const now = new Date().toISOString();
      const row: TaskRow = {
        id: newId('tsk'),
        project_id: projectId,
        parent_id: readParentId(input.parentId) ?? null,
        title: readText(input.title, '제목', MAX_LENGTH.title, { required: true, trim: true }),
        description: readText(input.description, '설명', MAX_LENGTH.description) ?? '',
        status: readStatus(input.status) ?? 'todo',
        jira_url: readLink(input.jiraUrl, 'Jira 링크') ?? null,
        confluence_url: readLink(input.confluenceUrl, 'Confluence 링크') ?? null,
        created_at: now,
        updated_at: now,
      };
      if (row.parent_id !== null) requireParent(projectId, row.parent_id);
      sql.insertTask.run(row);
      touch(projectId);
      const transitions = applyAutoTransitions(projectId, [], [row.parent_id]);
      return { task: getTask(row.id), autoTransitions: transitions };
    }),

    updateTask: write((taskId: string, input: Input): TaskChangeResult => {
      const task = requireTask(taskId);
      if (input.parentId !== undefined) {
        throw invalidInput('상위 공정은 여기서 바꿀 수 없습니다. 이동(POST /api/v1/tasks/{taskId}/move)을 쓰세요.');
      }
      checkTemplateInput(task.project_id, input, task);
      const jiraUrl = readLink(input.jiraUrl, 'Jira 링크');
      const confluenceUrl = readLink(input.confluenceUrl, 'Confluence 링크');
      const status = readStatus(input.status) ?? task.status;
      sql.updateTask.run({
        ...task,
        title:
          input.title === undefined
            ? task.title
            : readText(input.title, '제목', MAX_LENGTH.title, { required: true, trim: true }),
        description: readText(input.description, '설명', MAX_LENGTH.description) ?? task.description,
        status,
        jira_url: jiraUrl === undefined ? task.jira_url : jiraUrl,
        confluence_url: confluenceUrl === undefined ? task.confluence_url : confluenceUrl,
        updated_at: new Date().toISOString(),
      });
      touch(task.project_id);
      // 상위 공정을 사용자가 직접 바꾼 경우에는 그 공정의 하위를 보고 되돌리지 않는다(F-H06). 그 위 상위만 다시 본다.
      const transitions = status === task.status ? [] : applyAutoTransitions(task.project_id, [task.parent_id]);
      return { task: getTask(taskId), autoTransitions: transitions };
    }),

    /** 상위 공정을 바꾼다. 하위 공정은 함께 옮겨진다. 연결은 같은 층 안에서만 맺으므로 이 공정의 연결이 남아 있으면 거부한다(F-H08). */
    moveTask: write((taskId: string, input: Input): MoveTaskResult => {
      if (input.parentId === undefined) {
        throw invalidInput('새 상위 공정(parentId): 공정 ID를 입력하세요. 최상위로 옮기려면 null을 보냅니다.');
      }
      const parentId = readParentId(input.parentId) ?? null;
      const detach = readDetach(input.removeDependencies, taskId);
      const task = requireTask(taskId);
      if (parentId !== null) {
        requireParent(task.project_id, parentId);
        const path = findHierarchyCycle(sql.listTasks.all(task.project_id).map(toTaskLike), taskId, parentId);
        if (path) {
          const titles = titlesOf(task.project_id);
          const detail =
            path.length === 1
              ? '자기 자신을 상위 공정으로 지정할 수 없습니다.'
              : `하위 공정을 상위로 지정할 수 없습니다: ${[...path].reverse().map((id) => titles.get(id) ?? id).join(' › ')}`;
          throw new ApiError(422, 'HIERARCHY_CYCLE', detail, { path });
        }
      }
      // 상위가 그대로면 형제도 그대로라 연결을 지울 까닭이 없다.
      if (parentId === task.parent_id) return { task: getTask(taskId), removedDependencies: [], autoTransitions: [] };
      const attached = dependenciesOf(task.project_id).filter((edge) => edge.from === taskId || edge.to === taskId);
      const remaining = attached.filter((edge) => !detach.some((item) => item.from === edge.from && item.to === edge.to));
      if (remaining.length > 0) {
        const titles = titlesOf(task.project_id);
        const list = remaining.map((edge) => `${titles.get(edge.from)} → ${titles.get(edge.to)}`).join(', ');
        throw new ApiError(
          422,
          'HAS_DEPENDENCIES',
          `연결은 같은 층 안에서만 맺을 수 있어 연결이 있는 공정은 다른 층으로 옮길 수 없습니다. 먼저 지울 연결 ${remaining.length}개: ${list}`,
          { dependencies: remaining },
        );
      }
      for (const edge of attached) sql.deleteDependency.run(task.project_id, edge.from, edge.to);
      sql.setParent.run(parentId, new Date().toISOString(), taskId);
      touch(task.project_id);
      const transitions = applyAutoTransitions(task.project_id, [task.parent_id], [parentId]);
      return { task: getTask(taskId), removedDependencies: attached, autoTransitions: transitions };
    }),

    /** 공정을 지운다. 하위 공정이 있으면 자손까지 함께 지운다(ADR-0005). */
    deleteTask: write((taskId: string): DeleteTaskResult => {
      const task = requireTask(taskId);
      const rows = sql.listTasks.all(task.project_id);
      const byId = new Map(rows.map((row) => [row.id, row]));
      const descendants = descendantIds(rows.map(toTaskLike), taskId);
      const removed = new Set([taskId, ...descendants]);
      const removedDependencies = dependenciesOf(task.project_id).filter(
        (edge) => removed.has(edge.from) || removed.has(edge.to),
      );
      // 자손 공정과 연결은 외래 키 CASCADE로 함께 지워진다.
      sql.deleteTask.run(taskId);
      touch(task.project_id);
      return {
        deletedTaskId: taskId,
        removedTasks: descendants.map((id) => ({ id, parentId: byId.get(id)!.parent_id, title: byId.get(id)!.title })),
        removedDependencies,
        autoTransitions: applyAutoTransitions(task.project_id, [task.parent_id]),
      };
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
      if (fromTask.parent_id !== toTask.parent_id) {
        const titles = titlesOf(projectId);
        const level = (task: TaskRow) => (task.parent_id === null ? '최상위' : `${titles.get(task.parent_id)} 아래`);
        throw new ApiError(
          422,
          'CROSS_LEVEL_DEPENDENCY',
          `같은 상위 아래의 공정끼리만 연결할 수 있습니다: ${fromTask.title}(${level(fromTask)}) → ${toTask.title}(${level(toTask)})`,
          { parentIds: [fromTask.parent_id, toTask.parent_id] },
        );
      }
      // 연결은 모두 같은 층 안에 있으므로 전체에서 찾은 순환이 곧 그 층의 순환이다.
      const cycle = findCycle(edges, from, to);
      if (cycle) {
        const titles = titlesOf(projectId);
        const path = cycle.map((id) => titles.get(id) ?? id).join(' → ');
        throw new ApiError(422, 'VALIDATION_CYCLE', `이 연결을 추가하면 순환이 생깁니다: ${path}`, { cycle });
      }
      sql.insertDependency.run(projectId, from, to, new Date().toISOString());
      touch(projectId);
      return { from, to };
    }),

    removeDependency: write((projectId: string, input: Input): DependencyDto => {
      const from = readText(input.from, '선행 공정(from)', MAX_LENGTH.id, { required: true, trim: true });
      const to = readText(input.to, '후속 공정(to)', MAX_LENGTH.id, { required: true, trim: true });
      requireProject(projectId);
      if (sql.deleteDependency.run(projectId, from, to).changes === 0) {
        throw new ApiError(404, 'NOT_FOUND', '해당 연결이 없습니다.');
      }
      touch(projectId);
      return { from, to };
    }),
  };
}

function toProjectDto(row: ProjectRow, ownerName: string | null): ProjectDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    kind: row.kind,
    ...(row.kind === 'template'
      ? { template: { official: row.official === 1, ownerId: row.owner_user_id, ownerName, version: row.template_version } }
      : {}),
    source:
      row.source_template_id === null
        ? null
        : {
            templateId: row.source_template_id,
            name: row.source_template_name!,
            version: row.source_template_version!,
            appliedAt: row.source_applied_at!,
          },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toTaskDto(row: TaskRow, prerequisites: Prerequisites, hierarchy: Hierarchy): TaskDto {
  return {
    id: row.id,
    projectId: row.project_id,
    parentId: row.parent_id,
    title: row.title,
    description: row.description,
    status: row.status,
    jiraUrl: row.jira_url,
    jiraKey: row.jira_url ? jiraKeyFromUrl(row.jira_url) : null,
    confluenceUrl: row.confluence_url,
    ...prerequisites,
    ...hierarchy,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toTaskLike(row: TaskRow): TaskLike {
  return { id: row.id, status: row.status, parentId: row.parent_id };
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

/** 값이 없으면 undefined, null이면 null(최상위), 그 밖에는 공정 ID */
function readParentId(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return readText(value, '상위 공정(parentId)', MAX_LENGTH.id, { required: true, trim: true });
}

/** 이동과 함께 지울 연결 목록. 옮기는 공정에 닿은 연결만 받는다. */
function readDetach(value: unknown, taskId: string): Edge[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalidInput('함께 지울 연결(removeDependencies): 배열이어야 합니다.');
  return value.map((item: unknown) => {
    const edge = (typeof item === 'object' && item !== null ? item : {}) as Input;
    const from = readText(edge.from, '함께 지울 연결의 선행 공정(from)', MAX_LENGTH.id, { required: true, trim: true });
    const to = readText(edge.to, '함께 지울 연결의 후속 공정(to)', MAX_LENGTH.id, { required: true, trim: true });
    if (from !== taskId && to !== taskId) throw invalidInput(`함께 지울 연결은 옮기는 공정에 닿아 있어야 합니다: ${from} → ${to}`);
    return { from, to };
  });
}
