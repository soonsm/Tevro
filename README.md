# Tevro

프로젝트의 공정(할 일)과 선후관계, 진행 상태를 한 화면에서 보는 도구입니다. 이 저장소의 코드는 핵심만 담은 첫 버전(MVP)입니다. 전체 요구사항과 결정 기록은 [`Tevro/`](Tevro/) 문서 폴더에 있습니다.

## 이번 버전에 들어간 것

- 프로젝트 만들기·고르기
- 공정 추가, 제목·설명 수정, 삭제(함께 지워지는 연결과 끊기는 순서를 먼저 보여 줌)
- 선후관계: 카드를 끌어 연결하고 지우기. 자기 자신 연결, 중복, 순환(경로 표시), 다른 프로젝트 공정 연결은 서버가 거부
- 실행 상태(미착수·진행 중·완료)와 선행 조건 충족 여부를 따로 표시. 선행 공정이 안 끝나도 상태 변경은 막지 않음
- 공정 계층(상위·하위)
  - 화면은 한 번에 한 층. 상위 공정 카드의 [열기]나 두 번 누르기로 들어가고, 그래프 위에 뜬 줄(경로·상위 공정 상태·물려받는 선행)의 ← 버튼이나 Esc로 돌아옴
  - 연결은 같은 층(같은 상위 아래)의 공정끼리만. 상위에 맺은 선행은 하위가 물려받음
  - 하위가 하나라도 착수되면 상위가 진행 중으로, 하위가 모두 완료되면 상위가 완료로 자동 변경. 상위를 직접 바꿀 수도 있고, 어긋나면 막지 않고 표시
  - 상위 바꾸기(연결이 있으면 지워질 연결을 먼저 보여 주고 함께 지움), 하위가 있는 공정을 지우면 하위까지 삭제
  - 상태별 개수와 남은 공정은 말단 공정(하위가 없는 공정) 기준
- 그래프: 연결 없는 공정까지 모두 표시, 자동 배치, 고른 공정의 앞뒤 경로 강조, 상태별 개수
- Jira 이슈·Confluence 문서 링크(공정당 각 1개, 링크만 저장)
- 템플릿: 회사 템플릿(관리자가 관리, 모두 사용)과 내 템플릿(만든 사람만). 빈 템플릿 만들기, 프로젝트·템플릿을 복사해 템플릿으로 저장, 템플릿으로 새 프로젝트 만들기(진행 상태 초기화, Jira 링크 비움, Confluence 링크 복사), 출처(템플릿 이름·판) 기록. 아래 '템플릿'
- 로그인과 권한: 사용자 계정(열람자·편집자·관리자), 웹 세션, CLI·AI 에이전트용 개인 액세스 토큰(read·read-write, 만료일). 첫 관리자는 서버 관리 명령으로(아래 '로그인과 권한')
- CLI: 화면과 같은 서버 API를 쓰고 `--json` 출력 제공
- 저장: SQLite 파일 하나(`data/tevro.db`)

## 아직 넣지 않은 것

사내 계정(LDAP·SSO) 로그인, Jira 연동(이슈 생성·상태 가져오기), 데드라인·담당자, 변경 묶음·dry-run·동시 수정 충돌 감지, 프로젝트 삭제, 여러 층을 한 화면에 펼쳐 보기, 폐쇄망 설치 패키지. ADR의 결정은 그대로 두고 구현만 미뤘습니다.

> 서버는 기본적으로 이 컴퓨터(localhost)에서만 접속됩니다. 다른 PC에서 쓰거나 인터넷에 올릴 때는 HTTPS 프록시 뒤에 둡니다(아래 '인터넷에 올리기').

## 실행

필요한 것: Node.js 24.7 이상(비밀번호 해시에 내장 Argon2id를 씀), npm

```sh
npm install
npm run build   # 웹 화면 빌드
npm run admin -- user create --username admin --role admin   # 첫 관리자(비밀번호는 두 번 물음)
npm start       # http://localhost:4000 에서 그 계정으로 로그인
```

