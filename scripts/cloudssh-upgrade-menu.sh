#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# CloudSSH online upgrade / rollback menu for the host deployment.
# Defaults match the production layout used by hwyc888/cloudssh on Armbian.
SCRIPT_VERSION="1.1.0"
INSTALL_DIR="${CLOUDSSH_INSTALL_DIR:-/root/cloudssh}"
ENV_FILE="${CLOUDSSH_ENV_FILE:-$INSTALL_DIR/.env}"
COMPOSE_FILE="${CLOUDSSH_COMPOSE_FILE:-$INSTALL_DIR/docker/docker-compose.cloudssh.yml}"
BACKUP_ROOT="${CLOUDSSH_UPGRADE_BACKUP_DIR:-/root/cloudssh-upgrade-backups}"
TARGET_IMAGE="${CLOUDSSH_TARGET_IMAGE:-ghcr.io/hwyc888/cloudssh:latest}"
SCRIPT_SOURCE_URL="${CLOUDSSH_UPGRADE_SCRIPT_URL:-https://raw.githubusercontent.com/hwyc888/cloudssh/main/scripts/cloudssh-upgrade-menu.sh}"
DEFAULT_HTTP_PORT="${CLOUDSSH_DEFAULT_HTTP_PORT:-2244}"
HEALTH_TIMEOUT_SECONDS="${CLOUDSSH_HEALTH_TIMEOUT_SECONDS:-120}"

ACTIVE_DATA_VOLUME=""
ACTIVE_RECORDINGS_VOLUME=""
CURRENT_CONTAINER_ID=""
SELF_UPDATE_CHANGED=0

info() { printf '\033[1;36m%s\033[0m\n' "$*"; }
ok() { printf '\033[1;32m%s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m%s\033[0m\n' "$*" >&2; }
fail() { printf '\033[1;31m错误：%s\033[0m\n' "$*" >&2; return 1; }

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    printf '缺少必需命令：%s\n' "$1" >&2
    exit 2
  }
}

pause_screen() {
  printf '\n按 Enter 返回菜单...'
  read -r _ || true
}

