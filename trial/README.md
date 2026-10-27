# 체험 모드 예시 데이터

체험 서버(`TEVRO_TRIAL=1`, 설치 스크립트의 `--trial`)가 보여 주는 예시 데이터입니다. 서버를 켤 때 이 폴더의 `*.json`을 모두 읽어 메모리에 원본을 만들고, 브라우저 창마다 그 사본을 줍니다. 화면 위 안내 띠의 버튼 하나가 파일 하나입니다.

| 파일 | 버튼 | 내용 |
| --- | --- | --- |
| `developer.json` | 개발자용 데이터 | 신규 서비스 준비(저장소·CI·GitOps·개발·검증·배포). `npm run demo`도 이 파일을 씁니다 |
| `general.json` | 일반직용 데이터 | 신입사원 입사 준비. **임시 예시**이며 실제 데이터로 바꿀 예정입니다 |

## 바꾸는 방법

1. 이 폴더의 파일을 고치거나 새 파일을 더합니다. 파일 이름은 영문 소문자·숫자·`-`만 씁니다(예: `sales.json`).
2. 저장소에 올린 뒤 서버에서 설치 스크립트를 다시 실행합니다: `sudo bash /opt/tevro/deploy/oracle/install.sh`
3. 서버가 다시 켜지면서 새 원본을 만듭니다. 그때 열려 있던 창의 사본도 모두 처음 상태로 돌아갑니다.

파일에 잘못된 곳이 있으면 서버가 켜지지 않고, 어느 파일의 무엇이 틀렸는지 로그에 남깁니다(`journalctl -u tevro -n 30`). 설치 스크립트도 여기서 멈춥니다. 고치기 전에 내 컴퓨터에서 확인하려면 `TEVRO_TRIAL=1 npm start`.

## 형식

```json
{
  "label": "일반직용 데이터",
  "order": 2,
  "projects": [
    {
      "name": "신입사원 입사 준비",
      "tasks": [
        { "key": "papers", "title": "입사 서류 받기", "status": "done" },
        { "key": "workplace", "title": "근무 환경 준비" },
        { "key": "account", "title": "사내 계정 발급", "status": "in-progress", "parent": "workplace" }
      ],
      "dependencies": [["papers", "workplace"]]
    }
  ]
}
```

| 항목 | 필수 | 뜻 |
| --- | --- | --- |
| `label` | ○ | 안내 띠의 버튼 글자 |
| `order` | | 버튼 순서(작은 수가 먼저). 가장 앞의 데이터가 새 창의 기본값 |
| `projects` | ○ | 프로젝트 목록. 여러 개면 화면 위 '프로젝트' 선택에 모두 나옵니다 |
| `projects[].name` | ○ | 프로젝트 이름 |
| `projects[].description` | | 프로젝트 설명 |
| `tasks[].key` | ○ | 이 파일 안에서만 쓰는 공정 이름표. 연결과 상위 공정을 적을 때 씁니다 |
| `tasks[].title` | ○ | 공정 제목 |
| `tasks[].status` | | `todo`(미착수, 기본), `in-progress`(진행 중), `done`(완료) |
| `tasks[].parent` | | 상위 공정의 `key`. 적으면 그 공정의 하위 공정이 됩니다 |
| `tasks[].description` | | 설명(작업 절차, 완료 기준 등) |
| `tasks[].jiraUrl`, `tasks[].confluenceUrl` | | 링크 |
| `dependencies` | | `["선행 key", "후속 key"]` 목록. 화면에서처럼 같은 상위 아래의 공정끼리만, 순환 없이 |

화면에서 직접 만들 때와 같은 규칙이 적용됩니다. 하위 공정이 하나라도 착수 상태면 상위 공정은 미착수로 적어도 진행 중으로 바뀝니다. 다른 층의 공정을 잇거나 순환을 만들면 오류로 멈춥니다.
