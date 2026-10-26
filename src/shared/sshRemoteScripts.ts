import { PORACODE_REMOTE_PROTOCOL_VERSION } from "./remote/protocol";

export const REMOTE_NODE_ENV_SCRIPT = String.raw`
PORACODE_PORTABLE_NODE_VERSION="v24.10.0"

prepend_path_if_dir() {
  if [ -d "$1" ]; then
    case ":$PATH:" in
      *":$1:"*) ;;
      *) PATH="$1:$PATH" ;;
    esac
  fi
}

poracode_node_is_compatible() {
  node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 24 || (major === 24 && minor >= 10) ? 0 : 1)' >/dev/null 2>&1
}

poracode_sha256() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    return 1
  fi
}

install_poracode_portable_node() {
  PLATFORM="$(uname -s)-$(uname -m)"
  case "$PLATFORM" in
    Darwin-arm64)
      ARCHIVE="node-$PORACODE_PORTABLE_NODE_VERSION-darwin-arm64.tar.gz"
      ROOT="node-$PORACODE_PORTABLE_NODE_VERSION-darwin-arm64"
      EXPECTED="fbc3d6e1e1d962450d058e918214373872cc4c46e08673f31c35932afac4a8c5"
      TAR_ARGS="-xzf"
      ;;
    Darwin-x86_64)
      ARCHIVE="node-$PORACODE_PORTABLE_NODE_VERSION-darwin-x64.tar.gz"
      ROOT="node-$PORACODE_PORTABLE_NODE_VERSION-darwin-x64"
      EXPECTED="627b884f66db0dd35f4b46fb9e994774ce560a7fb60798ba1ab81e867a73687d"
      TAR_ARGS="-xzf"
      ;;
    Linux-aarch64|Linux-arm64)
      ARCHIVE="node-$PORACODE_PORTABLE_NODE_VERSION-linux-arm64.tar.xz"
      ROOT="node-$PORACODE_PORTABLE_NODE_VERSION-linux-arm64"
      EXPECTED="07f0558316ebb8977dd6fb29b4de8d369a639d3d8cef544293852a6f5eea6af8"
      TAR_ARGS="-xJf"
      ;;
    Linux-x86_64|Linux-amd64)
      ARCHIVE="node-$PORACODE_PORTABLE_NODE_VERSION-linux-x64.tar.xz"
      ROOT="node-$PORACODE_PORTABLE_NODE_VERSION-linux-x64"
      EXPECTED="2642f4428869aca32443660fd71b3918e2be1277a899bdcaeb64c93b54b5af17"
      TAR_ARGS="-xJf"
      ;;
    *) return 1 ;;
  esac

  NODE_ROOT="$HOME/.poracode/ssh/node"
  FINAL="$NODE_ROOT/$ROOT"
  if [ -x "$FINAL/bin/node" ]; then
    prepend_path_if_dir "$FINAL/bin"
    poracode_node_is_compatible && return 0
  fi

  mkdir -p "$NODE_ROOT"
  LOCK="$NODE_ROOT/.install-$PORACODE_PORTABLE_NODE_VERSION-$PLATFORM"
  if ! mkdir "$LOCK" 2>/dev/null; then
    ATTEMPT=0
    while [ "$ATTEMPT" -lt 120 ]; do
      if [ -x "$FINAL/bin/node" ]; then
        prepend_path_if_dir "$FINAL/bin"
        poracode_node_is_compatible && return 0
      fi
      ATTEMPT=$((ATTEMPT + 1))
      sleep 0.5
    done
    return 1
  fi

  TMP="$NODE_ROOT/.download-$ARCHIVE-$$"
  STAGE="$NODE_ROOT/.stage-$ROOT-$$"
  URL="https://nodejs.org/dist/$PORACODE_PORTABLE_NODE_VERSION/$ARCHIVE"
  DOWNLOAD_OK=0
  if command -v curl >/dev/null 2>&1; then
    curl --fail --location --silent --show-error --retry 2 --connect-timeout 15 \
      --output "$TMP" "$URL" && DOWNLOAD_OK=1
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$TMP" "$URL" && DOWNLOAD_OK=1
  fi
  if [ "$DOWNLOAD_OK" != "1" ] || [ "$(poracode_sha256 "$TMP" 2>/dev/null || true)" != "$EXPECTED" ]; then
    rm -f "$TMP"
    rm -rf "$STAGE"
    rmdir "$LOCK" 2>/dev/null || true
    return 1
  fi

  mkdir -p "$STAGE"
  if ! tar $TAR_ARGS "$TMP" -C "$STAGE"; then
    rm -f "$TMP"
    rm -rf "$STAGE"
    rmdir "$LOCK" 2>/dev/null || true
    return 1
  fi
  rm -f "$TMP"
  rm -rf "$FINAL"
  if ! mv "$STAGE/$ROOT" "$FINAL"; then
    rm -rf "$STAGE"
    rmdir "$LOCK" 2>/dev/null || true
    return 1
  fi
  rm -rf "$STAGE"
  rmdir "$LOCK" 2>/dev/null || true
  prepend_path_if_dir "$FINAL/bin"
  poracode_node_is_compatible
}

ensure_poracode_node() {
  prepend_path_if_dir "$HOME/.local/bin"
  prepend_path_if_dir "$HOME/bin"
  prepend_path_if_dir "/opt/homebrew/bin"
  prepend_path_if_dir "/usr/local/bin"
  prepend_path_if_dir "/usr/bin"
  prepend_path_if_dir "/bin"

  if command -v node >/dev/null 2>&1 && poracode_node_is_compatible; then
    return 0
  fi

  VOLTA_HOME="\${VOLTA_HOME:-$HOME/.volta}"
  export VOLTA_HOME
  prepend_path_if_dir "$VOLTA_HOME/bin"

  prepend_path_if_dir "$HOME/.asdf/shims"
  prepend_path_if_dir "$HOME/.asdf/bin"
  if [ -s "$HOME/.asdf/asdf.sh" ]; then
    . "$HOME/.asdf/asdf.sh" >/dev/null 2>&1 || true
  fi

  prepend_path_if_dir "$HOME/.local/share/mise/shims"
  prepend_path_if_dir "$HOME/.mise/shims"
  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then
    eval "$(mise activate sh)" >/dev/null 2>&1 || true
  fi

  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then
    eval "$(fnm env --shell bash)" >/dev/null 2>&1 || true
    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true
  fi

  prepend_path_if_dir "$HOME/.nodenv/bin"
  prepend_path_if_dir "$HOME/.nodenv/shims"
  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then
    eval "$(nodenv init -)" >/dev/null 2>&1 || true
  fi

  NVM_DIR="\${NVM_DIR:-$HOME/.nvm}"
  export NVM_DIR
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    . "$NVM_DIR/nvm.sh"
    nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true
  fi
  if ! command -v node >/dev/null 2>&1 && [ -d "$NVM_DIR/versions/node" ]; then
    for PORACODE_NODE_BIN in "$NVM_DIR"/versions/node/*/bin; do
      prepend_path_if_dir "$PORACODE_NODE_BIN"
    done
  fi

  if command -v node >/dev/null 2>&1 && poracode_node_is_compatible; then
    return 0
  fi

  install_poracode_portable_node
}
`;

