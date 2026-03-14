#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ROOT_REALPATH="$(cd "${ROOT_DIR}" && pwd -P)"
ENV_FILE="${ROOT_DIR}/.env"
ENV_EXAMPLE_FILE="${ROOT_DIR}/.env.example"
RUN_DIR="${ROOT_DIR}/.run"
LOG_DIR="${ROOT_DIR}/logs"
PID_FILE="${RUN_DIR}/codex-discord-bridge.pid"
LOG_FILE="${LOG_DIR}/codex-discord-bridge.log"
OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-${HOME}/.openclaw/openclaw.json}"
DEFAULT_ALLOWED_ROOTS="$HOME/work,$HOME/projects"
SECRET_DIR="${HOME}/.codex-tunning"
SECRET_ENV_FILE="${CODEX_TUNNING_SECRETS_FILE:-${SECRET_DIR}/secrets.env}"
TOKEN_ENV_KEY='CODEX_TUNNING_DISCORD_BOT_TOKEN'
ENV_CREATED_THIS_RUN=0
SERVICE_ARG_MODE=''
SERVICE_ARG_ASSUME_YES=0
SERVICE_LABEL_BASENAME="$(basename "${ROOT_REALPATH}" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-')"
SERVICE_LABEL_HASH="$(printf '%s' "${ROOT_REALPATH}" | shasum -a 256 | awk '{print substr($1, 1, 10)}')"
SERVICE_LABEL="com.codex-tunning.${SERVICE_LABEL_BASENAME:-bridge}.${SERVICE_LABEL_HASH}"

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
  ./scripts/macos-bridge.sh service-run
  ./scripts/macos-bridge.sh service-status
  ./scripts/macos-bridge.sh install-service [--mode daemon|agent] [-y]
  ./scripts/macos-bridge.sh uninstall-service [--mode daemon|agent] [-y]
  ./scripts/macos-bridge.sh deploy

说明：
  doctor            检查本机环境是否满足部署条件
  configure         交互式填写/修改 .env，并单独保存 Discord Bot Token
  setup             初始化 .env、提示填写配置、安装依赖、执行类型检查和构建
  start             启动服务；若已安装 launchd 服务，则优先启动 launchd 服务
  stop              停止服务；若已安装 launchd 服务，则临时卸载当前 launchd 实例
  restart           重启服务
  status            查看当前运行状态
  logs              实时查看日志
  open              打开本地 Web 管理面板
  service-run       前台运行服务，供 launchd 调用
  service-status    查看 launchd 安装状态
  install-service   安装成 macOS launchd 服务；daemon=开机启动，agent=登录后启动
  uninstall-service 卸载已安装的 launchd 服务
  deploy            一键执行 setup，并可选安装自启动服务
USAGE
}

require_macos() {
  if [[ "$(uname -s)" != 'Darwin' ]]; then
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

join_unique_path() {
  local joined='' chunk='' part=''
  for chunk in "$@"; do
    [[ -n "${chunk:-}" ]] || continue
    IFS=':' read -r -a _parts <<< "${chunk}"
    for part in "${_parts[@]}"; do
      [[ -n "${part}" ]] || continue
      case ":${joined}:" in
        *":${part}:"*) ;;
        *) joined="${joined:+${joined}:}${part}" ;;
      esac
    done
  done
  printf '%s' "${joined}"
}

