import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { createStore, openDatabase, type Db } from '../src/server/store.ts';

// 첫 MVP(스키마 1, user_version 0)가 만들던 스키마 그대로. 마이그레이션 시험용으로 고정해 둔다.
const SCHEMA_V1 = `
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

function withDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'tevro-migration-'));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** 비교용 스키마 요약. 테이블 이름의 따옴표(이름 바꾸기 후 SQLite가 붙임)와 공백 차이는 무시한다. */
function schemaOf(db: Db) {
  const rows = db.prepare('SELECT type, name, tbl_name AS tableName, sql FROM sqlite_master ORDER BY type, name').all() as {
    sql: string | null;
  }[];
  return rows.map((row) => ({
    ...row,
    sql: row.sql?.replace(/"(\w+)"/g, '$1').replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')') ?? null,
  }));
}

function backups(directory: string): string[] {
  return readdirSync(directory).filter((name) => name.endsWith('.bak'));
}

describe('스키마 마이그레이션', () => {
  it('첫 MVP DB(스키마 1)를 최신 스키마(4: 계층, 계정, 템플릿)로 올리고 데이터와 제약을 지킨다', () => {
    withDirectory((directory) => {
      const file = join(directory, 'tevro.db');
      const old = new Database(file);
      old.pragma('journal_mode = WAL');
      old.exec(SCHEMA_V1);
      old.exec(`
        INSERT INTO projects VALUES ('prj_1', '기존 프로젝트', '', 't', 't');
        INSERT INTO tasks (id, project_id, title, status, created_at, updated_at)
          VALUES ('tsk_a', 'prj_1', 'A', 'done', 't', 't'), ('tsk_b', 'prj_1', 'B', 'todo', 't', 't');
        INSERT INTO dependencies VALUES ('prj_1', 'tsk_a', 'tsk_b', 't');
      `);
      old.close();

      const messages: string[] = [];
      const db = openDatabase(file, (message) => messages.push(message));
      const fresh = openDatabase(':memory:');
      try {
        assert.equal(db.pragma('user_version', { simple: true }), 4);
        assert.match(messages.join('\n'), /스키마 1에서 4로/);
        assert.equal(backups(directory).length, 1);
        assert.deepEqual(schemaOf(db), schemaOf(fresh));

        const store = createStore(db);
        const graph = store.getGraph('prj_1');
        // 예전 프로젝트는 템플릿이 아닌 프로젝트이고 출처가 없다(스키마 4).
        assert.deepEqual([graph.project.kind, graph.project.source], ['project', null]);
        assert.deepEqual(
          graph.tasks.map((task) => [task.title, task.status, task.parentId]),
          [
            ['A', 'done', null],
            ['B', 'todo', null],
          ],
        );
        assert.deepEqual(graph.dependencies, [{ from: 'tsk_a', to: 'tsk_b' }]);

        // 계층을 쓸 수 있고, 외래 키 CASCADE가 하위 공정과 연결까지 지운다.
        const child = store.createTask('prj_1', { title: 'B-1', parentId: 'tsk_b' }).task;
        store.deleteTask('tsk_b');
        assert.deepEqual(store.getGraph('prj_1').dependencies, []);
        assert.throws(() => store.getTask(child.id), /찾을 수 없습니다/);
        assert.throws(
          () => db.prepare("UPDATE tasks SET parent_id = 'tsk_a' WHERE id = 'tsk_a'").run(),
          /CHECK constraint failed/,
        );
      } finally {
        db.close();
        fresh.close();
      }

      // 다시 열어도 그대로이고 백업을 또 만들지 않는다.
      openDatabase(file).close();
      assert.equal(backups(directory).length, 1);
    });
  });

  it('새 DB는 최신 스키마로 바로 만든다', () => {
    withDirectory((directory) => {
      const db = openDatabase(join(directory, 'tevro.db'));
      assert.equal(db.pragma('user_version', { simple: true }), 4);
      db.close();
      assert.deepEqual(backups(directory), []);
    });
  });

  it('이 Tevro보다 새 스키마의 DB는 열지 않는다', () => {
    withDirectory((directory) => {
      const file = join(directory, 'tevro.db');
      const future = new Database(file);
      future.exec(SCHEMA_V1);
      future.pragma('user_version = 99');
      future.close();
      assert.throws(() => openDatabase(file), /더 새 버전의 Tevro/);
    });
  });
});
