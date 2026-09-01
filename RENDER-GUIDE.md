# Render Deployment Guide — 9Router

End-to-end from repo to running `https://xxx.onrender.com`.

## 1. Overview

`render.yaml` Blueprint defines a Docker web service:

- **Runtime**: `node:22-alpine` → `npm install` → `npm run build` → `node custom-server.js`
- **Port**: Render injects `PORT=10000` at runtime. Local default `20128` is overridden automatically. Don't set `PORT` in dashboard.
- **Health**: `GET /health` → `200 {ok:true}` (rewrite to `/api/health`). Render uses it to know container is alive.
- **Data**: SQLite at `DATA_DIR=/app/data/db/data.sqlite`. Free tier is **ephemeral** — redeploy wipes it. See §5.

## 2. Deploy — Blueprint (recommended)

### 2.1 Push repo

```bash
git push origin master # this repo is S1NXIAN/9router-Render
```

### 2.2 Create Blueprint

1. Render Dashboard → **New** → **Blueprint** → Connect `9router-Render`
2. Render reads `render.yaml` → shows service `9router` (Docker, `free`, `healthCheckPath: /health`)
3. **Before** `Apply`, it prompts for `INITIAL_PASSWORD` (required):
   - Enter your first dashboard password (e.g. `S3cure!...`). This becomes the initial login.
   - `JWT_SECRET` is auto-generated (`generateValue: true`) — shown but don't change unless you know why.
   - `SELF_PING_ENABLED=true` is internal keep-warm — leave as is.
4. Click **Apply** → Render builds Docker image (5–10 min first time). Watch logs for `Creating an optimized production build ...` → `ready`.

> **Region**: `render.yaml` defaults to `singapore` (closest to SG/ASIA). Change `region:` to `oregon` (US), `frankfurt` (EU), `ohio` (US East), `virginia` — pick closest to you. Availability depends on plan (free may be limited to `singapore`/`oregon`). You can also override in Dashboard dropdown at Blueprint creation.

### 2.3 First login

```
https://<your-name>.onrender.com/login
User: (any, single-user dashboard)
Password: <the INITIAL_PASSWORD you entered>
```

Change it immediately: Dashboard → Settings → Users → change password. This writes to DB, `INITIAL_PASSWORD` env is then ignored until DB is wiped.

**Where is `INITIAL_PASSWORD` stored?**

- Dashboard → Service → **Environment** → `INITIAL_PASSWORD` (plaintext, visible via eye icon).
- Live password hash → `DATA_DIR/db/data.sqlite` (only inside container). After first boot, env is not read again.

If you forget it and have no disk: Environment → edit `INITIAL_PASSWORD` → **Manual Deploy** → Latest commit → DB re-seeded (because free tier wipes DB on redeploy).

### 2.4 Manual deploy (without Blueprint)

Render → **New Web Service** → Connect repo → **Docker** → set:

- `Dockerfile Path: ./Dockerfile`
- `Health Check Path: /health`
- Env:
  ```
  NODE_ENV=production
  HOSTNAME=0.0.0.0
  DATA_DIR=/app/data
  JWT_SECRET=<generate: openssl rand -hex 32>
  INITIAL_PASSWORD=<your password>
  SELF_PING_ENABLED=true
  ```
- Deploy. Same result as Blueprint.

## 3. Environment Variables — What They Do & Why