예시 프로젝트(공정 12개, 그중 '애플리케이션 개발' 아래 하위 공정 3개, 연결 10개)를 만들려면, 화면 오른쪽 위 계정 메뉴의 **내 토큰**에서 read-write 토큰을 발급한 뒤 서버를 켠 채로 다른 터미널에서 실행합니다. CLI로 데이터를 넣으므로 에이전트가 쓰는 흐름도 함께 볼 수 있습니다. 데이터는 체험 모드와 같은 [`trial/developer.json`](trial/README.md)입니다(일반직용: `npm run demo -- general`).

```sh
TEVRO_TOKEN=tevro_pat_… npm run demo
```

| 환경변수 | 기본값 | 뜻 |
| --- | --- | --- |
| `PORT` | `4000` | 서버 포트 |
| `HOST` | `127.0.0.1` | 다른 PC에서 접속하려면 `0.0.0.0` (HTTPS 프록시 뒤에 둘 것) |
| `TEVRO_DATA_DIR` | `./data` | SQLite 파일을 둘 폴더 |
| `TEVRO_SERVER` | `http://localhost:4000` | CLI가 접속할 서버 |
| `TEVRO_TOKEN` | 없음 | CLI: 개인 액세스 토큰. 없으면 `--token-file`, 그다음 `config set-token`으로 저장한 파일(`~/.config/tevro/token`) |
| `TEVRO_COOKIE_SECURE` | 없음 | 서버: `1`이면 로그인 쿠키에 항상 Secure. 없으면 프록시의 `X-Forwarded-Proto: https`를 보고 붙임 |
| `TEVRO_TRIAL` | 없음 | `1`이면 체험 모드(아래). 데이터 파일과 로그인을 쓰지 않음 |

첫 버전으로 만든 `data/tevro.db`는 서버가 시작할 때 계층을 담을 수 있게 자동으로 올립니다(기존 공정은 모두 최상위가 됨). 올리기 전 파일은 같은 폴더에 `tevro.db.schema1-….bak`으로 남습니다. 자세한 내용은 [`Tevro/db-schema.md`](Tevro/db-schema.md) 7장에 있습니다.

### 체험 모드

심사·시연처럼 여러 사람이 직접 조작해 보게 할 때 씁니다. `TEVRO_TRIAL=1 npm start`로 켭니다.

- 로그인 없이 열립니다. 서버를 켤 때 [`trial/`](trial/README.md)의 예시 데이터를 메모리에 원본으로 만들고, 브라우저 창마다 그 사본을 줍니다.
- 창에서 바꾼 내용은 그 사본에만 남습니다. 새로고침해도 유지되고, 창을 닫았다 다시 열면 처음 데이터로 돌아갑니다. 다른 사람의 창에는 영향이 없습니다.
- 화면 위 안내 띠의 버튼으로 예시 데이터(개발자용·일반직용)를 바꿉니다. 지금 것을 다시 누르면 처음 상태로 돌아갑니다. 바꾼 내용이 있으면 먼저 확인합니다.
- 2시간 동안 안 쓴 사본은 지우고(그 창은 다음 요청 때 처음 상태로 다시 시작), 사본은 동시에 500개까지만 둡니다(하나에 약 0.35MB).
- CLI는 쓸 수 없습니다(창이 없으므로 '웹 화면에서만 쓸 수 있습니다'로 끝남). 서버를 다시 켜면 모든 사본이 처음 상태로 돌아갑니다.

## 로그인과 권한

[ADR-0004](Tevro/adr/0004-authentication-authorization.md)를 구현했습니다. 체험 모드에는 적용하지 않습니다.

| 역할 | 할 수 있는 일 |
| --- | --- |
| 열람자 | 보기만. 토큰은 read만 발급 |
| 편집자 | 프로젝트·공정·연결·상태 바꾸기 |
| 관리자 | 편집자 + 사용자 관리(웹의 계정 메뉴 → 사용자 관리), 남의 토큰 폐기 |

