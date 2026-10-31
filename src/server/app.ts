import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { POLICY, type Accounts, type Actor } from './accounts.ts';
import { ApiError, internalError, invalidInput } from './errors.ts';
import type { Store } from './store.ts';
import { readSandboxId, type Sandbox, type Trial } from './trial.ts';

const MAX_BODY_BYTES = 1_000_000;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

// 외부 출처의 스크립트·스타일·글꼴 요청을 막아, 폐쇄망 요구(N-02) 위반이 브라우저 오류로 드러나게 한다(ADR-0002).
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const SESSION_COOKIE = 'tevro_session';

/**
 * 경로마다 필요한 권한(ADR-0004). 체험 모드는 로그인이 없어 모두 열려 있다.
 * - public: 로그인 없이
 * - read: 로그인한 누구나(세션 또는 토큰)
 * - write: 편집자·관리자이고, 토큰이면 read-write 범위
 * - session: 웹 세션으로 로그인한 누구나. 토큰 발급처럼 토큰으로 하면 안 되는 일
 * - admin: 웹 세션으로 로그인한 관리자
 */
type Access = 'public' | 'read' | 'write' | 'session' | 'admin';

interface Request {
  params: Record<string, string>;
  query: URLSearchParams;
  body: Record<string, unknown>;
  store: Store;
  /** 로그인한 사람(체험 모드와 public 경로에서는 없음) */
  actor?: Actor;
  /** 응답에 붙일 Set-Cookie */
  setCookie: (value: string) => void;
  /** 요청이 HTTPS로 들어왔는지(Caddy 같은 프록시 뒤면 X-Forwarded-Proto) */
  secure: boolean;
  /** 체험 모드에서 요청을 보낸 창의 체험 ID와 사본 */
  sandboxId?: string;
  sandbox?: Sandbox;
}

type Result = { status?: number; body: unknown };

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  access: Access;
  handle: (request: Request) => Result | Promise<Result>;
}

interface AppOptions {
  /** 데이터를 둘 저장소. 체험 모드면 대신 trial을 넘긴다 */
  store?: Store;
  /** 사용자·세션·토큰. store와 함께 넘긴다 */
  accounts?: Accounts;
  /** 체험 모드: 창마다 예시 데이터의 사본을 쓴다(src/server/trial.ts) */
  trial?: Trial;
  webRoot?: string;
}