augment_launch_path() {
  local node_dir='' npm_dir='' codex_dir=''
  if command -v node >/dev/null 2>&1; then
    node_dir="$(dirname "$(command -v node)")"
  fi
  if command -v npm >/dev/null 2>&1; then
    npm_dir="$(dirname "$(command -v npm)")"
  fi
  if command -v codex >/dev/null 2>&1; then
    codex_dir="$(dirname "$(command -v codex)")"
  fi

  export PATH="$(join_unique_path \
    "${PATH:-}" \
    "${CODEX_TUNNING_INSTALL_PATH:-}" \
    "${node_dir}" \
    "${npm_dir}" \
    "${codex_dir}" \
    "/opt/homebrew/bin" \
    "/usr/local/bin" \
    "/usr/bin" \
    "/bin" \
    "/usr/sbin" \
    "/sbin")"
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

stop_process_by_pidfile() {
  if ! is_running; then
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

read_secret_file_value() {
  local key="$1"
  if [[ ! -f "${SECRET_ENV_FILE}" ]]; then
    return 0
  fi

  SECRET_ENV_PATH="${SECRET_ENV_FILE}" SECRET_KEY="$key" node <<'NODE'
const fs = require('fs');
const envPath = process.env.SECRET_ENV_PATH;
const key = process.env.SECRET_KEY;
const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
for (const line of lines) {
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (!match || match[1] !== key) {
    continue;
  }

  const raw = match[2].trim();
  if (!raw) {
    break;
  }

  if (raw.startsWith('"') && raw.endsWith('"')) {
    try {
      process.stdout.write(JSON.parse(raw));
      break;
    } catch {}
  }

  if (raw.startsWith("'") && raw.endsWith("'")) {
    process.stdout.write(raw.slice(1, -1));
    break;
  }

  process.stdout.write(raw);
  break;
}
NODE
}

load_secret_env() {
  local value
  value="$(read_secret_file_value "${TOKEN_ENV_KEY}")"
  if [[ -n "${value}" ]]; then
    printf -v "$TOKEN_ENV_KEY" '%s' "$value"
    export "$TOKEN_ENV_KEY"
  fi
}

read_secret_value() {
  local key="$1"
  local current="${!key-}"
  if [[ -n "${current}" ]]; then
    printf '%s' "${current}"
    return 0
  fi

  read_secret_file_value "$key"
}

write_secret_value() {
  local key="$1"
  local value="$2"
  mkdir -p "$(dirname "${SECRET_ENV_FILE}")"

  SECRET_ENV_PATH="${SECRET_ENV_FILE}" SECRET_KEY="$key" SECRET_VALUE="$value" node <<'NODE'
const fs = require('fs');
const envPath = process.env.SECRET_ENV_PATH;
const key = process.env.SECRET_KEY;
const value = process.env.SECRET_VALUE ?? '';
const lines = fs.existsSync(envPath)
  ? fs.readFileSync(envPath, 'utf8').split(/\r?\n/)
  : [];
const encoded = JSON.stringify(value);
let replaced = false;
for (let index = 0; index < lines.length; index += 1) {
  const line = lines[index];
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (match && match[1] === key) {
    lines[index] = `${key}=${encoded}`;
    replaced = true;
    break;
  }
}
if (!replaced) {
  lines.push(`${key}=${encoded}`);
}
fs.writeFileSync(envPath, `${lines.join('\n').replace(/\n+$/,'')}\n`);
NODE

  chmod 600 "${SECRET_ENV_FILE}"
  printf -v "$key" '%s' "$value"
  export "$key"
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

  local openclaw_proxy web_token
  openclaw_proxy="$(get_openclaw_field 'channels.discord.proxy')"
  web_token="$(node -e 'console.log(require("node:crypto").randomBytes(16).toString("hex"))')"

  ENV_FILE_PATH="${ENV_FILE}" \
  OPENCLAW_PROXY="${openclaw_proxy}" \
  DEFAULT_ALLOWED_ROOTS="${DEFAULT_ALLOWED_ROOTS}" \
  GENERATED_WEB_AUTH_TOKEN="${web_token}" \
  node <<'NODE'
const fs = require('fs');
const path = process.env.ENV_FILE_PATH;
const source = fs.readFileSync(path, 'utf8');
let lines = source.split(/\r?\n/);
const openclawProxy = process.env.OPENCLAW_PROXY || '';
const defaults = new Map([
  ['COMMAND_PREFIX', '!'],
  ['DATA_DIR', './data'],
  ['CODEX_COMMAND', 'codex'],
  ['DEFAULT_CODEX_SANDBOX', 'danger-full-access'],
  ['DEFAULT_CODEX_APPROVAL', 'never'],
  ['DEFAULT_CODEX_SEARCH', 'false'],
  ['DEFAULT_CODEX_SKIP_GIT_REPO_CHECK', 'true'],
  ['WEB_ENABLED', 'true'],
  ['WEB_BIND', '127.0.0.1'],
  ['WEB_PORT', '3769'],
  ['ALLOWED_WORKSPACE_ROOTS', process.env.DEFAULT_ALLOWED_ROOTS || ''],
]);
if (process.env.GENERATED_WEB_AUTH_TOKEN) {
  defaults.set('WEB_AUTH_TOKEN', process.env.GENERATED_WEB_AUTH_TOKEN);
}

const placeholderValues = new Set(['']);
const removeKeys = new Set(['DISCORD_BOT_TOKEN', 'DISCORD_TOKEN']);
lines = lines.filter((line) => {
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
  return !match || !removeKeys.has(match[1]);
});

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
  lines.push('# 仅供 scripts/macos-bridge.sh start / service-run 自动注入到 HTTP_PROXY/HTTPS_PROXY');
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

remove_env_keys() {
  if [[ ! -f "${ENV_FILE}" ]]; then
    return 0
  fi

  ENV_FILE_PATH="${ENV_FILE}" REMOVE_KEYS="$*" node <<'NODE'
const fs = require('fs');
const envPath = process.env.ENV_FILE_PATH;
const removeKeys = new Set((process.env.REMOVE_KEYS || '').split(/\s+/).filter(Boolean));
const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
const kept = lines.filter((line) => {
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
  return !match || !removeKeys.has(match[1]);
});
fs.writeFileSync(envPath, `${kept.join('\n').replace(/\n+$/,'')}\n`);
NODE
}

migrate_project_token_to_secret_env() {
  local current_secret env_token legacy_token token_to_store
  current_secret="$(read_secret_value "${TOKEN_ENV_KEY}")"
  env_token="$(read_env_value 'DISCORD_BOT_TOKEN' || true)"
  legacy_token="$(read_env_value 'DISCORD_TOKEN' || true)"
  token_to_store="${current_secret:-${env_token:-${legacy_token:-}}}"

  if [[ -n "${token_to_store}" && -z "${current_secret}" ]]; then
    write_secret_value "${TOKEN_ENV_KEY}" "${token_to_store}"
    print_info "已将 Discord Bot Token 独立保存到：${SECRET_ENV_FILE}"
  fi

  if [[ -n "${env_token}" || -n "${legacy_token}" ]]; then
    remove_env_keys 'DISCORD_BOT_TOKEN' 'DISCORD_TOKEN'
    print_info '已从项目 .env 移除内联 Discord Token，避免与其他机器人配置混淆'
  fi
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

prompt_secret_value() {
  local key="$1"
  local label="$2"
  local fallback_value="${3:-}"
  local required="${4:-0}"
  local current_value prompt_label answer

  current_value="$(read_secret_value "${key}")"
  if [[ -z "${current_value}" ]]; then
    current_value="${fallback_value}"
  fi

  while true; do
    prompt_label="${label}"
    if [[ -n "${current_value}" ]]; then
      prompt_label+=" [已存在：$(mask_value "${current_value}")，回车保留]"
    else
      prompt_label+=" [未填写]"
    fi

    printf '%s: ' "${prompt_label}"
    read -r -s answer || true
    printf '\n'

    if [[ -z "${answer}" ]]; then
      answer="${current_value}"
    fi

    if [[ "${required}" == '1' ]] && [[ -z "${answer}" ]]; then
      print_warn '此项必填，请输入。'
      continue
    fi

    write_secret_value "${key}" "${answer}"
    return 0
  done
}

prompt_interactive_configuration() {
  if [[ ! -t 0 ]]; then
    print_warn '当前不是交互终端，无法进行提问式配置。'
    print_info "请手动编辑 ${ENV_FILE}，并在本机终端执行 ./scripts/macos-bridge.sh configure"
    return 0
  fi

  local openclaw_token current_token
  openclaw_token="$(get_openclaw_field 'channels.discord.token')"
  current_token="$(read_secret_value "${TOKEN_ENV_KEY}")"

  print_header '交互配置'
  print_info '直接回车即可保留当前值。'
  print_info "Discord Bot Token 会单独写入 ${SECRET_ENV_FILE}，不会写进项目 .env。"
  print_info '默认会将 Codex 权限设置为 danger-full-access，便于在 Discord 中直接读写项目文件。'
  if [[ -n "${openclaw_token}" && -z "${current_token}" ]]; then
    print_info '检测到 OpenClaw 中已有 Discord Token，可直接回车采用该值。'
  fi

  prompt_secret_value "${TOKEN_ENV_KEY}" 'Discord Bot Token（将保存为 CODEX_TUNNING_DISCORD_BOT_TOKEN）' "${openclaw_token}" 1
  prompt_env_value 'ALLOWED_WORKSPACE_ROOTS' '允许绑定的项目根目录（逗号分隔，例如 /path/to/workspaces,/path/to/projects）' "${DEFAULT_ALLOWED_ROOTS}" 0 0 0
  prompt_env_value 'DISCORD_ADMIN_USER_IDS' '你的 Discord 用户 ID（可选，多个用逗号；启用 Developer Mode 后可复制）' '' 0 0 1
  prompt_env_value 'WEB_PORT' 'Web 面板端口' '3769' 1 0 0
  prompt_env_value 'WEB_AUTH_TOKEN' 'Web 面板鉴权 Token（回车保留当前/自动生成值）' "$(read_env_value 'WEB_AUTH_TOKEN' || true)" 0 1 0
  prompt_env_value 'OPENCLAW_DISCORD_PROXY' 'Discord / 附件下载代理（可选，例如 http://127.0.0.1:7890）' "$(read_env_value 'OPENCLAW_DISCORD_PROXY' || true)" 0 0 1
  prompt_env_value 'OPENCLAW_DISCORD_CA_CERT' '代理 CA 证书文件（可选；daemon 模式下如遇 TLS 报错可填，例如 ~/.codex-tunning/clash-ca.pem）' "$(read_env_value 'OPENCLAW_DISCORD_CA_CERT' || true)" 0 0 1

  print_info "配置已写入：${ENV_FILE}"
  print_info "Discord Token 已单独写入：${SECRET_ENV_FILE}"
}

should_prompt_for_configuration() {
  if [[ ! -t 0 ]]; then
    return 1
  fi

  if [[ "${ENV_CREATED_THIS_RUN}" == '1' ]]; then
    return 0
  fi

  local token
  token="$(read_secret_value "${TOKEN_ENV_KEY}")"
  if [[ -z "${token}" ]]; then
    return 0
  fi

  local answer normalized
  read -r -p '检测到已有配置，是否现在检查/修改配置？[y/N]: ' answer || true
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
  token="$(read_secret_value "${TOKEN_ENV_KEY}")"
  if [[ -z "${token}" ]]; then
    print_error "${TOKEN_ENV_KEY} 仍未配置，无法继续。请运行 ./scripts/macos-bridge.sh configure。"
    exit 1
  fi

  local web_port
  web_port="$(read_env_value 'WEB_PORT' || true)"
  if [[ -z "${web_port}" ]]; then
    write_env_value 'WEB_PORT' '3769'
  fi
}

maybe_export_proxy() {
  local proxy=''
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

expand_home_path() {
  local value="${1:-}"
  case "${value}" in
    '~')
      printf '%s' "${HOME}"
      ;;
    '~/'*)
      printf '%s/%s' "${HOME}" "${value#~/}"
      ;;
    *)
      printf '%s' "${value}"
      ;;
  esac
}

node_options_has_flag() {
  local flag="$1"
  case " ${NODE_OPTIONS:-} " in
    *" ${flag} "*) return 0 ;;
    *) return 1 ;;
  esac
}