| Key | Required? | Default | Why |
|-----|-----------|---------|-----|
| `NODE_ENV` | yes (Blueprint sets `production`) | `development` | Disables dev logs, enables production optimizations |
| `HOSTNAME` | yes (`0.0.0.0`) | `localhost` | Must be `0.0.0.0` on Render to accept external traffic |
| `PORT` | **no** — Render injects `10000` | `20128` | `custom-server.js` falls back to `20128` if empty. Render overrides at runtime, so local `20128` and Render `10000` both work. |
| `DATA_DIR` | yes (`/app/data`) | `~/.9router` | Where `db/data.sqlite` lives. Must match `disk.mountPath` if you enable disk. |
| `JWT_SECRET` | yes (auto-generated) | random per container | Signs dashboard session cookies. Keep stable (don't change) or you log everyone out. Change only to share across instances. |
| `INITIAL_PASSWORD` | **prompted** (`sync: false`) | `123456` in code fallback | Seed password when DB empty. After first boot, stored hashed, env ignored. Prompt ensures you don't deploy with `123456`. |
| `SELF_PING_ENABLED` | no (`true`) | `true` | In-process `fetch /health` every 14m, jittered. Keeps warm **while process is alive**. Does **not** wake a fully suspended container (see §4). Disable with `false`. |
| `SELF_PING_INTERVAL_MS` | no | `840000` (14m) | Must be < 15m (Render free sleeps after 15m idle). Don't set <60s. |
| `SELF_PING_URL` | no | `RENDER_EXTERNAL_URL \|\| BASE_URL \|\| 127.0.0.1:PORT` | Override if behind custom domain. Usually auto-detected. |
| `BASE_URL` | no | `http://localhost:PORT` | Server-side self-calls for cloud sync (`/api/sync/cloud`). Set to `https://xxx.onrender.com` **after** first deploy if you use cloud sync. |
| `NEXT_PUBLIC_BASE_URL` | no | same as `BASE_URL` | Baked at **build** time for frontend. If you set `BASE_URL`, set this too and redeploy. |
| `RENDER_EXTERNAL_URL` | auto-provided by Render | — | Full external URL (`https://xxx.onrender.com`). Code prefers this for self-ping, no need to set manually. |

**Set `BASE_URL` / `NEXT_PUBLIC_BASE_URL` after first deploy:**

Dashboard → Environment → Add → `BASE_URL=https://xxx.onrender.com` + `NEXT_PUBLIC_BASE_URL=https://xxx.onrender.com` → **Manual Deploy**. Only needed for cloud sync / OAuth callbacks; dashboard works without.

## 4. Cold Start & Self-Ping — Why Two Pingers?

Render **free** sleeps after **15 minutes without inbound HTTP**. The next request then cold-starts (5–20s).

### 4.1 In-process (internal)

- `src/lib/selfPing.js` → `setInterval(fetch /health, 14m)` — wired in `src/instrumentation.js` + `custom-server.js`
- **Ceiling**: When container is *fully* suspended, Node timers freeze — internal ping **cannot wake it**. It only helps while process is still warm (reduces idle gaps).
- **Ponytail note**: Zero deps, ~20 LOC. Upgrade to external if still cold.

### 4.2 External (required to truly avoid sleep)

- `.github/workflows/keepwarm.yml` → GitHub Actions cron `*/14 * * * *` → `curl https://xxx.onrender.com/health`
- **Setup**: Repo → **Settings** → **Secrets and variables** → **Variables** → New repository variable → `RENDER_URL=https://xxx.onrender.com` → Actions will ping every 14m forever (free within GitHub limits ~103 pings/day).
- Alternative: Render Cron Job service or UptimeRobot/cron-job.org hitting same `/health` — same effect. GitHub one is already included, just set the variable.

**Which to use?** Both. Internal is free and private; external wakes suspended. If you upgrade to paid Render (no sleep), set `SELF_PING_ENABLED=false` and disable the workflow (or leave — harmless).

## 5. Data Persistence — Why Data Can Disappear

- **Free tier**: Filesystem **ephemeral**. `/app/data/db/data.sqlite` wiped on every deploy/restart. `INITIAL_PASSWORD` re-seeds on next boot.
- **Paid (Starter $7/mo+)**: Add disk in `render.yaml`:

  ```yaml
  disk:
    name: 9router-data
    mountPath: /app/data
    sizeGB: 1
  ```

  Uncomment, push, redeploy → DB persists. 1GB is plenty (DB is ~few MB).

**Check if you have disk:** Dashboard → Service → **Disks** tab.

**Backup**: Dashboard → Shell → `cat /app/data/db/data.sqlite` or use `src/lib/db/backup.js` via API.

## 6. Post-Deploy Checklist

- [ ] `/health` returns `{ok:true}` → `curl https://xxx.onrender.com/health`
- [ ] Login with `INITIAL_PASSWORD` → change password
- [ ] (Optional) Set `BASE_URL` + `NEXT_PUBLIC_BASE_URL` → redeploy if using cloud sync
- [ ] (Optional) Set repo variable `RENDER_URL` → GitHub keep-warm activates next cron
- [ ] (Optional) Enable disk if you need persistence
- [ ] Check logs: Dashboard → **Logs** → `Listening on 10000`, `BackgroundTokenRefresh start`

## 7. Troubleshooting

**Blueprint error `cannot simultaneously specify generateValue and sync`** — fixed. `INITIAL_PASSWORD` now `sync: false` only. Pull latest `master`.

**Build fails `Can't resolve 'better-sqlite3'`** — fixed by using `npm` (not `bun --bun`) — `serverExternalPackages` correctly externalizes it. `sql.js` is fallback if native build fails.

**First login not working** — check `INITIAL_PASSWORD` in Environment (eye icon). If DB already has a hash, env is ignored — reset via Dashboard → Shell → `rm /app/data/db/data.sqlite` (free tier) or change via Settings.

**Still cold after 15m** — internal ping alone insufficient. Set `vars.RENDER_URL` for GitHub workflow, or add UptimeRobot.

**No request logs** — set `ENABLE_REQUEST_LOGS=true` in Environment → redeploy.

**Port mismatch `EADDRINUSE`** — don't set `PORT` manually. Render injects it.

## 8. Updating

```bash
git pull origin master
# ... change ...
git push origin master
# Render (autoDeploy: false) → Dashboard → Manual Deploy → Deploy latest commit
# If autoDeploy: true, push auto-deploys
```

To enable auto-deploy: `render.yaml` → `autoDeploy: true` → push.

## 9. Security Notes

- Change `INITIAL_PASSWORD` immediately after first login.
- Keep `JWT_SECRET` stable; rotate only if you want to invalidate all sessions.
- `DATA_DIR` contains provider API keys/tokens (encrypted at rest in SQLite) — protect disk/backups.
- Don't expose `RENDER_EXTERNAL_URL` + `/api` publicly without `REQUIRE_API_KEY=true` if you proxy.

---

**Files added for Render**: `render.yaml`, `Dockerfile` (npm, `EXPOSE 20128 10000`, `HOSTNAME=0.0.0.0`), `custom-server.js` (PORT fallback), `next.config.mjs` (`/health` rewrite), `src/lib/selfPing.js`, `.github/workflows/keepwarm.yml`, this guide.

**External docs**: Render Blueprint spec, Next.js standalone output, 9Router `ARCHITECTURE.md` env matrix.