- **첫 관리자와 비상 관리:** 서버 호스트에서 `npm run admin -- user create | list | reset-password | set-role | activate | deactivate`. 비밀번호는 명령행 인자로 받지 않고 터미널에서 묻거나 표준 입력으로 받습니다. 웹에서 먼저 가입한 사람이 관리자가 되는 화면은 없습니다.
- **웹:** 서버에 저장하는 세션 + HttpOnly·SameSite=Lax 쿠키. 바꾸는 요청은 CSRF 값과 출처(Origin)를 확인합니다. 8시간 안 쓰면, 길어도 7일이면 다시 로그인합니다. 같은 계정으로 5번 틀리면 15분 잠깁니다. 비밀번호는 10자 이상(Argon2id로 저장).
- **CLI·AI 에이전트:** 웹 계정 메뉴의 **내 토큰**에서 개인 액세스 토큰(`tevro_pat_…`)을 발급합니다. 범위는 read 또는 read-write, 만료는 1~365일(기본 30일)이고, 할 수 있는 일은 토큰 범위와 발급한 사람의 역할 중 좁은 쪽입니다. 서버에는 해시만 남습니다. 토큰으로는 새 토큰 발급과 사용자 관리를 할 수 없습니다.
- **사내 계정 연동 대비:** 사용자(`users`)와 로그인 수단(`auth_identities`: 공급자 + 공급자 안의 ID)을 나눠 두었습니다. LDAP·SSO는 `src/server/accounts.ts`의 `PasswordProvider`를 더해 붙이고, 사용자 ID와 기록은 그대로입니다.

## 템플릿

[요구사항 §6.6](Tevro/product-requirements.md)(F-T01~F-T10)을 구현했습니다. 화면 위 **템플릿** 버튼이 관리 창이고, 프로젝트 목록에도 템플릿 묶음이 따로 나옵니다.

| 구분 | 누가 보나 | 누가 고치고 지우나 |
| --- | --- | --- |
| 회사 템플릿 | 모두 | 관리자. 관리자가 개인 템플릿을 '회사 템플릿으로 지정'하거나 처음부터 회사 템플릿으로 만든다 |
| 내 템플릿 | 만든 사람(관리자는 모두) | 만든 사람(과 관리자). 열람자도 웹에서 자기 템플릿을 만들 수 있다 |

- **만들기:** 빈 템플릿, 지금 프로젝트를 템플릿으로 저장, 다른 템플릿(회사 템플릿 포함)을 **내 템플릿으로 복사**해 고쳐 쓰기.
- **편집:** 프로젝트와 같은 그래프 화면에서 합니다(연결·하위 공정·순환 검사 같음). 템플릿에는 진행 상태와 Jira 링크가 없습니다.
- **새 프로젝트:** [새 프로젝트] → '템플릿에서 시작' → 구조를 미리 보고 이름만 정합니다. 편집자 이상. 공정·연결·하위 구조가 새 ID로 복사되고, 진행 상태는 모두 미착수, Confluence 링크는 복사, Jira 링크는 비웁니다.
- **서로 독립:** 템플릿을 고쳐도 이미 만든 프로젝트는 바뀌지 않고, 그 반대도 같습니다.
- **판과 출처:** 프로젝트에는 '템플릿 ○○ N판으로 만듦'이 남습니다. 판은 템플릿을 고친 뒤 다시 프로젝트를 만들 때 하나 오릅니다(같은 판이면 같은 정의). 템플릿을 지워도 프로젝트와 출처 기록은 남습니다.
- **체험 모드:** 예시 데이터마다 회사 템플릿이 하나씩 있습니다(`trial/*.json`의 `templates`).

## CLI