append_node_option_flag() {
  local flag="$1"
  if node_options_has_flag "${flag}"; then
    return 0
  fi

  export NODE_OPTIONS="${NODE_OPTIONS:+${NODE_OPTIONS} }${flag}"
}

maybe_configure_node_tls() {
  local proxy raw_ca_cert ca_cert
  proxy="$(read_env_value 'OPENCLAW_DISCORD_PROXY' || true)"
  raw_ca_cert="$(read_env_value 'OPENCLAW_DISCORD_CA_CERT' || true)"

  if [[ -n "${proxy}" || -n "${raw_ca_cert}" ]]; then
    append_node_option_flag '--use-system-ca'
    print_info '已为 Node 启用系统证书信任（--use-system-ca）'
  fi

  if [[ -n "${raw_ca_cert}" ]]; then
    ca_cert="$(expand_home_path "${raw_ca_cert}")"
  elif [[ -n "${NODE_EXTRA_CA_CERTS:-}" ]]; then
    ca_cert="${NODE_EXTRA_CA_CERTS}"
  elif [[ -f '/etc/ssl/cert.pem' ]]; then
    ca_cert='/etc/ssl/cert.pem'
  else
    return 0
  fi

  if [[ ! -f "${ca_cert}" ]]; then
    print_warn "额外 CA 证书文件不存在：${ca_cert}"
    return 0
  fi

  export NODE_EXTRA_CA_CERTS="${ca_cert}"
  print_info "已注入 NODE_EXTRA_CA_CERTS: ${ca_cert}"
}