/**
 * Mirror host-owned, filesystem-backed provider profiles into an SSH helper's
 * isolated settings file. The helper deliberately has its own database and
 * secret-storage key, so copying the whole desktop settings file would be both
 * unsafe and corrupting. Only profile definitions are portable: credentials
 * remain in their provider-specific home/config directories on the SSH host.
 *
 * Kept as a shell function so it also runs before an already-active compatible
 * helper is reused; no agent process has to be restarted merely to discover a
 * profile added through the host's desktop app.
 */
export const REMOTE_AGENT_PROFILE_SYNC_FUNCTION = String.raw`
sync_host_agent_profiles() {
  "$NODE" - "$1" "$2" "$3" "$4" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const sourcePath = process.argv[2];
const destinationPath = process.argv[3];
const statePath = process.argv[4];
const channel = process.argv[5];
const profileDrivers = new Set(["claude", "codex", "antigravity", "kimi"]);
const validId = /^[a-z0-9][a-z0-9_\-:.]{0,119}$/i;

function readJson(filePath, fallback, label) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    process.stderr.write("Poracode SSH left " + label + " unchanged because " + filePath + " is invalid JSON.\n");
    return undefined;
  }
}

function objectRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function portableConfig(driver, value) {
  const config = objectRecord(value);
  if (driver === "claude") {
    if (typeof config.configDir !== "string" || config.configDir.length === 0) return undefined;
    const portable = { configDir: config.configDir };
    if (Array.isArray(config.models)) {
      portable.models = config.models
        .filter((model) => model && typeof model === "object" && typeof model.id === "string")
        .map((model) => ({
          id: model.id,
          ...(typeof model.label === "string" ? { label: model.label } : {}),
        }));
    }
    if (Array.isArray(config.efforts)) portable.efforts = config.efforts.filter((item) => typeof item === "string");
    if (typeof config.defaultEffort === "string") portable.defaultEffort = config.defaultEffort;
    if (config.modelEfforts && typeof config.modelEfforts === "object" && !Array.isArray(config.modelEfforts)) {
      portable.modelEfforts = Object.fromEntries(
        Object.entries(config.modelEfforts)
          .filter(([, efforts]) => Array.isArray(efforts))
          .map(([model, efforts]) => [model, efforts.filter((item) => typeof item === "string")]),
      );
    }
    return portable;
  }
  if (typeof config.homeDir !== "string" || config.homeDir.length === 0) return undefined;
  return { homeDir: config.homeDir };
}

function writeJsonAtomic(filePath, value) {
  const encoded = JSON.stringify(value, null, 2) + "\n";
  if (fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8") === encoded) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = filePath + ".tmp-" + process.pid;
  fs.writeFileSync(temporaryPath, encoded, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

const source = readJson(sourcePath, {}, "profile sync");
if (source === undefined) process.exit(0);
const destination = readJson(destinationPath, {}, "helper settings");
if (destination === undefined) process.exit(0);
const previousState = readJson(statePath, { ids: [] }, "profile sync state") ?? { ids: [] };
const previousIds = new Set(Array.isArray(previousState.ids) ? previousState.ids : []);
const destinationInstances = { ...objectRecord(destination.agentInstances) };

for (const id of previousIds) {
  if (typeof id === "string") delete destinationInstances[id];
}

const sourceProfiles = [];
for (const [id, rawInstance] of Object.entries(objectRecord(source.agentInstances))) {
  if (!validId.test(id) || !rawInstance || typeof rawInstance !== "object" || Array.isArray(rawInstance)) continue;
  const instance = rawInstance;
  if (instance.id !== id || typeof instance.driver !== "string" || !profileDrivers.has(instance.driver)) continue;
  const config = portableConfig(instance.driver, instance.config);
  if (!config) continue;

  const existing = destinationInstances[id];
  if (
    existing &&
    typeof existing === "object" &&
    !Array.isArray(existing) &&
    typeof existing.driver === "string" &&
    !profileDrivers.has(existing.driver)
  ) {
    continue;
  }

  const portable = {
    id,
    driver: instance.driver,
    config,
    ...(typeof instance.displayName === "string" ? { displayName: instance.displayName } : {}),
    ...(typeof instance.version === "string" ? { version: instance.version } : {}),
    ...(typeof instance.accentColor === "string" ? { accentColor: instance.accentColor } : {}),
    ...(typeof instance.enabled === "boolean" ? { enabled: instance.enabled } : {}),
  };
  destinationInstances[id] = portable;
  sourceProfiles.push(id);
}

destination.agentInstances = destinationInstances;
writeJsonAtomic(destinationPath, destination);
writeJsonAtomic(statePath, { channel, ids: sourceProfiles.sort() });
NODE
}
`;

