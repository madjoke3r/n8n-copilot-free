#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# n8n-copilot-free  —  Uninstaller
# Stops and removes all containers, networks, and volumes created by setup.sh.
# The install directory itself is removed last.
#
# Usage: bash uninstall.sh [--keep-data]
#   --keep-data   Remove containers/networks but KEEP Docker volumes
#                 (preserves n8n workflows and database)
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env"
COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.yml"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

info()   { echo -e "${CYAN}[info]${RESET}  $*"; }
ok()     { echo -e "${GREEN}[ok]${RESET}    $*"; }
warn()   { echo -e "${YELLOW}[warn]${RESET}  $*"; }
header() { echo -e "\n${BOLD}${CYAN}══ $* ══${RESET}"; }

KEEP_DATA=false
for arg in "$@"; do
  [[ "$arg" == "--keep-data" ]] && KEEP_DATA=true
done

# ── compose binary ────────────────────────────────────────────────────────────
if docker compose version &>/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose &>/dev/null; then
  COMPOSE="docker-compose"
else
  COMPOSE=""
fi

# ── confirm ───────────────────────────────────────────────────────────────────
header "n8n-copilot-free Uninstaller"
echo ""
if [[ "$KEEP_DATA" == "true" ]]; then
  echo -e "  ${YELLOW}This will stop and remove all containers and networks.${RESET}"
  echo -e "  ${GREEN}Docker volumes (n8n workflows, database) will be KEPT.${RESET}"
else
  echo -e "  ${RED}${BOLD}This will stop and remove ALL containers, networks, and volumes.${RESET}"
  echo -e "  ${RED}All n8n workflows, credentials, and database data will be DELETED.${RESET}"
  echo -e "  Use --keep-data to preserve your data."
fi
echo ""
read -rp "  Continue? [y/N] " CONFIRM
if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
  echo "  Aborted."
  exit 0
fi

# ── stop and remove via compose ───────────────────────────────────────────────
header "Stopping containers"

if [[ -n "$COMPOSE" && -f "$COMPOSE_FILE" ]]; then
  ENV_ARGS=""
  [[ -f "$ENV_FILE" ]] && ENV_ARGS="--env-file ${ENV_FILE}"

  if [[ "$KEEP_DATA" == "true" ]]; then
    $COMPOSE $ENV_ARGS -f "$COMPOSE_FILE" down --remove-orphans 2>/dev/null || true
    ok "Containers and networks removed (volumes kept)"
  else
    $COMPOSE $ENV_ARGS -f "$COMPOSE_FILE" down --volumes --remove-orphans 2>/dev/null || true
    ok "Containers, networks, and volumes removed"
  fi
else
  # Compose not available or compose file gone — stop by container name
  warn "docker compose not available — stopping containers by name"
  for name in n8n-app n8n-postgres copilot-api copilot-shim; do
    if docker ps -a --format '{{.Names}}' | grep -q "^${name}$"; then
      docker rm -f "$name" 2>/dev/null && info "Removed container: ${name}" || true
    fi
  done

  if [[ "$KEEP_DATA" != "true" ]]; then
    for vol in n8n_data postgres_data copilot_data; do
      if docker volume inspect "$vol" &>/dev/null 2>&1; then
        docker volume rm "$vol" 2>/dev/null && info "Removed volume: ${vol}" || true
      fi
    done
    for net in n8n-net n8n_n8n-net; do
      if docker network inspect "$net" &>/dev/null 2>&1; then
        docker network rm "$net" 2>/dev/null && info "Removed network: ${net}" || true
      fi
    done
  fi
fi

# ── remove generated files ────────────────────────────────────────────────────
header "Cleaning up generated files"

for f in .env docker-compose.yml certs; do
  target="${SCRIPT_DIR}/${f}"
  if [[ -e "$target" ]]; then
    rm -rf "$target"
    info "Removed: ${f}"
  fi
done

# ── remove install directory ──────────────────────────────────────────────────
header "Removing install directory"

PARENT_DIR="$(dirname "$SCRIPT_DIR")"
INSTALL_DIR_NAME="$(basename "$SCRIPT_DIR")"

echo -e "  ${YELLOW}Remove the install directory '${INSTALL_DIR_NAME}'? [y/N]${RESET} "
read -rp "  " REMOVE_DIR
if [[ "$REMOVE_DIR" =~ ^[Yy]$ ]]; then
  cd "$PARENT_DIR"
  rm -rf "${SCRIPT_DIR}"
  ok "Install directory removed"
else
  info "Install directory kept at: ${SCRIPT_DIR}"
fi

# ── done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "  ${GREEN}${BOLD}Uninstall complete.${RESET}"
if [[ "$KEEP_DATA" == "true" ]]; then
  echo -e "  ${CYAN}Your Docker volumes still exist. Re-run setup.sh to reconnect to your data.${RESET}"
fi
echo ""