sanitize_codex_desktop_env() {
  local key
  while IFS= read -r key; do
    case "${key}" in
      CODEX_TUNNING_*|CODEX_HOME|CODEX_CONFIG_HOME)
        ;;
      CODEX_CI|CODEX_SHELL|CODEX_THREAD_ID|CODEX_INTERNAL_*)
        unset "${key}" || true
        ;;
    esac
  done < <(env | cut -d= -f1 | grep '^CODEX_' || true)
}

resolve_service_user() {
  if [[ -n "${CODEX_TUNNING_ORIGINAL_USER:-}" ]]; then
    printf '%s' "${CODEX_TUNNING_ORIGINAL_USER}"
    return 0
  fi

  if [[ -n "${SUDO_USER:-}" ]]; then
    printf '%s' "${SUDO_USER}"
    return 0
  fi

  id -un
}

resolve_service_home() {
  if [[ -n "${CODEX_TUNNING_ORIGINAL_HOME:-}" ]]; then
    printf '%s' "${CODEX_TUNNING_ORIGINAL_HOME}"
    return 0
  fi

  if [[ -n "${SUDO_USER:-}" ]]; then
    dscl . -read "/Users/${SUDO_USER}" NFSHomeDirectory 2>/dev/null | awk '{print $2}'
    return 0
  fi

  printf '%s' "${HOME}"
}

agent_plist_path() {
  printf '%s/Library/LaunchAgents/%s.plist' "$(resolve_service_home)" "${SERVICE_LABEL}"
}

daemon_plist_path() {
  printf '/Library/LaunchDaemons/%s.plist' "${SERVICE_LABEL}"
}

service_mode_label() {
  case "$1" in
    daemon) printf 'LaunchDaemon（开机启动）' ;;
    agent) printf 'LaunchAgent（登录后启动）' ;;
    *) printf '未知模式' ;;
  esac
}

service_plist_path_for_mode() {
  case "$1" in
    daemon) daemon_plist_path ;;
    agent) agent_plist_path ;;
    *)
      print_error "未知服务模式：$1"
      exit 1
      ;;
  esac
}

service_domain_for_mode() {
  case "$1" in
    daemon) printf 'system' ;;
    agent) printf 'gui/%s' "$(id -u "$(resolve_service_user)")" ;;
    *)
      print_error "未知服务模式：$1"
      exit 1
      ;;
  esac
}

service_target_for_mode() {
  printf '%s/%s' "$(service_domain_for_mode "$1")" "${SERVICE_LABEL}"
}

detect_installed_service_mode() {
  if [[ -f "$(agent_plist_path)" ]]; then
    printf 'agent'
    return 0
  fi

  if [[ -f "$(daemon_plist_path)" ]]; then
    printf 'daemon'
    return 0
  fi

  return 1
}

has_multiple_installed_service_modes() {
  [[ -f "$(agent_plist_path)" && -f "$(daemon_plist_path)" ]]
}

service_is_bootstrapped() {
  local mode="$1"
  launchctl print "$(service_target_for_mode "${mode}")" >/dev/null 2>&1
}

rerun_with_sudo() {
  local reason="$1"
  shift

  if [[ ! -t 0 ]]; then
    print_error "当前不是交互终端，无法自动 sudo。请手动执行：sudo $0 $*"
    exit 1
  fi

  print_info "${reason}，接下来会请求 macOS 管理员密码。"
  exec sudo env \
    "CODEX_TUNNING_ORIGINAL_USER=$(resolve_service_user)" \
    "CODEX_TUNNING_ORIGINAL_HOME=$(resolve_service_home)" \
    "CODEX_TUNNING_INSTALL_PATH=${PATH:-}" \
    "CODEX_TUNNING_SECRETS_FILE=${SECRET_ENV_FILE}" \
    "OPENCLAW_CONFIG_PATH=${OPENCLAW_CONFIG_PATH}" \
    bash "$0" "$@"
}

