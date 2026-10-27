# Oracle Cloud에 올리기

Oracle Cloud의 무료(Always Free) 가상 서버에 Tevro를 올려, 인터넷이 되는 곳 어디서나 `https://<도메인>`으로 쓰는 방법입니다. 설치는 `install.sh` 한 번으로 끝납니다.

구성은 이렇습니다. Caddy가 HTTPS 인증서(Let's Encrypt)를 자동으로 받아 443번 포트로 접속을 받고, 같은 서버 안의 Tevro(127.0.0.1:4000)로 넘깁니다. Tevro 포트는 밖에 열지 않습니다.

> **임시 공용 비밀번호:** 정식 로그인([ADR-0004](../../Tevro/adr/0004-authentication-authorization.md))을 만들기 전까지 쓰는 장치입니다. 모두 같은 비밀번호를 쓰고, 누가 무엇을 바꿨는지는 남지 않습니다. 비밀번호를 아는 사람은 모든 데이터를 고치고 지울 수 있습니다.

## 준비물

- Oracle Cloud 계정
- 도메인. 없으면 [DuckDNS](https://www.duckdns.org)에서 `<이름>.duckdns.org`를 무료로 만들 수 있습니다.
- SSH로 서버에 접속할 수 있는 컴퓨터(macOS·Linux 터미널, Windows PowerShell)

## 1. 가상 서버 만들기

이미 쓰는 Ubuntu 서버가 있으면 그 서버를 써도 됩니다. 단, 80·443번 포트를 다른 프로그램(nginx 등)이 쓰고 있으면 설치 스크립트가 멈춥니다.

Oracle 콘솔에서 Compute → Instances → Create instance:

| 항목 | 고를 것 |
| --- | --- |
| Image | Canonical Ubuntu 24.04(또는 22.04) |
| Shape | `VM.Standard.A1.Flex`(Ampere, OCPU 1개·메모리 6GB면 충분) 또는 `VM.Standard.E2.1.Micro`(메모리 1GB, 느리지만 동작). 'Always Free-eligible' 표시가 있는 것 |
| Networking | 공인 IPv4 주소 자동 할당(Assign a public IPv4 address)을 켬 |
| SSH keys | 키를 만들어 내려받거나, 가진 공개 키를 올림 |

만든 뒤 인스턴스 상세 화면의 **공인 IP 주소(Public IP address)**를 적어 둡니다.

## 2. 80·443 포트 열기(Oracle 콘솔)

인스턴스 상세 화면 → 서브넷(Subnet) → 보안 목록(Security Lists)의 기본 목록 → 수신 규칙 추가(Add Ingress Rules)에서 두 규칙을 더합니다.

| Source CIDR | IP Protocol | Destination Port Range |
| --- | --- | --- |
| `0.0.0.0/0` | TCP | `80` |
| `0.0.0.0/0` | TCP | `443` |

80번은 인증서 발급과 HTTPS로 넘겨 주는 데 씁니다. 서버 안의 방화벽(iptables)은 설치 스크립트가 엽니다. 네트워크 보안 그룹(NSG)을 쓰는 서버라면 그 NSG에 같은 규칙을 더합니다.

## 3. 도메인 연결

- **내 도메인:** DNS 관리 화면에서 A 레코드를 만들어 서버의 공인 IP를 가리키게 합니다(예: `tevro.example.com` → `203.0.113.10`).
- **Cloudflare에서 관리하는 도메인:** A 레코드의 프록시 상태를 **DNS only(회색 구름)**로 둡니다. Proxied(주황 구름)로 두면 Cloudflare의 SSL/TLS 설정에 따라 '리디렉션이 너무 많음' 오류가 나거나 Caddy의 인증서 발급이 실패할 수 있습니다. 이 안내는 회색 구름 기준입니다.
- **DuckDNS:** duckdns.org에 로그인 → 하위 도메인 이름을 정해 추가 → `current ip`에 서버 공인 IP를 넣고 `update ip`. 주소는 `<이름>.duckdns.org`가 됩니다. PC 브라우저에서 만들면 `current ip`에 그 PC의 IP가 들어가 있을 수 있으니 서버 IP로 바꿨는지 꼭 확인하세요.

확인: 내 컴퓨터에서 `nslookup <도메인>` 결과가 서버 공인 IP면 됩니다. 반영에 몇 분 걸릴 수 있습니다.

## 4. 설치

SSH로 서버에 접속합니다. Ubuntu 이미지의 기본 사용자는 `ubuntu`입니다.

```sh
ssh -i <내려받은 키 파일> ubuntu@<공인 IP>
```

서버에서 실행합니다. `<도메인>`을 바꿔 넣으세요. 지금은 앱 코드가 `claude/zealous-ride-imn72j` 브랜치에 있습니다(`main`에 합치면 `--branch`를 빼도 됩니다). Ubuntu Minimal 이미지에는 `curl`이 없을 수 있어 첫 줄에서 설치합니다.

```sh
sudo apt-get update && sudo apt-get install -y curl
curl -fsSLO https://raw.githubusercontent.com/soonsm/Tevro/refs/heads/claude/zealous-ride-imn72j/deploy/oracle/install.sh
sudo bash install.sh --domain <도메인> --branch claude/zealous-ride-imn72j
```

작은 서버에서는 10분 가까이 걸릴 수 있습니다. 스크립트가 하는 일:

1. 기본 패키지, Node.js 22(NodeSource), Caddy(공식 저장소) 설치. 메모리가 2GB보다 작으면 빌드용 스왑 2GB를 만듭니다.
2. `tevro` 시스템 사용자를 만들고, 코드를 `/opt/tevro`에 받아 빌드합니다.
3. 설정 파일 `/etc/tevro/tevro.env`(비밀번호 포함, root만 읽음)와 systemd 서비스 `tevro`를 만들고 시작합니다.
4. Caddy를 설정하고, Oracle Ubuntu 이미지의 iptables 방화벽에 80·443을 엽니다.

끝나면 주소와 **비밀번호**가 한 번 나옵니다. 지금 적어 두세요. 나중에 다시 보려면 `sudo grep TEVRO_PASSWORD /etc/tevro/tevro.env`.

## 5. 접속

브라우저에서 `https://<도메인>`을 엽니다. 로그인 창이 뜨면 사용자 이름은 비우거나 아무거나 쓰고, 비밀번호를 넣습니다. 처음 몇 분은 인증서를 받는 중이라 접속이 안 될 수 있습니다.

예시 프로젝트를 넣어 보려면 서버에서(체험 모드가 아닐 때):

```sh
sudo bash -c 'set -a && . /etc/tevro/tevro.env && cd /opt/tevro && node scripts/demo.ts'
```

마지막 줄에 나오는 `http://localhost:4000/...` 대신 `https://<도메인>`으로 여세요.

## 6. 내 컴퓨터의 CLI로 쓰기

저장소를 받은 컴퓨터에서 서버 주소와 비밀번호를 환경변수로 넘깁니다. 비밀번호는 명령행 인자로 받지 않습니다.

```sh
export TEVRO_SERVER=https://<도메인>
export TEVRO_PASSWORD=<비밀번호>
node src/cli/main.ts project list
```

비밀번호가 없거나 틀리면 종료 코드 4로 끝납니다.

## 7. 체험 서버로 쓰기

심사위원이나 동료가 비밀번호 없이 직접 조작해 보게 하려면 체험 모드로 엽니다.

```sh
sudo bash /opt/tevro/deploy/oracle/install.sh --trial
```

> 2026-10-27 이전에 설치한 서버는 `/opt/tevro`에 있는 설치 스크립트가 옛 버전이라 `모르는 옵션: --trial`로 멈춥니다. 처음 한 번만 인자 없이 실행해 최신 스크립트를 받은 뒤 `--trial`을 붙여 다시 실행하세요. 그 뒤로는 스크립트가 실행될 때마다 옵션을 보기 전에 먼저 최신 버전을 받아 다시 실행하므로, 새 옵션도 바로 쓸 수 있습니다.
>
> ```sh
> sudo bash /opt/tevro/deploy/oracle/install.sh
> sudo bash /opt/tevro/deploy/oracle/install.sh --trial
> ```

- 비밀번호 없이 열립니다. 화면 위 안내 띠에서 예시 데이터(개발자용·일반직용)를 고릅니다.
- 바꾼 내용은 각자의 브라우저 창에만 남습니다. 새로고침해도 유지되고, 창을 닫았다 다시 열면 처음 데이터로 돌아갑니다. 서버의 데이터 파일(`tevro.db`)은 쓰지도 바꾸지도 않습니다.
- 예시 데이터는 저장소의 `trial/*.json`입니다([형식](../../trial/README.md)). 바꾼 뒤 저장소에 올리고 설치 스크립트를 인자 없이 다시 실행하면 반영됩니다. 이때 열려 있던 창의 사본도 처음 상태로 돌아갑니다.
- 끄기: `sudo bash /opt/tevro/deploy/oracle/install.sh --no-trial`. 보통 서버로 돌아가며, 전에 쓰던 비밀번호와 데이터 파일을 그대로 씁니다.
- 체험 서버에는 CLI로 접속할 수 없습니다. 2시간 동안 안 쓴 창의 사본은 지워지고, 그 창은 다시 열 때처럼 처음 상태로 시작합니다.

## 운영

| 할 일 | 방법 |
| --- | --- |
| 최신 코드로 갱신 | `sudo bash /opt/tevro/deploy/oracle/install.sh` (인자 없이. 처음 정한 도메인·브랜치·비밀번호·체험 모드를 그대로 씀). 스크립트도 먼저 최신으로 받아 그것으로 실행합니다 |
| 체험 모드 켜기·끄기 | 같은 명령에 `--trial` 또는 `--no-trial`. 한 번 정하면 이후 갱신에도 유지됩니다(7장) |
| 도메인 바꾸기 | 새 도메인의 DNS를 서버 공인 IP로 건 뒤 `sudo bash /opt/tevro/deploy/oracle/install.sh --domain <새 도메인>`. 이후 갱신에도 새 도메인이 쓰이고, 예전 도메인으로는 더는 열리지 않습니다. 데이터와 비밀번호는 그대로입니다 |
| 비밀번호 바꾸기 | `/etc/tevro/tevro.env`의 `TEVRO_PASSWORD`를 고친 뒤 `sudo systemctl restart tevro`. 12자 이상, 영문·숫자와 `. _ ~ ! @ % ^ * + = : , -`만 |
| 상태·로그 | `systemctl status tevro`, `journalctl -u tevro -f`, 인증서는 `journalctl -u caddy -f` |
| 다시 시작 | `sudo systemctl restart tevro` |
| 데이터 위치 | `/var/lib/tevro/data/tevro.db`(같은 폴더의 `-wal`·`-shm` 파일까지 한 묶음) |
| 백업 | `sudo systemctl stop tevro && sudo cp -a /var/lib/tevro/data ~/tevro-backup-$(date +%F) && sudo systemctl start tevro`. Oracle의 부트 볼륨 백업(무료 5개)을 함께 쓰면 좋습니다 |

스키마가 바뀐 버전으로 갱신하면 서버가 시작할 때 데이터 파일을 올리고, 올리기 전 파일을 같은 폴더에 `tevro.db.schema…bak`으로 남깁니다.

## 알아 둘 것

- **유휴 서버 회수:** Oracle은 Always Free 서버가 7일 동안 CPU·네트워크(Ampere는 메모리도) 사용률 20% 미만이면 회수할 수 있다고 [공식 문서](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)에 적고 있습니다. Tevro는 평소 거의 쉬므로 해당될 수 있습니다. 백업을 두고, 서버가 멈추면 콘솔에서 다시 시작하세요. 종량제(Pay As You Go) 계정은 회수 대상에서 빠진다는 이야기가 있지만 공식 문서로 확인하지 못했습니다.
- **데이터 위치:** 데이터가 Oracle Cloud에 저장됩니다. 실제 업무 데이터를 넣어도 되는지는 사내 기준을 확인하세요. 최종 설치는 폐쇄망이 기준입니다(PRD N-02).
- **시험 범위:** 이 스크립트는 Ubuntu 24.04(x86_64) 컨테이너에서 설치, 비밀번호, HTTPS 프록시, 갱신, 방화벽 단계를 확인했습니다. Ampere(arm64) 서버와 실제 Let's Encrypt 발급은 시험하지 못했습니다.

## 문제 해결

| 증상 | 확인할 것 |
| --- | --- |
| 브라우저가 접속하지 못함 | 2번의 수신 규칙(80·443), `nslookup <도메인>`이 공인 IP인지, `sudo ss -ltnp \| grep -E ':(80\|443) '`에 caddy가 있는지 |
| 인증서 오류 | DNS가 반영되기 전에 발급을 시도한 경우가 많습니다. 몇 분 기다리거나 `sudo systemctl restart caddy`. 같은 도메인으로 발급에 계속 실패하면 Let's Encrypt가 한동안 막으므로 `journalctl -u caddy`의 원인을 먼저 고칩니다 |
| 로그인 창이 계속 다시 뜸 | 비밀번호 확인: `sudo grep TEVRO_PASSWORD /etc/tevro/tevro.env` |
| 설치가 빌드 단계에서 멈춤 | 메모리 부족일 수 있습니다. `free -h`로 스왑을 확인하거나 메모리가 더 큰 Shape를 씁니다 |
| `502` 오류 | Tevro 서버가 멈춘 상태입니다. `journalctl -u tevro -n 50` |
