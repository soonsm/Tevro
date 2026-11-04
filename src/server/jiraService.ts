// Jira 연동의 흐름(ADR-0009): 사람마다의 토큰, 프로젝트 연결 설정, 조회(5분 기준), Tevro에서 바꾼 값을 Jira에 먼저 반영, 이슈 만들기.
// Jira는 그 작업을 요청한 사람의 토큰으로만 부른다. DB 쓰기는 store를 거친다.
import type { JiraTokenStatusDto, JiraValuesDto, ProjectJiraDto } from '../shared/types.ts';
import type { TaskStatus } from '../shared/domain.ts';
import type { Actor } from './accounts.ts';
import { ApiError, invalidInput } from './errors.ts';
import { ISSUE_KEY, createJiraClient, issueKeyOnSite, type JiraClient, type JiraClientOptions, type JiraIssue, type JiraStatus, type StatusCategory } from './jira.ts';
import type { SecretBox } from './secrets.ts';
import { statusOfCategory, type Db, type JiraFetched, type LinkedTask, type Store } from './store.ts';

/** 프로젝트를 읽을 때 이보다 오래된 조회면 먼저 Jira에서 가져온다 */
export const REFRESH_AFTER_MS = 5 * 60 * 1000;
const CATEGORY_ORDER: Record<StatusCategory, number> = { new: 0, indeterminate: 1, done: 2 };
const TEVRO_TO_CATEGORY: Record<TaskStatus, StatusCategory> = { todo: 'new', 'in-progress': 'indeterminate', done: 'done' };

export interface JiraServiceOptions {
  db: Db;
  store: Store;
  /** TEVRO_JIRA_URL. 없으면 연동을 끈다 */
  site: string | null;
  /** 토큰 암호화. 없으면 토큰을 등록할 수 없다(키가 없는 이유는 boxProblem) */
  box: SecretBox | null;
  boxProblem?: string;
  client?: JiraClientOptions;
  now?: () => number;
}

interface TokenRow {
  user_id: string;
  sealed: string;
  key_fingerprint: string;
  jira_name: string;
  jira_display_name: string;
  created_at: string;
  last_used_at: string | null;
}

export type JiraService = ReturnType<typeof createJiraService>;

