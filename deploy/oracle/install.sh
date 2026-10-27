#!/usr/bin/env bash
# Tevro를 Oracle Cloud의 Ubuntu 가상 서버(22.04·24.04)에 설치한다. 다시 실행하면 최신 코드로 갱신한다.
#
# 처음 설치(가상 서버에서):
#   curl -fsSLO https://raw.githubusercontent.com/soonsm/Tevro/refs/heads/<브랜치>/deploy/oracle/install.sh
#   sudo bash install.sh --domain <도메인> --branch <브랜치>
# 갱신(처음 설치한 도메인·브랜치·체험 모드를 그대로 씀):
#   sudo bash /opt/tevro/deploy/oracle/install.sh
# 체험 서버로 쓰기(비밀번호 없이, 브라우저 창마다 trial/*.json 예시 데이터의 사본): --trial, 끄기: --no-trial
#
# 하는 일: Node.js 22와 Caddy 설치 → tevro 사용자·폴더 → 코드 받기·빌드 → systemd 서비스 →
#          Caddy로 HTTPS(Let's Encrypt 인증서 자동) → Oracle Ubuntu 이미지 방화벽(iptables)에 80·443 열기.
# 접속 비밀번호는 처음 설치할 때 만들어 /etc/tevro/tevro.env에 둔다. 직접 정하려면 TEVRO_PASSWORD로 넘긴다.
# 체험 모드에서는 비밀번호를 쓰지 않는다(파일에는 남겨 두어, 체험 모드를 끄면 다시 쓰인다).
# 자세한 안내: deploy/oracle/README.md
set -euo pipefail

# 포크 등 다른 저장소에서 설치하려면 TEVRO_REPO_URL로 바꾼다.
REPO_URL="${TEVRO_REPO_URL:-https://github.com/soonsm/Tevro.git}"
APP_DIR=/opt/tevro
TEVRO_HOME=/var/lib/tevro
DATA_DIR=/var/lib/tevro/data
CONF_DIR=/etc/tevro
ENV_FILE=/etc/tevro/tevro.env
INSTALL_CONF=/etc/tevro/install.conf
PORT=4000
MARK="deploy/oracle/install.sh가 만든 파일"

