#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${ROOT_DIR}/.env"
ENV_EXAMPLE_FILE="${ROOT_DIR}/.env.example"
RUN_DIR="${ROOT_DIR}/.run"
LOG_DIR="${ROOT_DIR}/logs"
PID_FILE="${RUN_DIR}/codex-discord-bridge.pid"
LOG_FILE="${LOG_DIR}/codex-discord-bridge.log"
OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-${HOME}/.openclaw/openclaw.json}"
DEFAULT_ALLOWED_ROOTS="/Users/${USER}/work,/Users/${USER}/projects"
ENV_CREATED_THIS_RUN=0

mkdir -p "${RUN_DIR}" "${LOG_DIR}"

print_header() {
  printf '\n==> %s\n' "$1"
}

print_info() {
  printf '[info] %s\n' "$1"
}

print_warn() {
  printf '[warn] %s\n' "$1"
}

print_error() {
  printf '[error] %s\n' "$1" >&2
}

usage() {
  cat <<USAGE
Codex Discord Bridge macOS 管理脚本

用法：
  ./scripts/macos-bridge.sh doctor
  ./scripts/macos-bridge.sh configure
  ./scripts/macos-bridge.sh setup
  ./scripts/macos-bridge.sh start
  ./scripts/macos-bridge.sh stop
  ./scripts/macos-bridge.sh restart
  ./scripts/macos-bridge.sh status
  ./scripts/macos-bridge.sh logs
  ./scripts/macos-bridge.sh open
  ./scripts/macos-bridge.sh deploy

说明：
  doctor     检查本机环境是否满足部署条件
  configure  交互式填写/修改 .env 配置
  setup      初始化 .env、提示填写配置、安装依赖、执行类型检查和构建
  start      后台启动服务（日志写入 logs/codex-discord-bridge.log）
  stop       停止后台服务
  restart    重启后台服务
  status     查看当前运行状态
  logs       实时查看日志
  open       打开本地 Web 管理面板
  deploy     一键执行 setup + start
USAGE
}

require_macos() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    print_error '该脚本目前只面向 macOS。'
    exit 1
  fi
}

require_command() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    print_error "缺少命令：${cmd}"
    exit 1
  fi
}

check_node_version() {
  node -e '
const version = process.versions.node.split(".").map(Number);
const ok = version[0] > 20 || (version[0] === 20 && version[1] >= 11);
if (!ok) {
  console.error(`Node.js 版本过低：${process.versions.node}，需要 >= 20.11`);
  process.exit(1);
}
' >/dev/null
}

is_placeholder_value() {
  local value="${1:-}"
  [[ -z "${value}" || "${value}" == 'your-discord-bot-token' ]]
}

