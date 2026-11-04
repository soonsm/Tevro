// 시험용 가짜 Jira Data Center. Tevro가 쓰는 REST 경로만 흉내 낸다(ADR-0009).
// 상태: 열림(할 일) → 진행 중 → 검토 중 → 완료, 어디서나 안 함(완료 분류). 열림에서 완료로 바로 가는 전환은 없다.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeIssue {
  key: string;
  id: string;
  project: string;
  summary: string;
  description: string;
  issuetype: string;
  statusId: string;
  duedate: string | null;
  assignee: string | null;
  reporter: string;
  fields: Record<string, unknown>;
}

export interface FakeLink {
  id: string;
  type: string;
  /** 실제 Jira에서 'outward 이슈 [outward 설명] inward 이슈'가 아니라, 요청 그대로 저장한다 */
  inward: string;
  outward: string;
}

export const STATUSES = {
  open: { id: '1', name: '열림', statusCategory: { key: 'new' } },
  progress: { id: '3', name: '진행 중', statusCategory: { key: 'indeterminate' } },
  review: { id: '10', name: '검토 중', statusCategory: { key: 'indeterminate' } },
  done: { id: '5', name: '완료', statusCategory: { key: 'done' } },
  wontdo: { id: '6', name: '안 함', statusCategory: { key: 'done' } },
};
const BY_ID = new Map(Object.values(STATUSES).map((status) => [status.id, status]));
// 상태 id → [전환 id, 도착 상태 id]
const WORKFLOW: Record<string, [string, string][]> = {
  '1': [['11', '3'], ['61', '6']],
  '3': [['21', '10'], ['12', '1'], ['61', '6']],
  '10': [['51', '5'], ['31', '3'], ['61', '6']],
  '5': [['71', '1']],
  '6': [['71', '1']],
};

export interface FakeJira {
  url: string;
  issues: Map<string, FakeIssue>;
  links: FakeLink[];
  users: Map<string, { name: string; displayName: string }>;
  /** 요청 기록(메서드 경로) */
  calls: string[];
  /** 다음 요청 하나를 이 상태 코드로 실패시킨다(경로에 포함된 문자열 조건) */
  failNext(match: string, status: number, body?: unknown): void;
  /** 다음 요청 하나를 답하지 않고 끊는다(시간 초과 흉내) */
  hangNext(match: string): void;
  /** 링크 방향 해석을 실제와 반대로 흉내 낸다 */
  linkReversed: boolean;
  /** createIssue의 사이트 필수 필드 */
  requiredNumberField: { id: string; name: string } | null;
  addIssue(input: Partial<FakeIssue> & { key: string }): FakeIssue;
  close(): Promise<void>;
}

