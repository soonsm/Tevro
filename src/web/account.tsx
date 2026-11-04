// 로그인 화면과 계정 메뉴(내 토큰, 비밀번호 바꾸기, 사용자 관리). ADR-0004.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import type { CreatedTokenDto, Role, TokenDto, TokenScope, UserDto } from '../shared/types.ts';
import { ApiFailure, api } from './api.ts';
import { Modal } from './dialogs.tsx';
import { CopyIcon, PlusIcon } from './icons.tsx';
import { JiraTokenDialog } from './jira.tsx';

export const ROLE_LABELS: Record<Role, string> = { viewer: '열람자', editor: '편집자', admin: '관리자' };
const ROLE_HINTS: Record<Role, string> = {
  viewer: '보기만 함',
  editor: '프로젝트·공정·연결을 바꿈',
  admin: '편집자 + 사용자 관리',
};

function errorText(error: unknown): string {
  if (error instanceof ApiFailure) return error.problem.detail;
  return error instanceof Error ? error.message : String(error);
}

function day(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '-';
}

export function LoginScreen({ onLogin }: { onLogin: (user: UserDto) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { user } = await api.login(username.trim(), password);
      onLogin(user);
    } catch (failure) {
      setError(errorText(failure));
      setPassword('');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">Tevro</span>
      </header>
      <div className="center-message">
        <form className="message-card" onSubmit={submit}>
          <h1>로그인</h1>
          {error && (
            <p className="panel-note is-error" role="alert">
              {error}
            </p>
          )}
          <label className="field-label" htmlFor="login-username">
            아이디
          </label>
          <input
            id="login-username"
            className="input"
            autoComplete="username"
            autoFocus
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
          <label className="field-label" htmlFor="login-password">
            비밀번호
          </label>
          <input
            id="login-password"
            className="input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <button type="submit" className="button primary" disabled={busy || !username.trim() || !password}>
            {busy ? '확인 중…' : '로그인'}
          </button>
          <p className="panel-note is-small">계정이 없으면 관리자에게 요청하세요.</p>
        </form>
      </div>
    </div>
  );
}

/** 첫 설정: 사용자가 하나도 없을 때 서버 로그의 설정 코드를 받아 첫 관리자를 만든다. */
export function SetupScreen({ onDone, onLogin }: { onDone: (user: UserDto) => void; onLogin: () => void }) {
  const [code, setCode] = useState('');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mismatch = confirm !== '' && confirm !== password;
  const short = password !== '' && [...password].length < 10;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { user } = await api.setup({ code: code.trim(), username: username.trim(), displayName: displayName.trim(), password });
      onDone(user);
    } catch (failure) {
      // 그사이 다른 사람이 먼저 설정을 마쳤으면 로그인 화면으로 보낸다.
      if (failure instanceof ApiFailure && /이미 사용자가 있어/.test(failure.problem.detail)) onLogin();
      else setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">Tevro</span>
      </header>
      <div className="center-message">
        <form className="message-card setup-card" onSubmit={submit}>
          <h1>첫 관리자 만들기</h1>
          <p className="panel-note">
            아직 사용자가 없습니다. 서버를 켤 때 로그에 나온 <b>설정 코드</b>를 넣고 관리자 계정을 만드세요. 관리자는 다른 사람의 계정을 만들 수 있습니다.
          </p>
          {error && (
            <p className="panel-note is-error" role="alert">
              {error}
            </p>
          )}
          <label className="field-label" htmlFor="setup-code">
            설정 코드
          </label>
          <input
            id="setup-code"
            className="input setup-code"
            autoComplete="off"
            spellCheck={false}
            autoFocus
            placeholder="XXXX-XXXX-XXXX-XXXX"
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
          <p className="panel-note is-small">
            서버 로그에서 찾습니다. 예: <code>docker logs tevro</code>, <code>journalctl -u tevro</code>
          </p>
          <label className="field-label" htmlFor="setup-username">
            아이디
          </label>
          <input id="setup-username" className="input" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} />
          <label className="field-label" htmlFor="setup-name">
            이름 (선택)
          </label>
          <input id="setup-name" className="input" autoComplete="name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
          <label className="field-label" htmlFor="setup-password">
            비밀번호 (10자 이상)
          </label>
          <input
            id="setup-password"
            className="input"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <label className="field-label" htmlFor="setup-confirm">
            비밀번호 확인
          </label>
          <input
            id="setup-confirm"
            className="input"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
          />
          {short && <p className="panel-note is-small is-error">비밀번호는 10자 이상이어야 합니다.</p>}
          {mismatch && <p className="panel-note is-small is-error">비밀번호가 서로 다릅니다.</p>}
          <button
            type="submit"
            className="button primary"
            disabled={busy || !code.trim() || !username.trim() || !password || short || confirm !== password}
          >
            {busy ? '만드는 중…' : '관리자 만들고 시작하기'}
          </button>
        </form>
      </div>
    </div>
  );
}