mask_value() {
  local value="${1:-}"
  if [[ -z "${value}" ]]; then
    return 0
  fi

  if (( ${#value} <= 8 )); then
    printf '********'
    return 0
  fi

  printf '%s***%s' "${value:0:4}" "${value: -2}"
}

is_running() {
  if [[ ! -f "${PID_FILE}" ]]; then
    return 1
  fi

  local pid
  pid="$(cat "${PID_FILE}")"
  if [[ -z "${pid}" ]]; then
    return 1
  fi

  if kill -0 "${pid}" >/dev/null 2>&1; then
    return 0
  fi

  rm -f "${PID_FILE}"
  return 1
}

get_openclaw_field() {
  local field="$1"
  if [[ ! -f "${OPENCLAW_CONFIG_PATH}" ]]; then
    return 0
  fi

  OPENCLAW_QUERY_FIELD="$field" OPENCLAW_QUERY_PATH="${OPENCLAW_CONFIG_PATH}" node <<'NODE'
const fs = require('fs');
const field = process.env.OPENCLAW_QUERY_FIELD;
const configPath = process.env.OPENCLAW_QUERY_PATH;
try {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const value = field.split('.').reduce((current, key) => current?.[key], config);
  if (typeof value === 'string' && value.trim()) {
    process.stdout.write(value.trim());
  }
} catch {}
NODE
}

ensure_env_file() {
  if [[ ! -f "${ENV_FILE}" ]]; then
    cp "${ENV_EXAMPLE_FILE}" "${ENV_FILE}"
    ENV_CREATED_THIS_RUN=1
    print_info '已从 .env.example 创建 .env'
  fi

  local openclaw_token openclaw_proxy web_token
  openclaw_token="$(get_openclaw_field 'channels.discord.token')"
  openclaw_proxy="$(get_openclaw_field 'channels.discord.proxy')"
  web_token="$(node -e 'console.log(require("node:crypto").randomBytes(16).toString("hex"))')"

  ENV_FILE_PATH="${ENV_FILE}" \
  OPENCLAW_TOKEN="${openclaw_token}" \
  OPENCLAW_PROXY="${openclaw_proxy}" \
  DEFAULT_ALLOWED_ROOTS="${DEFAULT_ALLOWED_ROOTS}" \
  GENERATED_WEB_AUTH_TOKEN="${web_token}" \
  node <<'NODE'
const fs = require('fs');
const path = process.env.ENV_FILE_PATH;
const source = fs.readFileSync(path, 'utf8');
const lines = source.split(/\r?\n/);
const openclawToken = process.env.OPENCLAW_TOKEN || '';
const openclawProxy = process.env.OPENCLAW_PROXY || '';
const defaults = new Map([
  ['COMMAND_PREFIX', '!'],
  ['DATA_DIR', './data'],
  ['CODEX_COMMAND', 'codex'],
  ['DEFAULT_CODEX_SANDBOX', 'workspace-write'],
  ['DEFAULT_CODEX_APPROVAL', 'never'],
  ['DEFAULT_CODEX_SEARCH', 'false'],
  ['DEFAULT_CODEX_SKIP_GIT_REPO_CHECK', 'true'],
  ['WEB_ENABLED', 'true'],
  ['WEB_BIND', '127.0.0.1'],
  ['WEB_PORT', '3769'],
  ['ALLOWED_WORKSPACE_ROOTS', process.env.DEFAULT_ALLOWED_ROOTS || ''],
]);
if (openclawToken) {
  defaults.set('DISCORD_BOT_TOKEN', openclawToken);
}
if (process.env.GENERATED_WEB_AUTH_TOKEN) {
  defaults.set('WEB_AUTH_TOKEN', process.env.GENERATED_WEB_AUTH_TOKEN);
}

const placeholderValues = new Set(['', 'your-discord-bot-token']);
const indexByKey = new Map();
for (let index = 0; index < lines.length; index += 1) {
  const line = lines[index];
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (match) {
    indexByKey.set(match[1], index);
  }
}

for (const [key, value] of defaults.entries()) {
  if (!value) continue;
  if (!indexByKey.has(key)) {
    lines.push(`${key}=${value}`);
    continue;
  }

  const index = indexByKey.get(key);
  const existing = lines[index].slice(key.length + 1);
  if (placeholderValues.has(existing)) {
    lines[index] = `${key}=${value}`;
  }
}

if (openclawProxy && !lines.some((line) => line.startsWith('# OPENCLAW_DISCORD_PROXY=')) && !lines.some((line) => line.startsWith('OPENCLAW_DISCORD_PROXY='))) {
  lines.push('');
  lines.push('# 仅供 scripts/macos-bridge.sh start 自动注入到 HTTP_PROXY/HTTPS_PROXY');
  lines.push(`OPENCLAW_DISCORD_PROXY=${openclawProxy}`);
}

fs.writeFileSync(path, `${lines.join('\n').replace(/\n+$/,'')}\n`);
NODE

  print_info "环境文件已准备：${ENV_FILE}"
}

read_env_value() {
  local key="$1"
  if [[ ! -f "${ENV_FILE}" ]]; then
    return 0
  fi
  ENV_FILE_PATH="${ENV_FILE}" ENV_LOOKUP_KEY="$key" node <<'NODE'
const fs = require('fs');
const envPath = process.env.ENV_FILE_PATH;
const key = process.env.ENV_LOOKUP_KEY;
const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
for (const line of lines) {
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (match && match[1] === key) {
    process.stdout.write(match[2]);
    break;
  }
}
NODE
}

write_env_value() {
  local key="$1"
  local value="${2-}"
  ENV_FILE_PATH="${ENV_FILE}" ENV_WRITE_KEY="$key" ENV_WRITE_VALUE="$value" node <<'NODE'
const fs = require('fs');
const envPath = process.env.ENV_FILE_PATH;
const key = process.env.ENV_WRITE_KEY;
const value = process.env.ENV_WRITE_VALUE ?? '';
const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
let replaced = false;
for (let index = 0; index < lines.length; index += 1) {
  const line = lines[index];
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (match && match[1] === key) {
    lines[index] = `${key}=${value}`;
    replaced = true;
    break;
  }
}
if (!replaced) {
  lines.push(`${key}=${value}`);
}
fs.writeFileSync(envPath, `${lines.join('\n').replace(/\n+$/,'')}\n`);
NODE
}

prompt_env_value() {
  local key="$1"
  local label="$2"
  local fallback_value="${3:-}"
  local required="${4:-0}"
  local secret="${5:-0}"
  local allow_clear="${6:-0}"
  local current_value prompt_value answer prompt_label

  current_value="$(read_env_value "${key}" || true)"
  if [[ -z "${current_value}" ]]; then
    current_value="${fallback_value}"
  fi

  while true; do
    prompt_label="${label}"

    if [[ "${secret}" == '1' ]]; then
      if [[ -n "${current_value}" ]]; then
        prompt_label+=" [已存在：$(mask_value "${current_value}")，回车保留]"
      else
        prompt_label+=" [未填写]"
      fi

      if [[ "${allow_clear}" == '1' ]]; then
        prompt_label+="（输入 none 清空）"
      fi

      printf '%s: ' "${prompt_label}"
      read -r -s answer || true
      printf '\n'
    else
      prompt_value="${current_value}"
      if [[ -n "${prompt_value}" ]]; then
        prompt_label+=" [${prompt_value}]"
      fi

      if [[ "${allow_clear}" == '1' ]]; then
        prompt_label+="（输入 none 清空）"
      fi

      read -r -p "${prompt_label}: " answer || true
    fi

    if [[ "${allow_clear}" == '1' && "${answer}" == 'none' ]]; then
      answer=''
    elif [[ -z "${answer}" ]]; then
      answer="${current_value}"
    fi

    if [[ "${required}" == '1' ]] && [[ -z "${answer}" ]]; then
      print_warn '此项必填，请输入。'
      continue
    fi

    write_env_value "${key}" "${answer}"
    return 0
  done
}

prompt_interactive_configuration() {
  if [[ ! -t 0 ]]; then
    print_warn '当前不是交互终端，无法进行提问式配置。'
    print_info "请手动编辑 ${ENV_FILE}，或在本机终端执行 ./scripts/macos-bridge.sh configure"
    return 0
  fi

  print_header '交互配置'
  print_info '直接回车即可保留当前值。'
  print_info '如果你有 OpenClaw 配置，脚本已经先自动导入可识别的 Discord Token / 代理。'

  prompt_env_value 'DISCORD_BOT_TOKEN' 'Discord Bot Token（Developer Portal -> Application -> Bot -> Token）' '' 1 1 0
  prompt_env_value 'ALLOWED_WORKSPACE_ROOTS' '允许绑定的项目根目录（逗号分隔，例如 /Users/<user>/work,/Users/<user>/projects）' "${DEFAULT_ALLOWED_ROOTS}" 0 0 0
  prompt_env_value 'DISCORD_ADMIN_USER_IDS' '你的 Discord 用户 ID（可选，多个用逗号；启用 Developer Mode 后可复制）' '' 0 0 1
  prompt_env_value 'WEB_PORT' 'Web 面板端口' '3769' 1 0 0
  prompt_env_value 'WEB_AUTH_TOKEN' 'Web 面板鉴权 Token（回车保留当前/自动生成值）' "$(read_env_value 'WEB_AUTH_TOKEN' || true)" 0 1 0
  prompt_env_value 'OPENCLAW_DISCORD_PROXY' 'Discord / 附件下载代理（可选，例如 http://127.0.0.1:7890）' "$(read_env_value 'OPENCLAW_DISCORD_PROXY' || true)" 0 0 1

  print_info "配置已写入：${ENV_FILE}"
}

should_prompt_for_configuration() {
  if [[ ! -t 0 ]]; then
    return 1
  fi

  if [[ "${ENV_CREATED_THIS_RUN}" == '1' ]]; then
    return 0
  fi

  local token
  token="$(read_env_value 'DISCORD_BOT_TOKEN' || true)"
  if is_placeholder_value "${token}"; then
    return 0
  fi

  local answer normalized
  read -r -p '检测到已有 .env，是否现在检查/修改配置？[y/N]: ' answer || true
  normalized="$(printf '%s' "${answer}" | tr '[:upper:]' '[:lower:]')"
  case "${normalized}" in
    y|yes)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

validate_required_env() {
  local token
  token="$(read_env_value 'DISCORD_BOT_TOKEN' || true)"
  if is_placeholder_value "${token}"; then
    print_error 'DISCORD_BOT_TOKEN 仍未配置，无法继续。请运行 ./scripts/macos-bridge.sh configure 或手动编辑 .env。'
    exit 1
  fi

  local web_port
  web_port="$(read_env_value 'WEB_PORT' || true)"
  if [[ -z "${web_port}" ]]; then
    write_env_value 'WEB_PORT' '3769'
  fi
}

maybe_export_proxy() {
  local proxy=""
  proxy="$(read_env_value 'OPENCLAW_DISCORD_PROXY' || true)"
  if [[ -z "${HTTP_PROXY:-}" && -n "${proxy}" ]]; then
    export HTTP_PROXY="${proxy}"
    export http_proxy="${proxy}"
    print_info "已注入 HTTP proxy: ${proxy}"
  fi
  if [[ -z "${HTTPS_PROXY:-}" && -n "${proxy}" ]]; then
    export HTTPS_PROXY="${proxy}"
    export https_proxy="${proxy}"
    print_info "已注入 HTTPS proxy: ${proxy}"
  fi
}

run_doctor() {
  require_macos
  require_command node
  require_command npm
  require_command codex
  check_node_version
  print_info "Node.js: $(node -v)"
  print_info "npm: $(npm -v)"
  print_info "codex: $(codex --version)"

  if [[ -f "${OPENCLAW_CONFIG_PATH}" ]]; then
    print_info "检测到 OpenClaw 配置：${OPENCLAW_CONFIG_PATH}"
  else
    print_warn "未检测到 OpenClaw 配置：${OPENCLAW_CONFIG_PATH}"
  fi

  if [[ -f "${ENV_FILE}" ]]; then
    print_info ".env 已存在：${ENV_FILE}"
  else
    print_warn '.env 不存在，执行 setup / deploy 时会自动创建并提示填写'
  fi
}

run_configure() {
  require_macos
  require_command node
  ensure_env_file
  prompt_interactive_configuration
  validate_required_env
}

run_setup() {
  run_doctor
  ensure_env_file

  if should_prompt_for_configuration; then
    prompt_interactive_configuration
  fi

  validate_required_env

  print_header '安装依赖'
  (cd "${ROOT_DIR}" && npm install)
  print_header '类型检查'
  (cd "${ROOT_DIR}" && npm run check)
  print_header '构建'
  (cd "${ROOT_DIR}" && npm run build)

  local token admin_id web_port
  token="$(read_env_value 'DISCORD_BOT_TOKEN' || true)"
  admin_id="$(read_env_value 'DISCORD_ADMIN_USER_IDS' || true)"
  web_port="$(read_env_value 'WEB_PORT' || true)"

  print_header 'setup 完成'
  print_info "配置文件：${ENV_FILE}"
  print_info "Web 面板：http://127.0.0.1:${web_port:-3769}"
  if ! is_placeholder_value "${token}"; then
    print_info 'Discord Bot Token 已配置'
  else
    print_warn 'DISCORD_BOT_TOKEN 仍为空，请运行 ./scripts/macos-bridge.sh configure'
  fi
  if [[ -z "${admin_id}" ]]; then
    print_warn 'DISCORD_ADMIN_USER_IDS 为空；你也可以依赖 Discord 频道管理权限来执行管理员命令'
  fi
  print_info '下一步：./scripts/macos-bridge.sh start'
}

run_start() {
  require_macos
  require_command node
  require_command npm
  require_command codex
  ensure_env_file
  validate_required_env
  maybe_export_proxy

  if is_running; then
    print_warn "服务已在运行，PID=$(cat "${PID_FILE}")"
    return 0
  fi

  if [[ ! -d "${ROOT_DIR}/dist" ]]; then
    print_warn 'dist 不存在，先执行 setup'
    run_setup
  fi

  print_header '启动服务'
  (
    cd "${ROOT_DIR}"
    nohup node dist/index.js >> "${LOG_FILE}" 2>&1 &
    echo $! > "${PID_FILE}"
  )

  sleep 2
  if is_running; then
    print_info "启动成功，PID=$(cat "${PID_FILE}")"
    print_info "日志文件：${LOG_FILE}"
    print_info '查看状态：./scripts/macos-bridge.sh status'
  else
    print_error '启动失败，请查看日志'
    tail -n 50 "${LOG_FILE}" || true
    exit 1
  fi
}

run_stop() {
  if ! is_running; then
    print_warn '服务当前未运行'
    return 0
  fi

  local pid
  pid="$(cat "${PID_FILE}")"
  print_header "停止服务 PID=${pid}"
  kill "${pid}" >/dev/null 2>&1 || true

  for _ in {1..20}; do
    if ! kill -0 "${pid}" >/dev/null 2>&1; then
      rm -f "${PID_FILE}"
      print_info '服务已停止'
      return 0
    fi
    sleep 0.5
  done

  print_warn 'SIGTERM 后仍未退出，发送 SIGKILL'
  kill -9 "${pid}" >/dev/null 2>&1 || true
  rm -f "${PID_FILE}"
  print_info '服务已强制停止'
}

run_status() {
  local web_port
  web_port="$(read_env_value 'WEB_PORT' || true)"
  if is_running; then
    print_info "服务运行中，PID=$(cat "${PID_FILE}")"
    print_info "Web 面板：http://127.0.0.1:${web_port:-3769}"
    print_info "日志文件：${LOG_FILE}"
  else
    print_warn '服务未运行'
    print_info '启动命令：./scripts/macos-bridge.sh start'
  fi
}

run_logs() {
  touch "${LOG_FILE}"
  tail -n 80 -f "${LOG_FILE}"
}

run_open() {
  local web_port web_auth_token url encoded_token
  web_port="$(read_env_value 'WEB_PORT' || true)"
  web_auth_token="$(read_env_value 'WEB_AUTH_TOKEN' || true)"
  url="http://127.0.0.1:${web_port:-3769}"

  if [[ -n "${web_auth_token}" ]]; then
    encoded_token="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1] || ""))' "${web_auth_token}")"
    url="${url}/?token=${encoded_token}"
  fi

  open "${url}"
}

run_deploy() {
  run_setup
  run_start
}

main() {
  local command="${1:-help}"
  case "${command}" in
    help|-h|--help)
      usage
      ;;
    doctor)
      run_doctor
      ;;
    configure)
      run_configure
      ;;
    setup)
      run_setup
      ;;
    start)
      run_start
      ;;
    stop)
      run_stop
      ;;
    restart)
      run_stop
      run_start
      ;;
    status)
      run_status
      ;;
    logs)
      run_logs
      ;;
    open)
      run_open
      ;;
    deploy)
      run_deploy
      ;;
    *)
      usage
      exit 1
      ;;
  esac
}

main "$@"