```sh
node src/cli/main.ts --help
export TEVRO_TOKEN=tevro_pat_…                 # 웹 [내 토큰]에서 발급. 또는 config set-token --stdin
node src/cli/main.ts whoami                    # 토큰의 사용자·역할·범위
node src/cli/main.ts project list
node src/cli/main.ts graph show --project <프로젝트 ID>
node src/cli/main.ts task add --project <프로젝트 ID> --title "CI 구성" --status in-progress
node src/cli/main.ts dependency add --from <선행 공정 ID> --to <후속 공정 ID>
node src/cli/main.ts task status <공정 ID> --set done
node src/cli/main.ts task update <공정 ID> --jira-url https://jira.example.com/browse/ABC-1
node src/cli/main.ts task delete <공정 ID>         # 영향(하위 공정·연결)만 보여 줌
node src/cli/main.ts task delete <공정 ID> --yes   # 실제 삭제

# 계층
node src/cli/main.ts task add --project <프로젝트 ID> --parent <상위 공정 ID> --title "배치 개발"
node src/cli/main.ts task list --project <프로젝트 ID> --parent <상위 공정 ID>   # 직접 하위만 (--top: 최상위만)
node src/cli/main.ts graph show --project <프로젝트 ID> --root <상위 공정 ID>    # 그 공정 안의 층만
node src/cli/main.ts task move <공정 ID> --parent <새 상위 공정 ID>             # --top이면 최상위로
node src/cli/main.ts task move <공정 ID> --top --detach                         # 지워질 연결만 보여 줌
node src/cli/main.ts task move <공정 ID> --top --detach --yes                   # 연결을 지우고 옮김

# 템플릿 (템플릿 안의 공정·연결은 위 task·dependency 명령에 템플릿 ID를 --project로 넣어 고침)
node src/cli/main.ts template list                                             # 회사 템플릿·내 템플릿
node src/cli/main.ts template show <템플릿 ID>
node src/cli/main.ts template create --name "표준 서비스 준비"                  # 관리자는 --official로 회사 템플릿
node src/cli/main.ts template save --from <프로젝트 또는 템플릿 ID> --name "내 수정본"
node src/cli/main.ts template use <템플릿 ID> --name "결제 모듈 개편"            # 템플릿으로 새 프로젝트
node src/cli/main.ts template update <템플릿 ID> --official                     # 회사 템플릿으로 지정(관리자)
node src/cli/main.ts template delete <템플릿 ID> --yes
```

`npm link`를 한 번 하면 `node src/cli/main.ts` 대신 `tevro`로 쓸 수 있습니다.

- `--json`을 붙이면 stdout에 `{"schemaVersion":1,"data":…}`를 쓰고, 실패하면 stderr에 `{"schemaVersion":1,"error":…}`를 씁니다.
- 종료 코드: 0 성공, 1 기타 오류, 2 사용법 오류·`--yes` 필요, 3 검증 실패(순환, 다른 층 연결, 자기 하위로 옮기기, 연결이 남은 공정 옮기기 등), 4 인증·권한(토큰 없음·만료·폐기, 범위·역할 부족, 다른 사람도 읽을 수 있는 토큰 파일), 6 대상 없음, 8 서버 연결 실패.
- 토큰은 `TEVRO_TOKEN`, `--token-file <경로>`(권한 600), `tevro config set-token --stdin`으로 저장한 파일 중 하나로 받습니다. 명령행 인자로는 받지 않고, 출력·오류에도 쓰지 않습니다. `tevro config show`는 토큰을 어디서 읽는지만 보여 줍니다.
- 상태를 바꾸다 상위 공정이 자동으로 바뀌면 함께 알려 줍니다(`--json`에서는 `autoTransitions`).

## 인터넷에 올리기

Oracle Cloud 무료 가상 서버에 올리는 스크립트와 안내가 [`deploy/oracle/`](deploy/oracle/README.md)에 있습니다. 서버에서 명령 두 줄로 Node.js·Caddy 설치, 빌드, systemd 서비스, HTTPS 인증서, 방화벽 설정까지 끝납니다. 보통 서버는 계정으로 로그인하고, 첫 관리자는 서버에서 `sudo tevro-admin`으로 만듭니다. 체험 서버로 열려면 `--trial`을 붙입니다.

## 확인 시나리오