/** API(/api/v1)와 웹 정적 파일을 함께 제공하는 서버. GUI와 CLI는 같은 API만 쓴다(PRD 원칙 7). */
export function createApp({ store, accounts, trial, webRoot }: AppOptions): Server {
  if ((store === undefined) === (trial === undefined)) throw new Error('store와 trial 중 하나만 넘깁니다.');
  if (store && !accounts) throw new Error('store를 넘길 때는 accounts도 넘깁니다.');

  const routes: Route[] = [
    route('GET', '/api/v1/projects', 'read', ({ store }) => ({ body: store.listProjects() })),
    route('POST', '/api/v1/projects', 'write', ({ store, body }) => ({ status: 201, body: store.createProject(body) })),
    route('GET', '/api/v1/projects/:projectId/graph', 'read', ({ store, params }) => ({ body: store.getGraph(params.projectId) })),
    route('POST', '/api/v1/projects/:projectId/tasks', 'write', ({ store, params, body }) => ({
      status: 201,
      body: store.createTask(params.projectId, body),
    })),
    route('POST', '/api/v1/projects/:projectId/dependencies', 'write', ({ store, params, body }) => ({
      status: 201,
      body: store.addDependency(params.projectId, body),
    })),
    route('DELETE', '/api/v1/projects/:projectId/dependencies', 'write', ({ store, params, query }) => ({
      body: store.removeDependency(params.projectId, {
        from: query.get('from') ?? undefined,
        to: query.get('to') ?? undefined,
      }),
    })),
    route('GET', '/api/v1/tasks/:taskId', 'read', ({ store, params }) => ({ body: store.getTask(params.taskId) })),
    route('PATCH', '/api/v1/tasks/:taskId', 'write', ({ store, params, body }) => ({ body: store.updateTask(params.taskId, body) })),
    route('POST', '/api/v1/tasks/:taskId/move', 'write', ({ store, params, body }) => ({ body: store.moveTask(params.taskId, body) })),
    route('DELETE', '/api/v1/tasks/:taskId', 'write', ({ store, params }) => ({ body: store.deleteTask(params.taskId) })),
  ];
  if (accounts) routes.push(...accountRoutes(accounts));
  if (!trial) {
    // 화면이 체험 모드인지 물을 때 콘솔에 404 오류가 남지 않게, 체험 모드가 아니면 내용 없이 답한다.
    routes.push(route('GET', '/api/v1/trial', 'public', () => ({ status: 204, body: undefined })));
  } else {
    routes.push(
      route('GET', '/api/v1/trial', 'public', ({ sandbox }) => ({ body: trial.status(sandbox!) })),
      route('POST', '/api/v1/trial/reset', 'public', ({ sandboxId, body }) => {
        if (typeof body.dataset !== 'string') throw invalidInput('불러올 예시 데이터(dataset)를 지정하세요.');
        return { body: trial.status(trial.reset(sandboxId!, body.dataset)) };
      }),
    );
  }

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/healthz') {
        if (req.method !== 'GET') throw new ApiError(404, 'NOT_FOUND', `API 경로가 없습니다: ${req.method} ${url.pathname}`);
        sendJson(res, 200, { status: 'ok' });
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url);
      } else {
        await serveStatic(res, url.pathname);
      }
    } catch (error) {
      sendProblem(res, error);
    }
  });

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    for (const { method, pattern, keys, access, handle } of routes) {
      const match = method === req.method ? pattern.exec(url.pathname) : null;
      if (!match) continue;
      const params = Object.fromEntries(keys.map((key, index) => [key, decodePath(match[index + 1])]));
      // 권한을 본문보다 먼저 본다. 로그인하지 않은 요청의 본문은 읽지 않는다(ADR-0006 검사 순서).
      const actor = accounts && access !== 'public' ? authorize(req, url, accounts, access) : undefined;
      const body = await readJsonBody(req);
      // 체험 모드면 요청을 보낸 창의 사본을, 아니면 하나뿐인 저장소를 쓴다. 본문을 다 읽은 뒤에 고르므로
      // 그사이 같은 창이 예시 데이터를 다시 불러와도 지워진 사본을 쓰지 않는다.
      const sandboxId = trial ? readSandboxId(req.headers['x-tevro-sandbox']) : undefined;
      const sandbox = trial ? trial.sandbox(sandboxId!, headerValue(req.headers['x-tevro-dataset'])) : undefined;
      const cookies: string[] = [];
      const result = await handle({
        params,
        query: url.searchParams,
        body,
        store: sandbox ? sandbox.store : store!,
        actor,
        setCookie: (value) => cookies.push(value),
        secure: isSecure(req),
        sandboxId,
        sandbox,
      });
      if (sandbox && req.method !== 'GET' && !url.pathname.startsWith('/api/v1/trial')) sandbox.dirty = true;
      if (cookies.length > 0) res.setHeader('set-cookie', cookies);
      sendJson(res, result.status ?? 200, result.body);
      return;
    }
    throw new ApiError(404, 'NOT_FOUND', `API 경로가 없습니다: ${req.method} ${url.pathname}`);
  }

  async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
    const root = webRoot ? resolve(webRoot) : null;
    const requested = root ? resolve(root, `.${safeDecode(pathname) ?? '/'}`) : null;
    const insideRoot = root && requested && requested.startsWith(root + sep);
    // 화면 주소(예: /?project=…)는 모두 index.html로 돌려 SPA가 처리한다.
    const file = insideRoot && (await isFile(requested)) ? requested : root && join(root, 'index.html');
    if (!file || !(await isFile(file))) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('웹 화면이 빌드되지 않았습니다. 먼저 npm run build를 실행하세요.');
      return;
    }
    const hashedAsset = root !== null && file.startsWith(join(root, 'assets') + sep);
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': hashedAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
      'content-security-policy': CONTENT_SECURITY_POLICY,
      'x-content-type-options': 'nosniff',
    });
    res.end(await readFile(file));
  }
}