export const PROBE_REMOTE_RUNTIME_SCRIPT = String.raw`set -eu
${REMOTE_NODE_ENV_SCRIPT}
HASH="$1"
RUNTIME="$HOME/.poracode/ssh/runtime/$HASH"
ensure_poracode_node || {
  printf 'Poracode SSH could not provision its private Node runtime. Check outbound access to nodejs.org, then retry.\n' >&2
  exit 41
}
if [ -f "$RUNTIME/.ready" ] && [ "$(cat "$RUNTIME/.ready")" = "$HASH" ] && [ -f "$RUNTIME/server.cjs" ] && [ -f "$RUNTIME/supervisor.cjs" ]; then
  printf 'ready\n'
else
  printf 'install\n'
fi
`;

export const PREPARE_REMOTE_UPLOAD_SCRIPT = String.raw`set -eu
mkdir -p "$HOME/.poracode/ssh/uploads" "$HOME/.poracode/ssh/runtime"
`;

export const INSTALL_REMOTE_RUNTIME_SCRIPT = String.raw`set -eu
${REMOTE_NODE_ENV_SCRIPT}
HASH="$1"
case "$HASH" in
  *[!0-9a-f]*|'') printf 'Invalid Poracode runtime hash.\n' >&2; exit 2 ;;
esac
ensure_poracode_node || {
  printf 'Poracode SSH could not provision its private Node runtime. Check outbound access to nodejs.org, then retry.\n' >&2
  exit 41
}
command -v npm >/dev/null 2>&1 || {
  printf 'Poracode SSH requires npm on the remote host.\n' >&2
  exit 42
}
BASE="$HOME/.poracode/ssh"
ARCHIVE="$BASE/uploads/$HASH.tar.gz"
FINAL="$BASE/runtime/$HASH"
STAGE="$BASE/runtime/.staging-$HASH-$$"
PREVIOUS="$BASE/runtime/.previous-$HASH-$$"
test -f "$ARCHIVE" || { printf 'Uploaded Poracode runtime archive was not found.\n' >&2; exit 43; }
rm -rf "$STAGE" "$PREVIOUS"
mkdir -p "$STAGE"
cleanup() { rm -rf "$STAGE" "$PREVIOUS"; }
trap cleanup EXIT
tar -xzf "$ARCHIVE" -C "$STAGE"
(
  cd "$STAGE"
  npm install --omit=dev --no-audit --no-fund --loglevel=error
)
mkdir -p "$HOME/.poracode/agent-plugins"
if [ -d "$STAGE/agent-plugins" ]; then
  cp -R "$STAGE/agent-plugins/." "$HOME/.poracode/agent-plugins/"
fi
printf '%s\n' "$HASH" >"$STAGE/.ready"
if [ -d "$FINAL" ]; then
  mv "$FINAL" "$PREVIOUS"
fi
if ! mv "$STAGE" "$FINAL"; then
  if [ -d "$PREVIOUS" ]; then mv "$PREVIOUS" "$FINAL"; fi
  exit 44
fi
rm -rf "$PREVIOUS"
rm -f "$ARCHIVE"
trap - EXIT
printf 'ready\n'
`;