write_launchd_plist() {
  local mode="$1"
  local output_path="$2"
  local service_user service_home path_value plist_dir

  service_user="$(resolve_service_user)"
  service_home="$(resolve_service_home)"
  path_value="$(join_unique_path "${CODEX_TUNNING_INSTALL_PATH:-${PATH:-}}" "/opt/homebrew/bin" "/usr/local/bin" "/usr/bin" "/bin" "/usr/sbin" "/sbin")"
  plist_dir="$(dirname "${output_path}")"
  mkdir -p "${plist_dir}"

  LAUNCHD_MODE="${mode}" \
  LAUNCHD_OUTPUT_PATH="${output_path}" \
  LAUNCHD_LABEL="${SERVICE_LABEL}" \
  LAUNCHD_WORKDIR="${ROOT_DIR}" \
  LAUNCHD_SCRIPT_PATH="${SCRIPT_DIR}/macos-bridge.sh" \
  LAUNCHD_LOG_PATH="${LOG_FILE}" \
  LAUNCHD_PATH_VALUE="${path_value}" \
  LAUNCHD_HOME_VALUE="${service_home}" \
  LAUNCHD_USER_VALUE="${service_user}" \
  LAUNCHD_SECRET_PATH="${SECRET_ENV_FILE}" \
  LAUNCHD_OPENCLAW_PATH="${OPENCLAW_CONFIG_PATH}" \
  node <<'NODE'
const fs = require('fs');

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const mode = process.env.LAUNCHD_MODE;
const outputPath = process.env.LAUNCHD_OUTPUT_PATH;
const programArguments = ['/bin/bash', process.env.LAUNCHD_SCRIPT_PATH, 'service-run'];
const environment = {
  HOME: process.env.LAUNCHD_HOME_VALUE,
  PATH: process.env.LAUNCHD_PATH_VALUE,
  USER: process.env.LAUNCHD_USER_VALUE,
  CODEX_TUNNING_INSTALL_PATH: process.env.LAUNCHD_PATH_VALUE,
  CODEX_TUNNING_SECRETS_FILE: process.env.LAUNCHD_SECRET_PATH,
  OPENCLAW_CONFIG_PATH: process.env.LAUNCHD_OPENCLAW_PATH,
};

const environmentXml = Object.entries(environment)
  .filter(([, value]) => Boolean(value))
  .map(([key, value]) => `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`)
  .join('\n');

const programArgumentsXml = programArguments
  .map((value) => `    <string>${escapeXml(value)}</string>`)
  .join('\n');

const daemonUserXml = mode === 'daemon'
  ? `  <key>UserName</key>\n  <string>${escapeXml(process.env.LAUNCHD_USER_VALUE || '')}</string>\n`
  : '';

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(process.env.LAUNCHD_LABEL || '')}</string>
${daemonUserXml}  <key>ProgramArguments</key>
  <array>
${programArgumentsXml}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(process.env.LAUNCHD_WORKDIR || '')}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>3</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(process.env.LAUNCHD_LOG_PATH || '')}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(process.env.LAUNCHD_LOG_PATH || '')}</string>
  <key>EnvironmentVariables</key>
  <dict>
${environmentXml}
  </dict>