function route(method: string, path: string, access: Access, handle: Route['handle']): Route {
  const keys: string[] = [];
  const source = path.replace(/:(\w+)/g, (_, key: string) => {
    keys.push(key);
    return '([^/]+)';
  });
  return { method, pattern: new RegExp(`^${source}$`), keys, access, handle };
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new ApiError(413, 'VALIDATION_INPUT', '요청 본문이 너무 큽니다.');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(400, 'VALIDATION_INPUT', '요청 본문이 올바른 JSON이 아닙니다.');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ApiError(400, 'VALIDATION_INPUT', '요청 본문은 JSON 객체여야 합니다.');
  }
  return body as Record<string, unknown>;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function decodePath(segment: string): string {
  const decoded = safeDecode(segment);
  if (decoded === null) throw new ApiError(400, 'VALIDATION_INPUT', `주소를 해석할 수 없습니다: ${segment}`);
  return decoded;
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (status === 204) {
    res.writeHead(204, { 'cache-control': 'no-store' });
    res.end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendProblem(res: ServerResponse, error: unknown): void {
  if (!(error instanceof ApiError)) console.error(error);
  const problem = (error instanceof ApiError ? error : internalError()).toProblem();
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(problem.status, { 'content-type': 'application/problem+json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(problem));
}

/** 사용자·로그인·토큰 API. 토큰 발급과 사용자 관리는 웹 세션으로만 한다(에이전트가 토큰으로 새 토큰을 만들지 못하게). */
function accountRoutes(accounts: Accounts): Route[] {
  return [
    route('GET', '/api/v1/auth/config', 'public', () => ({ body: { providers: accounts.providers() } })),
    route('POST', '/api/v1/auth/login', 'public', async ({ body, setCookie, secure }) => {
      const { user, cookie, csrfToken } = await accounts.login(body);
      setCookie(sessionCookie(cookie, secure, Math.floor(POLICY.sessionMaxMs / 1000)));
      return { body: { user, csrfToken } };
    }),
    route('POST', '/api/v1/auth/logout', 'session', ({ actor, setCookie, secure }) => {
      accounts.logout(actor!);
      setCookie(sessionCookie('', secure, 0));
      return { status: 204, body: undefined };
    }),
    route('GET', '/api/v1/auth/me', 'read', ({ actor }) => ({
      body: { user: actor!.user, ...(actor!.csrfToken ? { csrfToken: actor!.csrfToken } : {}), ...(actor!.token ? { token: actor!.token } : {}) },
    })),
    route('POST', '/api/v1/auth/password', 'session', async ({ actor, body }) => {
      await accounts.changeOwnPassword(actor!, body.currentPassword, body.newPassword);
      return { status: 204, body: undefined };
    }),
    route('GET', '/api/v1/tokens', 'session', ({ actor }) => ({ body: accounts.listTokens(actor!.user.id) })),
    route('POST', '/api/v1/tokens', 'session', ({ actor, body }) => ({ status: 201, body: accounts.createToken(actor!, body) })),
    route('DELETE', '/api/v1/tokens/:tokenId', 'session', ({ actor, params }) => ({ body: accounts.revokeToken(actor!, params.tokenId) })),
    route('GET', '/api/v1/users', 'admin', () => ({ body: accounts.listUsers() })),
    route('POST', '/api/v1/users', 'admin', async ({ body }) => ({ status: 201, body: await accounts.createUser(body) })),
    route('PATCH', '/api/v1/users/:userId', 'admin', ({ params, body }) => ({ body: accounts.updateUser(params.userId, body) })),
    route('POST', '/api/v1/users/:userId/password', 'admin', async ({ params, body }) => {
      await accounts.setPassword(params.userId, body.password);
      return { status: 204, body: undefined };
    }),
    route('GET', '/api/v1/users/:userId/tokens', 'admin', ({ params }) => ({ body: accounts.listTokens(accounts.getUser(params.userId).id) })),
  ];
}

/**
 * 세션 쿠키 또는 Authorization: Bearer 토큰으로 사람을 찾고 권한을 본다.
 * 세션으로 상태를 바꾸는 요청은 CSRF 값(x-tevro-csrf)과 출처(Origin)를 확인한다. 토큰 요청은 쿠키를 쓰지 않으므로 CSRF 대상이 아니다.
 */
function authorize(req: IncomingMessage, url: URL, accounts: Accounts, access: Access): Actor {
  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '');
  let actor: Actor | null;
  if (bearer) {
    actor = accounts.authenticateToken(bearer[1]);
    // 받은 토큰 값은 오류에 되돌려 보내지 않는다(AC-20).
    if (!actor) throw new ApiError(401, 'UNAUTHENTICATED', '토큰이 올바르지 않거나 만료·폐기되었습니다. 웹 화면에서 새 토큰을 발급하세요.');
  } else {
    const cookie = readCookie(req.headers.cookie, SESSION_COOKIE);
    actor = cookie ? accounts.authenticateSession(cookie) : null;
    if (!actor) throw new ApiError(401, 'UNAUTHENTICATED', '로그인이 필요합니다.');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = headerValue(req.headers.origin);
      if (origin && hostOf(origin) !== (req.headers.host ?? url.host)) {
        throw new ApiError(403, 'FORBIDDEN', '다른 사이트에서 보낸 요청은 받지 않습니다.');
      }
      if (headerValue(req.headers['x-tevro-csrf']) !== actor.csrfToken) {
        throw new ApiError(403, 'FORBIDDEN', '요청 확인값이 맞지 않습니다. 화면을 새로고침한 뒤 다시 시도하세요.');
      }
    }
  }
  const { role } = actor.user;
  if ((access === 'session' || access === 'admin') && actor.via !== 'session') {
    throw new ApiError(403, 'FORBIDDEN', '이 작업은 웹 화면에서 로그인해서 하세요. 토큰으로는 할 수 없습니다.');
  }
  if (access === 'admin' && role !== 'admin') throw new ApiError(403, 'FORBIDDEN', '관리자만 할 수 있습니다.');
  if (access === 'write') {
    if (role === 'viewer') throw new ApiError(403, 'FORBIDDEN', '열람자는 바꿀 수 없습니다. 관리자에게 편집자 역할을 요청하세요.');
    if (actor.token && actor.token.scope !== 'read-write') {
      throw new ApiError(403, 'FORBIDDEN', '읽기 전용(read) 토큰입니다. 바꾸려면 read-write 범위의 토큰을 쓰세요.');
    }
  }
  return actor;
}

function hostOf(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

function readCookie(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || null;
  }
  return null;
}

function sessionCookie(value: string, secure: boolean, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}

/** HTTPS로 들어온 요청인지. Caddy 같은 프록시 뒤에서는 X-Forwarded-Proto를 본다. TEVRO_COOKIE_SECURE=1이면 항상 Secure. */
function isSecure(req: IncomingMessage): boolean {
  if (process.env.TEVRO_COOKIE_SECURE === '1') return true;
  return headerValue(req.headers['x-forwarded-proto'])?.split(',')[0].trim() === 'https' || 'encrypted' in req.socket;
}
