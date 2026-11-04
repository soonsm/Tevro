// Jira Data Center REST 어댑터(ADR-0001: SDK 없이 필요한 범위만, ADR-0009). 요청마다 그 사람의 개인 액세스 토큰(Bearer)을 쓴다.
// Jira의 응답을 Tevro에서 쓰는 모양으로 줄이고, 실패는 Tevro 오류 코드(JIRA_*)로 바꾼다. 토큰 값은 오류에 넣지 않는다.
import { ApiError } from './errors.ts';

export type StatusCategory = 'new' | 'indeterminate' | 'done';

export interface JiraUser {
  name: string;
  displayName: string;
}

export interface JiraIssue {
  key: string;
  summary: string;
  status: { id: string; name: string; category: StatusCategory | null };
  duedate: string | null;
  assignee: JiraUser | null;
}

export interface JiraStatus {
  id: string;
  name: string;
  category: StatusCategory | null;
}

export interface JiraTransition {
  id: string;
  name: string;
  to: JiraStatus;
}

export interface JiraIssueType {
  id: string;
  name: string;
  subtask: boolean;
}

export interface JiraField {
  fieldId: string;
  name: string;
  required: boolean;
  schema: { type: string; items?: string; custom?: string; system?: string };
  allowedValues?: { id: string; name?: string; value?: string }[];
  hasDefaultValue?: boolean;
  defaultValue?: unknown;
}

export interface JiraLinkType {
  id: string;
  name: string;
  inward: string;
  outward: string;
}

export interface JiraIssueLink {
  id: string;
  type: { name: string };
  /** 이 이슈에서 본 링크. outwardIssue가 있으면 '이 이슈 [outward] 그 이슈'다(예: 이 이슈 blocks 그 이슈) */
  inwardIssue?: { key: string };
  outwardIssue?: { key: string };
}

export interface JiraClientOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const ISSUE_FIELDS = ['summary', 'status', 'duedate', 'assignee'];

/** 이슈 키 모양(예: ABC-123) */
export const ISSUE_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;

/** 사이트 주소의 이슈 주소에서 키를 꺼낸다. 다른 사이트 주소면 null */
export function issueKeyOnSite(base: string, url: string): string | null {
  let site: URL;
  let target: URL;
  try {
    site = new URL(base);
    target = new URL(url);
  } catch {
    return null;
  }
  if (site.host !== target.host) return null;
  const sitePath = site.pathname.replace(/\/+$/, '');
  if (!target.pathname.startsWith(`${sitePath}/`)) return null;
  const key = /\/browse\/([A-Z][A-Z0-9_]+-\d+)\/?$/.exec(target.pathname)?.[1] ?? target.searchParams.get('selectedIssue');
  return key && ISSUE_KEY.test(key) ? key : null;
}

export function browseUrl(base: string, key: string): string {
  return `${base.replace(/\/+$/, '')}/browse/${key}`;
}