</dict>
</plist>
`;

fs.writeFileSync(outputPath, plist);
NODE
}

parse_service_args() {
  SERVICE_ARG_MODE=''
  SERVICE_ARG_ASSUME_YES=0

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --mode)
        SERVICE_ARG_MODE="${2:-}"
        shift 2
        ;;
      daemon|--daemon)
        SERVICE_ARG_MODE='daemon'
        shift
        ;;
      agent|--agent)
        SERVICE_ARG_MODE='agent'
        shift
        ;;
      -y|--yes)
        SERVICE_ARG_ASSUME_YES=1
        shift
        ;;
      *)
        print_error "未知参数：$1"
        exit 1
        ;;
    esac
  done
}

resolve_requested_service_mode() {
  if [[ -n "${SERVICE_ARG_MODE}" ]]; then
    case "${SERVICE_ARG_MODE}" in
      daemon|agent)
        printf '%s' "${SERVICE_ARG_MODE}"
        return 0
        ;;
      *)
        print_error "不支持的服务模式：${SERVICE_ARG_MODE}"
        exit 1
        ;;
    esac
  fi

  if [[ ! -t 0 ]]; then
    printf 'daemon'
    return 0
  fi

  local answer normalized
  read -r -p '请选择服务模式 [daemon/agent]（默认 daemon，daemon=开机启动，agent=登录后启动）: ' answer || true
  normalized="$(printf '%s' "${answer}" | tr '[:upper:]' '[:lower:]')"
  case "${normalized}" in
    ''|daemon|d)
      printf 'daemon'
      ;;
    agent|a)
      printf 'agent'
      ;;
    *)
      print_error "不支持的服务模式：${answer}"
      exit 1
      ;;
  esac
}

confirm_if_needed() {
  local prompt="$1"
  if [[ "${SERVICE_ARG_ASSUME_YES}" == '1' ]]; then
    return 0
  fi

  if [[ ! -t 0 ]]; then
    return 0
  fi

  local answer normalized
  read -r -p "${prompt} [Y/n]: " answer || true
  normalized="$(printf '%s' "${answer}" | tr '[:upper:]' '[:lower:]')"
  case "${normalized}" in
    ''|y|yes)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

install_launchd_mode() {
  local mode="$1"
  local plist_path temp_plist other_mode
  plist_path="$(service_plist_path_for_mode "${mode}")"

  if [[ "${mode}" == 'daemon' && "${EUID}" -ne 0 ]]; then
    rerun_with_sudo '安装开机启动 LaunchDaemon' install-service --mode daemon -y
  fi

  other_mode='agent'
  if [[ "${mode}" == 'agent' ]]; then
    other_mode='daemon'
  fi
  if [[ -f "$(service_plist_path_for_mode "${other_mode}")" ]]; then
    print_error "检测到已安装的 $(service_mode_label "${other_mode}")。请先执行 ./scripts/macos-bridge.sh uninstall-service --mode ${other_mode}"
    exit 1
  fi

  mkdir -p "${LOG_DIR}"
  if [[ "${mode}" == 'agent' ]]; then
    mkdir -p "$(dirname "${plist_path}")"
  fi

  temp_plist="${RUN_DIR}/${SERVICE_LABEL}.${mode}.plist"
  write_launchd_plist "${mode}" "${temp_plist}"
  plutil -lint "${temp_plist}" >/dev/null

  stop_process_by_pidfile >/dev/null 2>&1 || true

  if [[ "${mode}" == 'daemon' ]]; then
    install -m 644 "${temp_plist}" "${plist_path}"
    chown root:wheel "${plist_path}"
  else
    install -m 644 "${temp_plist}" "${plist_path}"
  fi

  launchctl bootout "$(service_target_for_mode "${mode}")" >/dev/null 2>&1 || true
  launchctl bootstrap "$(service_domain_for_mode "${mode}")" "${plist_path}"
  launchctl kickstart -k "$(service_target_for_mode "${mode}")" >/dev/null 2>&1 || true

  sleep 2
  print_info "已安装 $(service_mode_label "${mode}")"
  print_info "服务标签：${SERVICE_LABEL}"
  print_info "plist 文件：${plist_path}"
  print_info '异常退出后会由 launchd 自动拉起。'
}

uninstall_launchd_mode() {
  local mode="$1"
  local plist_path
  plist_path="$(service_plist_path_for_mode "${mode}")"

  if [[ ! -f "${plist_path}" ]]; then
    return 0
  fi

  if [[ "${mode}" == 'daemon' && "${EUID}" -ne 0 ]]; then
    rerun_with_sudo '卸载开机启动 LaunchDaemon' uninstall-service --mode daemon -y
  fi

  launchctl bootout "$(service_target_for_mode "${mode}")" >/dev/null 2>&1 || true
  rm -f "${plist_path}"
  if ! is_running; then
    rm -f "${PID_FILE}" || true
  fi
  print_info "已卸载 $(service_mode_label "${mode}")"
}

run_doctor() {
  require_macos
  augment_launch_path
  require_command node
  require_command npm
  require_command codex
  check_node_version

  print_info "Node.js: $(node -v)"
  print_info "npm: $(npm -v)"
  print_info "codex: $(codex --version)"
  print_info "服务标签：${SERVICE_LABEL}"

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

  if [[ -f "${SECRET_ENV_FILE}" ]]; then
    print_info "独立密钥文件已存在：${SECRET_ENV_FILE}"
  else
    print_warn "独立密钥文件不存在：${SECRET_ENV_FILE}"
  fi

  local token
  token="$(read_secret_value "${TOKEN_ENV_KEY}")"
  if [[ -n "${token}" ]]; then
    print_info "${TOKEN_ENV_KEY} 已配置"
  else
    print_warn "${TOKEN_ENV_KEY} 未配置"
  fi

  local proxy raw_ca_cert ca_cert
  proxy="$(read_env_value 'OPENCLAW_DISCORD_PROXY' || true)"
  raw_ca_cert="$(read_env_value 'OPENCLAW_DISCORD_CA_CERT' || true)"
  if [[ -n "${proxy}" ]]; then
    print_info "已配置 Discord 代理：${proxy}"
    print_info '检测到代理时，start / service-run 会自动为 Node 注入 --use-system-ca'
    if [[ -f '/etc/ssl/cert.pem' ]]; then
      print_info '检测到 /etc/ssl/cert.pem，start / service-run 会把它作为额外 CA bundle 注入'
    fi
  fi
  if [[ -n "${raw_ca_cert}" ]]; then
    ca_cert="$(expand_home_path "${raw_ca_cert}")"
    if [[ -f "${ca_cert}" ]]; then
      print_info "已配置额外 CA 证书：${ca_cert}"
    else
      print_warn "已配置 OPENCLAW_DISCORD_CA_CERT，但文件不存在：${ca_cert}"
    fi
  elif [[ -n "${proxy}" ]]; then
    print_info '如代理仍报 unable to get local issuer certificate，可额外设置 OPENCLAW_DISCORD_CA_CERT=/path/to/proxy-ca.pem'
  fi

  if [[ -f "$(daemon_plist_path)" ]]; then
    print_info "已安装 $(service_mode_label daemon)：$(daemon_plist_path)"
  elif [[ -f "$(agent_plist_path)" ]]; then
    print_info "已安装 $(service_mode_label agent)：$(agent_plist_path)"
  else
    print_warn '尚未安装 launchd 自启动服务'
  fi
}

run_configure() {
  require_macos
  require_command node
  load_secret_env
  ensure_env_file
  migrate_project_token_to_secret_env
  prompt_interactive_configuration
  validate_required_env
}

run_setup() {
  run_doctor
  ensure_env_file
  migrate_project_token_to_secret_env

  if should_prompt_for_configuration; then
    prompt_interactive_configuration
  fi

  validate_required_env
  augment_launch_path

  print_header '安装依赖'
  (cd "${ROOT_DIR}" && npm install)
  print_header '类型检查'
  (cd "${ROOT_DIR}" && npm run check)
  print_header '构建'
  (cd "${ROOT_DIR}" && npm run build)

  local admin_id web_port default_sandbox
  admin_id="$(read_env_value 'DISCORD_ADMIN_USER_IDS' || true)"
  web_port="$(read_env_value 'WEB_PORT' || true)"
  default_sandbox="$(read_env_value 'DEFAULT_CODEX_SANDBOX' || true)"

  print_header 'setup 完成'
  print_info "配置文件：${ENV_FILE}"
  print_info "独立密钥文件：${SECRET_ENV_FILE}"
  print_info "Web 面板：http://127.0.0.1:${web_port:-3769}"
  print_info "${TOKEN_ENV_KEY} 已配置"
  print_info "默认沙箱：${default_sandbox:-danger-full-access}"
  if [[ -z "${admin_id}" ]]; then
    print_warn 'DISCORD_ADMIN_USER_IDS 为空；你也可以依赖 Discord 频道管理权限来执行管理员命令'
  fi
  print_info '下一步：./scripts/macos-bridge.sh start'
}

run_service_run() {
  require_macos
  augment_launch_path
  require_command node
  require_command codex
  load_secret_env
  ensure_env_file
  migrate_project_token_to_secret_env
  validate_required_env
  maybe_export_proxy
  maybe_configure_node_tls
  sanitize_codex_desktop_env

  if [[ ! -f "${ROOT_DIR}/dist/index.js" ]]; then
    print_error 'dist/index.js 不存在，请先执行 ./scripts/macos-bridge.sh setup'
    exit 1
  fi

  rm -f "${PID_FILE}" >/dev/null 2>&1 || true

  print_header '前台运行服务'
  cd "${ROOT_DIR}"
  echo "$$" > "${PID_FILE}"
  print_info "服务已进入前台运行，PID=$$"
  exec node dist/index.js
}

run_start_manual() {
  require_macos
  augment_launch_path
  require_command node
  require_command npm
  require_command codex
  load_secret_env
  ensure_env_file
  migrate_project_token_to_secret_env
  validate_required_env
  maybe_export_proxy
  maybe_configure_node_tls

  if is_running; then
    print_warn "服务已在运行，PID=$(cat "${PID_FILE}")"
    return 0
  fi

  if [[ ! -f "${ROOT_DIR}/dist/index.js" ]]; then
    print_warn 'dist 不存在，先执行 setup'
    run_setup
  fi

  print_header '后台启动服务'
  (
    cd "${ROOT_DIR}"
    nohup /bin/bash "${SCRIPT_DIR}/macos-bridge.sh" service-run >> "${LOG_FILE}" 2>&1 &
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

run_start() {
  local installed_mode=''
  installed_mode="$(detect_installed_service_mode || true)"

  if [[ -n "${installed_mode}" ]]; then
    print_header "启动 $(service_mode_label "${installed_mode}")"
    if has_multiple_installed_service_modes; then
      print_warn '同时检测到 LaunchAgent 和 LaunchDaemon，属于冲突状态。建议卸载后仅保留一种模式。'
    fi
    if [[ "${installed_mode}" == 'daemon' && "${EUID}" -ne 0 ]]; then
      rerun_with_sudo '启动开机启动 LaunchDaemon' start
    fi

    launchctl bootout "$(service_target_for_mode "${installed_mode}")" >/dev/null 2>&1 || true
    if ! launchctl bootstrap "$(service_domain_for_mode "${installed_mode}")" "$(service_plist_path_for_mode "${installed_mode}")"; then
      print_warn 'launchd 启动失败，回退到普通后台进程启动；本次运行不会具备 launchd 自动拉起能力。'
      run_start_manual
      return 0
    fi
    launchctl kickstart -k "$(service_target_for_mode "${installed_mode}")" >/dev/null 2>&1 || true
    sleep 2
    run_status
    return 0
  fi

  run_start_manual
}

run_stop() {
  local installed_mode=''
  installed_mode="$(detect_installed_service_mode || true)"

  if [[ -n "${installed_mode}" ]]; then
    print_header "停止 $(service_mode_label "${installed_mode}")"
    if [[ "${installed_mode}" == 'daemon' && "${EUID}" -ne 0 ]]; then
      rerun_with_sudo '停止开机启动 LaunchDaemon' stop
    fi

    launchctl bootout "$(service_target_for_mode "${installed_mode}")" >/dev/null 2>&1 || true
    sleep 1
    if ! is_running; then
      rm -f "${PID_FILE}" || true
    fi
    print_info 'launchd 服务已停止；plist 文件仍保留，重启系统后仍会自动拉起。'
    return 0
  fi

  stop_process_by_pidfile
}

run_restart() {
  run_stop
  run_start
}

run_service_status() {
  local web_port pid installed_mode
  web_port="$(read_env_value 'WEB_PORT' || true)"
  installed_mode="$(detect_installed_service_mode || true)"

  print_header 'launchd 服务状态'
  print_info "服务标签：${SERVICE_LABEL}"

  if has_multiple_installed_service_modes; then
    print_warn '同时安装了 LaunchDaemon 与 LaunchAgent；这会增加启动冲突风险。建议卸载后只保留一种。'
  fi

  if [[ -f "$(daemon_plist_path)" ]]; then
    print_info "已安装：$(service_mode_label daemon)"
    print_info "plist：$(daemon_plist_path)"
    if service_is_bootstrapped daemon; then
      print_info 'launchctl：已加载'
    else
      print_warn 'launchctl：未加载'
    fi
  fi

  if [[ -f "$(agent_plist_path)" ]]; then
    print_info "已安装：$(service_mode_label agent)"
    print_info "plist：$(agent_plist_path)"
    if service_is_bootstrapped agent; then
      print_info 'launchctl：已加载'
    else
      print_warn 'launchctl：未加载'
    fi
  fi

  if [[ -z "${installed_mode}" ]]; then
    print_warn '当前未安装 launchd 服务'
  fi

  if is_running; then
    pid="$(cat "${PID_FILE}")"
    print_info "进程状态：运行中，PID=${pid}"
  else
    print_warn '进程状态：未运行'
  fi

  print_info "Web 面板：http://127.0.0.1:${web_port:-3769}"
  print_info "日志文件：${LOG_FILE}"
}

run_status() {
  local web_port installed_mode
  web_port="$(read_env_value 'WEB_PORT' || true)"
  installed_mode="$(detect_installed_service_mode || true)"

  if is_running; then
    print_info "服务运行中，PID=$(cat "${PID_FILE}")"
    print_info "Web 面板：http://127.0.0.1:${web_port:-3769}"
    print_info "日志文件：${LOG_FILE}"
  else
    print_warn '服务未运行'
    print_info '启动命令：./scripts/macos-bridge.sh start'
  fi

  if [[ -n "${installed_mode}" ]]; then
    print_info "自启动模式：$(service_mode_label "${installed_mode}")"
    print_info "服务标签：${SERVICE_LABEL}"
  fi

  if has_multiple_installed_service_modes; then
    print_warn '当前同时安装了 LaunchDaemon 和 LaunchAgent；建议清理成单一模式。'
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

run_install_service() {
  local mode
  mode="$(resolve_requested_service_mode)"

  confirm_if_needed "确认安装 $(service_mode_label "${mode}")？" || {
    print_warn '已取消安装。'
    return 0
  }

  run_setup
  install_launchd_mode "${mode}"
  run_service_status
}

run_uninstall_service() {
  local mode=''

  if [[ -n "${SERVICE_ARG_MODE}" ]]; then
    mode="${SERVICE_ARG_MODE}"
    case "${mode}" in
      daemon|agent) ;;
      *)
        print_error "不支持的服务模式：${mode}"
        exit 1
        ;;
    esac

    if [[ ! -f "$(service_plist_path_for_mode "${mode}")" ]]; then
      print_warn "未检测到 $(service_mode_label "${mode}")"
      return 0
    fi

    confirm_if_needed "确认卸载 $(service_mode_label "${mode}")？" || {
      print_warn '已取消卸载。'
      return 0
    }

    uninstall_launchd_mode "${mode}"
    return 0
  fi

  confirm_if_needed '确认卸载当前仓库对应的所有 launchd 服务？' || {
    print_warn '已取消卸载。'
    return 0
  }

  uninstall_launchd_mode daemon
  uninstall_launchd_mode agent
}

prompt_deploy_service_mode() {
  if [[ ! -t 0 ]]; then
    return 1
  fi

  local answer normalized mode_answer mode_normalized
  read -r -p '是否安装为 macOS 自启动服务？[Y/n]: ' answer || true
  normalized="$(printf '%s' "${answer}" | tr '[:upper:]' '[:lower:]')"
  case "${normalized}" in
    n|no)
      return 1
      ;;
  esac

  read -r -p '选择服务模式 [daemon/agent]（默认 daemon，daemon=开机启动，agent=登录后启动）: ' mode_answer || true
  mode_normalized="$(printf '%s' "${mode_answer}" | tr '[:upper:]' '[:lower:]')"
  case "${mode_normalized}" in
    ''|daemon|d)
      printf 'daemon'
      ;;
    agent|a)
      printf 'agent'
      ;;
    *)
      print_error "不支持的服务模式：${mode_answer}"
      exit 1
      ;;
  esac
}

run_deploy() {
  local install_mode=''
  run_setup

  install_mode="$(prompt_deploy_service_mode || true)"
  if [[ -n "${install_mode}" ]]; then
    install_launchd_mode "${install_mode}"
    run_service_status
    return 0
  fi

  run_start
}

main() {
  load_secret_env
  augment_launch_path

  local command="${1:-help}"
  shift || true

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
      run_restart
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
    service-run)
      run_service_run
      ;;
    service-status)
      run_service_status
      ;;
    install-service)
      parse_service_args "$@"
      run_install_service
      ;;
    uninstall-service)
      parse_service_args "$@"
      run_uninstall_service
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