export function createJiraService({ db, store, site, box, boxProblem, client: clientOptions, now = Date.now }: JiraServiceOptions) {
  const sql = {
    getToken: db.prepare<[string], TokenRow>('SELECT * FROM jira_tokens WHERE user_id = ?'),
    upsertToken: db.prepare<[string, string, string, string, string, string]>(
      `INSERT INTO jira_tokens (user_id, sealed, key_fingerprint, jira_name, jira_display_name, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET sealed = excluded.sealed, key_fingerprint = excluded.key_fingerprint,
         jira_name = excluded.jira_name, jira_display_name = excluded.jira_display_name, created_at = excluded.created_at, last_used_at = NULL`,
    ),
    deleteToken: db.prepare<[string]>('DELETE FROM jira_tokens WHERE user_id = ?'),
    touchToken: db.prepare<[string, string]>('UPDATE jira_tokens SET last_used_at = ? WHERE user_id = ?'),
    setUserJiraName: db.prepare<[string | null, string]>('UPDATE users SET jira_name = ? WHERE id = ?'),
    userJiraName: db.prepare<[string], { jira_name: string | null; display_name: string }>('SELECT jira_name, display_name FROM users WHERE id = ?'),
  };
  const iso = (ms = now()) => new Date(ms).toISOString();
  /** 같은 프로젝트를 여러 요청이 동시에 조회하지 않게 진행 중인 조회를 나눠 쓴다 */
  const inflight = new Map<string, Promise<void>>();
  /** Jira 프로젝트 키 → 상태 목록(상태 짝이 없을 때 기본 상태를 고르는 데 쓴다). 10분 동안 둔다 */
  const statusCache = new Map<string, { at: number; statuses: JiraStatus[] }>();

  /** 상태 짝이 없을 때: 그 이슈의 Jira 프로젝트에서 그 분류의 첫 상태(설정 화면의 추천값과 같은 규칙) */
  async function defaultStatusFor(client: JiraClient, issueKey: string, target: TaskStatus): Promise<{ id: string; name: string } | undefined> {
    const projectKey = issueKey.slice(0, issueKey.lastIndexOf('-'));
    let cached = statusCache.get(projectKey);
    if (!cached || now() - cached.at > 10 * 60 * 1000) {
      const byType = await client.projectStatuses(projectKey);
      const seen = new Map<string, JiraStatus>();
      for (const type of byType) for (const status of type.statuses) if (!seen.has(status.id)) seen.set(status.id, status);
      cached = { at: now(), statuses: [...seen.values()] };
      statusCache.set(projectKey, cached);
    }
    const found = cached.statuses.find((status) => status.category === TEVRO_TO_CATEGORY[target]);
    return found ? { id: found.id, name: found.name } : undefined;
  }

  function requireEnabled(): string {
    if (!site) throw new ApiError(409, 'JIRA_NOT_CONFIGURED', '이 서버에는 Jira가 연결돼 있지 않습니다. 관리자가 TEVRO_JIRA_URL을 설정해야 합니다.');
    return site;
  }

  /** 그 사람의 Jira 클라이언트. 토큰이 없으면 JIRA_TOKEN_REQUIRED */
  function clientFor(actor: Actor): JiraClient {
    const base = requireEnabled();
    const row = sql.getToken.get(actor.user.id);
    if (!row) {
      throw new ApiError(403, 'JIRA_TOKEN_REQUIRED', 'Jira 토큰이 없습니다. 계정 메뉴의 [Jira 연결]에서 내 Jira 개인 액세스 토큰을 등록하세요.');
    }
    if (!box || row.key_fingerprint !== box.fingerprint) {
      throw new ApiError(403, 'JIRA_TOKEN_REQUIRED', '서버 비밀키가 바뀌어 저장한 Jira 토큰을 쓸 수 없습니다. [Jira 연결]에서 토큰을 다시 등록하세요.');
    }
    let token: string;
    try {
      token = box.open(row.sealed);
    } catch {
      throw new ApiError(403, 'JIRA_TOKEN_REQUIRED', '저장한 Jira 토큰을 풀 수 없습니다. [Jira 연결]에서 토큰을 다시 등록하세요.');
    }
    const at = now();
    if (!row.last_used_at || at - Date.parse(row.last_used_at) > 60_000) sql.touchToken.run(iso(at), actor.user.id);
    return createJiraClient(base, token, clientOptions);
  }

  const hasToken = (actor: Actor | undefined): boolean => Boolean(actor && site && sql.getToken.get(actor.user.id));

  /** Jira 이슈 값을 Tevro 쪽 값으로 */
  function valuesOf(issue: JiraIssue): JiraValuesDto {
    const assigneeId = store.tevroUserOfJira(issue.assignee?.name);
    return {
      key: issue.key,
      status: statusOfCategory(issue.status.category),
      statusName: issue.status.name,
      deadline: issue.duedate,
      assigneeId,
      assigneeName: issue.assignee?.displayName ?? null,
    };
  }

  /** 프로젝트에 연결된 이슈를 가져와 반영한다. 통째로 실패하면 이유를 남기고 던진다 */
  async function refreshNow(actor: Actor, projectId: string): Promise<void> {
    const linked = store.jiraLinkedTasks(projectId);
    const by = actor.user.displayName;
    try {
      const client = clientFor(actor);
      if (linked.length === 0) {
        store.applyJira(projectId, [], by, { error: null });
        return;
      }
      const keys = [...new Set(linked.map((task) => task.key))];
      const { issues, missing } = await client.issuesByKeys(keys);
      const fetched: JiraFetched[] = [
        ...issues,
        ...missing.map((key) => ({ key, error: 'Jira에서 찾을 수 없거나 볼 권한이 없습니다.' })),
      ];
      store.applyJira(projectId, fetched, by, { error: null });
    } catch (error) {
      if (error instanceof ApiError) store.recordJiraRefreshError(projectId, by, error.message);
      throw error;
    }
  }

  async function refresh(actor: Actor, projectId: string): Promise<void> {
    const running = inflight.get(projectId);
    if (running) return running;
    const job = refreshNow(actor, projectId).finally(() => inflight.delete(projectId));
    inflight.set(projectId, job);
    return job;
  }

  /**
   * 이슈를 Tevro 상태 target에 맞는 Jira 상태로 옮긴다. preferred(상태 짝)가 있으면 그 상태로.
   * 바로 가는 전환이 없으면 목표 쪽 다른 분류의 상태를 거쳐 최대 3단계. 목표 분류의 다른 상태(예: '안 함')에는 내려앉지 않는다.
   */
  async function moveTo(client: JiraClient, key: string, target: TaskStatus, preferred: { id: string; name: string } | undefined): Promise<void> {
    const targetCategory = TEVRO_TO_CATEGORY[target];
    const goal = CATEGORY_ORDER[targetCategory];
    const visited = new Set<string>();
    for (let step = 0; step <= 3; step += 1) {
      const issue = await client.issue(key);
      if (preferred ? issue.status.id === preferred.id : issue.status.category === targetCategory) return;
      visited.add(issue.status.id);
      if (step === 3) break;
      const transitions = await client.transitions(key);
      const direct = preferred
        ? transitions.find((item) => item.to.id === preferred.id)
        : (() => {
            const landing = transitions.filter((item) => item.to.category === targetCategory);
            if (landing.length > 1) ambiguous(landing.map((item) => item.to));
            return landing[0];
          })();
      if (direct) {
        await client.transition(key, direct.id);
        continue;
      }
      // 이미 목표 분류인데 짝지은 상태로만 못 가는 경우(예: '검토 중' → '진행 중' 전환 없음)는 그대로 둔다. Tevro 상태로는 같다.
      if (issue.status.category === targetCategory) return;
      const current = issue.status.category ? CATEGORY_ORDER[issue.status.category] : -1;
      const stepping = transitions
        .filter((item) => item.to.category && item.to.category !== targetCategory && !visited.has(item.to.id))
        .map((item) => ({ item, distance: Math.abs(goal - CATEGORY_ORDER[item.to.category!]) }))
        // 목표에 더 가까워지는 상태, 또는 같은 분류 안의 다음 상태(예: 진행 중 → 검토 중 → 완료처럼 옆으로 한 칸)
        .filter(({ item, distance }) => current < 0 || distance < Math.abs(goal - current) || item.to.category === issue.status.category)
        .sort((a, b) => a.distance - b.distance)[0];
      if (!stepping) {
        const options = transitions.map((item) => `${item.name} → ${item.to.name}`).join(', ') || '없음';
        throw new ApiError(424, 'JIRA_TRANSITION', `Jira에서 ${key}를 '${preferred?.name ?? target}'(으)로 옮길 전환이 없습니다. 지금 갈 수 있는 전환: ${options}`);
      }
      await client.transition(key, stepping.item.id);
    }
    throw new ApiError(424, 'JIRA_TRANSITION', `Jira에서 ${key}를 '${preferred?.name ?? target}'(으)로 3단계 안에 옮기지 못했습니다. Jira 워크플로를 확인하세요.`);
  }

  function ambiguous(statuses: JiraStatus[]): never {
    throw new ApiError(
      409,
      'JIRA_NOT_CONFIGURED',
      `옮길 수 있는 Jira 상태가 여럿입니다(${statuses.map((item) => item.name).join(', ')}). 프로젝트의 [Jira 설정]에서 상태 짝을 정하세요.`,
    );
  }

  return {
    enabled: site !== null,
    site,

    tokenStatus(actor: Actor): JiraTokenStatusDto {
      const row = site ? sql.getToken.get(actor.user.id) : undefined;
      return {
        enabled: site !== null,
        siteUrl: site,
        storage: box !== null,
        connected: Boolean(row),
        jiraName: row?.jira_name ?? null,
        jiraDisplayName: row?.jira_display_name ?? null,
        registeredAt: row?.created_at ?? null,
        lastUsedAt: row?.last_used_at ?? null,
        problem: !site ? null : !box ? (boxProblem ?? 'TEVRO_SECRET_KEY가 없어 토큰을 저장할 수 없습니다.') : row && row.key_fingerprint !== box.fingerprint ? '서버 비밀키가 바뀌어 토큰을 다시 등록해야 합니다.' : null,
      };
    },

    /** 토큰을 Jira에 확인한 뒤 암호화해 저장한다. Jira name을 그 사람의 Tevro 계정에 짝짓는다 */
    async setToken(actor: Actor, token: unknown): Promise<JiraTokenStatusDto> {
      const base = requireEnabled();
      if (!box) throw new ApiError(409, 'JIRA_NOT_CONFIGURED', boxProblem ?? '서버에 TEVRO_SECRET_KEY가 없어 토큰을 저장할 수 없습니다. 관리자에게 알리세요.');
      if (typeof token !== 'string' || token.trim().length < 8 || token.length > 500 || /\s/.test(token.trim())) {
        throw invalidInput('Jira 개인 액세스 토큰을 그대로 붙여 넣으세요.');
      }
      const me = await createJiraClient(base, token.trim(), clientOptions).myself();
      sql.upsertToken.run(actor.user.id, box.seal(token.trim()), box.fingerprint, me.name, me.displayName, iso());
      sql.setUserJiraName.run(me.name, actor.user.id);
      return this.tokenStatus(actor);
    },

    deleteToken(actor: Actor): JiraTokenStatusDto {
      sql.deleteToken.run(actor.user.id);
      return this.tokenStatus(actor);
    },

    /** 관리자: 토큰이 없는 사람의 Jira 사용자를 짝짓는다(담당자 주고받기용) */
    setUserJiraName(userId: string, jiraName: unknown): void {
      if (jiraName !== null && (typeof jiraName !== 'string' || jiraName.trim() === '' || jiraName.length > 255)) {
        throw invalidInput('Jira 사용자(jiraName): Jira 아이디(name)를 넣거나 null로 지우세요.');
      }
      if (!sql.userJiraName.get(userId)) throw new ApiError(404, 'NOT_FOUND', `사용자가 없습니다: ${userId}`);
      sql.setUserJiraName.run(jiraName === null ? null : (jiraName as string).trim(), userId);
    },

    async searchUsers(actor: Actor, query: unknown) {
      if (typeof query !== 'string' || query.trim().length < 2) throw invalidInput('찾을 Jira 사용자를 두 글자 이상 넣으세요.');
      return clientFor(actor).searchUsers(query.trim());
    },

    /** 프로젝트를 읽기 전에: 마지막 조회 뒤 5분이 지났고 토큰이 있으면 먼저 가져온다. 실패해도 읽기는 막지 않는다 */
    async refreshIfStale(actor: Actor | undefined, projectId: string): Promise<void> {
      if (!actor || !hasToken(actor)) return;
      if (store.jiraLinkedTasks(projectId).length === 0) return;
      const last = store.jiraLastRefresh(projectId);
      if (last !== null && now() - last < REFRESH_AFTER_MS) return;
      try {
        await refresh(actor, projectId);
      } catch {
        // 이유는 프로젝트의 마지막 조회 오류로 남았다. 저장된 값으로 답한다.
      }
    },

    /** [Jira에서 새로고침]: 5분과 상관없이 바로 */
    async refresh(actor: Actor, projectId: string): Promise<void> {
      await refresh(actor, projectId);
    },

    /** 프로젝트 연결 설정에 쓸 Jira 정보(이슈 유형·상태·링크 유형)와 추천값 */
    async options(actor: Actor, jiraProjectKey: unknown) {
      if (typeof jiraProjectKey !== 'string' || !/^[A-Z][A-Z0-9_]+$/.test(jiraProjectKey.trim())) {
        throw invalidInput('Jira 프로젝트 키(예: ABC)를 넣으세요.');
      }
      const key = jiraProjectKey.trim();
      const client = clientFor(actor);
      const [issueTypes, statusesByType, linkTypes] = await Promise.all([client.issueTypes(key), client.projectStatuses(key), client.linkTypes()]);
      const statuses = new Map<string, JiraStatus>();
      for (const type of statusesByType) for (const status of type.statuses) if (!statuses.has(status.id)) statuses.set(status.id, status);
      const all = [...statuses.values()];
      const pick = (category: StatusCategory) => all.find((status) => status.category === category);
      const suggestion: ProjectJiraDto['statusMap'] = {};
      for (const status of ['todo', 'in-progress', 'done'] as const) {
        const found = pick(TEVRO_TO_CATEGORY[status]);
        if (found) suggestion[status] = { id: found.id, name: found.name };
      }
      const blocks = linkTypes.find((type) => /block/i.test(type.name) || /block/i.test(type.outward));
      return {
        projectKey: key,
        issueTypes: issueTypes.filter((type) => !type.subtask),
        statuses: all,
        linkTypes,
        suggested: { statusMap: suggestion, linkType: blocks?.name ?? null, issueTypeId: issueTypes.find((type) => !type.subtask)?.id ?? null },
      };
    },

    /** 프로젝트 연결 설정 저장(편집자 이상). Jira에 키가 있는지 확인한다 */
    async saveSettings(actor: Actor, projectId: string, input: Record<string, unknown>): Promise<void> {
      requireEnabled();
      const projectKey = input.projectKey === null ? null : typeof input.projectKey === 'string' ? input.projectKey.trim() : undefined;
      if (projectKey !== undefined && projectKey !== null && !/^[A-Z][A-Z0-9_]+$/.test(projectKey)) throw invalidInput('Jira 프로젝트 키(예: ABC)를 넣으세요.');
      let issueTypeName: string | null | undefined;
      const issueTypeId = input.issueTypeId === undefined ? undefined : input.issueTypeId === null ? null : String(input.issueTypeId);
      if (projectKey) {
        const types = await clientFor(actor).issueTypes(projectKey);
        if (issueTypeId) {
          const type = types.find((item) => item.id === issueTypeId);
          if (!type || type.subtask) throw invalidInput('이 Jira 프로젝트에서 만들 수 있는 이슈 유형이 아닙니다(하위 작업 유형은 고를 수 없습니다).');
          issueTypeName = type.name;
        }
      }
      let statusMap: ProjectJiraDto['statusMap'] | undefined;
      if (input.statusMap !== undefined) {
        if (typeof input.statusMap !== 'object' || input.statusMap === null) throw invalidInput('상태 짝(statusMap): 객체여야 합니다.');
        statusMap = {};
        for (const status of ['todo', 'in-progress', 'done'] as const) {
          const value = (input.statusMap as Record<string, unknown>)[status] as { id?: unknown; name?: unknown } | undefined;
          if (value === undefined || value === null) continue;
          if (typeof value.id !== 'string' || typeof value.name !== 'string') throw invalidInput(`상태 짝(${status}): {id, name}이어야 합니다.`);
          statusMap[status] = { id: value.id, name: value.name };
        }
      }
      const linkType = input.linkType === undefined ? undefined : input.linkType === null || input.linkType === '' ? null : String(input.linkType);
      store.saveJiraProjectSettings(projectId, {
        projectKey,
        issueTypeId: issueTypeId === undefined ? undefined : issueTypeId,
        issueTypeName: issueTypeId === undefined ? undefined : (issueTypeName ?? null),
        statusMap,
        linkType,
        ...(linkType !== undefined ? { linkReversed: false } : {}),
      });
    },

    /**
     * 공정을 고치기 전에(PATCH /tasks/:id). 연결된 공정의 상태·기한·담당자를 바꾸면 Jira에 먼저 반영한다.
     * 새로 이 사이트 이슈에 연결하면 그 이슈를 읽어 Tevro 값과 다르면 확인을 받는다.
     * 돌려준 함수는 Tevro에 저장한 뒤 부른다(방금 반영한 이슈를 다시 읽어 조회 결과로 남긴다).
     */
    async beforeTaskUpdate(actor: Actor | undefined, taskId: string, input: Record<string, unknown>): Promise<(() => Promise<void>) | null> {
      if (!site || !actor) return null;
      const projectId = store.projectIdOfTask(taskId);
      const before = store.getTask(taskId);
      const confirm = input.jiraConfirm === true;
      delete input.jiraConfirm;

      // 1) 연결할 이슈가 바뀌는 경우: 새 이슈를 읽어 다르면 확인
      if (input.jiraUrl !== undefined) {
        const url = typeof input.jiraUrl === 'string' ? input.jiraUrl.trim() : null;
        const newKey = url ? issueKeyOnSite(site, url) : null;
        if (newKey && newKey !== before.jira?.key) {
          if (!hasToken(actor)) return null; // 토큰이 없으면 연결만 하고, 다음 조회 때 Jira 값으로 바뀐다
          const client = clientFor(actor);
          const values = valuesOf(await client.issue(newKey));
          const differs =
            (values.status !== null && values.status !== before.status) || values.deadline !== before.deadline || values.assigneeId !== before.assigneeId;
          if (differs && !confirm) {
            throw new ApiError(409, 'JIRA_CHANGED', `${newKey}에 연결하면 상태·기한·담당자가 Jira 값으로 바뀝니다. 확인한 뒤 다시 저장하세요.`, { jira: values });
          }
          return async () => refreshOne(actor, projectId, taskId);
        }
        if (!newKey) return null;
      }

      // 2) 연결된 공정의 Jira 원본 값을 바꾸는 경우
      const linked = store.jiraLinkedTask(taskId);
      if (!linked) return null;
      const wants = {
        status: input.status !== undefined && input.status !== linked.status ? (input.status as TaskStatus) : undefined,
        deadline: input.deadline !== undefined && (input.deadline || null) !== linked.deadline ? ((input.deadline as string | null) || null) : undefined,
        assignee: input.assigneeId !== undefined && (input.assigneeId || null) !== linked.assigneeId ? ((input.assigneeId as string | null) || null) : undefined,
      };
      if (wants.status === undefined && wants.deadline === undefined && wants.assignee === undefined) return null;
      if (wants.status !== undefined && !['todo', 'in-progress', 'done'].includes(wants.status)) return null; // 형식 오류는 store가 낸다
      if (wants.deadline !== undefined && wants.deadline !== null && !/^\d{4}-\d{2}-\d{2}$/.test(wants.deadline)) return null;
      const client = clientFor(actor);

      // 덮어쓰기 확인: 마지막 조회 뒤 Jira에서 바뀌었으면 멈춘다
      const current = valuesOf(await client.issue(linked.key));
      const changedInJira =
        (wants.status !== undefined && current.status !== null && current.status !== linked.status) ||
        (wants.deadline !== undefined && current.deadline !== linked.deadline) ||
        (wants.assignee !== undefined && current.assigneeId !== linked.assigneeId);
      if (changedInJira && !confirm) {
        throw new ApiError(409, 'JIRA_CHANGED', `마지막 조회 뒤 Jira에서 ${linked.key}가 바뀌었습니다. 지금 Jira 값을 확인한 뒤 다시 저장하세요.`, { jira: current });
      }

      const fields: Record<string, unknown> = {};
      if (wants.deadline !== undefined) fields.duedate = wants.deadline;
      if (wants.assignee !== undefined) {
        if (wants.assignee === null) fields.assignee = null;
        else {
          const jiraName = sql.userJiraName.get(wants.assignee);
          if (!jiraName) throw invalidInput(`담당자로 지정할 사용자가 없습니다: ${wants.assignee}`);
          if (!jiraName.jira_name) {
            throw invalidInput(`${jiraName.display_name}은(는) Jira 사용자와 짝지어지지 않아 Jira 담당자로 넘길 수 없습니다. 본인이 Jira 토큰을 등록하거나 관리자가 짝지어 주세요.`);
          }
          fields.assignee = { name: jiraName.jira_name };
        }
      }
      if (Object.keys(fields).length > 0) await client.edit(linked.key, fields);
      if (wants.status !== undefined && current.status !== wants.status) {
        // 상태 짝은 프로젝트에 연결한 Jira 프로젝트의 이슈에만 쓴다. 다른 Jira 프로젝트 이슈면 그 프로젝트의 기본 상태로.
        const settings = store.jiraProjectSettings(projectId);
        const sameProject = settings.projectKey !== null && linked.key.startsWith(`${settings.projectKey}-`);
        const preferred = (sameProject ? settings.statusMap[wants.status] : undefined) ?? (await defaultStatusFor(client, linked.key, wants.status));
        await moveTo(client, linked.key, wants.status, preferred);
      }
      return async () => refreshOne(actor, projectId, taskId);
    },

    /** 이슈 키 모양인지(CLI·API 입력 확인용) */
    isIssueKey: (value: string) => ISSUE_KEY.test(value),

    clientFor,
    valuesOf,
    moveTo,
    hasToken,
  };

  /** 이슈 하나를 다시 읽어 반영한다(바꾼 직후·연결한 직후). 실패해도 저장은 이미 끝났으므로 조용히 둔다 */
  async function refreshOne(actor: Actor, projectId: string, taskId: string): Promise<void> {
    const linked = store.jiraLinkedTask(taskId);
    if (!linked) return;
    try {
      const issue = await clientFor(actor).issue(linked.key);
      store.applyJira(projectId, [issue], actor.user.displayName);
    } catch (error) {
      if (error instanceof ApiError) store.applyJira(projectId, [{ key: linked.key, error: error.message }], actor.user.displayName);
    }
  }
}

export type { LinkedTask };
