# Tevro

프로젝트의 공정(할 일)과 선후관계, 진행 상태를 한 화면에서 보는 도구입니다. 이 저장소의 코드는 핵심만 담은 첫 버전(MVP)입니다. 전체 요구사항과 결정 기록은 [`Tevro/`](Tevro/) 문서 폴더에 있습니다.

## 이번 버전에 들어간 것

- 프로젝트 만들기·고르기
- 공정 추가, 제목·설명 수정, 삭제(함께 지워지는 연결과 끊기는 순서를 먼저 보여 줌)
- 선후관계: 카드를 끌어 연결하고 지우기. 자기 자신 연결, 중복, 순환(경로 표시), 다른 프로젝트 공정 연결은 서버가 거부
- 실행 상태(미착수·진행 중·완료)와 선행 조건 충족 여부를 따로 표시. 선행 공정이 안 끝나도 상태 변경은 막지 않음
- 그래프: 연결 없는 공정까지 모두 표시, 자동 배치, 고른 공정의 앞뒤 경로 강조, 상태별 개수
- Jira 이슈·Confluence 문서 링크(공정당 각 1개, 링크만 저장)
- CLI: 화면과 같은 서버 API를 쓰고 `--json` 출력 제공
- 저장: SQLite 파일 하나(`data/tevro.db`)

## 아직 넣지 않은 것

공정 계층(상위·하위), 로그인·권한, 템플릿, Jira 연동(이슈 생성·상태 가져오기), 데드라인·담당자, 변경 묶음·dry-run·동시 수정 충돌 감지, 프로젝트 삭제, 폐쇄망 설치 패키지. ADR의 결정은 그대로 두고 구현만 미뤘습니다.

> 로그인이 없으므로 서버는 기본적으로 이 컴퓨터(localhost)에서만 접속됩니다.

## 실행

필요한 것: Node.js 22.18 이상, npm

```sh
npm install
npm run build   # 웹 화면 빌드
npm start       # http://localhost:4000
```

예시 프로젝트(공정 8개, 연결 6개)를 만들려면 서버를 켠 채로 다른 터미널에서 실행합니다. CLI로 데이터를 넣으므로 에이전트가 쓰는 흐름도 함께 볼 수 있습니다.

```sh
npm run demo
```

| 환경변수 | 기본값 | 뜻 |
| --- | --- | --- |
| `PORT` | `4000` | 서버 포트 |
| `HOST` | `127.0.0.1` | 다른 PC에서 접속하려면 `0.0.0.0` (로그인이 없으니 주의) |
| `TEVRO_DATA_DIR` | `./data` | SQLite 파일을 둘 폴더 |
| `TEVRO_SERVER` | `http://localhost:4000` | CLI가 접속할 서버 |

## CLI

```sh
node src/cli/main.ts --help
node src/cli/main.ts project list
node src/cli/main.ts graph show --project <프로젝트 ID>
node src/cli/main.ts task add --project <프로젝트 ID> --title "CI 구성" --status in-progress
node src/cli/main.ts dependency add --from <선행 공정 ID> --to <후속 공정 ID>
node src/cli/main.ts task status <공정 ID> --set done
node src/cli/main.ts task update <공정 ID> --jira-url https://jira.example.com/browse/ABC-1
node src/cli/main.ts task delete <공정 ID>         # 영향만 보여 줌
node src/cli/main.ts task delete <공정 ID> --yes   # 실제 삭제
```

`npm link`를 한 번 하면 `node src/cli/main.ts` 대신 `tevro`로 쓸 수 있습니다.

- `--json`을 붙이면 stdout에 `{"schemaVersion":1,"data":…}`를 쓰고, 실패하면 stderr에 `{"schemaVersion":1,"error":…}`를 씁니다.
- 종료 코드: 0 성공, 1 기타 오류, 2 사용법 오류·`--yes` 필요, 3 검증 실패(순환 등), 6 대상 없음, 8 서버 연결 실패.

## 확인 시나리오

| 해 볼 것 | 기대 결과 | 기준 |
| --- | --- | --- |
| `npm run demo` 후 화면 열기 | 공정 8개가 모두 보이고(연결 없는 '참고 문서 정리' 포함) 화살표 방향이 맞음 | AC-01 |
| 'GitOps 설정' 클릭 | 앞뒤 경로가 진해지고, 패널에 완료되지 않은 선행 공정(CI 구성, 실행환경 구성)이 보임 | AC-02 |
| GitOps 설정을 '진행 중'으로 변경 | 바뀌고, 선행 미충족 표시는 그대로 남음 | AC-03 |
| '배포' 카드 오른쪽 끝을 '저장소 준비'로 끌기 | "연결을 저장하지 않았습니다"와 순환 경로가 뜨고, 경로가 주황색으로 강조됨 | AC-04 |
| 제목을 바꾸거나 카드를 끌어 옮기기 | ID와 연결이 그대로임 | AC-05 |
| CLI로 상태를 바꾼 뒤 화면에서 새로고침 | 같은 내용이 보임(반대 방향도) | AC-13 |
| 서버를 껐다 켜기 | 데이터가 남아 있음 | F-P08 |

`npm test`는 위 항목과 AC-16(자기 자신 연결·중복 연결 거부), AC-18(동시에 들어온 A → B, B → A 중 하나만 저장)을 자동으로 확인합니다.

## 개발

```sh
npm run dev        # API 서버(4000) + Vite 개발 서버(5173, 화면 수정 즉시 반영)
npm test           # 도메인·API·CLI 테스트
npm run typecheck  # TypeScript 검사
```

서버와 CLI는 빌드 단계 없이 Node.js가 TypeScript를 바로 실행합니다(Node.js 22.18 이상의 타입 제거 기능).

## 구조

| 경로 | 내용 |
| --- | --- |
| `src/shared` | 서버·웹·CLI가 함께 쓰는 공정 규칙(순환 검사, 선행 조건 계산)과 API 타입 |
| `src/server` | HTTP API(`/api/v1`)와 SQLite 저장. 모든 쓰기는 한 트랜잭션 안에서 검증한 뒤 저장 |
| `src/web` | React + React Flow 화면. 빌드 결과(`dist/web`)를 서버가 함께 제공 |
| `src/cli` | Commander.js CLI |
| `scripts` | `demo`(예시 데이터), `dev`(개발 서버) |
| `test` | `node:test` 테스트 |
| `Tevro/` | 요구사항·결정 기록 문서(Obsidian) |
| `Tevro/db-schema.md` | 테이블 설계서(ERD, 컬럼 설명, 제약) |
