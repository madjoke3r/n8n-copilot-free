#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# n8n-copilot-free  —  One-shot setup script
# Deploys n8n + GitHub Copilot as a free local LLM backend via Docker Compose.
#
# Requirements: Docker + Docker Compose v2, bash, curl, openssl
# Usage:        bash setup.sh
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="${SCRIPT_DIR}/config.env"
ENV_FILE="${SCRIPT_DIR}/.env"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.yml"

# ── colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${CYAN}[info]${RESET}  $*"; }
ok()      { echo -e "${GREEN}[ok]${RESET}    $*"; }
warn()    { echo -e "${YELLOW}[warn]${RESET}  $*"; }
error()   { echo -e "${RED}[error]${RESET} $*" >&2; }
header()  { echo -e "\n${BOLD}${CYAN}══ $* ══${RESET}"; }

# ── pre-flight ────────────────────────────────────────────────────────────────
header "Pre-flight checks"

if ! command -v docker &>/dev/null; then
  error "Docker is not installed. Install it from https://docs.docker.com/get-docker/"
  exit 1
fi
ok "Docker found: $(docker --version)"

# Accept both 'docker compose' (v2 plugin) and 'docker-compose' (v1 standalone)
if docker compose version &>/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose &>/dev/null; then
  COMPOSE="docker-compose"
else
  error "Docker Compose not found. Install it: https://docs.docker.com/compose/install/"
  exit 1
fi
ok "Compose found: $($COMPOSE version)"

if [[ ! -f "$CONFIG_FILE" ]]; then
  error "config.env not found at ${CONFIG_FILE}"
  exit 1
fi

# ── load config ───────────────────────────────────────────────────────────────
header "Loading configuration"

# Source safely — only grab known variables
# shellcheck source=config.env
source <(grep -E '^[A-Z_]+=.*' "$CONFIG_FILE" | grep -v '^#')

N8N_PORT="${N8N_PORT:-5678}"
COPILOT_API_PORT="${COPILOT_API_PORT:-4141}"
COPILOT_SHIM_PORT="${COPILOT_SHIM_PORT:-4142}"
COPILOT_API_VERSION="${COPILOT_API_VERSION:-0.7.0}"
DB_USER="${DB_USER:-n8n}"
DB_PASSWORD="${DB_PASSWORD:-changeme123}"
DB_NAME="${DB_NAME:-n8n}"
N8N_HOST="${N8N_HOST:-localhost}"
N8N_PROTOCOL="${N8N_PROTOCOL:-http}"
N8N_EDITOR_BASE_URL="${N8N_EDITOR_BASE_URL:-http://localhost:${N8N_PORT}}"
WEBHOOK_URL="${WEBHOOK_URL:-http://localhost:${N8N_PORT}/webhook}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-Change@Me123}"
N8N_SSL_CERT="${N8N_SSL_CERT:-}"
N8N_SSL_KEY="${N8N_SSL_KEY:-}"
N8N_SECURE_COOKIE="${N8N_SECURE_COOKIE:-false}"

info "Desired ports → n8n:${N8N_PORT}  copilot-api:${COPILOT_API_PORT}  shim:${COPILOT_SHIM_PORT}"

# ── port checker ──────────────────────────────────────────────────────────────
header "Port availability check"

# Returns 0 if port is free, 1 if in use
port_in_use() {
  local port="$1"
  # Try ss first (Linux), fall back to netstat, fall back to /dev/tcp
  if command -v ss &>/dev/null; then
    ss -tlnp 2>/dev/null | grep -q ":${port} " && return 0 || return 1
  elif command -v netstat &>/dev/null; then
    netstat -tlnp 2>/dev/null | grep -q ":${port} " && return 0 || return 1
  else
    # Bash /dev/tcp fallback (no external tool needed)
    (echo >/dev/tcp/127.0.0.1/"$port") 2>/dev/null && return 0 || return 1
  fi
}

# Find next available port starting from $1
next_free_port() {
  local port="$1"
  while port_in_use "$port"; do
    warn "Port ${port} is already in use — trying $((port+1))"
    port=$((port + 1))
  done
  echo "$port"
}