self_script_path() {
  local script_path="${BASH_SOURCE[0]}"
  if [[ "$script_path" == /* ]]; then
    printf '%s' "$script_path"
  else
    printf '%s/%s' "$(cd "$(dirname "$script_path")" && pwd -P)" "$(basename "$script_path")"
  fi
}

download_to() {
  local url="$1"
  local output="$2"
  if [[ "$url" == file://* ]]; then
    cp "${url#file://}" "$output"
  elif command -v curl >/dev/null 2>&1; then
    curl -fsSL --connect-timeout 15 --max-time 60 "$url" -o "$output"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -T 60 -O "$output" "$url"
  else
    fail '在线升级脚本需要 curl 或 wget'
    return 1
  fi
}

self_update() {
  local current_path tmp remote_version previous_path
  SELF_UPDATE_CHANGED=0
  current_path="$(self_script_path)"
  tmp="$(mktemp "${TMPDIR:-/tmp}/cloudssh-upgrade-menu.XXXXXX")"
  previous_path="${current_path}.previous"

  info '===== 在线升级 CloudSSH 管理脚本 ====='
  printf '当前脚本版本：%s\n' "$SCRIPT_VERSION"
  printf '更新地址：%s\n' "$SCRIPT_SOURCE_URL"

  if ! download_to "$SCRIPT_SOURCE_URL" "$tmp"; then
    rm -f "$tmp"
    fail '下载管理脚本失败，当前脚本未修改'
    return 1
  fi

  if [[ "$(head -n 1 "$tmp" 2>/dev/null || true)" != '#!/usr/bin/env bash' ]] ||
    ! grep -Fq 'CloudSSH online upgrade / rollback menu for the host deployment.' "$tmp"; then
    rm -f "$tmp"
    fail '下载内容不是有效的 CloudSSH 升级管理脚本'
    return 1
  fi

  if ! "$BASH" -n "$tmp"; then
    rm -f "$tmp"
    fail '下载脚本未通过 Bash 语法检查，当前脚本未修改'
    return 1
  fi

  remote_version="$(sed -n 's/^SCRIPT_VERSION="\([^"]*\)"$/\1/p' "$tmp" | head -n 1)"
  [[ -n "$remote_version" ]] || remote_version='unknown'
  printf '在线脚本版本：%s\n' "$remote_version"

  if cmp -s "$current_path" "$tmp"; then
    rm -f "$tmp"
    ok '当前管理脚本已经是最新版。'
    return 0
  fi

  [[ -f "$current_path" && -w "$(dirname "$current_path")" ]] || {
    rm -f "$tmp"
    fail "无法写入当前脚本：$current_path"
    return 1
  }

  cp -a "$current_path" "$previous_path"
  chmod --reference="$current_path" "$tmp" 2>/dev/null || chmod 700 "$tmp"
  if ! mv "$tmp" "$current_path"; then
    rm -f "$tmp"
    fail '替换管理脚本失败；旧脚本仍保留'
    return 1
  fi

  SELF_UPDATE_CHANGED=1
  ok "管理脚本升级完成：$SCRIPT_VERSION -> $remote_version"
  printf '旧脚本备份：%s\n' "$previous_path"
}

get_env() {
  local key="$1"
  sed -n "s/^${key}=//p" "$ENV_FILE" | tail -n 1
}

set_env() {
  local key="$1"
  local value="$2"
  local tmp
  tmp="$(mktemp "${ENV_FILE}.tmp.XXXXXX")"
  awk -v key="$key" -v value="$value" '
    BEGIN { replaced = 0 }
    $0 ~ "^" key "=" {
      if (!replaced) {
        print key "=" value
        replaced = 1
      }
      next
    }
    { print }
    END {
      if (!replaced) print key "=" value
    }
  ' "$ENV_FILE" >"$tmp"
  chmod --reference="$ENV_FILE" "$tmp" 2>/dev/null || chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

compose() {
  CLOUDSSH_DATA_VOLUME="${ACTIVE_DATA_VOLUME:-cloudssh-data}" \
    CLOUDSSH_RECORDINGS_VOLUME="${ACTIVE_RECORDINGS_VOLUME:-cloudssh-recordings}" \
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

container_id() {
  compose ps -a -q cloudssh 2>/dev/null | head -n 1
}

mount_spec() {
  local container="$1"
  local destination="$2"
  docker inspect --format "{{range .Mounts}}{{if eq .Destination \"$destination\"}}{{.Type}}|{{.Name}}{{end}}{{end}}" "$container" 2>/dev/null
}

load_current_runtime() {
  local data_spec recordings_spec
  CURRENT_CONTAINER_ID="$(container_id)"
  [[ -n "$CURRENT_CONTAINER_ID" ]] || return 1

  data_spec="$(mount_spec "$CURRENT_CONTAINER_ID" /app/data)"
  recordings_spec="$(mount_spec "$CURRENT_CONTAINER_ID" /app/data/session_recordings/guacamole)"
  [[ "$data_spec" == volume\|* ]] || return 1
  [[ "$recordings_spec" == volume\|* ]] || return 1

  ACTIVE_DATA_VOLUME="${data_spec#volume|}"
  ACTIVE_RECORDINGS_VOLUME="${recordings_spec#volume|}"
  [[ -n "$ACTIVE_DATA_VOLUME" && -n "$ACTIVE_RECORDINGS_VOLUME" ]]
  [[ "$ACTIVE_DATA_VOLUME" != "$ACTIVE_RECORDINGS_VOLUME" ]]
}

published_port() {
  local port
  port="$(docker port "$CURRENT_CONTAINER_ID" 8080/tcp 2>/dev/null | head -n 1 | awk -F: '{print $NF}')"
  if [[ "$port" =~ ^[0-9]+$ ]]; then
    printf '%s' "$port"
    return
  fi

  port="$(get_env CLOUDSSH_HTTP_PORT || true)"
  if [[ "$port" =~ ^[0-9]+$ ]]; then
    printf '%s' "$port"
  else
    printf '%s' "$DEFAULT_HTTP_PORT"
  fi
}

ensure_runtime_env() {
  local port bind
  port="$(published_port)"
  set_env CLOUDSSH_HTTP_PORT "$port"

  bind="$(get_env CLOUDSSH_BIND_ADDRESS || true)"
  if [[ -z "$bind" ]]; then
    bind="$(docker inspect --format '{{with (index .HostConfig.PortBindings "8080/tcp")}}{{(index . 0).HostIp}}{{end}}' "$CURRENT_CONTAINER_ID" 2>/dev/null || true)"
    [[ -n "$bind" ]] || bind="0.0.0.0"
    set_env CLOUDSSH_BIND_ADDRESS "$bind"
  fi
}

container_version() {
  docker exec "$CURRENT_CONTAINER_ID" node -p "require('/app/package.json').version" 2>/dev/null || printf 'unknown'
}

image_version() {
  local image="$1"
  docker run --rm --entrypoint node "$image" -p "require('/app/package.json').version" 2>/dev/null || printf 'unknown'
}

health_status() {
  docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CURRENT_CONTAINER_ID" 2>/dev/null || printf 'unknown'
}

wait_for_health() {
  local elapsed=0
  local state
  while (( elapsed < HEALTH_TIMEOUT_SECONDS )); do
    CURRENT_CONTAINER_ID="$(container_id)"
    if [[ -n "$CURRENT_CONTAINER_ID" ]]; then
      state="$(health_status)"
      if [[ "$state" == "healthy" || "$state" == "running" ]]; then
        return 0
      fi
      if [[ "$state" == "unhealthy" || "$state" == "exited" || "$state" == "dead" ]]; then
        return 1
      fi
    fi
    sleep 2
    (( elapsed += 2 ))
  done
  return 1
}

verify_preserved_volumes() {
  local data_spec recordings_spec
  CURRENT_CONTAINER_ID="$(container_id)"
  [[ -n "$CURRENT_CONTAINER_ID" ]] || return 1
  data_spec="$(mount_spec "$CURRENT_CONTAINER_ID" /app/data)"
  recordings_spec="$(mount_spec "$CURRENT_CONTAINER_ID" /app/data/session_recordings/guacamole)"
  [[ "$data_spec" == "volume|$ACTIVE_DATA_VOLUME" ]]
  [[ "$recordings_spec" == "volume|$ACTIVE_RECORDINGS_VOLUME" ]]
}

create_restore_point() {
  local timestamp backup_dir image_id image_ref rollback_tag version port git_commit
  timestamp="$(date +%Y%m%d-%H%M%S)"
  backup_dir="$BACKUP_ROOT/$timestamp-$$"
  mkdir -p "$backup_dir"

  image_id="$(docker inspect --format '{{.Image}}' "$CURRENT_CONTAINER_ID")"
  image_ref="$(docker inspect --format '{{.Config.Image}}' "$CURRENT_CONTAINER_ID")"
  version="$(container_version)"
  port="$(published_port)"
  rollback_tag="cloudssh-termix:rollback-$timestamp-$$"
  git_commit="$(git -C "$INSTALL_DIR" rev-parse HEAD 2>/dev/null || printf 'unknown')"

  docker image inspect "$image_id" >/dev/null
  docker image tag "$image_id" "$rollback_tag"

  cp -a "$ENV_FILE" "$backup_dir/env"
  cp -a "$COMPOSE_FILE" "$backup_dir/docker-compose.cloudssh.yml"
  if [[ -f "$INSTALL_DIR/secrets/cloudssh_master_key" ]]; then
    cp -a "$INSTALL_DIR/secrets/cloudssh_master_key" "$backup_dir/cloudssh_master_key"
  fi

  {
    printf 'CREATED_AT=%q\n' "$timestamp"
    printf 'ROLLBACK_TAG=%q\n' "$rollback_tag"
    printf 'PREVIOUS_IMAGE_REF=%q\n' "$image_ref"
    printf 'PREVIOUS_IMAGE_ID=%q\n' "$image_id"
    printf 'PREVIOUS_VERSION=%q\n' "$version"
    printf 'HTTP_PORT=%q\n' "$port"
    printf 'DATA_VOLUME=%q\n' "$ACTIVE_DATA_VOLUME"
    printf 'RECORDINGS_VOLUME=%q\n' "$ACTIVE_RECORDINGS_VOLUME"
    printf 'GIT_COMMIT=%q\n' "$git_commit"
  } >"$backup_dir/metadata.env"

  printf '%s' "$backup_dir"
}

show_status() {
  printf '\n'
  info '===== CloudSSH 当前状态 ====='
  if ! load_current_runtime; then
    warn '未找到可识别的 cloudssh 容器。'
    return 1
  fi
  ensure_runtime_env

  printf '运行版本       : %s\n' "$(container_version)"
  printf '运行镜像       : %s\n' "$(docker inspect --format '{{.Config.Image}}' "$CURRENT_CONTAINER_ID")"
  printf '容器状态       : %s\n' "$(health_status)"
  printf '外部端口       : %s\n' "$(published_port)"
  printf '数据卷         : %s\n' "$ACTIVE_DATA_VOLUME"
  printf 'RDP 录像卷     : %s\n' "$ACTIVE_RECORDINGS_VOLUME"
  printf '.env 镜像      : %s\n' "$(get_env CLOUDSSH_IMAGE || true)"
  printf '目标在线镜像   : %s\n' "$TARGET_IMAGE"
}

rollback_from_dir() {
  local backup_dir="$1"
  local automatic="${2:-0}"

  [[ -f "$backup_dir/metadata.env" && -f "$backup_dir/env" ]] || {
    fail "回滚点不完整：$backup_dir"
    return 1
  }

  # shellcheck disable=SC1090
  source "$backup_dir/metadata.env"
  [[ -n "${ROLLBACK_TAG:-}" && -n "${DATA_VOLUME:-}" && -n "${RECORDINGS_VOLUME:-}" ]] || {
    fail '回滚点元数据不完整'
    return 1
  }
  docker image inspect "$ROLLBACK_TAG" >/dev/null 2>&1 || {
    fail "本机找不到回滚镜像：$ROLLBACK_TAG"
    return 1
  }

  ACTIVE_DATA_VOLUME="$DATA_VOLUME"
  ACTIVE_RECORDINGS_VOLUME="$RECORDINGS_VOLUME"

  if [[ "$automatic" != "1" ]]; then
    printf '\n将回滚到：%s (%s)\n' "${PREVIOUS_VERSION:-unknown}" "$ROLLBACK_TAG"
    printf '数据卷保持不变：%s / %s\n' "$ACTIVE_DATA_VOLUME" "$ACTIVE_RECORDINGS_VOLUME"
    read -r -p '确认回滚？[y/N] ' answer
    [[ "$answer" =~ ^[Yy]$ ]] || return 0
  fi

  cp -a "$backup_dir/env" "$ENV_FILE"
  set_env CLOUDSSH_IMAGE "$ROLLBACK_TAG"
  [[ -n "${HTTP_PORT:-}" ]] && set_env CLOUDSSH_HTTP_PORT "$HTTP_PORT"

  info "正在回滚到 $ROLLBACK_TAG ..."
  if ! compose up -d --no-deps --no-build --force-recreate cloudssh; then
    fail '回滚容器启动失败'
    return 1
  fi
  if ! verify_preserved_volumes; then
    fail '回滚后数据卷校验失败，已停止继续操作'
    return 1
  fi
  if ! wait_for_health; then
    fail '回滚后的容器未通过健康检查'
    return 1
  fi

  ok "回滚完成：$(container_version)"
  printf '端口：%s，数据卷：%s\n' "$(published_port)" "$ACTIVE_DATA_VOLUME"
}

upgrade_latest() {
  local restore_point old_image_id new_image_id new_version port

  printf '\n'
  info '===== 在线升级到 GitHub GHCR latest ====='
  load_current_runtime || {
    fail '找不到当前 cloudssh 容器，拒绝在无法确认数据卷时升级'
    return 1
  }
  ensure_runtime_env
  port="$(published_port)"

  old_image_id="$(docker inspect --format '{{.Image}}' "$CURRENT_CONTAINER_ID")"

  info "拉取镜像：$TARGET_IMAGE"
  if ! docker pull "$TARGET_IMAGE"; then
    fail '镜像拉取失败；当前运行中的 CloudSSH 未被修改'
    return 1
  fi
  new_image_id="$(docker image inspect "$TARGET_IMAGE" --format '{{.Id}}')"
  new_version="$(image_version "$TARGET_IMAGE")"
  printf '待升级版本：%s\n' "$new_version"

  if [[ "$new_image_id" == "$old_image_id" ]]; then
    ok '当前已经是 latest 镜像，无需重建。'
    return 0
  fi

  info '创建升级前回滚点...'
  restore_point="$(create_restore_point)"
  ok "回滚点：$restore_point"

  set_env CLOUDSSH_IMAGE "$TARGET_IMAGE"
  set_env CLOUDSSH_HTTP_PORT "$port"

  info '检查 Compose 配置...'
  if ! compose config >/dev/null; then
    fail 'Compose 配置校验失败；未替换运行中的容器'
    return 1
  fi

  info '只重建 cloudssh 容器（不停止 guacd，不删除任何 volume）...'
  if ! compose up -d --no-deps --no-build --force-recreate cloudssh; then
    warn '新容器启动失败，自动回滚。'
    rollback_from_dir "$restore_point" 1 || true
    return 1
  fi

  if ! verify_preserved_volumes; then
    warn '检测到数据卷不一致，自动回滚。'
    docker logs --tail=200 "$CURRENT_CONTAINER_ID" >"$restore_point/failed-cloudssh.log" 2>&1 || true
    rollback_from_dir "$restore_point" 1 || true
    return 1
  fi

  info '等待健康检查...'
  if ! wait_for_health; then
    warn '新版本健康检查失败，保存日志并自动回滚。'
    CURRENT_CONTAINER_ID="$(container_id)"
    docker logs --tail=300 "$CURRENT_CONTAINER_ID" >"$restore_point/failed-cloudssh.log" 2>&1 || true
    rollback_from_dir "$restore_point" 1 || true
    return 1
  fi

  CURRENT_CONTAINER_ID="$(container_id)"
  ok "升级成功：$(container_version)"
  printf '运行镜像：%s\n' "$(docker inspect --format '{{.Config.Image}}' "$CURRENT_CONTAINER_ID")"
  printf '外部端口：%s（容器内部仍为 8080，这是正常的）\n' "$(published_port)"
  printf '数据卷：%s\n' "$ACTIVE_DATA_VOLUME"
  printf '如需撤回，可从菜单选择回滚点：%s\n' "$restore_point"
}

backup_dirs() {
  [[ -d "$BACKUP_ROOT" ]] || return 0
  find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -name '20*' -print 2>/dev/null | sort -r
}

list_restore_points() {
  local dir count=0
  printf '\n'
  info '===== 可用回滚点 ====='
  while IFS= read -r dir; do
    [[ -f "$dir/metadata.env" ]] || continue
    # shellcheck disable=SC1090
    source "$dir/metadata.env"
    (( count += 1 ))
    printf '%2d) %-18s  版本=%-22s  镜像=%s\n' \
      "$count" "${CREATED_AT:-unknown}" "${PREVIOUS_VERSION:-unknown}" "${ROLLBACK_TAG:-unknown}"
  done < <(backup_dirs)
  (( count > 0 )) || printf '暂无回滚点。\n'
}

rollback_latest() {
  local dir
  dir="$(backup_dirs | head -n 1)"
  [[ -n "$dir" ]] || {
    warn '暂无回滚点。'
    return 1
  }
  rollback_from_dir "$dir"
}

rollback_select() {
  local -a dirs=()
  local dir index
  while IFS= read -r dir; do
    [[ -f "$dir/metadata.env" ]] && dirs+=("$dir")
  done < <(backup_dirs)

  if (( ${#dirs[@]} == 0 )); then
    warn '暂无回滚点。'
    return 1
  fi

  list_restore_points
  printf '选择回滚序号（0 取消）：'
  read -r index
  [[ "$index" =~ ^[0-9]+$ ]] || return 0
  (( index > 0 && index <= ${#dirs[@]} )) || return 0
  rollback_from_dir "${dirs[index-1]}"
}

delete_restore_point() {
  local backup_dir="$1"
  local rollback_tag current_image_ref env_image answer

  [[ "$(dirname "$backup_dir")" == "$BACKUP_ROOT" && -f "$backup_dir/metadata.env" ]] || {
    fail "非法或不完整的回滚点：$backup_dir"
    return 1
  }

  # shellcheck disable=SC1090
  source "$backup_dir/metadata.env"
  rollback_tag="${ROLLBACK_TAG:-}"
  [[ -n "$rollback_tag" ]] || {
    fail '回滚点缺少镜像标签，拒绝删除'
    return 1
  }

  current_image_ref=''
  if load_current_runtime; then
    current_image_ref="$(docker inspect --format '{{.Config.Image}}' "$CURRENT_CONTAINER_ID" 2>/dev/null || true)"
  fi
  env_image="$(get_env CLOUDSSH_IMAGE || true)"

  if [[ "$current_image_ref" == "$rollback_tag" || "$env_image" == "$rollback_tag" ]]; then
    fail "该回滚镜像仍被当前运行配置使用，不能删除：$rollback_tag"
    return 1
  fi

  printf '\n准备永久删除回滚点：\n'
  printf '  时间：%s\n' "${CREATED_AT:-unknown}"
  printf '  版本：%s\n' "${PREVIOUS_VERSION:-unknown}"
  printf '  镜像：%s\n' "$rollback_tag"
  printf '  目录：%s\n' "$backup_dir"
  read -r -p '确认永久删除？删除后不能再用此回滚点。[y/N] ' answer
  [[ "$answer" =~ ^[Yy]$ ]] || return 0

  if docker image inspect "$rollback_tag" >/dev/null 2>&1; then
    if ! docker image rm "$rollback_tag" >/dev/null; then
      fail '无法删除对应的 Docker 回滚镜像，回滚点未删除'
      return 1
    fi
  fi

  rm -rf -- "$backup_dir"
  ok '历史回滚点已删除。'
}

delete_restore_select() {
  local -a dirs=()
  local dir index
  while IFS= read -r dir; do
    [[ -f "$dir/metadata.env" ]] && dirs+=("$dir")
  done < <(backup_dirs)

  if (( ${#dirs[@]} == 0 )); then
    warn '暂无可删除的回滚点。'
    return 1
  fi

  list_restore_points
  printf '选择要删除的回滚点序号（0 取消）：'
  read -r index
  [[ "$index" =~ ^[0-9]+$ ]] || return 0
  (( index > 0 && index <= ${#dirs[@]} )) || return 0
  delete_restore_point "${dirs[index-1]}"
}

preflight() {
  require_command docker
  require_command awk
  require_command sed
  require_command find

  [[ -d "$INSTALL_DIR" ]] || {
    printf '安装目录不存在：%s\n' "$INSTALL_DIR" >&2
    exit 2
  }
  [[ -f "$ENV_FILE" ]] || {
    printf '环境文件不存在：%s\n' "$ENV_FILE" >&2
    exit 2
  }
  [[ -f "$COMPOSE_FILE" ]] || {
    printf 'Compose 文件不存在：%s\n' "$COMPOSE_FILE" >&2
    exit 2
  }
  docker info >/dev/null 2>&1 || {
    printf '当前用户无法访问 Docker。请使用 root 或有 Docker 权限的用户运行。\n' >&2
    exit 2
  }
  docker compose version >/dev/null 2>&1 || {
    printf '未检测到 docker compose v2。\n' >&2
    exit 2
  }
  mkdir -p "$BACKUP_ROOT"
}

menu() {
  local choice
  while true; do
    clear 2>/dev/null || true
    printf '=============================================\n'
    printf '       CloudSSH 升级 / 回滚管理器\n'
    printf '=============================================\n'
    printf '管理脚本版本：%s\n' "$SCRIPT_VERSION"
    printf '安装目录：%s\n' "$INSTALL_DIR"
    printf '目标镜像：%s\n' "$TARGET_IMAGE"
    printf '\n'
    printf '  1) 立即升级到最新版本\n'
    printf '  2) 查看当前运行状态\n'
    printf '  3) 回滚到最近一次升级前版本\n'
    printf '  4) 选择历史回滚点\n'
    printf '  5) 查看所有回滚点\n'
    printf '  6) 删除历史回滚点\n'
    printf '  7) 在线升级本管理脚本\n'
    printf '  0) 退出\n'
    printf '\n请选择：'
    read -r choice || exit 0

    case "$choice" in
      1) upgrade_latest || true; pause_screen ;;
      2) show_status || true; pause_screen ;;
      3) rollback_latest || true; pause_screen ;;
      4) rollback_select || true; pause_screen ;;
      5) list_restore_points; pause_screen ;;
      6) delete_restore_select || true; pause_screen ;;
      7)
        if self_update && (( SELF_UPDATE_CHANGED == 1 )); then
          ok '正在重新启动新版管理脚本...'
          exec "$(self_script_path)"
        fi
        pause_screen
        ;;
      0) exit 0 ;;
      *) warn '无效选择'; sleep 1 ;;
    esac
  done
}

usage() {
  cat <<'EOF'
用法：
  cloudssh-upgrade-menu.sh                打开菜单
  cloudssh-upgrade-menu.sh --upgrade          直接升级 latest
  cloudssh-upgrade-menu.sh --status           查看状态
  cloudssh-upgrade-menu.sh --rollback         回滚到最近回滚点
  cloudssh-upgrade-menu.sh --delete-rollback  选择并删除历史回滚点
  cloudssh-upgrade-menu.sh --self-update      在线升级本管理脚本

可通过环境变量覆盖路径：
  CLOUDSSH_INSTALL_DIR
  CLOUDSSH_ENV_FILE
  CLOUDSSH_COMPOSE_FILE
  CLOUDSSH_UPGRADE_BACKUP_DIR
  CLOUDSSH_TARGET_IMAGE
  CLOUDSSH_UPGRADE_SCRIPT_URL
EOF
}

main() {
  case "${1:-}" in
    -h|--help) usage; return 0 ;;
    --self-update) self_update; return $? ;;
  esac

  preflight
  case "${1:-}" in
    '') menu ;;
    --upgrade) upgrade_latest ;;
    --status) show_status ;;
    --rollback) rollback_latest ;;
    --delete-rollback) delete_restore_select ;;
    *) usage; exit 2 ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