log() { printf '\n==> %s\n' "$*"; }
warn() { printf '[주의] %s\n' "$*" >&2; }
fail() {
  printf '\n[중단] %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
사용법: sudo bash install.sh --domain <도메인> [--branch <브랜치>] [--trial | --no-trial]
  --domain    Tevro를 열 주소. 이 서버의 공인 IP를 가리키는 도메인(예: tevro.example.com, myname.duckdns.org)
  --branch    설치할 Git 브랜치(기본: main)
  --trial     체험 서버로 연다. 비밀번호 없이 누구나 조작할 수 있고, 바꾼 내용은 각자의 브라우저 창에만 남는다
              (창을 닫으면 처음 데이터로). 예시 데이터는 저장소의 trial/*.json
  --no-trial  체험 모드를 끄고 보통 서버(비밀번호, 데이터 파일)로 되돌린다
처음 설치한 뒤에는 인자 없이 다시 실행하면 같은 설정으로 최신 코드를 받아 다시 시작합니다.
비밀번호를 직접 정하려면: sudo TEVRO_PASSWORD='12자 이상' bash install.sh ...
EOF
}

# tevro 사용자로 실행한다. runuser는 HOME을 바꾸지 않으므로 직접 넘긴다(npm 캐시 위치).
as_tevro() { runuser -u tevro -- env HOME="$TEVRO_HOME" "$@"; }

node_ok() {
  command -v node >/dev/null 2>&1 &&
    node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 18) ? 0 : 1)'
}

install_node() {
  node_ok && return
  log "Node.js 22 설치(NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -q nodejs >/dev/null
  node_ok || fail "Node.js 22.18 이상을 설치하지 못했습니다."
}

install_caddy() {
  command -v caddy >/dev/null 2>&1 && return
  log "Caddy 설치(공식 저장소)"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' |
    gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' >/etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q >/dev/null
  apt-get install -y -q caddy >/dev/null
}

# 메모리가 1GB인 작은 서버(VM.Standard.E2.1.Micro)에서 빌드가 메모리 부족으로 죽지 않게 스왑을 둔다.
ensure_swap() {
  local mem_kb
  mem_kb="$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo)"
  [ "$mem_kb" -lt 2000000 ] || return 0
  [ -z "$(swapon --noheadings --show 2>/dev/null)" ] || return 0
  log "메모리가 2GB보다 작아 빌드에 쓸 스왑 2GB를 만듭니다"
  if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
  fi
  swapon /swapfile || warn "스왑을 켜지 못했습니다. 빌드가 메모리 부족으로 실패하면 메모리가 더 큰 서버를 쓰세요."
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
}

# Oracle의 Ubuntu 이미지는 iptables INPUT 끝에 REJECT 규칙이 있어 SSH(22) 말고는 막혀 있다. 그 앞에 80·443을 연다.
open_firewall() {
  if iptables -S INPUT 2>/dev/null | grep -q -- '-j REJECT'; then
    local port position
    for port in 80 443; do
      iptables -C INPUT -p tcp -m conntrack --ctstate NEW --dport "$port" -j ACCEPT 2>/dev/null && continue
      position="$(iptables -L INPUT --line-numbers -n | awk '$2 == "REJECT" { print $1; exit }')"
      iptables -I INPUT "$position" -p tcp -m conntrack --ctstate NEW --dport "$port" -j ACCEPT
    done
    if command -v netfilter-persistent >/dev/null 2>&1; then
      netfilter-persistent save >/dev/null 2>&1
    else
      install -d /etc/iptables
      iptables-save >/etc/iptables/rules.v4
      warn "netfilter-persistent가 없어 /etc/iptables/rules.v4에만 저장했습니다. 재부팅 뒤에도 80·443이 열려 있는지 확인하세요."
    fi
  fi
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then
    ufw allow 80/tcp >/dev/null
    ufw allow 443/tcp >/dev/null
  fi
}

write_caddyfile() {
  local domain="$1" caddyfile=/etc/caddy/Caddyfile
  if [ -f "$caddyfile" ] && ! grep -q "$MARK" "$caddyfile" &&
    ! grep -q 'The Caddyfile is an easy way to configure your Caddy web server' "$caddyfile"; then
    cp "$caddyfile" "$caddyfile.before-tevro"
    warn "원래 있던 Caddy 설정을 $caddyfile.before-tevro 에 남기고 새로 씁니다."
  fi
  cat >"$caddyfile" <<EOF
# Tevro($MARK). 다시 실행하면 덮어씁니다.
$domain {
	encode zstd gzip
	reverse_proxy 127.0.0.1:$PORT
}
EOF
  if ! caddy validate --config "$caddyfile" --adapter caddyfile >/dev/null 2>&1; then
    caddy validate --config "$caddyfile" --adapter caddyfile || true
    fail "Caddy 설정 검사에 실패했습니다: $caddyfile"
  fi
  systemctl enable caddy >/dev/null 2>&1
  systemctl reload caddy 2>/dev/null || systemctl restart caddy
}

write_service() {
  cat >/etc/systemd/system/tevro.service <<EOF
# $MARK
[Unit]
Description=Tevro
After=network-online.target
Wants=network-online.target

[Service]
User=tevro
Group=tevro
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$(command -v node) src/server/main.ts
Restart=on-failure
RestartSec=3
# 쓰기는 데이터 폴더에만 허용한다.
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable tevro >/dev/null 2>&1
  systemctl restart tevro
}

wait_for_server() {
  local _
  for _ in $(seq 1 30); do
    curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && return 0
    sleep 1
  done
  journalctl -u tevro -n 30 --no-pager || true
  fail "Tevro 서버가 뜨지 않았습니다. 위 로그를 확인하세요."
}

main() {
  local domain="" branch="" trial=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --domain) domain="${2:?--domain 값이 없습니다}"; shift 2 ;;
      --branch) branch="${2:?--branch 값이 없습니다}"; shift 2 ;;
      --trial) trial=1; shift ;;
      --no-trial) trial=0; shift ;;
      -h | --help) usage; exit 0 ;;
      *) usage >&2; fail "모르는 옵션: $1" ;;
    esac
  done

  [ "$(id -u)" -eq 0 ] || fail "관리자 권한이 필요합니다. 'sudo bash $0 ...'로 실행하세요."
  command -v apt-get >/dev/null 2>&1 || fail "apt를 쓰는 Ubuntu(22.04·24.04)에서만 동작합니다."
  # shellcheck source=/dev/null
  . /etc/os-release
  [ "${ID:-}" = ubuntu ] || warn "Ubuntu 22.04·24.04를 기준으로 만든 스크립트입니다(지금: ${PRETTY_NAME:-알 수 없음})."

  if [ -f "$INSTALL_CONF" ]; then
    # shellcheck source=/dev/null
    . "$INSTALL_CONF"
    domain="${domain:-${TEVRO_DOMAIN:-}}"
    branch="${branch:-${TEVRO_BRANCH:-}}"
    trial="${trial:-${TEVRO_TRIAL:-}}"
  fi
  branch="${branch:-main}"
  trial="${trial:-0}"
  [[ "$trial" =~ ^[01]$ ]] || fail "$INSTALL_CONF 의 TEVRO_TRIAL은 0 또는 1이어야 합니다: $trial"
  [ -n "$domain" ] || { usage >&2; fail "--domain을 지정하세요."; }
  [[ "$domain" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || fail "도메인 형식이 아닙니다: $domain"
  [[ "$branch" =~ ^[A-Za-z0-9._/-]+$ ]] || fail "브랜치 이름 형식이 아닙니다: $branch"

  log "1/7 기본 패키지"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q >/dev/null
  apt-get install -y -q ca-certificates curl gnupg git build-essential python3 iproute2 iptables >/dev/null
  local busy
  busy="$(ss -Hltnp '( sport = :80 or sport = :443 )' 2>/dev/null | grep -v '"caddy"' || true)"
  [ -z "$busy" ] || fail "80·443 포트를 이미 다른 프로그램이 쓰고 있습니다. 그 프로그램을 멈추거나 다른 서버를 쓰세요.
$busy"
  ensure_swap

  log "2/7 Node.js·Caddy"
  install_node
  install_caddy

  log "3/7 tevro 사용자와 폴더"
  id -u tevro >/dev/null 2>&1 || useradd --system --user-group --home-dir "$TEVRO_HOME" --shell /usr/sbin/nologin tevro
  install -d -o tevro -g tevro -m 750 "$TEVRO_HOME" "$DATA_DIR"
  install -d -o tevro -g tevro -m 755 "$APP_DIR"
  install -d -m 755 "$CONF_DIR"

  log "4/7 코드 받기: $branch"
  if [ -d "$APP_DIR/.git" ]; then
    as_tevro git -C "$APP_DIR" fetch --quiet --depth 1 origin "$branch"
    as_tevro git -C "$APP_DIR" reset --quiet --hard FETCH_HEAD
  else
    as_tevro git clone --quiet --depth 1 --branch "$branch" "$REPO_URL" "$APP_DIR"
  fi
  [ -f "$APP_DIR/package.json" ] ||
    fail "'$branch' 브랜치에 Tevro 앱 코드(package.json)가 없습니다. --branch를 확인하세요."

  log "5/7 의존성 설치와 화면 빌드(작은 서버에서는 몇 분 걸립니다)"
  as_tevro bash -c "cd '$APP_DIR' && npm ci --no-audit --no-fund --no-update-notifier --loglevel=error && npm run build --silent --no-update-notifier"

  log "6/7 설정과 서비스"
  local password="${TEVRO_PASSWORD:-}" origin=given allowed='^[A-Za-z0-9._~!@%^*+=:,-]+$'
  if [ -z "$password" ] && [ -f "$ENV_FILE" ]; then
    password="$(sed -n 's/^TEVRO_PASSWORD=//p' "$ENV_FILE")"
    origin=kept
  fi
  if [ -z "$password" ]; then
    password="$(head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')"
    password="${password:0:24}"
    origin=generated
  fi
  [ "${#password}" -ge 12 ] || fail "비밀번호는 12자 이상이어야 합니다."
  [[ "$password" =~ $allowed ]] || fail "비밀번호에는 영문, 숫자와 . _ ~ ! @ % ^ * + = : , - 만 쓸 수 있습니다."
  (
    umask 077
    cat >"$ENV_FILE" <<EOF
# Tevro 서버 설정($MARK). 바꾼 뒤에는 sudo systemctl restart tevro
PORT=$PORT
HOST=127.0.0.1
TEVRO_DATA_DIR=$DATA_DIR
TEVRO_PASSWORD=$password
TEVRO_TRIAL=$trial
EOF
  )
  chmod 600 "$ENV_FILE"
  printf 'TEVRO_DOMAIN=%s\nTEVRO_BRANCH=%s\nTEVRO_TRIAL=%s\n' "$domain" "$branch" "$trial" >"$INSTALL_CONF"
  write_service
  wait_for_server

  log "7/7 HTTPS(Caddy)와 방화벽"
  write_caddyfile "$domain"
  open_firewall

  local public_ip resolved
  public_ip="$(curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
  resolved="$(getent ahostsv4 "$domain" 2>/dev/null | awk 'NR == 1 { print $1 }' || true)"

  printf '\n설치를 마쳤습니다.\n'
  printf '  주소      https://%s\n' "$domain"
  if [ "$trial" = 1 ]; then
    printf '  체험 모드 켜짐. 비밀번호 없이 열리고, 바꾼 내용은 각자의 브라우저 창에만 남습니다\n'
    printf '  예시 데이터 %s/trial/*.json (저장소에서 바꾼 뒤 이 스크립트를 다시 실행하면 반영)\n' "$APP_DIR"
    printf '  체험 모드 끄기 sudo bash %s/deploy/oracle/install.sh --no-trial\n' "$APP_DIR"
  else
    case "$origin" in
      generated) printf '  비밀번호  %s   (사용자 이름은 비우거나 아무거나. 지금 적어 두세요)\n' "$password" ;;
      given) printf '  비밀번호  TEVRO_PASSWORD로 넘긴 값\n' ;;
      kept) printf '  비밀번호  그대로 유지(%s 의 TEVRO_PASSWORD)\n' "$ENV_FILE" ;;
    esac
    printf '  데이터    %s/tevro.db\n' "$DATA_DIR"
  fi
  printf '  상태·로그 systemctl status tevro / journalctl -u tevro -f\n'
  printf '\nHTTPS 인증서는 아래 두 가지가 맞으면 Caddy가 몇 분 안에 자동으로 받습니다(journalctl -u caddy -f).\n'
  printf '  1. Oracle 콘솔에서 이 서버 서브넷의 보안 목록에 TCP 80·443 수신 규칙이 있다\n'
  printf '  2. %s 가 이 서버의 공인 IP(%s)를 가리킨다\n' "$domain" "${public_ip:-확인 못 함}"
  if [ -n "$public_ip" ] && [ -n "$resolved" ] && [ "$public_ip" != "$resolved" ]; then
    warn "$domain 은(는) 지금 $resolved 를 가리킵니다. 이 서버의 공인 IP는 $public_ip 입니다."
  elif [ -z "$resolved" ]; then
    warn "$domain 의 DNS를 아직 찾을 수 없습니다. DNS를 설정했다면 퍼지는 데 몇 분 걸릴 수 있습니다."
  fi
}

# 갱신할 때 이 파일 자체가 git reset으로 바뀌므로, 끝까지 읽은 뒤 main을 실행하고 바로 끝낸다.
main "$@"; exit $?