N8N_PORT=$(next_free_port "$N8N_PORT")
COPILOT_API_PORT=$(next_free_port "$COPILOT_API_PORT")
COPILOT_SHIM_PORT=$(next_free_port "$COPILOT_SHIM_PORT")

ok "Resolved ports → n8n:${N8N_PORT}  copilot-api:${COPILOT_API_PORT}  shim:${COPILOT_SHIM_PORT}"

# ── generate secrets if not set ───────────────────────────────────────────────
header "Secrets"

# Priority order for encryption key:
#  1. Explicitly set in config.env
#  2. Already in .env from a previous setup run
#  3. Auto-detected from a running n8n-app container
#  4. Auto-detected from the n8n_data volume (n8n not running)
#  5. Generate a fresh random key (fresh install only)

CFG_ENCRYPTION_KEY="${N8N_ENCRYPTION_KEY:-}"
CFG_JWT_SECRET="${JWT_SECRET:-}"

# Check existing .env
if [[ -f "$ENV_FILE" ]]; then
  EXISTING_KEY="$(grep '^N8N_ENCRYPTION_KEY=' "$ENV_FILE" | cut -d= -f2-)"
  EXISTING_JWT="$(grep '^JWT_SECRET=' "$ENV_FILE" | cut -d= -f2-)"
  [[ -z "$CFG_ENCRYPTION_KEY" && -n "$EXISTING_KEY" ]] && CFG_ENCRYPTION_KEY="$EXISTING_KEY"
  [[ -z "$CFG_JWT_SECRET" && -n "$EXISTING_JWT" ]] && CFG_JWT_SECRET="$EXISTING_JWT"
fi