| 해 볼 것 | 기대 결과 | 기준 |
| --- | --- | --- |
| 로그인 후 `TEVRO_TOKEN=… npm run demo`, 화면 새로고침 | 최상위 공정 9개가 모두 보이고(연결 없는 '참고 문서 정리' 포함) 화살표 방향이 맞음. '애플리케이션 개발' 카드에 하위 1/3 | AC-01, F-H07 |
| 'GitOps 설정' 클릭 | 앞뒤 경로가 진해지고, 패널에 완료되지 않은 선행 공정(CI 구성, 실행환경 구성)이 보임 | AC-02 |
| GitOps 설정을 '진행 중'으로 변경 | 바뀌고, 선행 미충족 표시는 그대로 남음 | AC-03 |
| '배포' 카드 오른쪽 끝을 '저장소 준비'로 끌기 | "연결을 저장하지 않았습니다"와 순환 경로가 뜨고, 경로가 주황색으로 강조됨 | AC-04 |
| 제목을 바꾸거나 카드를 끌어 옮기기 | ID와 연결이 그대로임 | AC-05 |
| CLI로 상태를 바꾼 뒤 화면에서 새로고침 | 같은 내용이 보임(반대 방향도) | AC-13 |
| 서버를 껐다 켜기 | 데이터가 남아 있음 | F-P08 |
| '애플리케이션 개발'의 [열기] | 하위 3개와 그 사이 연결만 보이고, 위쪽에 '신규 서비스 준비 › 애플리케이션 개발'과 '이 층 전체의 선행: 저장소 준비'가 보임. '배치 개발'을 고르면 패널에 물려받은 선행이 보임 | F-H07, AC-28 |
| 하위의 '배치 개발'·'개발 결과 검토'를 완료로 변경 | '상위 공정 상태가 자동으로 바뀌었습니다' 알림과 함께 '애플리케이션 개발'이 완료가 되고, 최상위의 '통합 검증'의 미충족 선행에서 빠짐 | AC-25, AC-28 |
| 그다음 하위 하나를 다시 진행 중으로 변경 | 상위는 완료로 남고, 상위 카드와 패널에 어긋남 경고가 보임 | AC-26 |
| '배포'를 골라 [옮기기]로 다른 상위 아래로 | 지워질 연결(통합 검증 → 배포)을 먼저 보여 주고, 확인하면 연결을 지우고 옮김 | AC-32 |
| CLI로 `task add --parent` 후 화면 새로고침 | 그 상위 안에 같은 ID로 보임 | AC-31 |

`npm test`는 위 항목과 AC-16(자기 자신 연결·중복 연결 거부), AC-18(동시에 들어온 A → B, B → A 중 하나만 저장), AC-27(다른 층 연결 거부), AC-29(자기 하위로 옮기기 거부), 첫 버전 DB의 스키마 올리기, 로그인·세션 만료·잠금·CSRF·역할·토큰 범위와 만료·관리 명령, 템플릿의 복사 규칙·독립성·출처·권한(AC-07, AC-08, AC-22, AC-30)을 자동으로 확인합니다.

## 개발

```sh
npm run dev        # API 서버(4000) + Vite 개발 서버(5173, 화면 수정 즉시 반영)
npm test           # 도메인·API·CLI 테스트
npm run typecheck  # TypeScript 검사
```

서버와 CLI는 빌드 단계 없이 Node.js가 TypeScript를 바로 실행합니다(Node.js의 타입 제거 기능).

## 구조

| 경로 | 내용 |
| --- | --- |
| `src/shared` | 서버·웹·CLI가 함께 쓰는 공정 규칙(순환 검사, 선행 조건 계산)과 API 타입 |
| `src/server` | HTTP API(`/api/v1`)와 SQLite 저장. 모든 쓰기는 한 트랜잭션 안에서 검증한 뒤 저장. 사용자·세션·토큰은 `accounts.ts`, 서버 관리 명령은 `admin.ts` |
| `src/web` | React + React Flow 화면. 빌드 결과(`dist/web`)를 서버가 함께 제공 |
| `src/cli` | Commander.js CLI |
| `scripts` | `demo`(예시 데이터를 CLI로 넣기), `dev`(개발 서버) |
| `trial` | 체험 모드와 `npm run demo`가 쓰는 예시 데이터(JSON)와 형식 안내 |
| `deploy/oracle` | Oracle Cloud 설치 스크립트와 안내 |
| `test` | `node:test` 테스트(도메인 규칙, API, CLI, 스키마 마이그레이션, 선 배치, 체험 모드, 로그인·권한, 템플릿) |
| `Tevro/` | 요구사항·결정 기록 문서(Obsidian) |
| `Tevro/db-schema.md` | 테이블 설계서(ERD, 컬럼 설명, 제약) |