type AccountDialog = 'tokens' | 'password' | 'users' | 'jira' | null;

/** 상단 막대 오른쪽의 계정 메뉴 */
export function AccountMenu({ user, onLogout }: { user: UserDto; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<AccountDialog>(null);
  /** 서버에 Jira가 연결돼 있는지(없으면 Jira 메뉴를 숨긴다) */
  const [jira, setJira] = useState<{ enabled: boolean; connected: boolean } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    api.jiraToken().then(
      (status) => setJira({ enabled: status.enabled, connected: status.connected }),
      () => setJira(null),
    );
  }, [dialog]);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  const choose = (next: AccountDialog) => {
    setOpen(false);
    setDialog(next);
  };
  return (
    <div className="account" ref={ref}>
      <button type="button" className="button account__button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="account__name">{user.displayName}</span>
        <span className="account__role">{ROLE_LABELS[user.role]}</span>
      </button>
      {open && (
        <div className="account__menu" role="menu">
          <div className="account__who">
            <b>{user.displayName}</b>
            <span>
              {user.username} · {ROLE_LABELS[user.role]}
            </span>
          </div>
          <button type="button" role="menuitem" onClick={() => choose('tokens')}>
            내 토큰 (CLI·AI 에이전트용)
          </button>
          {jira?.enabled && (
            <button type="button" role="menuitem" onClick={() => choose('jira')}>
              Jira 연결 {jira.connected ? '(연결됨)' : '(토큰 등록)'}
            </button>
          )}
          <button type="button" role="menuitem" onClick={() => choose('password')}>
            비밀번호 바꾸기
          </button>
          {user.role === 'admin' && (
            <button type="button" role="menuitem" onClick={() => choose('users')}>
              사용자 관리
            </button>
          )}
          <button type="button" role="menuitem" onClick={onLogout}>
            로그아웃
          </button>
        </div>
      )}
      {/* 상단 막대의 글자·버튼 색을 물려받지 않게 창은 body에 그린다 */}
      {dialog &&
        createPortal(
          <>
            {dialog === 'tokens' && <TokensDialog user={user} onClose={() => setDialog(null)} />}
            {dialog === 'password' && <PasswordDialog onClose={() => setDialog(null)} />}
            {dialog === 'users' && <UsersDialog me={user} jira={jira?.enabled === true} onClose={() => setDialog(null)} />}
            {dialog === 'jira' && <JiraTokenDialog onClose={() => setDialog(null)} />}
          </>,
          document.body,
        )}
    </div>
  );
}