export function createJiraClient(base: string, token: string, options: JiraClientOptions = {}) {
  const root = base.replace(/\/+$/, '');
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;

  async function call<T>(method: string, path: string, body?: unknown, allow: number[] = []): Promise<{ status: number; data: T }> {
    let response: Response;
    try {
      response = await doFetch(`${root}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'manual',
      });
    } catch (error) {
      const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new ApiError(
        timeout ? 504 : 502,
        'JIRA_UNAVAILABLE',
        timeout ? `Jira가 ${Math.round(timeoutMs / 1000)}초 안에 답하지 않았습니다.` : `Jira에 접속하지 못했습니다(${root}).`,
        { timeout },
      );
    }
    const text = await response.text();
    let data: unknown = undefined;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = undefined;
      }
    }
    if (response.ok || allow.includes(response.status)) return { status: response.status, data: data as T };
    throw jiraError(response, data);
  }

  function jiraError(response: Response, data: unknown): ApiError {
    const messages = errorMessages(data);
    const reason = messages.length > 0 ? ` (${messages.join(' / ').slice(0, 500)})` : '';
    if (response.status === 401) {
      return new ApiError(424, 'JIRA_AUTH', 'Jira가 토큰을 받지 않았습니다. 토큰이 만료됐거나 폐기됐을 수 있습니다. 계정 메뉴의 [Jira 연결]에서 다시 등록하세요.');
    }
    if (response.status === 403) return new ApiError(424, 'JIRA_AUTH', `Jira에서 이 작업을 할 권한이 없습니다${reason}.`);
    if (response.status === 404) return new ApiError(424, 'JIRA_REJECTED', `Jira에서 찾을 수 없습니다${reason}.`, { jiraStatus: 404 });
    if (response.status === 429 || response.status === 503) {
      const retry = Number(response.headers.get('retry-after'));
      return new ApiError(502, 'JIRA_UNAVAILABLE', `Jira가 요청을 잠시 받지 않습니다${reason}.`, Number.isFinite(retry) && retry > 0 ? { retryAfter: retry } : {});
    }
    if (response.status >= 500) return new ApiError(502, 'JIRA_UNAVAILABLE', `Jira 서버 오류(${response.status})${reason}.`);
    if (response.status >= 300 && response.status < 400) {
      return new ApiError(502, 'JIRA_UNAVAILABLE', 'Jira가 다른 주소로 보냈습니다. TEVRO_JIRA_URL이 맞는지, SSO 로그인 페이지로 가지 않는지 확인하세요.');
    }
    return new ApiError(424, 'JIRA_REJECTED', `Jira가 요청을 거부했습니다${reason}.`, { jiraStatus: response.status, jiraMessages: messages });
  }

  const encode = encodeURIComponent;

  return {
    async myself(): Promise<JiraUser & { key: string; emailAddress: string | null }> {
      const { data } = await call<{ name: string; key: string; displayName: string; emailAddress?: string }>('GET', '/rest/api/2/myself');
      return { name: data.name, key: data.key, displayName: data.displayName ?? data.name, emailAddress: data.emailAddress ?? null };
    },

    /** 키 목록의 이슈(100개씩). 없거나 볼 수 없는 키는 missing으로 돌려준다(JQL은 그런 키가 하나라도 있으면 통째로 실패한다). */
    async issuesByKeys(keys: string[]): Promise<{ issues: JiraIssue[]; missing: string[] }> {
      const issues: JiraIssue[] = [];
      const missing: string[] = [];
      for (let at = 0; at < keys.length; at += 100) {
        let batch = keys.slice(at, at + 100);
        for (let attempt = 0; attempt < 3 && batch.length > 0; attempt += 1) {
          const { status, data } = await call<{ issues?: RawIssue[]; errorMessages?: string[] }>(
            'POST',
            '/rest/api/2/search',
            { jql: `key in (${batch.join(',')})`, fields: ISSUE_FIELDS, maxResults: batch.length, validateQuery: 'warn' },
            [400],
          );
          if (status === 200) {
            const found = (data.issues ?? []).map(toIssue);
            issues.push(...found);
            const foundKeys = new Set(found.map((issue) => issue.key));
            missing.push(...batch.filter((key) => !foundKeys.has(key)));
            batch = [];
            break;
          }
          const bad = batch.filter((key) => (data.errorMessages ?? []).some((message) => message.includes(`'${key}'`)));
          if (bad.length === 0) throw jiraError(new Response(null, { status: 400 }), data);
          missing.push(...bad);
          batch = batch.filter((key) => !bad.includes(key));
        }
      }
      return { issues, missing };
    },

    async issue(key: string): Promise<JiraIssue> {
      const { data } = await call<RawIssue>('GET', `/rest/api/2/issue/${encode(key)}?fields=${ISSUE_FIELDS.join(',')}`);
      return toIssue(data);
    },

    async transitions(key: string): Promise<JiraTransition[]> {
      const { data } = await call<{ transitions: { id: string; name: string; to: RawStatus }[] }>('GET', `/rest/api/2/issue/${encode(key)}/transitions`);
      return data.transitions.map((item) => ({ id: item.id, name: item.name, to: toStatus(item.to) }));
    },

    async transition(key: string, transitionId: string): Promise<void> {
      await call('POST', `/rest/api/2/issue/${encode(key)}/transitions`, { transition: { id: transitionId } });
    },

    async edit(key: string, fields: Record<string, unknown>): Promise<void> {
      await call('PUT', `/rest/api/2/issue/${encode(key)}?notifyUsers=true`, { fields });
    },

    /** 프로젝트의 이슈 유형별 상태 목록 */
    async projectStatuses(projectKey: string): Promise<{ issueTypeId: string; issueTypeName: string; statuses: JiraStatus[] }[]> {
      const { data } = await call<{ id: string; name: string; statuses: RawStatus[] }[]>('GET', `/rest/api/2/project/${encode(projectKey)}/statuses`);
      return data.map((item) => ({ issueTypeId: item.id, issueTypeName: item.name, statuses: item.statuses.map(toStatus) }));
    },

    async issueTypes(projectKey: string): Promise<JiraIssueType[]> {
      const { data } = await call<{ values: { id: string; name: string; subtask?: boolean }[] }>(
        'GET',
        `/rest/api/2/issue/createmeta/${encode(projectKey)}/issuetypes?maxResults=100`,
      );
      return data.values.map((item) => ({ id: item.id, name: item.name, subtask: item.subtask === true }));
    },

    async createFields(projectKey: string, issueTypeId: string): Promise<JiraField[]> {
      const { data } = await call<{ values: JiraField[] }>(
        'GET',
        `/rest/api/2/issue/createmeta/${encode(projectKey)}/issuetypes/${encode(issueTypeId)}?maxResults=200`,
      );
      return data.values;
    },

    async createIssue(fields: Record<string, unknown>): Promise<{ id: string; key: string }> {
      const { data } = await call<{ id: string; key: string }>('POST', '/rest/api/2/issue', { fields });
      return { id: data.id, key: data.key };
    },

    async linkTypes(): Promise<JiraLinkType[]> {
      const { data } = await call<{ issueLinkTypes: JiraLinkType[] }>('GET', '/rest/api/2/issueLinkType');
      return data.issueLinkTypes.map(({ id, name, inward, outward }) => ({ id, name, inward, outward }));
    },

    async createLink(typeName: string, inwardKey: string, outwardKey: string): Promise<void> {
      await call('POST', '/rest/api/2/issueLink', { type: { name: typeName }, inwardIssue: { key: inwardKey }, outwardIssue: { key: outwardKey } });
    },

    async issueLinks(key: string): Promise<JiraIssueLink[]> {
      const { data } = await call<{ fields: { issuelinks?: JiraIssueLink[] } }>('GET', `/rest/api/2/issue/${encode(key)}?fields=issuelinks`);
      return data.fields.issuelinks ?? [];
    },

    async deleteLink(linkId: string): Promise<void> {
      await call('DELETE', `/rest/api/2/issueLink/${encode(linkId)}`);
    },

    async searchUsers(query: string): Promise<(JiraUser & { emailAddress: string | null })[]> {
      const { data } = await call<{ name: string; displayName: string; emailAddress?: string }[]>(
        'GET',
        `/rest/api/2/user/search?username=${encode(query)}&maxResults=20`,
      );
      return data.map((user) => ({ name: user.name, displayName: user.displayName, emailAddress: user.emailAddress ?? null }));
    },

    /** 응답을 받지 못한 생성을 찾는다: 같은 프로젝트, 같은 제목, 내가 보고자, 최근 하루 */
    async findRecentlyCreated(projectKey: string, summary: string): Promise<string[]> {
      const quoted = summary.replace(/["\\]/g, ' ').trim();
      const { data } = await call<{ issues?: RawIssue[] }>('POST', '/rest/api/2/search', {
        jql: `project = "${projectKey}" AND reporter = currentUser() AND created >= -1d AND summary ~ "\\"${quoted}\\"" ORDER BY created DESC`,
        fields: ['summary'],
        maxResults: 10,
      });
      return (data.issues ?? []).filter((issue) => (issue.fields.summary ?? '').trim() === summary.trim()).map((issue) => issue.key);
    },
  };
}

export type JiraClient = ReturnType<typeof createJiraClient>;

interface RawStatus {
  id: string;
  name: string;
  statusCategory?: { key?: string };
}

interface RawIssue {
  key: string;
  fields: {
    summary?: string;
    status?: RawStatus;
    duedate?: string | null;
    assignee?: { name: string; displayName?: string } | null;
  };
}

function toStatus(raw: RawStatus): JiraStatus {
  const key = raw.statusCategory?.key;
  return { id: String(raw.id), name: raw.name, category: key === 'new' || key === 'indeterminate' || key === 'done' ? key : null };
}

function toIssue(raw: RawIssue): JiraIssue {
  return {
    key: raw.key,
    summary: raw.fields.summary ?? '',
    status: raw.fields.status ? toStatus(raw.fields.status) : { id: '', name: '', category: null },
    duedate: raw.fields.duedate ?? null,
    assignee: raw.fields.assignee ? { name: raw.fields.assignee.name, displayName: raw.fields.assignee.displayName ?? raw.fields.assignee.name } : null,
  };
}

function errorMessages(data: unknown): string[] {
  if (!data || typeof data !== 'object') return [];
  const value = data as { errorMessages?: unknown; errors?: unknown };
  const list = Array.isArray(value.errorMessages) ? value.errorMessages.map(String) : [];
  if (value.errors && typeof value.errors === 'object') {
    for (const [field, message] of Object.entries(value.errors as Record<string, unknown>)) list.push(`${field}: ${String(message)}`);
  }
  return list;
}