export const LAUNCH_REMOTE_SERVER_SCRIPT = String.raw`set -eu
${REMOTE_NODE_ENV_SCRIPT}
${REMOTE_AGENT_PROFILE_SYNC_FUNCTION}
CONNECTION_ID="$1"
RUNTIME_HASH="$2"
CHANNEL="$3"
case "$CONNECTION_ID" in
  *[!0-9a-f-]*|'') printf 'Invalid Poracode SSH connection id.\n' >&2; exit 2 ;;
esac
case "$RUNTIME_HASH" in
  *[!0-9a-f]*|'') printf 'Invalid Poracode runtime hash.\n' >&2; exit 2 ;;
esac
case "$CHANNEL" in
  stable) HOST_SETTINGS="$HOME/.poracode/settings.json" ;;
  nightly) HOST_SETTINGS="$HOME/.poracode-nightly/settings.json" ;;
  *) printf 'Invalid Poracode channel.\n' >&2; exit 2 ;;
esac
ensure_poracode_node || {
  printf 'Poracode SSH could not provision its private Node runtime. Check outbound access to nodejs.org, then retry.\n' >&2
  exit 41
}
NODE="$(command -v node)"
BASE="$HOME/.poracode/ssh"
RUNTIME="$BASE/runtime/$RUNTIME_HASH"
STATE="$BASE/hosts/$CONNECTION_ID"
PID_FILE="$STATE/pid"
PORT_FILE="$STATE/port"
RUNTIME_FILE="$STATE/runtime"
LOG_FILE="$STATE/server.log"
DATA_DIR="$STATE/data"
mkdir -p "$STATE" "$DATA_DIR"
test -f "$RUNTIME/.ready" || { printf 'Poracode remote runtime is not installed.\n' >&2; exit 45; }
APP_VERSION="$("$NODE" -p 'require(process.argv[1]).version' "$RUNTIME/package.json")"
sync_host_agent_profiles \
  "$HOST_SETTINGS" \
  "$DATA_DIR/settings.json" \
  "$STATE/host-agent-profiles.json" \
  "$CHANNEL"

server_ready() {
  REQUIRE_EXACT_VERSION="\${3:-1}"
  "$NODE" - "$1" "$2" "$REQUIRE_EXACT_VERSION" <<'NODE'
const http = require("node:http");
const port = Number(process.argv[2]);
const appVersion = process.argv[3];
const requireExactVersion = process.argv[4] !== "0";
const req = http.get({ host: "127.0.0.1", port, path: "/.well-known/poracode/environment", timeout: 800 }, (res) => {
  let body = "";
  res.setEncoding("utf8");
  res.on("data", (chunk) => { body += chunk; });
  res.on("end", () => {
    try {
      const descriptor = JSON.parse(body);
      process.exit(
        res.statusCode === 200 &&
        descriptor.protocolVersion === ${PORACODE_REMOTE_PROTOCOL_VERSION} &&
        descriptor.hostMode === "helper" &&
        (!requireExactVersion || descriptor.appVersion === appVersion)
          ? 0
          : 1
      );
    } catch {
      process.exit(1);
    }
  });
});
req.on("timeout", () => { req.destroy(); process.exit(1); });
req.on("error", () => process.exit(1));
NODE
}

server_has_active_threads() {
  "$NODE" - "$RUNTIME/node_modules/better-sqlite3" "$DATA_DIR/state.sqlite" <<'NODE'
try {
  const Database = require(process.argv[2]);
  const db = new Database(process.argv[3], { readonly: true, fileMustExist: true });
  const row = db
    .prepare("select count(*) as count from threads where status in ('working','starting','queued')")
    .get();
  db.close();
  process.exit(Number(row?.count ?? 0) > 0 ? 0 : 1);
} catch {
  process.exit(1);
}
NODE
}

stop_server() {
  if [ -z "$1" ] || ! kill -0 "$1" 2>/dev/null; then return; fi
  kill "$1" 2>/dev/null || true
  ATTEMPT=0
  while [ "$ATTEMPT" -lt 50 ] && kill -0 "$1" 2>/dev/null; do
    ATTEMPT=$((ATTEMPT + 1))
    sleep 0.1
  done
  if kill -0 "$1" 2>/dev/null; then
    kill -KILL "$1" 2>/dev/null || true
    ATTEMPT=0
    while [ "$ATTEMPT" -lt 20 ] && kill -0 "$1" 2>/dev/null; do
      ATTEMPT=$((ATTEMPT + 1))
      sleep 0.1
    done
  fi
}

pick_port() {
  "$NODE" <<'NODE'
const net = require("node:net");
(async () => {
  for (let port = 49152; port <= 65535; port += 1) {
    const available = await new Promise((resolve) => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
    });
    if (available) { process.stdout.write(String(port)); return; }
  }
  process.exit(1);
})().catch(() => process.exit(1));
NODE
}

PID="$(cat "$PID_FILE" 2>/dev/null || true)"
PORT="$(cat "$PORT_FILE" 2>/dev/null || true)"
CURRENT_RUNTIME="$(cat "$RUNTIME_FILE" 2>/dev/null || true)"
ACTUAL_RUNTIME=""
case "$PID" in *[!0-9]*|'') PID="" ;; esac
case "$PORT" in *[!0-9]*|'') PORT="" ;; esac
case "$CURRENT_RUNTIME" in *[!0-9a-f]*|'') CURRENT_RUNTIME="" ;; esac

# A previous bootstrap may have removed the state files after racing a still
# shutting-down helper. Recover the owner from the shared data-dir lock and the
# last listening port/runtime from the process log/command before deciding
# whether an upgrade is required.
LOCK_PID="$(cat "$DATA_DIR/server.lock" 2>/dev/null || true)"
case "$LOCK_PID" in *[!0-9]*|'') LOCK_PID="" ;; esac
if [ -z "$PID" ] && [ -n "$LOCK_PID" ] && kill -0 "$LOCK_PID" 2>/dev/null; then PID="$LOCK_PID"; fi
if [ -z "$PORT" ] && [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
  PORT="$(sed -n 's#.*listening at:.*:\([0-9][0-9]*\)/.*#\1#p' "$LOG_FILE" 2>/dev/null | tail -n 1)"
  case "$PORT" in *[!0-9]*|'') PORT="" ;; esac
fi
if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
  ACTUAL_RUNTIME="$(ps -p "$PID" -o command= 2>/dev/null | sed -n 's#.*[/]runtime/\([0-9a-f][0-9a-f]*\)/server\.cjs.*#\1#p' | tail -n 1)"
  case "$ACTUAL_RUNTIME" in *[!0-9a-f]*|'') ACTUAL_RUNTIME="" ;; esac
  if [ -z "$CURRENT_RUNTIME" ]; then CURRENT_RUNTIME="$ACTUAL_RUNTIME"; fi
fi

# The state file may intentionally retain the other channel's compatible hash
# as an alias, while the process command exposes the runtime that is actually
# executing. Reuse either exact match. A same-version hash that matches neither
# is a hotfix and must replace the stale helper once it is safe to do so. An
# app restart must never turn an in-flight remote turn into an interruption:
# keep a protocol-compatible helper until every active thread has settled.
REUSE_SERVER=0
if [ -n "$PID" ] && [ -n "$PORT" ] && kill -0 "$PID" 2>/dev/null && \
  { [ "$CURRENT_RUNTIME" = "$RUNTIME_HASH" ] || [ "$ACTUAL_RUNTIME" = "$RUNTIME_HASH" ]; } && \
  server_ready "$PORT" "$APP_VERSION"; then
  REUSE_SERVER=1
elif [ -n "$PID" ] && [ -n "$PORT" ] && kill -0 "$PID" 2>/dev/null && \
  server_ready "$PORT" "$APP_VERSION" 0 && server_has_active_threads; then
  REUSE_SERVER=1
fi

if [ "$REUSE_SERVER" = "1" ]; then
  printf '%s\n' "$PID" >"$PID_FILE"
  printf '%s\n' "$PORT" >"$PORT_FILE"
  if [ -n "$CURRENT_RUNTIME" ]; then printf '%s\n' "$CURRENT_RUNTIME" >"$RUNTIME_FILE"; fi
else
  COMPAT_RUNTIME="$CURRENT_RUNTIME"
  stop_server "$PID"
  rm -f "$PID_FILE" "$PORT_FILE" "$RUNTIME_FILE"
  PORT="$(pick_port)" || { printf 'No remote loopback port is available for Poracode.\n' >&2; exit 46; }
  nohup env \
    PORACODE_BASE_DIR="$DATA_DIR" \
    PORACODE_REMOTE_ACCESS_HOST=127.0.0.1 \
    PORACODE_REMOTE_ACCESS_ADVERTISED_HOST=127.0.0.1 \
    PORACODE_REMOTE_ACCESS_PORT="$PORT" \
    PORACODE_APP_VERSION="$APP_VERSION" \
    PORACODE_WSL_HELPERS_DIR="$RUNTIME/wsl-helpers" \
    PORACODE_BUNDLED_SKILLS_DIR="$RUNTIME/skills" \
    PORACODE_BUNDLED_PLUGINS_DIR="$RUNTIME/plugins" \
    "$NODE" "$RUNTIME/server.cjs" >>"$LOG_FILE" 2>&1 </dev/null &
  PID="$!"
  printf '%s\n' "$PID" >"$PID_FILE"
  printf '%s\n' "$PORT" >"$PORT_FILE"
  # Keep the previous runtime hash as an alias when upgrading a compatible
  # stable helper. Older Poracode clients compare only this file plus the wire
  # protocol, so the alias lets Stable and Nightly share the upgraded process
  # instead of repeatedly replacing one another.
  if [ -n "$COMPAT_RUNTIME" ] && [ "$COMPAT_RUNTIME" != "$RUNTIME_HASH" ]; then
    printf '%s\n' "$COMPAT_RUNTIME" >"$RUNTIME_FILE"
  else
    printf '%s\n' "$RUNTIME_HASH" >"$RUNTIME_FILE"
  fi
  READY=0
  ATTEMPT=0
  while [ "$ATTEMPT" -lt 100 ]; do
    if server_ready "$PORT" "$APP_VERSION"; then READY=1; break; fi
    if ! kill -0 "$PID" 2>/dev/null; then break; fi
    ATTEMPT=$((ATTEMPT + 1))
    sleep 0.2
  done
  if [ "$READY" -ne 1 ]; then
    printf 'Poracode Helper failed to start or returned an incompatible protocol.\n' >&2
    tail -n 80 "$LOG_FILE" >&2 2>/dev/null || true
    kill "$PID" 2>/dev/null || true
    rm -f "$PID_FILE" "$PORT_FILE" "$RUNTIME_FILE"
    exit 47
  fi
fi
printf '{"remotePort":%s}\n' "$PORT"
`;

export const PAIR_REMOTE_SERVER_SCRIPT = String.raw`set -eu
${REMOTE_NODE_ENV_SCRIPT}
CONNECTION_ID="$1"
RUNTIME_HASH="$2"
ensure_poracode_node || exit 41
NODE="$(command -v node)"
BASE="$HOME/.poracode/ssh"
RUNTIME="$BASE/runtime/$RUNTIME_HASH"
DATA_DIR="$BASE/hosts/$CONNECTION_ID/data"
PORACODE_BASE_DIR="$DATA_DIR" exec "$NODE" "$RUNTIME/server.cjs" pair --json
`;
