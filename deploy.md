# Deploy DECKSHOT to a public URL

The goal is one HTTPS link you can text to a friend. The Node server serves both
the game and the WebSocket endpoint on a single port, so there is nothing to
configure on the client side — it derives its socket URL from `window.location`.

---

## Option A — Fly.io (recommended)

Fly keeps a machine warm in one region, which is what you want for a real-time
game: a cold start mid-match drops everyone in the lobby.

```bash
# One-time setup
brew install flyctl          # or: curl -L https://fly.io/install.sh | sh
fly auth login

# From the project root. --copy-config uses the fly.toml already in this repo.
fly launch --no-deploy --copy-config

# Pick a unique app name when prompted, and a region near your players.
# Then:
fly deploy
```

Your URL is printed at the end — `https://<your-app>.fly.dev`. Open it, click
**CREATE LOBBY**, and send the invite link.

Useful afterwards:

```bash
fly logs                  # live server logs
fly status                # machine health
fly scale count 1         # keep exactly one machine (lobbies are in-memory)
fly apps open             # open the game in a browser
```

**Important:** lobbies live in the server's memory. Do **not** scale beyond one
machine — two machines means two separate lobby registries and a friend using
your code may land on the machine that has never heard of it. `fly.toml` sets
`min_machines_running = 1` for this reason. Scaling horizontally would require
moving the lobby registry into Redis, which is not built.

---

## Option B — Railway

```bash
npm i -g @railway/cli
railway login
railway init
railway up
```

Railway detects the Dockerfile automatically. Set the `PORT` variable if it does
not inject one; the server reads `process.env.PORT` and falls back to 8080.
Generate a public domain from the Railway dashboard under **Settings → Networking
→ Generate Domain**.

Same caveat: one replica only.

---

## Option C — Any Docker host

```bash
docker build -t deckshot .
docker run -p 8080:8080 -e PORT=8080 deckshot
```

Then put any TLS-terminating proxy in front of it. The only requirement is that
the proxy **upgrades WebSocket connections** on `/ws`. For nginx:

```nginx
location /ws {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;   # game sockets are long-lived
}

location / {
    proxy_pass http://127.0.0.1:8080;
}
```

Browsers block insecure WebSockets from an HTTPS page, so if the page is served
over `https://`, the socket must be `wss://`. The client handles this
automatically by matching the page protocol — you just need the proxy to pass
the upgrade through.

---

## Running locally

```bash
npm install
npm run dev
```

Client on `http://localhost:5173`, game server on `:8080`. Vite proxies `/ws` to
the server, so the single-URL behaviour is identical in dev and production.

To test multiplayer on one machine, open the game in two browser windows (or one
normal and one private window). Create a lobby in the first, copy the invite
link, paste it into the second.

To test with a friend before deploying, `ngrok http 5173` works — but expect the
added latency to make the game feel worse than a real deploy.

---

## Health check

`GET /health` returns `200` with a small JSON body reporting uptime, active
lobbies and connected players. `fly.toml` uses it; point any other platform's
health check at the same path.