function TokensDialog({ user, onClose }: { user: UserDto; onClose: () => void }) {
  const [tokens, setTokens] = useState<TokenDto[] | null>(null);
  const [created, setCreated] = useState<CreatedTokenDto | null>(null);
  const [name, setName] = useState('');
  const [scope, setScope] = useState<TokenScope>('read');
  const [days, setDays] = useState(30);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const canWrite = user.role !== 'viewer';

  const load = () => api.listTokens().then(setTokens, (failure) => setError(errorText(failure)));
  useEffect(() => void load(), []);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      setCreated(await api.createToken(name.trim(), scope, days));
      setName('');
      setCopied(false);
      await load();
    } catch (failure) {
      setError(errorText(failure));
    }
  };
  const revoke = async (token: TokenDto) => {
    setError(null);
    try {
      await api.revokeToken(token.id);
      if (created?.id === token.id) setCreated(null);
      await load();
    } catch (failure) {
      setError(errorText(failure));
    }
  };
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setError('복사하지 못했습니다. 값을 직접 선택해 복사하세요.');
    }
  };

  return (
    <Modal labelledBy="tokens-title" onClose={onClose}>
      <h2 id="tokens-title" className="modal__title">
        내 토큰
      </h2>
      <p className="panel-note">
        CLI와 AI 에이전트가 내 계정으로 Tevro를 쓸 때 넣는 값입니다. 할 수 있는 일은 토큰 범위와 내 역할({ROLE_LABELS[user.role]}) 중
        좁은 쪽입니다.
      </p>
      {error && (
        <p className="panel-note is-error" role="alert">
          {error}
        </p>
      )}
      {created && (
        <div className="token-created">
          <span className="field-label is-strong">새 토큰 ‘{created.name}’ — 이 창을 닫으면 다시 볼 수 없습니다</span>
          <div className="token-created__value">
            <code>{created.token}</code>
            <button type="button" className="button small" onClick={() => void copy(created.token)}>
              <CopyIcon />
              {copied ? '복사됨' : '복사'}
            </button>
          </div>
          <p className="panel-note is-small">
            터미널에서: <code>export TEVRO_TOKEN=…</code> 또는 <code>tevro config set-token --stdin</code>
          </p>
        </div>
      )}
      <form className="token-form" onSubmit={create}>
        <div className="token-form__row">
          <label className="field-label" htmlFor="token-name">
            이름(용도)
          </label>
          <input
            id="token-name"
            className="input"
            value={name}
            maxLength={100}
            placeholder="예: 내 노트북의 AI 에이전트"
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="token-form__grid">
          <div className="token-form__row">
            <label className="field-label" htmlFor="token-scope">
              범위
            </label>
            <select id="token-scope" className="select" value={scope} onChange={(event) => setScope(event.target.value as TokenScope)}>
              <option value="read">읽기 전용(read)</option>
              <option value="read-write" disabled={!canWrite}>
                읽기·쓰기(read-write){canWrite ? '' : ' — 편집자 이상'}
              </option>
            </select>
          </div>
          <div className="token-form__row">
            <label className="field-label" htmlFor="token-days">
              만료(일)
            </label>
            <select id="token-days" className="select" value={days} onChange={(event) => setDays(Number(event.target.value))}>
              {[7, 30, 90, 180, 365].map((value) => (
                <option key={value} value={value}>
                  {value}일
                </option>
              ))}
            </select>
          </div>
        </div>
        <button type="submit" className="button primary" disabled={!name.trim()}>
          <PlusIcon />
          토큰 발급
        </button>
      </form>
      <div className="modal__block">
        <span className="field-label is-strong">사용 중인 토큰 {tokens?.length ?? ''}</span>
        {tokens?.length === 0 && <p className="panel-note">발급한 토큰이 없습니다.</p>}
        <ul className="token-list">
          {tokens?.map((token) => (
            <li key={token.id}>
              <div className="token-list__main">
                <b>{token.name}</b>
                <span className="panel-note is-small">
                  {token.scope} · 만료 {day(token.expiresAt)} · 마지막 사용 {day(token.lastUsedAt)}
                </span>
              </div>
              <button type="button" className="button small danger" onClick={() => void revoke(token)}>
                폐기
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="modal__actions">
        <button type="button" className="button" onClick={onClose}>
          닫기
        </button>
      </div>
    </Modal>
  );
}

function PasswordDialog({ onClose }: { onClose: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (next !== again) {
      setError('새 비밀번호 두 개가 다릅니다.');
      return;
    }
    setError(null);
    try {
      await api.changePassword(current, next);
      setDone(true);
    } catch (failure) {
      setError(errorText(failure));
    }
  };
  return (
    <Modal labelledBy="password-title" onClose={onClose}>
      <form onSubmit={submit}>
        <h2 id="password-title" className="modal__title">
          비밀번호 바꾸기
        </h2>
        {done ? (
          <p className="panel-note">비밀번호를 바꿨습니다. 다른 곳에서 로그인한 세션은 끊겼습니다.</p>
        ) : (
          <>
            {error && (
              <p className="panel-note is-error" role="alert">
                {error}
              </p>
            )}
            <label className="field-label" htmlFor="password-current">
              현재 비밀번호
            </label>
            <input id="password-current" className="input" type="password" autoComplete="current-password" value={current} onChange={(event) => setCurrent(event.target.value)} />
            <label className="field-label" htmlFor="password-next">
              새 비밀번호 (10자 이상)
            </label>
            <input id="password-next" className="input" type="password" autoComplete="new-password" value={next} onChange={(event) => setNext(event.target.value)} />
            <label className="field-label" htmlFor="password-again">
              새 비밀번호 확인
            </label>
            <input id="password-again" className="input" type="password" autoComplete="new-password" value={again} onChange={(event) => setAgain(event.target.value)} />
          </>
        )}
        <div className="modal__actions">
          <button type="button" className="button" onClick={onClose}>
            {done ? '닫기' : '취소'}
          </button>
          {!done && (
            <button type="submit" className="button primary" disabled={!current || !next || !again}>
              바꾸기
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}

function UsersDialog({ me, jira, onClose }: { me: UserDto; jira: boolean; onClose: () => void }) {
  const [users, setUsers] = useState<UserDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [resetting, setResetting] = useState<UserDto | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [mapping, setMapping] = useState<UserDto | null>(null);

  const load = () => api.listUsers().then(setUsers, (failure) => setError(errorText(failure)));
  useEffect(() => void load(), []);

  async function run(action: () => Promise<unknown>, done: string) {
    setError(null);
    setMessage(null);
    try {
      await action();
      setMessage(done);
      await load();
      return true;
    } catch (failure) {
      setError(errorText(failure));
      return false;
    }
  }

  const resetPassword = async (event: FormEvent) => {
    event.preventDefault();
    const user = resetting!;
    if (await run(() => api.resetPassword(user.id, newPassword), `${user.username}의 비밀번호를 바꿨습니다. 본인에게 따로 알려 주세요.`)) {
      setResetting(null);
      setNewPassword('');
    }
  };

  return (
    <Modal labelledBy="users-title" onClose={onClose}>
      <h2 id="users-title" className="modal__title">
        사용자 관리
      </h2>
      <p className="panel-note">역할: 열람자는 보기만, 편집자는 바꾸기까지, 관리자는 사용자 관리까지 합니다.</p>
      {error && (
        <p className="panel-note is-error" role="alert">
          {error}
        </p>
      )}
      {message && <p className="panel-note">{message}</p>}
      <ul className="user-list">
        {users?.map((user) => (
          <li key={user.id} className={user.active ? undefined : 'is-inactive'}>
            <div className="user-list__main">
              <b>
                {user.displayName}
                {user.id === me.id && ' (나)'}
              </b>
              <span className="panel-note is-small">
                {user.username} · 마지막 로그인 {day(user.lastLoginAt)}
                {!user.active && ' · 비활성'}
                {jira && ` · Jira ${user.jiraName ?? '짝 없음'}`}
              </span>
            </div>
            <select
              className="select"
              aria-label={`${user.username} 역할`}
              value={user.role}
              onChange={(event) =>
                void run(() => api.updateUser(user.id, { role: event.target.value as Role }), `${user.username}: ${ROLE_LABELS[event.target.value as Role]}`)
              }
            >
              {(['viewer', 'editor', 'admin'] as Role[]).map((role) => (
                <option key={role} value={role}>
                  {ROLE_LABELS[role]}
                </option>
              ))}
            </select>
            <button type="button" className="button small" onClick={() => setResetting(user)}>
              비밀번호 재설정
            </button>
            {jira && (
              <button type="button" className="button small" onClick={() => setMapping(user)}>
                Jira 짝
              </button>
            )}
            <button
              type="button"
              className="button small"
              onClick={() =>
                void run(() => api.updateUser(user.id, { active: !user.active }), `${user.username}: ${user.active ? '비활성화' : '활성화'}했습니다.`)
              }
            >
              {user.active ? '비활성화' : '활성화'}
            </button>
          </li>
        ))}
      </ul>
      {resetting && (
        <form className="new-user" onSubmit={resetPassword}>
          <label className="field-label is-strong" htmlFor="reset-password">
            {resetting.username}의 새 비밀번호 (10자 이상)
          </label>
          <input id="reset-password" className="input" type="password" autoComplete="new-password" autoFocus value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
          <div className="modal__actions">
            <button type="button" className="button" onClick={() => setResetting(null)}>
              취소
            </button>
            <button type="submit" className="button primary" disabled={!newPassword}>
              재설정
            </button>
          </div>
        </form>
      )}
      {mapping && (
        <JiraMappingForm
          user={mapping}
          onCancel={() => setMapping(null)}
          onSave={async (jiraName) => {
            if (await run(() => api.setUserJiraName(mapping.id, jiraName), jiraName ? `${mapping.username} ↔ Jira ${jiraName}` : `${mapping.username}의 Jira 짝을 지웠습니다.`)) setMapping(null);
          }}
        />
      )}
      {adding ? (
        <NewUserForm
          onCancel={() => setAdding(false)}
          onCreate={async (input) => {
            if (await run(() => api.createUser(input), `${input.username} 사용자를 만들었습니다. 비밀번호는 본인에게 따로 알려 주세요.`)) setAdding(false);
          }}
        />
      ) : (
        <button type="button" className="button" onClick={() => setAdding(true)}>
          <PlusIcon />
          사용자 추가
        </button>
      )}
      <div className="modal__actions">
        <button type="button" className="button" onClick={onClose}>
          닫기
        </button>
      </div>
    </Modal>
  );
}

/** 관리자: Jira 토큰이 없는 사람의 Jira 사용자를 짝짓는다(담당자를 Jira와 주고받기 위해). 검색은 관리자의 Jira 토큰으로 한다. */
function JiraMappingForm({ user, onCancel, onSave }: { user: UserDto; onCancel: () => void; onSave: (jiraName: string | null) => void }) {
  const [query, setQuery] = useState(user.jiraName ?? user.username);
  const [found, setFound] = useState<{ name: string; displayName: string; emailAddress: string | null }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const search = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      setFound(await api.searchJiraUsers(query.trim()));
    } catch (failure) {
      setError(errorText(failure));
    }
  };
  return (
    <form className="new-user" onSubmit={search}>
      <span className="field-label is-strong">{user.displayName}의 Jira 사용자</span>
      <p className="panel-note is-small">본인이 Jira 토큰을 등록하면 자동으로 짝지어집니다. 검색은 내 Jira 토큰으로 합니다.</p>
      <div className="jira-key-row">
        <input className="input" value={query} placeholder="Jira 아이디나 이름" onChange={(event) => setQuery(event.target.value)} />
        <button type="submit" className="button" disabled={query.trim().length < 2}>
          찾기
        </button>
      </div>
      {error && <p className="panel-note is-error">{error}</p>}
      {found?.length === 0 && <p className="panel-note">찾지 못했습니다.</p>}
      <ul className="token-list">
        {found?.map((person) => (
          <li key={person.name}>
            <div className="token-list__main">
              <b>{person.displayName}</b>
              <span className="panel-note is-small">
                {person.name}
                {person.emailAddress ? ` · ${person.emailAddress}` : ''}
              </span>
            </div>
            <button type="button" className="button small" onClick={() => onSave(person.name)}>
              짝짓기
            </button>
          </li>
        ))}
      </ul>
      <div className="modal__actions">
        {user.jiraName && (
          <button type="button" className="button danger" onClick={() => onSave(null)}>
            짝 지우기
          </button>
        )}
        <button type="button" className="button" onClick={onCancel}>
          취소
        </button>
      </div>
    </form>
  );
}

function NewUserForm({
  onCancel,
  onCreate,
}: {
  onCancel: () => void;
  onCreate: (input: { username: string; displayName: string; role: Role; password: string }) => void;
}) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<Role>('editor');
  const [password, setPassword] = useState('');
  return (
    <form
      className="new-user"
      onSubmit={(event) => {
        event.preventDefault();
        onCreate({ username: username.trim(), displayName: displayName.trim(), role, password });
      }}
    >
      <span className="field-label is-strong">새 사용자</span>
      <div className="token-form__grid">
        <div className="token-form__row">
          <label className="field-label" htmlFor="new-user-username">
            아이디
          </label>
          <input id="new-user-username" className="input" value={username} onChange={(event) => setUsername(event.target.value)} />
        </div>
        <div className="token-form__row">
          <label className="field-label" htmlFor="new-user-name">
            이름
          </label>
          <input id="new-user-name" className="input" value={displayName} placeholder="비우면 아이디" onChange={(event) => setDisplayName(event.target.value)} />
        </div>
        <div className="token-form__row">
          <label className="field-label" htmlFor="new-user-role">
            역할
          </label>
          <select id="new-user-role" className="select" value={role} onChange={(event) => setRole(event.target.value as Role)}>
            {(['viewer', 'editor', 'admin'] as Role[]).map((value) => (
              <option key={value} value={value}>
                {ROLE_LABELS[value]} — {ROLE_HINTS[value]}
              </option>
            ))}
          </select>
        </div>
        <div className="token-form__row">
          <label className="field-label" htmlFor="new-user-password">
            처음 비밀번호 (10자 이상)
          </label>
          <input id="new-user-password" className="input" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} />
        </div>
      </div>
      <div className="modal__actions">
        <button type="button" className="button" onClick={onCancel}>
          취소
        </button>
        <button type="submit" className="button primary" disabled={!username.trim() || !password}>
          만들기
        </button>
      </div>
    </form>
  );
}