export async function startFakeJira(): Promise<FakeJira> {
  const issues = new Map<string, FakeIssue>();
  const links: FakeLink[] = [];
  const users = new Map<string, { name: string; displayName: string }>([
    ['token-kim', { name: 'kim.jira', displayName: 'Kim Jira' }],
    ['token-lee', { name: 'lee.jira', displayName: 'Lee Jira' }],
  ]);
  const people = [
    { name: 'kim.jira', displayName: 'Kim Jira' },
    { name: 'lee.jira', displayName: 'Lee Jira' },
    { name: 'outsider', displayName: 'Outsider' },
  ];
  const calls: string[] = [];
  const failures: { match: string; status: number; body?: unknown }[] = [];
  const hangs: string[] = [];
  let nextId = 10000;
  let nextLink = 1;
  const fake: FakeJira = {
    url: '',
    issues,
    links,
    users,
    calls,
    requiredNumberField: { id: 'customfield_10106', name: 'Story Points' },
    linkReversed: false,
    failNext: (match, status, body) => void failures.push({ match, status, body }),
    hangNext: (match) => void hangs.push(match),
    addIssue(input) {
      const issue: FakeIssue = {
        id: String(nextId++),
        project: input.key.split('-')[0],
        summary: input.key,
        description: '',
        issuetype: '10001',
        statusId: STATUSES.open.id,
        duedate: null,
        assignee: null,
        reporter: 'kim.jira',
        fields: {},
        ...input,
      };
      issues.set(issue.key, issue);
      return issue;
    },
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };

  const view = (issue: FakeIssue) => ({
    id: issue.id,
    key: issue.key,
    fields: {
      summary: issue.summary,
      status: BY_ID.get(issue.statusId),
      duedate: issue.duedate,
      assignee: issue.assignee ? people.find((person) => person.name === issue.assignee) ?? { name: issue.assignee, displayName: issue.assignee } : null,
      issuelinks: links
        .filter((link) => link.inward === issue.key || link.outward === issue.key)
        .map((link) =>
          // 이 가짜는 요청의 inwardIssue=X, outwardIssue=Y를 'X [outward 설명] Y'(예: X blocks Y)로 저장한다.
          // linkReversed면 반대('Y [outward 설명] X')로 저장한다. Tevro는 만든 뒤 읽어서 방향을 확인하므로 둘 다 맞게 동작해야 한다.
          (fake.linkReversed ? link.outward === issue.key : link.inward === issue.key) 
            ? { id: link.id, type: { name: link.type }, outwardIssue: { key: fake.linkReversed ? link.inward : link.outward } }
            : { id: link.id, type: { name: link.type }, inwardIssue: { key: fake.linkReversed ? link.outward : link.inward } },
        ),
    },
  });

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    calls.push(`${req.method} ${path}`);
    const send = (status: number, body?: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    const hang = hangs.findIndex((match) => `${req.method} ${path}`.includes(match));
    if (hang !== -1) {
      hangs.splice(hang, 1);
      return; // 답하지 않는다
    }
    const failure = failures.findIndex((item) => `${req.method} ${path}`.includes(item.match));
    if (failure !== -1) {
      const [item] = failures.splice(failure, 1);
      return send(item.status, item.body ?? { errorMessages: [`가짜 실패 ${item.status}`] });
    }
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    const me = token ? users.get(token) : undefined;
    if (!me) return send(401, { errorMessages: ['You are not authenticated.'] });
    const body = await readBody(req);
    const issueMatch = /^\/rest\/api\/2\/issue\/([A-Z][A-Z0-9_]+-\d+)(\/transitions)?$/.exec(path);

    if (req.method === 'GET' && path === '/rest/api/2/myself') return send(200, { ...me, key: `JIRAUSER${me.name.length}`, emailAddress: `${me.name}@example.com` });
    if (req.method === 'POST' && path === '/rest/api/2/search') {
      const jql = String(body.jql ?? '');
      const keys = /key in \(([^)]*)\)/.exec(jql)?.[1].split(',').map((key) => key.trim()).filter(Boolean);
      if (keys) {
        const missing = keys.filter((key) => !issues.has(key));
        if (missing.length > 0) return send(400, { errorMessages: missing.map((key) => `An issue with key '${key}' does not exist for field 'key'.`) });
        return send(200, { issues: keys.map((key) => view(issues.get(key)!)) });
      }
      const project = /project = "([^"]+)"/.exec(jql)?.[1];
      const summary = /summary ~ "\\"(.*)\\""/.exec(jql)?.[1];
      const found = [...issues.values()].filter((issue) => issue.project === project && issue.reporter === me.name && (!summary || issue.summary.includes(summary)));
      return send(200, { issues: found.reverse().map(view) });
    }
    if (issueMatch && !issueMatch[2]) {
      const issue = issues.get(issueMatch[1]);
      if (!issue) return send(404, { errorMessages: ['Issue Does Not Exist'] });
      if (req.method === 'GET') return send(200, view(issue));
      if (req.method === 'PUT') {
        const fields = (body.fields ?? {}) as Record<string, unknown>;
        if ('duedate' in fields) issue.duedate = (fields.duedate as string | null) ?? null;
        if ('assignee' in fields) {
          const name = (fields.assignee as { name?: string } | null)?.name ?? null;
          if (name && !people.some((person) => person.name === name)) return send(400, { errors: { assignee: `User '${name}' does not exist.` } });
          issue.assignee = name;
        }
        return send(204);
      }
    }
    if (issueMatch && issueMatch[2]) {
      const issue = issues.get(issueMatch[1]);
      if (!issue) return send(404, { errorMessages: ['Issue Does Not Exist'] });
      const options = (WORKFLOW[issue.statusId] ?? []).map(([id, to]) => ({ id, name: `→ ${BY_ID.get(to)!.name}`, to: BY_ID.get(to) }));
      if (req.method === 'GET') return send(200, { transitions: options });
      const wanted = String((body.transition as { id?: string })?.id ?? '');
      const option = (WORKFLOW[issue.statusId] ?? []).find(([id]) => id === wanted);
      if (!option) return send(400, { errorMessages: [`Transition id '${wanted}' is not valid for this issue.`] });
      issue.statusId = option[1];
      return send(204);
    }
    const statusesMatch = /^\/rest\/api\/2\/project\/([A-Z0-9_]+)\/statuses$/.exec(path);
    if (req.method === 'GET' && statusesMatch) {
      if (statusesMatch[1] !== 'ABC') return send(404, { errorMessages: [`No project could be found with key '${statusesMatch[1]}'.`] });
      const all = Object.values(STATUSES);
      return send(200, [
        { id: '10001', name: '작업', statuses: all },
        { id: '10002', name: '이야기', statuses: all },
        { id: '10003', name: '하위 작업', statuses: all },
      ]);
    }
    const metaMatch = /^\/rest\/api\/2\/issue\/createmeta\/([A-Z0-9_]+)\/issuetypes(?:\/(\d+))?$/.exec(path);
    if (req.method === 'GET' && metaMatch) {
      if (metaMatch[1] !== 'ABC') return send(404, { errorMessages: ['No project'] });
      if (!metaMatch[2]) {
        return send(200, {
          values: [
            { id: '10001', name: '작업', subtask: false },
            { id: '10002', name: '이야기', subtask: false },
            { id: '10003', name: '하위 작업', subtask: true },
          ],
        });
      }
      const values: unknown[] = [
        { fieldId: 'summary', name: '요약', required: true, schema: { type: 'string', system: 'summary' } },
        { fieldId: 'issuetype', name: '이슈 유형', required: true, schema: { type: 'issuetype', system: 'issuetype' } },
        { fieldId: 'project', name: '프로젝트', required: true, schema: { type: 'project', system: 'project' } },
        { fieldId: 'reporter', name: '보고자', required: true, schema: { type: 'user', system: 'reporter' } },
        { fieldId: 'description', name: '설명', required: false, schema: { type: 'string', system: 'description' } },
        { fieldId: 'duedate', name: '기한', required: false, schema: { type: 'date', system: 'duedate' } },
        { fieldId: 'assignee', name: '담당자', required: false, schema: { type: 'user', system: 'assignee' } },
      ];
      if (fake.requiredNumberField) {
        values.push({
          fieldId: fake.requiredNumberField.id,
          name: fake.requiredNumberField.name,
          required: true,
          schema: { type: 'number', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:float' },
          hasDefaultValue: true,
          defaultValue: 0,
        });
      }
      if (metaMatch[2] === '10002') {
        values.push({
          fieldId: 'customfield_20000',
          name: '난이도',
          required: true,
          schema: { type: 'option', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:select' },
          allowedValues: [
            { id: '1', value: '쉬움' },
            { id: '2', value: '어려움' },
          ],
        });
      }
      return send(200, { values });
    }
    if (req.method === 'POST' && path === '/rest/api/2/issue') {
      const fields = (body.fields ?? {}) as Record<string, unknown>;
      const project = (fields.project as { key?: string })?.key;
      if (project !== 'ABC') return send(400, { errors: { project: 'project is required' } });
      if (!fields.summary) return send(400, { errors: { summary: 'You must specify a summary of the issue.' } });
      if (fake.requiredNumberField && typeof fields[fake.requiredNumberField.id] !== 'number') {
        return send(400, { errors: { [fake.requiredNumberField.id]: `${fake.requiredNumberField.name} is required.` } });
      }
      const issuetype = (fields.issuetype as { id?: string })?.id ?? '';
      if (issuetype === '10002' && !(fields.customfield_20000 as { id?: string })?.id) return send(400, { errors: { customfield_20000: '난이도 is required.' } });
      const key = `ABC-${issues.size + 1}`;
      fake.addIssue({
        key,
        summary: String(fields.summary),
        description: String(fields.description ?? ''),
        issuetype,
        duedate: (fields.duedate as string | undefined) ?? null,
        assignee: (fields.assignee as { name?: string } | undefined)?.name ?? null,
        reporter: (fields.reporter as { name?: string } | undefined)?.name ?? me.name,
        fields,
      });
      return send(201, { id: issues.get(key)!.id, key, self: `${fake.url}/rest/api/2/issue/${key}` });
    }
    if (req.method === 'GET' && path === '/rest/api/2/issueLinkType') {
      return send(200, {
        issueLinkTypes: [
          { id: '1', name: 'Relates', inward: 'relates to', outward: 'relates to' },
          { id: '2', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
        ],
      });
    }
    if (req.method === 'POST' && path === '/rest/api/2/issueLink') {
      const inward = (body.inwardIssue as { key?: string })?.key ?? '';
      const outward = (body.outwardIssue as { key?: string })?.key ?? '';
      if (!issues.has(inward) || !issues.has(outward)) return send(404, { errorMessages: ['Issue not found'] });
      links.push({ id: String(nextLink++), type: String((body.type as { name?: string })?.name), inward, outward });
      return send(201);
    }
    const linkDelete = /^\/rest\/api\/2\/issueLink\/(\d+)$/.exec(path);
    if (req.method === 'DELETE' && linkDelete) {
      const index = links.findIndex((link) => link.id === linkDelete[1]);
      if (index === -1) return send(404);
      links.splice(index, 1);
      return send(204);
    }
    if (req.method === 'GET' && path === '/rest/api/2/user/search') {
      const q = (url.searchParams.get('username') ?? '').toLowerCase();
      return send(200, people.filter((person) => person.name.includes(q) || person.displayName.toLowerCase().includes(q)));
    }
    send(404, { errorMessages: [`가짜 Jira에 없는 경로: ${req.method} ${path}`] });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/jira`;
  // 사이트가 하위 경로(/jira)에 있는 경우도 흉내 낸다
  const handler = server.listeners('request')[0] as (req: IncomingMessage, res: unknown) => void;
  server.removeAllListeners('request');
  server.on('request', (req: IncomingMessage, res) => {
    if (req.url?.startsWith('/jira/')) req.url = req.url.slice('/jira'.length);
    handler(req, res);
  });
  return fake;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}
