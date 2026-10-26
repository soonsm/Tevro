import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { ApiError, internalError } from './errors.ts';
import type { Store } from './store.ts';

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

interface Request {
  params: Record<string, string>;
  query: URLSearchParams;
  body: Record<string, unknown>;
}

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handle: (request: Request) => { status?: number; body: unknown };
}

interface AppOptions {
  store: Store;
  webRoot?: string;
  /**
   * 설정하면 상태 확인(/healthz) 말고는 모든 요청에 이 비밀번호를 요구한다(HTTP Basic 인증, 사용자 이름은 보지 않음).
   * 정식 로그인(ADR-0004)을 만들기 전에 서버를 인터넷에 올릴 때 쓰는 임시 장치다. HTTPS 뒤에서만 쓴다.
   */
  password?: string;
}

/** API(/api/v1)와 웹 정적 파일을 함께 제공하는 서버. GUI와 CLI는 같은 API만 쓴다(PRD 원칙 7). */
export function createApp({ store, webRoot, password }: AppOptions): Server {
  const passwordDigest = password ? digest(password) : null;

  const routes: Route[] = [
    route('GET', '/healthz', () => ({ body: { status: 'ok' } })),
    route('GET', '/api/v1/projects', () => ({ body: store.listProjects() })),
    route('POST', '/api/v1/projects', ({ body }) => ({ status: 201, body: store.createProject(body) })),
    route('GET', '/api/v1/projects/:projectId/graph', ({ params }) => ({ body: store.getGraph(params.projectId) })),
    route('POST', '/api/v1/projects/:projectId/tasks', ({ params, body }) => ({
      status: 201,
      body: store.createTask(params.projectId, body),
    })),
    route('POST', '/api/v1/projects/:projectId/dependencies', ({ params, body }) => ({
      status: 201,
      body: store.addDependency(params.projectId, body),
    })),
    route('DELETE', '/api/v1/projects/:projectId/dependencies', ({ params, query }) => ({
      body: store.removeDependency(params.projectId, {
        from: query.get('from') ?? undefined,
        to: query.get('to') ?? undefined,
      }),
    })),
    route('GET', '/api/v1/tasks/:taskId', ({ params }) => ({ body: store.getTask(params.taskId) })),
    route('PATCH', '/api/v1/tasks/:taskId', ({ params, body }) => ({ body: store.updateTask(params.taskId, body) })),
    route('POST', '/api/v1/tasks/:taskId/move', ({ params, body }) => ({ body: store.moveTask(params.taskId, body) })),
    route('DELETE', '/api/v1/tasks/:taskId', ({ params }) => ({ body: store.deleteTask(params.taskId) })),
  ];

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (passwordDigest && url.pathname !== '/healthz' && !hasPassword(req, passwordDigest)) {
        throw new ApiError(401, 'UNAUTHORIZED', '이 서버는 비밀번호가 필요합니다.');
      }
      if (url.pathname === '/healthz' || url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url);
      } else {
        await serveStatic(res, url.pathname);
      }
    } catch (error) {
      sendProblem(res, error);
    }
  });

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    for (const { method, pattern, keys, handle } of routes) {
      const match = method === req.method ? pattern.exec(url.pathname) : null;
      if (!match) continue;
      const params = Object.fromEntries(keys.map((key, index) => [key, decodePath(match[index + 1])]));
      const result = handle({ params, query: url.searchParams, body: await readJsonBody(req) });
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

function route(method: string, path: string, handle: Route['handle']): Route {
  const keys: string[] = [];
  const source = path.replace(/:(\w+)/g, (_, key: string) => {
    keys.push(key);
    return '([^/]+)';
  });
  return { method, pattern: new RegExp(`^${source}$`), keys, handle };
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
  res.writeHead(problem.status, {
    'content-type': 'application/problem+json; charset=utf-8',
    // 브라우저는 이 머리글을 보고 기본 로그인 창을 띄운다.
    ...(problem.status === 401 ? { 'www-authenticate': 'Basic realm="Tevro", charset="UTF-8"' } : {}),
  });
  res.end(JSON.stringify(problem));
}

function digest(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest();
}

/** Authorization: Basic 머리글의 비밀번호가 맞는지. 길이가 달라도 같은 시간에 비교하도록 해시끼리 비교한다. */
function hasPassword(req: IncomingMessage, expected: Buffer): boolean {
  const match = /^Basic\s+([A-Za-z0-9+/]+={0,2})\s*$/i.exec(req.headers.authorization ?? '');
  if (!match) return false;
  const credentials = Buffer.from(match[1], 'base64').toString('utf8');
  const colon = credentials.indexOf(':');
  return colon !== -1 && timingSafeEqual(digest(credentials.slice(colon + 1)), expected);
}
