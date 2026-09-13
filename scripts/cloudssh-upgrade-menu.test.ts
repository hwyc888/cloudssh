import { spawnSync } from "node:child_process";
import { constants, existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = "scripts/cloudssh-upgrade-menu.sh";

function bashExecutable(): string | null {
  if (process.platform !== "win32") return "bash";
  const candidates = [
    "C:/Program Files/Git/bin/bash.exe",
    "C:/Program Files/Git/usr/bin/bash.exe",
  ];
  return candidates.find(existsSync) ?? null;
}

function toShellPath(value: string): string {
  if (process.platform !== "win32") return value;
  const normalized = path.resolve(value).replace(/\\/g, "/");
  return normalized.replace(
    /^([A-Za-z]):/,
    (_match, drive: string) => `/${drive.toLowerCase()}`,
  );
}

async function makeExecutable(filePath: string): Promise<void> {
  await chmod(
    filePath,
    constants.S_IRUSR | constants.S_IWUSR | constants.S_IXUSR,
  );
}

describe("CloudSSH 升级/回滚菜单", () => {
  it("默认使用生产机路径，并始终显式加载 env/compose", async () => {
    const script = await readFile(scriptPath, "utf8");

    expect(script).toContain(
      'INSTALL_DIR="${CLOUDSSH_INSTALL_DIR:-/root/cloudssh}"',
    );
    expect(script).toContain(
      'ENV_FILE="${CLOUDSSH_ENV_FILE:-$INSTALL_DIR/.env}"',
    );
    expect(script).toContain(
      'COMPOSE_FILE="${CLOUDSSH_COMPOSE_FILE:-$INSTALL_DIR/docker/docker-compose.cloudssh.yml}"',
    );
    expect(script).toContain(
      'docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE"',
    );
    expect(script).toContain(
      'DEFAULT_HTTP_PORT="${CLOUDSSH_DEFAULT_HTTP_PORT:-2244}"',
    );
  });

  it("升级前保留镜像、env、主密钥和真实命名卷", async () => {
    const script = await readFile(scriptPath, "utf8");

    expect(script).toContain('docker image tag "$image_id" "$rollback_tag"');
    expect(script).toContain('cp -a "$ENV_FILE" "$backup_dir/env"');
    expect(script).toContain(
      'cp -a "$INSTALL_DIR/secrets/cloudssh_master_key" "$backup_dir/cloudssh_master_key"',
    );
    expect(script).toContain('ACTIVE_DATA_VOLUME="${data_spec#volume|}"');
    expect(script).toContain(
      'ACTIVE_RECORDINGS_VOLUME="${recordings_spec#volume|}"',
    );
    expect(script).toContain("verify_preserved_volumes");
  });

  it("只重建 cloudssh，不删除 volume，并在失败时自动回滚", async () => {
    const script = await readFile(scriptPath, "utf8");

    expect(script).toContain(
      "compose up -d --no-deps --no-build --force-recreate cloudssh",
    );
    expect(script).toContain('rollback_from_dir "$restore_point" 1');
    expect(script).not.toContain("docker compose down");
    expect(script).not.toContain("compose down");
    expect(script).not.toContain(" down -v");
    expect(script).not.toContain("docker volume rm");
    expect(script).not.toContain("docker volume prune");
  });

  it("提供直接升级、状态查看和可选择回滚菜单", async () => {
    const script = await readFile(scriptPath, "utf8");

    expect(script).toContain("1) 立即升级到最新版本");
    expect(script).toContain("2) 查看当前运行状态");
    expect(script).toContain("3) 回滚到最近一次升级前版本");
    expect(script).toContain("4) 选择历史回滚点");
    expect(script).toContain("5) 查看所有回滚点");
    expect(script).toContain("--upgrade) upgrade_latest");
    expect(script).toContain("--rollback) rollback_latest");
  });

  it("通过 bash 语法检查", () => {
    const bash = bashExecutable();
    if (!bash) return;

    const result = spawnSync(bash, ["-n", scriptPath], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it("模拟升级和回滚时保持 2244、CORS 和两个命名卷", async () => {
    const bash = bashExecutable();
    if (!bash) return;

    const root = await mkdtemp(
      path.join(os.tmpdir(), "cloudssh-upgrade-menu-"),
    );
    try {
      const installDir = path.join(root, "cloudssh");
      const mockBin = path.join(root, "mock-bin");
      const stateDir = path.join(root, "state");
      const logPath = path.join(root, "commands.log");
      await Promise.all([
        mkdir(path.join(installDir, "docker"), { recursive: true }),
        mkdir(path.join(installDir, "secrets"), { recursive: true }),
        mkdir(mockBin, { recursive: true }),
        mkdir(stateDir, { recursive: true }),
      ]);

      const envPath = path.join(installDir, ".env");
      await writeFile(
        envPath,
        [
          "CLOUDSSH_BIND_ADDRESS=0.0.0.0",
          "CLOUDSSH_HTTP_PORT=2244",
          "CLOUDSSH_IMAGE=cloudssh-termix:2.6.0-cloudssh.58",
          "ALLOW_REGISTRATION=true",
          "CORS_ALLOWED_ORIGINS=http://192.168.50.241:2244,http://127.0.0.1:2244",
          "",
        ].join("\n"),
      );
      await writeFile(
        path.join(installDir, "docker", "docker-compose.cloudssh.yml"),
        "services:\n  cloudssh: {}\n",
      );
      await writeFile(
        path.join(installDir, "secrets", "cloudssh_master_key"),
        "test-master-key\n",
      );
      await writeFile(path.join(stateDir, "image-id"), "sha256:old-image\n");
      await writeFile(
        path.join(stateDir, "image-ref"),
        "cloudssh-termix:2.6.0-cloudssh.58\n",
      );
      await writeFile(path.join(stateDir, "version"), "2.6.0-cloudssh.58\n");

      const dockerMock = path.join(mockBin, "docker");
      await writeFile(
        dockerMock,
        `#!/usr/bin/env bash
set -euo pipefail
printf '%s data=%s rec=%s\\n' "$*" "\${CLOUDSSH_DATA_VOLUME:-}" "\${CLOUDSSH_RECORDINGS_VOLUME:-}" >> "$MOCK_LOG"
state="$MOCK_STATE"
cmd="\${1:-}"
shift || true
case "$cmd" in
  info) exit 0 ;;
  pull) exit 0 ;;
  port) echo '0.0.0.0:2244'; exit 0 ;;
  exec) cat "$state/version"; exit 0 ;;
  logs) echo 'mock log'; exit 0 ;;
  run) echo '2.6.0-cloudssh.59'; exit 0 ;;
  inspect)
    fmt="\${2:-}"
    case "$fmt" in
      *'.Config.Image'*) cat "$state/image-ref" ;;
      *'.Image'*) cat "$state/image-id" ;;
      *'State.Health'*) echo healthy ;;
      *'PortBindings'*) echo '0.0.0.0' ;;
      *'session_recordings/guacamole'*) echo 'volume|cloudssh-recordings-live' ;;
      *'/app/data'*) echo 'volume|cloudssh-data-live' ;;
      *) exit 0 ;;
    esac
    exit 0
    ;;
  image)
    sub="\${1:-}"; shift || true
    case "$sub" in
      tag)
        printf '%s' "\${2:-}" > "$state/rollback-tag"
        exit 0
        ;;
      inspect)
        image="\${1:-}"
        if [[ "\${2:-}" == '--format' && "\${3:-}" == '{{.Id}}' ]]; then
          if [[ "$image" == 'ghcr.io/hwyc888/cloudssh:latest' ]]; then
            echo 'sha256:new-image'
          else
            echo 'sha256:old-image'
          fi
        fi
        exit 0
        ;;
    esac
    ;;
  compose)
    if [[ "\${1:-}" == 'version' ]]; then echo 'Docker Compose mock'; exit 0; fi
    envfile=''
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --env-file) envfile="$2"; shift 2 ;;
        -f) shift 2 ;;
        *) break ;;
      esac
    done
    sub="\${1:-}"; shift || true
    case "$sub" in
      ps) echo mock-container; exit 0 ;;
      config) exit 0 ;;
      up)
        image="$(sed -n 's/^CLOUDSSH_IMAGE=//p' "$envfile" | tail -n 1)"
        printf '%s\\n' "$image" > "$state/image-ref"
        if [[ "$image" == 'ghcr.io/hwyc888/cloudssh:latest' ]]; then
          echo 'sha256:new-image' > "$state/image-id"
          echo '2.6.0-cloudssh.59' > "$state/version"
        else
          echo 'sha256:old-image' > "$state/image-id"
          echo '2.6.0-cloudssh.58' > "$state/version"
        fi
        exit 0
        ;;
    esac
    ;;
esac
printf 'unexpected docker invocation: %s %s\\n' "$cmd" "$*" >&2
exit 1
`,
      );
      await makeExecutable(dockerMock);

      const shellInstall = toShellPath(installDir);
      const shellMockBin = toShellPath(mockBin);
      const backupRoot = path.join(root, "upgrade-backups");
      const sharedEnv = {
        ...process.env,
        PATH: `${shellMockBin}:${process.env.PATH ?? ""}`,
        CLOUDSSH_INSTALL_DIR: shellInstall,
        CLOUDSSH_UPGRADE_BACKUP_DIR: toShellPath(backupRoot),
        MOCK_LOG: toShellPath(logPath),
        MOCK_STATE: toShellPath(stateDir),
        CLOUDSSH_HEALTH_TIMEOUT_SECONDS: "4",
      };

      const upgrade = spawnSync(bash, [scriptPath, "--upgrade"], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: sharedEnv,
        timeout: 10_000,
      });
      expect(upgrade.status, upgrade.stderr || upgrade.stdout).toBe(0);
      expect(upgrade.stdout).toContain("升级成功：2.6.0-cloudssh.59");

      const upgradedEnv = await readFile(envPath, "utf8");
      expect(upgradedEnv).toContain("CLOUDSSH_HTTP_PORT=2244");
      expect(upgradedEnv).toContain(
        "CORS_ALLOWED_ORIGINS=http://192.168.50.241:2244,http://127.0.0.1:2244",
      );
      expect(upgradedEnv).toContain(
        "CLOUDSSH_IMAGE=ghcr.io/hwyc888/cloudssh:latest",
      );
      expect(
        (await readFile(path.join(stateDir, "version"), "utf8")).trim(),
      ).toBe("2.6.0-cloudssh.59");

      const backups = await readdir(backupRoot);
      expect(backups).toHaveLength(1);
      const backupDir = path.join(backupRoot, backups[0]!);
      expect(await readFile(path.join(backupDir, "env"), "utf8")).toContain(
        "CLOUDSSH_HTTP_PORT=2244",
      );
      expect(
        await readFile(path.join(backupDir, "cloudssh_master_key"), "utf8"),
      ).toBe("test-master-key\n");

      const rollback = spawnSync(bash, [scriptPath, "--rollback"], {
        cwd: process.cwd(),
        encoding: "utf8",
        input: "y\n",
        env: sharedEnv,
        timeout: 10_000,
      });
      expect(rollback.status, rollback.stderr || rollback.stdout).toBe(0);
      expect(rollback.stdout).toContain("回滚完成：2.6.0-cloudssh.58");

      const rolledBackEnv = await readFile(envPath, "utf8");
      expect(rolledBackEnv).toContain("CLOUDSSH_HTTP_PORT=2244");
      expect(rolledBackEnv).toContain(
        "CORS_ALLOWED_ORIGINS=http://192.168.50.241:2244,http://127.0.0.1:2244",
      );
      expect(rolledBackEnv).toMatch(/CLOUDSSH_IMAGE=cloudssh-termix:rollback-/);
      expect(
        (await readFile(path.join(stateDir, "version"), "utf8")).trim(),
      ).toBe("2.6.0-cloudssh.58");

      const log = await readFile(logPath, "utf8");
      expect(log).toContain(
        "data=cloudssh-data-live rec=cloudssh-recordings-live",
      );
      expect(log).not.toContain(" down ");
      expect(log).not.toContain(" -v");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
