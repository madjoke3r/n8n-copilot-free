# n8n-copilot-free

**Run n8n with GitHub Copilot as a free, local AI backend — no OpenAI bill, no data leaving your server.**

> Works with n8n AI Agent workflow nodes **and** Personal Agents chat (the new `/v1/responses` streaming API).

---

## How it works

```
n8n  ──►  copilot-shim (port 4142)  ──►  copilot-api (port 4141)  ──►  GitHub Copilot
```

| Container | Role |
|---|---|
| `n8n-app` | n8n automation platform |
| `n8n-postgres` | n8n database |
| `copilot-api` | Translates GitHub Copilot → OpenAI-compatible REST API |
| `copilot-shim` | Translates n8n's `/v1/responses` (Responses API + SSE streaming) → `/v1/chat/completions` |

`copilot-shim` is a zero-dependency Node.js proxy written specifically to bridge the gap between n8n 2.x Personal Agents and copilot-api.

---

## Requirements

- Docker + Docker Compose v2 (the `docker compose` plugin)
- A GitHub account with **GitHub Copilot** active (free tier works)
- Linux or macOS host (WSL2 on Windows also works)
- `openssl`, `curl`, `bash` — standard on all Linux distros

---

## Quick start

```bash
git clone https://github.com/YOUR_USERNAME/n8n-copilot-free.git
cd n8n-copilot-free

# Optional: edit config.env first (ports, domain, passwords)
nano config.env

bash setup.sh
```

`setup.sh` will:

1. Check Docker is installed
2. Read `config.env` for your desired ports
3. Check each port — if already in use, automatically pick the next available one
4. Generate secure random secrets for n8n (encryption key + JWT)
5. Pull all Docker images
6. Start all four containers
7. Walk you through the one-time GitHub Device Auth flow
8. Print your n8n URL and credential config instructions

---

## Configuration (`config.env`)

| Variable | Default | Description |
|---|---|---|
| `N8N_PORT` | `5678` | n8n web UI port (bound to 127.0.0.1) |
| `COPILOT_API_PORT` | `4141` | copilot-api port |
| `COPILOT_SHIM_PORT` | `4142` | Shim port — **this is what n8n credentials point to** |
| `COPILOT_API_VERSION` | `0.7.0` | Pin copilot-api to a known-good version |
| `DB_PASSWORD` | `changeme123` | PostgreSQL password — **change before going to production** |
| `N8N_HOST` | `localhost` | Your domain if behind a reverse proxy |
| `N8N_PROTOCOL` | `http` | `http` or `https` |
| `N8N_EDITOR_BASE_URL` | `http://localhost:5678` | Full URL users open in their browser |
| `WEBHOOK_URL` | `http://localhost:5678/webhook` | Base URL for n8n webhooks |
| `N8N_ENCRYPTION_KEY` | *(auto-generated)* | Leave blank — setup.sh generates a secure value |
| `JWT_SECRET` | *(auto-generated)* | Leave blank — setup.sh generates a secure value |
| `ADMIN_PASSWORD` | `Change@Me123` | n8n admin password — change this |

> **Port conflicts:** If any port is already in use on your server, setup.sh will automatically increment until it finds a free one and tell you which ports were assigned.

---

## One-time GitHub Authentication

During setup you will be prompted to authenticate:

```
docker exec -it copilot-api copilot-api auth
```

This prints a code like `4E54-1C17`. Open [https://github.com/login/device](https://github.com/login/device), enter the code, and approve access with your GitHub account.

The auth token is saved in a Docker named volume (`copilot_data`) and **survives container restarts** and `docker compose down/up`. You only need to do this once per install.

---

## Configuring n8n to use GitHub Copilot

After setup completes:

1. Open n8n → **Settings → Credentials → New Credential**
2. Search for **OpenAI**
3. Fill in:
   - **Base URL:** `http://copilot-shim:4142/v1`  *(use container name, not localhost — they're on the same Docker network)*
   - **API Key:** `dummy`
4. Save. Use this credential in any AI Agent node or Personal Agents chat.

Available models include `gpt-4o`, `gpt-4o-mini`, `gpt-4.1`, `gpt-4.1-mini`, and others depending on your Copilot plan.

---

## Reverse proxy (optional)

n8n binds to `127.0.0.1:${N8N_PORT}` only. To expose it on a domain, put nginx or Caddy in front:

**Nginx snippet:**

```nginx
server {
    listen 443 ssl;
    server_name automate.example.com;
    # ... ssl config ...

    location / {
        proxy_pass http://127.0.0.1:5678;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 86400;
    }
}
```

Update `N8N_HOST`, `N8N_PROTOCOL`, `N8N_EDITOR_BASE_URL`, and `WEBHOOK_URL` in `config.env` to match your domain, then re-run `bash setup.sh`.

---

## Useful commands

```bash
# View real-time AI request logs
docker logs -f copilot-shim

# View copilot-api upstream logs
docker logs -f copilot-api

# Stop everything
docker compose --env-file .env down

# Start everything again
docker compose --env-file .env up -d

# Re-run setup after editing config.env
bash setup.sh

# Re-authenticate with GitHub (if token expires)
docker exec -it copilot-api copilot-api auth
```

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Cannot read properties of undefined (reading 'content')" in Personal Agents | The shim is not running. Check `docker logs copilot-shim` |
| copilot-api container keeps restarting | Run `docker exec -it copilot-api copilot-api auth` — token may have expired |
| Port already in use error | setup.sh auto-resolves this, but if you're starting manually, check `ss -tlnp` |
| n8n can't reach copilot-shim | Make sure the credential Base URL uses the container name `copilot-shim`, not `localhost` |
| Models return 401 | Your GitHub Copilot subscription may have lapsed, or you need to re-auth |

---

## File structure

```
n8n-copilot-free/
├── config.env          ← Edit this (ports, domain, passwords)
├── docker-compose.yml  ← All 4 services templated from config.env
├── responses-shim.js   ← Zero-dependency Node.js shim (do not edit)
├── init-db.sql         ← PostgreSQL init
├── setup.sh            ← One-shot install script
└── .env                ← Auto-generated by setup.sh (do not commit)
```

---

## Credits

- [copilot-api](https://github.com/ericc-ch/copilot-api) by ericc-ch — GitHub Copilot → OpenAI bridge
- `responses-shim.js` — custom shim bridging the OpenAI Responses API + SSE streaming for n8n 2.x compatibility

---

## License

MIT