# Auto-detect from running n8n container
if [[ -z "$CFG_ENCRYPTION_KEY" ]]; then
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -q 'n8n-app\|n8n_app'; then
    CONTAINER_NAME=$(docker ps --format '{{.Names}}' | grep -E 'n8n-app|n8n_app' | head -1)
    DETECTED="$(docker exec "$CONTAINER_NAME" cat /home/node/.n8n/config 2>/dev/null \
      | grep -o '"encryptionKey":"[^"]*"' | cut -d'"' -f4)"
    if [[ -n "$DETECTED" ]]; then
      CFG_ENCRYPTION_KEY="$DETECTED"
      info "Auto-detected N8N_ENCRYPTION_KEY from running container (${CONTAINER_NAME})"
    fi
  fi
fi

# Auto-detect from n8n_data volume (n8n stopped but volume exists)
if [[ -z "$CFG_ENCRYPTION_KEY" ]]; then
  for VOL in n8n_data n8n_n8n_data; do
    if docker volume inspect "$VOL" &>/dev/null 2>&1; then
      DETECTED="$(docker run --rm -v "${VOL}":/n8ndata alpine \
        sh -c 'cat /n8ndata/config 2>/dev/null' \
        | grep -o '"encryptionKey":"[^"]*"' | cut -d'"' -f4 2>/dev/null || true)"
      if [[ -n "$DETECTED" ]]; then
        CFG_ENCRYPTION_KEY="$DETECTED"
        info "Auto-detected N8N_ENCRYPTION_KEY from volume (${VOL})"
        break
      fi
    fi
  done
fi

if [[ -z "$CFG_ENCRYPTION_KEY" ]]; then
  CFG_ENCRYPTION_KEY="$(openssl rand -hex 24)"
  info "Generated new N8N_ENCRYPTION_KEY (fresh install)"
else
  info "N8N_ENCRYPTION_KEY resolved — existing data will be preserved"
fi

if [[ -z "$CFG_JWT_SECRET" ]]; then
  CFG_JWT_SECRET="$(openssl rand -hex 24)"
  info "Generated JWT_SECRET (saved to .env)"
else
  info "Using JWT_SECRET from config"
fi

# ── write .env ─────────────────────────────────────────────────────────────────
header "Writing .env"

cat > "$ENV_FILE" <<EOF
# Auto-generated by setup.sh on $(date -u '+%Y-%m-%d %H:%M UTC')
# Do not edit by hand — re-run setup.sh to regenerate.

# Ports (auto-resolved)
N8N_PORT=${N8N_PORT}
COPILOT_API_PORT=${COPILOT_API_PORT}
COPILOT_SHIM_PORT=${COPILOT_SHIM_PORT}

# copilot-api
COPILOT_API_VERSION=${COPILOT_API_VERSION}

# Database
DB_USER=${DB_USER}
DB_PASSWORD=${DB_PASSWORD}
DB_NAME=${DB_NAME}

# n8n
N8N_HOST=${N8N_HOST}
N8N_PROTOCOL=${N8N_PROTOCOL}
N8N_EDITOR_BASE_URL=${N8N_EDITOR_BASE_URL}
WEBHOOK_URL=${WEBHOOK_URL}
N8N_ENCRYPTION_KEY=${CFG_ENCRYPTION_KEY}
JWT_SECRET=${CFG_JWT_SECRET}
ADMIN_PASSWORD=${ADMIN_PASSWORD}
N8N_SECURE_COOKIE=${N8N_SECURE_COOKIE}
EOF

# Write SSL vars only if provided
if [[ -n "${N8N_SSL_CERT}" && -n "${N8N_SSL_KEY}" ]]; then
  echo "N8N_SSL_CERT=${N8N_SSL_CERT}" >> "$ENV_FILE"
  echo "N8N_SSL_KEY=${N8N_SSL_KEY}" >> "$ENV_FILE"
  info "SSL cert paths written to .env"
fi

ok ".env written to ${ENV_FILE}"

# ── patch compose for SSL if certs provided ───────────────────────────────────
if [[ -n "${N8N_SSL_CERT}" && -n "${N8N_SSL_KEY}" ]]; then
  CERT_DIR="$(dirname "${N8N_SSL_CERT}")"
  info "Patching docker-compose.yml for SSL (cert dir: ${CERT_DIR})"
  python3 - "$COMPOSE_FILE" "$CERT_DIR" <<'PYEOF'
import sys
compose_file, cert_dir = sys.argv[1], sys.argv[2]
with open(compose_file, 'r') as f:
    c = f.read()
if 'N8N_SSL_CERT' not in c:
    c = c.replace(
        '      N8N_PUSH_BACKEND: websocket',
        '      N8N_PUSH_BACKEND: websocket\n      N8N_SSL_CERT: ${N8N_SSL_CERT}\n      N8N_SSL_KEY: ${N8N_SSL_KEY}'
    )
if 'certs:ro' not in c:
    c = c.replace(
        '      - n8n_data:/home/node/.n8n',
        '      - n8n_data:/home/node/.n8n\n      - ' + cert_dir + ':/certs:ro'
    )
with open(compose_file, 'w') as f:
    f.write(c)
print('compose patched for SSL')
PYEOF
  ok "docker-compose.yml patched for SSL"
fi

# ── pull images ───────────────────────────────────────────────────────────────
header "Pulling Docker images"
$COMPOSE --env-file "$ENV_FILE" -f "$COMPOSE_FILE" pull --quiet
ok "Images pulled"

# ── start stack ───────────────────────────────────────────────────────────────
header "Starting services"
$COMPOSE --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d
ok "All containers started"

# ── wait for copilot-api ──────────────────────────────────────────────────────
header "Waiting for copilot-api to be ready"

# copilot-api logs the device auth code immediately on first start.
# Check for it within 30s rather than waiting 120s for /v1/models (which needs auth first).
echo -n "  Waiting for copilot-api to start"
ELAPSED=0
COPILOT_READY=false
while [[ $ELAPSED -lt 30 ]]; do
  # Already authenticated from a previous run
  if curl -sf --max-time 2 "http://localhost:${COPILOT_API_PORT}/v1/models" &>/dev/null; then
    echo ""
    ok "copilot-api is ready and authenticated"
    COPILOT_READY=true
    break
  fi
  # Needs auth — device code will be in logs
  if docker logs copilot-api 2>&1 | grep -q 'login/device\|Please enter the code'; then
    echo ""
    AUTH_CODE=$(docker logs copilot-api 2>&1 | grep -oE '[A-Z0-9]{4}-[A-Z0-9]{4}' | tail -1)
    if [[ -n "$AUTH_CODE" ]]; then
      ok "copilot-api is running — GitHub authentication required"
      echo ""
      echo -e "  ${BOLD}${YELLOW}Your one-time GitHub auth code is: ${AUTH_CODE}${RESET}"
    else
      ok "copilot-api is running — GitHub authentication required"
    fi
    COPILOT_READY=true
    break
  fi
  echo -n "."
  sleep 2
  ELAPSED=$((ELAPSED + 2))
done

if [[ "$COPILOT_READY" != "true" ]]; then
  echo ""
  warn "copilot-api did not respond in time. Logs:"
  docker logs copilot-api --tail 10 2>&1 | sed 's/^/  /'
fi

# ── GitHub device auth ────────────────────────────────────────────────────────
header "GitHub Copilot Authentication"

echo ""
if [[ -n "${AUTH_CODE:-}" ]]; then
  echo -e "  ${BOLD}Your one-time code is shown above.${RESET}"
else
  echo -e "  ${BOLD}Get your one-time auth code by running:${RESET}"
  echo ""
  echo -e "     ${YELLOW}docker exec -it copilot-api copilot-api auth${RESET}"
  echo ""
fi
echo "  Open this URL in your browser and enter the code:"
echo -e "     ${CYAN}https://github.com/login/device${RESET}"
echo ""
echo "  Approve access with your GitHub account (Copilot subscription must be active)."
echo "  The auth token is stored in a Docker volume and persists across restarts."
echo ""
read -rp "  Press Enter once you have completed GitHub auth to continue..."

# ── verify shim ───────────────────────────────────────────────────────────────
header "Verifying shim"

if curl -sf "http://localhost:${COPILOT_SHIM_PORT}/v1/models" &>/dev/null; then
  ok "Shim is reachable at http://localhost:${COPILOT_SHIM_PORT}/v1"
else
  warn "Could not reach shim on port ${COPILOT_SHIM_PORT}. Check: docker logs copilot-shim"
fi

# ── wait for n8n ──────────────────────────────────────────────────────────────
header "Waiting for n8n"

echo -n "  Waiting"
ELAPSED=0
N8N_HEALTH_PROTO="${N8N_PROTOCOL:-http}"
until curl -sfk "${N8N_HEALTH_PROTO}://localhost:${N8N_PORT}/healthz" &>/dev/null; do
  if [[ $ELAPSED -ge 90 ]]; then
    echo ""
    warn "n8n did not respond within 90s. Check: docker logs n8n-app"
    break
  fi
  echo -n "."
  sleep 3
  ELAPSED=$((ELAPSED + 3))
done
echo ""
ok "n8n is up"

# ── final instructions ────────────────────────────────────────────────────────
header "Setup complete"

echo ""
echo -e "  ${GREEN}${BOLD}Everything is running!${RESET}"
echo ""
echo -e "  ${BOLD}n8n URL:${RESET}           ${N8N_PROTOCOL:-http}://localhost:${N8N_PORT}"
echo -e "  ${BOLD}Admin password:${RESET}    ${ADMIN_PASSWORD}"
echo ""
echo -e "  ${YELLOW}If you access n8n via a reverse proxy or different URL, use that instead.${RESET}"
echo -e "  ${YELLOW}To uninstall cleanly, run:  bash uninstall.sh${RESET}"
echo ""
echo -e "  ${BOLD}${CYAN}Configure n8n to use GitHub Copilot as AI:${RESET}"
echo "  ─────────────────────────────────────────"
echo "  1. Open n8n → Settings → Credentials → New"
echo "  2. Search for: OpenAI"
echo "  3. Set:"
echo -e "       Base URL:  ${YELLOW}http://copilot-shim:4142/v1${RESET}"
echo -e "       (copilot-shim is the Docker container name — always port 4142 internally)"
echo -e "       API Key:   ${YELLOW}dummy${RESET}"
echo "  4. Save and use this credential in any AI Agent node or Personal Agents chat."
echo ""
echo -e "  ${BOLD}Useful commands:${RESET}"
echo "  docker logs -f copilot-shim       # watch AI request translation"
echo "  docker logs -f copilot-api        # watch upstream Copilot calls"
echo "  $COMPOSE --env-file .env -f docker-compose.yml down   # stop all"
echo "  $COMPOSE --env-file .env -f docker-compose.yml up -d  # start all"
echo ""
echo -e "  ${BOLD}To re-run setup (e.g. after editing config.env):${RESET}"
echo "  bash setup.sh"
echo ""
