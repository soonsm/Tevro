#!/usr/bin/env bash
# Tevro를 Oracle Cloud의 Ubuntu 가상 서버(22.04·24.04)에 설치한다. 다시 실행하면 최신 코드로 갱신한다.
#
# 처음 설치(가상 서버에서):
#   curl -fsSLO https://raw.githubusercontent.com/soonsm/Tevro/refs/heads/<브랜치>/deploy/oracle/install.sh
#   sudo bash install.sh --domain <도메인> --branch <브랜치>
# 갱신(처음 설치한 도메인·브랜치·체험 모드를 그대로 씀):
#   sudo bash /opt/tevro/deploy/oracle/install.sh
#   이미 설치된 서버에서는 옵션을 보기 전에 최신 코드를 받아 새 스크립트로 다시 실행하므로, 새 옵션도 바로 쓸 수 있다.
# 체험 서버로 쓰기(로그인 없이, 브라우저 창마다 trial/*.json 예시 데이터의 사본): --trial, 끄기: --no-trial
#
# 하는 일: Node.js 24와 Caddy 설치 → tevro 사용자·폴더 → 코드 받기·빌드 → systemd 서비스 →
#          Caddy로 HTTPS(Let's Encrypt 인증서 자동) → Oracle Ubuntu 이미지 방화벽(iptables)에 80·443 열기.
# 보통 서버는 사용자 계정으로 로그인한다(ADR-0004). 첫 관리자는 이 서버에서 sudo tevro-admin user create ...로 만든다.
# 터미널에서 실행했고 사용자가 아직 없으면 이 스크립트가 첫 관리자를 만들지 묻는다.
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
ADMIN_BIN=/usr/local/bin/tevro-admin
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
  --trial     체험 서버로 연다. 로그인 없이 누구나 조작할 수 있고, 바꾼 내용은 각자의 브라우저 창에만 남는다
              (창을 닫으면 처음 데이터로). 예시 데이터는 저장소의 trial/*.json
  --no-trial  체험 모드를 끄고 보통 서버(사용자 계정 로그인, 데이터 파일)로 되돌린다
처음 설치한 뒤에는 인자 없이 다시 실행하면 같은 설정으로 최신 코드를 받아 다시 시작합니다.
보통 서버의 첫 관리자: sudo tevro-admin user create --username <아이디> --role admin
EOF
}

# tevro 사용자로 실행한다. runuser는 HOME을 바꾸지 않으므로 직접 넘긴다(npm 캐시 위치).
as_tevro() { runuser -u tevro -- env HOME="$TEVRO_HOME" "$@"; }

# /opt/tevro에 있는 이 스크립트는 지난번 설치 때 받은 버전이라 새 옵션이나 바뀐 설치 단계를 모를 수 있다.
# 이미 설치된 서버면 옵션을 보기 전에 최신 코드를 받고, 받은 새 스크립트로 한 번 다시 실행한다.
update_self() {
  if [ -n "${TEVRO_INSTALLER_UPDATED:-}" ] || [ "$(id -u)" -ne 0 ] || [ ! -d "$APP_DIR/.git" ]; then
    return 0
  fi
  local branch="" previous="" arg
  for arg in "$@"; do
    # --branch로 브랜치를 바꾸는 경우에는 그 브랜치에서 받는다.
    if [ "$previous" = --branch ]; then branch="$arg"; fi
    previous="$arg"
  done
  if [ -z "$branch" ] && [ -f "$INSTALL_CONF" ]; then
    branch="$(sed -n 's/^TEVRO_BRANCH=//p' "$INSTALL_CONF")"
  fi
  branch="${branch:-main}"
  [[ "$branch" =~ ^[A-Za-z0-9._/-]+$ ]] || return 0
  log "설치 스크립트를 최신으로 받기: $branch"
  if as_tevro git -C "$APP_DIR" fetch --quiet --depth 1 origin "$branch" &&
    as_tevro git -C "$APP_DIR" reset --quiet --hard FETCH_HEAD &&
    [ -f "$APP_DIR/deploy/oracle/install.sh" ]; then
    exec env TEVRO_INSTALLER_UPDATED=1 bash "$APP_DIR/deploy/oracle/install.sh" "$@"
  fi
  warn "최신 설치 스크립트를 받지 못해 지금 버전으로 계속합니다."
}

node_ok() {
  command -v node >/dev/null 2>&1 &&
    node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 24 || (a === 24 && b >= 7) ? 0 : 1)'
}

# 비밀번호 해시(Argon2id)에 Node.js 24.7부터 들어 있는 crypto.argon2를 쓴다. 예전에 설치한 Node.js 22는 24로 올린다.
install_node() {
  node_ok && return
  log "Node.js 24 설치(NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null
  apt-get install -y -q nodejs >/dev/null
  node_ok || fail "Node.js 24.7 이상을 설치하지 못했습니다."
}

# 서버 관리 명령(첫 관리자, 비밀번호 재설정 등)을 tevro 사용자·데이터 폴더로 실행하는 짧은 명령을 둔다.
write_admin_command() {
  cat >"$ADMIN_BIN" <<EOF
#!/usr/bin/env bash
# $MARK. Tevro 서버 관리 명령. 예: sudo tevro-admin user create --username admin --role admin
[ "\$(id -u)" -eq 0 ] || { echo "sudo tevro-admin ...로 실행하세요." >&2; exit 1; }
cd "$APP_DIR" && exec runuser -u tevro -- env HOME="$TEVRO_HOME" TEVRO_DATA_DIR="$DATA_DIR" "$(command -v node)" src/server/admin.ts "\$@"
EOF
  chmod 755 "$ADMIN_BIN"
}

# 보통 서버에 사용자가 없으면 아무도 로그인할 수 없다. 터미널에서 실행했으면 첫 관리자를 지금 만들지 묻는다.
ensure_admin() {
  "$ADMIN_BIN" user list 2>/dev/null | grep -q '사용자가 없습니다' || return 0
  if [ ! -t 0 ]; then
    NEEDS_ADMIN=1
    return 0
  fi
  local answer username
  printf '\n아직 사용자가 없습니다. 첫 관리자를 지금 만들까요? [Y/n] '
  read -r answer || answer=n
  case "$answer" in n | N | no | NO) NEEDS_ADMIN=1; return 0 ;; esac
  printf '관리자 아이디 [admin]: '
  read -r username || username=""
  username="${username:-admin}"
  if ! "$ADMIN_BIN" user create --username "$username" --role admin; then
    warn "첫 관리자를 만들지 못했습니다. 나중에 sudo tevro-admin user create --username <아이디> --role admin"
    NEEDS_ADMIN=1
  fi
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
  update_self "$@"
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
  # 예전 설치의 공용 비밀번호(TEVRO_PASSWORD)는 사용자 계정 로그인으로 바뀌어 더 쓰지 않으므로 옮기지 않는다.
  local had_password=0
  if [ -f "$ENV_FILE" ] && grep -q '^TEVRO_PASSWORD=' "$ENV_FILE"; then had_password=1; fi
  (
    umask 077
    cat >"$ENV_FILE" <<EOF
# Tevro 서버 설정($MARK). 바꾼 뒤에는 sudo systemctl restart tevro
PORT=$PORT
HOST=127.0.0.1
TEVRO_DATA_DIR=$DATA_DIR
TEVRO_TRIAL=$trial
# Caddy가 HTTPS로 받으므로 로그인 쿠키에 항상 Secure를 붙인다.
TEVRO_COOKIE_SECURE=1
EOF
  )
  chmod 600 "$ENV_FILE"
  printf 'TEVRO_DOMAIN=%s\nTEVRO_BRANCH=%s\nTEVRO_TRIAL=%s\n' "$domain" "$branch" "$trial" >"$INSTALL_CONF"
  write_admin_command
  write_service
  wait_for_server
  NEEDS_ADMIN=0
  [ "$trial" = 1 ] || ensure_admin

  log "7/7 HTTPS(Caddy)와 방화벽"
  write_caddyfile "$domain"
  open_firewall

  local public_ip resolved
  public_ip="$(curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
  resolved="$(getent ahostsv4 "$domain" 2>/dev/null | awk 'NR == 1 { print $1 }' || true)"

  printf '\n설치를 마쳤습니다.\n'
  printf '  주소      https://%s\n' "$domain"
  if [ "$trial" = 1 ]; then
    printf '  체험 모드 켜짐. 로그인 없이 열리고, 바꾼 내용은 각자의 브라우저 창에만 남습니다\n'
    printf '  예시 데이터 %s/trial/*.json (저장소에서 바꾼 뒤 이 스크립트를 다시 실행하면 반영)\n' "$APP_DIR"
    printf '  체험 모드 끄기 sudo bash %s/deploy/oracle/install.sh --no-trial\n' "$APP_DIR"
  else
    printf '  로그인    사용자 계정(웹 화면 오른쪽 위 계정 메뉴에서 사용자 관리·토큰 발급)\n'
    printf '  관리 명령 sudo tevro-admin user list | create | reset-password | set-role | activate | deactivate\n'
    printf '  데이터    %s/tevro.db\n' "$DATA_DIR"
    if [ "$had_password" = 1 ]; then
      printf '  공용 비밀번호(TEVRO_PASSWORD)는 없앴습니다. 이제 각자 계정으로 로그인합니다.\n'
    fi
    if [ "$NEEDS_ADMIN" = 1 ]; then
      warn "아직 사용자가 없어 아무도 로그인할 수 없습니다. 첫 관리자를 만드세요: sudo tevro-admin user create --username admin --role admin"
    fi
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
