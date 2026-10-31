// 사용자·로그인·세션·개인 액세스 토큰(ADR-0004). 데이터는 store와 같은 SQLite 파일의 계정 테이블(스키마 3)에 둔다.
// 로그인 수단은 사용자와 따로 둔다. 지금은 로컬 비밀번호만 있고, LDAP·SSO 같은 사내 계정은 PasswordProvider를 더해 붙인다.
import { argon2, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { CreatedTokenDto, Role, TokenDto, TokenScope, UserDto } from '../shared/types.ts';
import { ApiError, invalidInput } from './errors.ts';
import { newId } from './ids.ts';
import type { Db } from './store.ts';

export type Accounts = ReturnType<typeof createAccounts>;

/** 2026-10-31 결정(ADR-0004 남은 확인 사항): 추천값을 그대로 채택 */
export const POLICY = {
  /** 세션: 마지막 요청 뒤 8시간 동안 안 쓰면 만료, 로그인 뒤 길어도 7일 */
  sessionIdleMs: 8 * 60 * 60 * 1000,
  sessionMaxMs: 7 * 24 * 60 * 60 * 1000,
  /** 토큰 만료: 기본 30일, 최대 1년 */
  tokenDefaultDays: 30,
  tokenMaxDays: 365,
  /** 같은 계정으로 5번 연속 틀리면 15분 잠금 */
  lockAfterFailures: 5,
  lockMs: 15 * 60 * 1000,
  /** 비밀번호: 10자 이상, 조합 규칙 없음 */
  passwordMin: 10,
  passwordMax: 256,
};

export const ROLES: readonly Role[] = ['viewer', 'editor', 'admin'];
export const TOKEN_PREFIX = 'tevro_pat_';
const LOCAL = 'local';
// 마지막 사용 시각은 요청마다 쓰지 않고 이 간격이 지났을 때만 고친다.
const TOUCH_INTERVAL_MS = 60 * 1000;

/** 로그인 수단 하나. 아이디·비밀번호를 받아 그 공급자 안의 식별자를 돌려준다(틀리면 null). LDAP 등은 이 모양으로 더한다. */
export interface PasswordProvider {
  readonly id: string;
  readonly label: string;
  verify(username: string, password: string): Promise<{ subject: string; displayName?: string } | null>;
}

/** 지금 요청한 사람과 그 수단 */
export interface Actor {
  user: UserDto;
  via: 'session' | 'token';
  /** via가 session일 때 */
  sessionHash?: string;
  csrfToken?: string;
  /** via가 token일 때 */
  token?: TokenDto;
}

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  role: Role;
  active: number;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

interface IdentityRow {
  provider: string;
  subject: string;
  user_id: string;
  secret_hash: string | null;
  failed_count: number;
  locked_until: string | null;
}

interface SessionRow {
  id_hash: string;
  user_id: string;
  csrf_token: string;
  last_seen_at: string;
  expires_at: string;
}

interface TokenRow {
  id: string;
  user_id: string;
  name: string;
  scope: TokenScope;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export function createAccounts(db: Db, options: { now?: () => number; providers?: PasswordProvider[] } = {}) {
  const now = options.now ?? Date.now;
  const iso = (ms = now()) => new Date(ms).toISOString();

  const sql = {
    countUsers: db.prepare<[], { count: number }>('SELECT COUNT(*) AS count FROM users'),
    listUsers: db.prepare<[], UserRow>('SELECT * FROM users ORDER BY username'),
    getUser: db.prepare<[string], UserRow>('SELECT * FROM users WHERE id = ?'),
    getUserByName: db.prepare<[string], UserRow>('SELECT * FROM users WHERE username = ?'),
    insertUser: db.prepare<[UserRow]>(
      `INSERT INTO users (id, username, display_name, role, active, created_at, updated_at, last_login_at)
       VALUES (@id, @username, @display_name, @role, @active, @created_at, @updated_at, @last_login_at)`,
    ),
    updateUser: db.prepare<[string, Role, number, string, string]>(
      'UPDATE users SET display_name = ?, role = ?, active = ?, updated_at = ? WHERE id = ?',
    ),
    setLastLogin: db.prepare<[string, string]>('UPDATE users SET last_login_at = ? WHERE id = ?'),
    countActiveAdmins: db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND active = 1"),
    getIdentity: db.prepare<[string, string], IdentityRow>('SELECT * FROM auth_identities WHERE provider = ? AND subject = ?'),
    getLocalIdentityOf: db.prepare<[string], IdentityRow>("SELECT * FROM auth_identities WHERE provider = 'local' AND user_id = ?"),
    insertIdentity: db.prepare<[string, string, string, string | null, string]>(
      'INSERT INTO auth_identities (provider, subject, user_id, secret_hash, created_at) VALUES (?, ?, ?, ?, ?)',
    ),
    setSecret: db.prepare<[string, string, string]>(
      'UPDATE auth_identities SET secret_hash = ?, failed_count = 0, locked_until = NULL WHERE provider = ? AND subject = ?',
    ),
    setFailures: db.prepare<[number, string | null, string, string]>(
      'UPDATE auth_identities SET failed_count = ?, locked_until = ? WHERE provider = ? AND subject = ?',
    ),
    insertSession: db.prepare<[string, string, string, string, string, string]>(
      'INSERT INTO sessions (id_hash, user_id, csrf_token, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    ),
    getSession: db.prepare<[string], SessionRow>('SELECT * FROM sessions WHERE id_hash = ?'),
    touchSession: db.prepare<[string, string]>('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?'),
    deleteSession: db.prepare<[string]>('DELETE FROM sessions WHERE id_hash = ?'),
    deleteSessionsOf: db.prepare<[string]>('DELETE FROM sessions WHERE user_id = ?'),
    deleteExpiredSessions: db.prepare<[string, string]>('DELETE FROM sessions WHERE expires_at <= ? OR last_seen_at <= ?'),
    insertToken: db.prepare<[string, string, string, TokenScope, string, string, string]>(
      'INSERT INTO access_tokens (id, user_id, name, scope, secret_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ),
    listTokens: db.prepare<[string, string], TokenRow>(
      'SELECT * FROM access_tokens WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC',
    ),
    getToken: db.prepare<[string], TokenRow>('SELECT * FROM access_tokens WHERE id = ?'),
    getTokenBySecret: db.prepare<[string], TokenRow>('SELECT * FROM access_tokens WHERE secret_hash = ?'),
    touchToken: db.prepare<[string, string]>('UPDATE access_tokens SET last_used_at = ? WHERE id = ?'),
    revokeToken: db.prepare<[string, string]>('UPDATE access_tokens SET revoked_at = ? WHERE id = ?'),
  };

  // 로컬 계정 공급자. 비밀번호 해시는 auth_identities.secret_hash에 있다.
  const local: PasswordProvider = {
    id: LOCAL,
    label: 'Tevro 계정',
    async verify(username, password) {
      const identity = sql.getIdentity.get(LOCAL, username);
      // 없는 아이디도 같은 시간이 걸리게 가짜 해시로 한 번 계산한다.
      const ok = await verifyPassword(password, identity?.secret_hash ?? (await dummyHash()));
      return identity && ok ? { subject: identity.subject } : null;
    },
  };
  const providers = new Map<string, PasswordProvider>([[LOCAL, local], ...(options.providers ?? []).map((p) => [p.id, p] as const)]);

  function requireUser(userId: string): UserRow {
    const row = sql.getUser.get(userId);
    if (!row) throw new ApiError(404, 'NOT_FOUND', `사용자가 없습니다: ${userId}`);
    return row;
  }

  /** 마지막 관리자를 강등·비활성화하면 아무도 사용자를 관리할 수 없게 된다. */
  function keepAnAdmin(row: UserRow, role: Role, active: boolean): void {
    const losesAdmin = row.role === 'admin' && row.active === 1 && (role !== 'admin' || !active);
    if (losesAdmin && sql.countActiveAdmins.get()!.count <= 1) {
      throw invalidInput('활성 관리자가 한 명뿐이라 강등하거나 비활성화할 수 없습니다. 먼저 다른 관리자를 지정하세요.');
    }
  }

  function startSession(userId: string): { cookie: string; csrfToken: string } {
    const cookie = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(24).toString('base64url');
    const at = now();
    sql.deleteExpiredSessions.run(iso(at), iso(at - POLICY.sessionIdleMs));
    sql.insertSession.run(sha256(cookie), userId, csrfToken, iso(at), iso(at), iso(at + POLICY.sessionMaxMs));
    sql.setLastLogin.run(iso(at), userId);
    return { cookie, csrfToken };
  }

  return {
    providers: () => [...providers.values()].map(({ id, label }) => ({ id, label })),
    hasUsers: () => sql.countUsers.get()!.count > 0,
    listUsers: () => sql.listUsers.all().map(toUserDto),
    getUser: (userId: string) => toUserDto(requireUser(userId)),
    findUser: (username: string) => {
      const row = sql.getUserByName.get(username);
      return row ? toUserDto(row) : null;
    },

    /** 사용자와 로컬 비밀번호를 함께 만든다. 비밀번호를 주지 않으면 사내 계정 공급자로만 로그인하는 사용자다. */
    async createUser(input: { username?: unknown; displayName?: unknown; role?: unknown; password?: unknown }): Promise<UserDto> {
      const username = readUsername(input.username);
      const displayName = readDisplayName(input.displayName) ?? username;
      const role = readRole(input.role ?? 'viewer');
      const password = input.password === undefined ? undefined : readPassword(input.password);
      if (sql.getUserByName.get(username)) throw invalidInput(`이미 있는 아이디입니다: ${username}`);
      const hash = password === undefined ? null : await hashPassword(password);
      const at = iso();
      const row: UserRow = {
        id: newId('usr'),
        username,
        display_name: displayName,
        role,
        active: 1,
        created_at: at,
        updated_at: at,
        last_login_at: null,
      };
      db.transaction(() => {
        // 해시를 계산하는 사이 같은 아이디가 생겼을 수 있어 트랜잭션 안에서 다시 본다.
        if (sql.getUserByName.get(username)) throw invalidInput(`이미 있는 아이디입니다: ${username}`);
        sql.insertUser.run(row);
        if (hash !== null) sql.insertIdentity.run(LOCAL, username, row.id, hash, at);
      }).immediate();
      return toUserDto(row);
    },

    /** 역할·활성·표시 이름을 바꾼다. 비활성화하거나 역할을 바꾸면 그 사람의 세션은 끊는다(토큰은 역할을 매번 다시 보므로 그대로 둔다). */
    updateUser(userId: string, input: { displayName?: unknown; role?: unknown; active?: unknown }): UserDto {
      return db.transaction(() => {
        const row = requireUser(userId);
        const role = input.role === undefined ? row.role : readRole(input.role);
        if (input.active !== undefined && typeof input.active !== 'boolean') throw invalidInput('활성(active): true 또는 false여야 합니다.');
        const active = input.active === undefined ? row.active === 1 : (input.active as boolean);
        const displayName = readDisplayName(input.displayName) ?? row.display_name;
        keepAnAdmin(row, role, active);
        sql.updateUser.run(displayName, role, active ? 1 : 0, iso(), userId);
        if (role !== row.role || !active) sql.deleteSessionsOf.run(userId);
        return toUserDto(requireUser(userId));
      }).immediate();
    },

    /** 로컬 비밀번호를 정한다(관리자 재설정, 관리 명령). 없으면 만든다. 잠금을 풀고 기존 세션을 끊는다. */
    async setPassword(userId: string, password: unknown): Promise<void> {
      const user = requireUser(userId);
      const hash = await hashPassword(readPassword(password));
      db.transaction(() => {
        const identity = sql.getLocalIdentityOf.get(userId);
        if (identity) sql.setSecret.run(hash, LOCAL, identity.subject);
        else sql.insertIdentity.run(LOCAL, user.username, userId, hash, iso());
        sql.deleteSessionsOf.run(userId);
      }).immediate();
    },

    /** 본인이 현재 비밀번호를 확인한 뒤 바꾼다. 지금 세션만 남기고 나머지 세션은 끊는다. */
    async changeOwnPassword(actor: Actor, current: unknown, next: unknown): Promise<void> {
      const identity = sql.getLocalIdentityOf.get(actor.user.id);
      if (!identity?.secret_hash) throw invalidInput('Tevro 비밀번호가 없는 계정입니다. 사내 계정 비밀번호는 그쪽에서 바꾸세요.');
      if (typeof current !== 'string' || !(await verifyPassword(current, identity.secret_hash))) {
        throw invalidInput('현재 비밀번호가 맞지 않습니다.');
      }
      const hash = await hashPassword(readPassword(next));
      db.transaction(() => {
        sql.setSecret.run(hash, LOCAL, identity.subject);
        sql.deleteSessionsOf.run(actor.user.id);
        if (actor.sessionHash) {
          // 지금 쓰는 세션은 다시 만든다(위에서 지웠으므로 같은 값으로 되살림).
          const at = now();
          sql.insertSession.run(actor.sessionHash, actor.user.id, actor.csrfToken!, iso(at), iso(at), iso(at + POLICY.sessionMaxMs));
        }
      }).immediate();
    },

    /** 아이디·비밀번호로 로그인해 새 세션을 만든다. 같은 계정으로 연속해서 틀리면 잠근다. */
    async login(input: { provider?: unknown; username?: unknown; password?: unknown }): Promise<{ user: UserDto; cookie: string; csrfToken: string }> {
      const providerId = input.provider === undefined ? LOCAL : input.provider;
      const provider = typeof providerId === 'string' ? providers.get(providerId) : undefined;
      if (!provider) throw invalidInput(`로그인 방식이 없습니다: ${String(providerId)}`);
      if (typeof input.username !== 'string' || typeof input.password !== 'string' || input.username.trim() === '' || input.password === '') {
        throw invalidInput('아이디와 비밀번호를 입력하세요.');
      }
      const username = input.username.trim();
      const failed = new ApiError(401, 'UNAUTHENTICATED', '아이디 또는 비밀번호가 맞지 않습니다.');
      const before = sql.getIdentity.get(provider.id, username);
      if (before?.locked_until && Date.parse(before.locked_until) > now()) throw lockedError(before.locked_until);

      const verified = await provider.verify(username, input.password);
      const identity = verified ? sql.getIdentity.get(provider.id, verified.subject) : before;
      if (!verified) {
        if (identity) {
          const count = identity.failed_count + 1;
          const lock = count >= POLICY.lockAfterFailures ? iso(now() + POLICY.lockMs) : null;
          sql.setFailures.run(lock ? 0 : count, lock, provider.id, identity.subject);
          if (lock) throw lockedError(lock);
        }
        throw failed;
      }
      // 사내 계정 공급자가 확인했어도 Tevro에 연결된 사용자가 없으면 들어올 수 없다(관리자가 먼저 사용자를 만든다).
      if (!identity) throw new ApiError(403, 'FORBIDDEN', 'Tevro에 등록되지 않은 계정입니다. 관리자에게 사용자 등록을 요청하세요.');
      const user = requireUser(identity.user_id);
      if (user.active !== 1) throw new ApiError(403, 'FORBIDDEN', '비활성화된 계정입니다. 관리자에게 문의하세요.');
      sql.setFailures.run(0, null, provider.id, identity.subject);
      const session = startSession(user.id);
      return { user: toUserDto(requireUser(user.id)), ...session };
    },

    /** 세션 쿠키 값으로 사람을 찾는다. 만료됐으면 지우고 null. */
    authenticateSession(cookie: string): Actor | null {
      const hash = sha256(cookie);
      const session = sql.getSession.get(hash);
      if (!session) return null;
      const at = now();
      if (Date.parse(session.expires_at) <= at || Date.parse(session.last_seen_at) + POLICY.sessionIdleMs <= at) {
        sql.deleteSession.run(hash);
        return null;
      }
      const user = sql.getUser.get(session.user_id);
      if (!user || user.active !== 1) return null;
      if (at - Date.parse(session.last_seen_at) >= TOUCH_INTERVAL_MS) sql.touchSession.run(iso(at), hash);
      return { user: toUserDto(user), via: 'session', sessionHash: hash, csrfToken: session.csrf_token };
    },

    logout(actor: Actor): void {
      if (actor.sessionHash) sql.deleteSession.run(actor.sessionHash);
    },

    /** 토큰 비밀값으로 사람을 찾는다. 형식이 다르거나, 만료·폐기됐거나, 계정이 비활성이면 null. */
    authenticateToken(secret: string): Actor | null {
      if (!secret.startsWith(TOKEN_PREFIX)) return null;
      const row = sql.getTokenBySecret.get(sha256(secret));
      const at = now();
      if (!row || row.revoked_at || Date.parse(row.expires_at) <= at) return null;
      const user = sql.getUser.get(row.user_id);
      if (!user || user.active !== 1) return null;
      if (!row.last_used_at || at - Date.parse(row.last_used_at) >= TOUCH_INTERVAL_MS) {
        sql.touchToken.run(iso(at), row.id);
        row.last_used_at = iso(at);
      }
      return { user: toUserDto(user), via: 'token', token: toTokenDto(row) };
    },

    /** 본인 토큰 발급. 열람자는 read 범위만. 비밀값은 이 응답에서만 볼 수 있다. */
    createToken(actor: Actor, input: { name?: unknown; scope?: unknown; expiresInDays?: unknown }): CreatedTokenDto {
      const name = readText(input.name, '토큰 이름(name)', 100);
      const scope = input.scope ?? 'read';
      if (scope !== 'read' && scope !== 'read-write') throw invalidInput('범위(scope): read 또는 read-write여야 합니다.');
      if (scope === 'read-write' && actor.user.role === 'viewer') {
        throw new ApiError(403, 'FORBIDDEN', '열람자는 read 범위의 토큰만 발급할 수 있습니다.');
      }
      const days = input.expiresInDays ?? POLICY.tokenDefaultDays;
      if (!Number.isInteger(days) || (days as number) < 1 || (days as number) > POLICY.tokenMaxDays) {
        throw invalidInput(`만료(expiresInDays): 1~${POLICY.tokenMaxDays}일 사이의 정수여야 합니다.`);
      }
      const secret = TOKEN_PREFIX + randomBytes(32).toString('base64url');
      const at = now();
      const row: TokenRow = {
        id: newId('tok'),
        user_id: actor.user.id,
        name,
        scope,
        created_at: iso(at),
        expires_at: iso(at + (days as number) * 24 * 60 * 60 * 1000),
        last_used_at: null,
        revoked_at: null,
      };
      sql.insertToken.run(row.id, row.user_id, row.name, row.scope, sha256(secret), row.created_at, row.expires_at);
      return { ...toTokenDto(row), token: secret };
    },

    /** 유효한(만료·폐기되지 않은) 토큰 목록 */
    listTokens: (userId: string) => sql.listTokens.all(userId, iso()).map(toTokenDto),

    /** 본인 토큰, 또는 관리자는 누구의 토큰이든 폐기한다. */
    revokeToken(actor: Actor, tokenId: string): TokenDto {
      const row = sql.getToken.get(tokenId);
      if (!row || (row.user_id !== actor.user.id && actor.user.role !== 'admin')) {
        throw new ApiError(404, 'NOT_FOUND', `토큰이 없습니다: ${tokenId}`);
      }
      if (!row.revoked_at) sql.revokeToken.run(iso(), tokenId);
      return toTokenDto(row);
    },
  };

  function lockedError(until: string): ApiError {
    const minutes = Math.max(1, Math.ceil((Date.parse(until) - now()) / 60_000));
    return new ApiError(429, 'ACCOUNT_LOCKED', `비밀번호를 여러 번 틀려 계정이 잠겼습니다. ${minutes}분 뒤에 다시 시도하거나 관리자에게 재설정을 요청하세요.`);
  }
}

function toUserDto(row: UserRow): UserDto {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    active: row.active === 1,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  };
}

function toTokenDto(row: TokenRow): TokenDto {
  return { id: row.id, name: row.name, scope: row.scope, createdAt: row.created_at, expiresAt: row.expires_at, lastUsedAt: row.last_used_at };
}

function readText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '') throw invalidInput(`${label}: 값을 입력하세요.`);
  const text = value.trim();
  if (text.length > max) throw invalidInput(`${label}: ${max}자까지 입력할 수 있습니다.`);
  return text;
}

// 사내 계정 아이디(사번, 이메일 등)를 그대로 쓸 수 있게 영문·숫자와 . _ @ - 를 받는다.
function readUsername(value: unknown): string {
  const username = readText(value, '아이디(username)', 64);
  if (!/^[A-Za-z0-9._@-]+$/.test(username)) throw invalidInput('아이디(username): 영문, 숫자와 . _ @ - 만 쓸 수 있습니다.');
  return username;
}

function readDisplayName(value: unknown): string | undefined {
  return value === undefined || value === '' ? undefined : readText(value, '이름(displayName)', 100);
}

export function readRole(value: unknown): Role {
  if (!ROLES.includes(value as Role)) throw invalidInput('역할(role): viewer, editor, admin 중 하나여야 합니다.');
  return value as Role;
}

export function readPassword(value: unknown): string {
  if (typeof value !== 'string') throw invalidInput('비밀번호: 문자열이어야 합니다.');
  if ([...value].length < POLICY.passwordMin) throw invalidInput(`비밀번호: ${POLICY.passwordMin}자 이상이어야 합니다.`);
  if (value.length > POLICY.passwordMax) throw invalidInput(`비밀번호: ${POLICY.passwordMax}자까지 쓸 수 있습니다.`);
  return value;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// 비밀번호 해시: Argon2id(Node.js 24.7부터 내장). OWASP 최소 권고값 m=19MiB, t=2, p=1. PHC 문자열로 저장해 값을 바꿔도 예전 해시를 확인할 수 있다.
const ARGON2 = { memory: 19 * 1024, passes: 2, parallelism: 1, tagLength: 32 };

function argon2id(message: string, nonce: Buffer, params: { memory: number; passes: number; parallelism: number; tagLength: number }): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    argon2('argon2id', { message, nonce, ...params }, (error, derived) => (error ? reject(error) : resolve(derived))),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await argon2id(password, salt, ARGON2);
  return `$argon2id$v=19$m=${ARGON2.memory},t=${ARGON2.passes},p=${ARGON2.parallelism}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const match = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(stored);
  if (!match) return false;
  const expected = Buffer.from(match[5], 'base64url');
  const actual = await argon2id(password, Buffer.from(match[4], 'base64url'), {
    memory: Number(match[1]),
    passes: Number(match[2]),
    parallelism: Number(match[3]),
    tagLength: expected.length,
  });
  return timingSafeEqual(actual, expected);
}

let dummy: Promise<string> | null = null;
function dummyHash(): Promise<string> {
  dummy ??= hashPassword(randomBytes(16).toString('hex'));
  return dummy;
}
