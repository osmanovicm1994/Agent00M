# Remote access (Tailscale)

Use the agent dashboard from outside your home network (phone on mobile data, laptop elsewhere). Works behind CGNAT (Telemach EON), because no port is opened on the router. Source of truth is the code: `src/remote.ts`, `src/server.ts`, `web/vite.config.ts`, `web/src/Dashboard.tsx`, `scripts/remote.sh`.

Everything still runs on your home computer: the model (LM Studio), the files and the commands. Only the dashboard is reached remotely.

## How it fits together

```
phone/laptop (Tailscale app)
   -> https://<machine>.<tailnet>.ts.net          (Tailscale Serve, HTTPS, tailnet only)
   -> Vite dev server on 127.0.0.1:5173            (page + proxy for /ws)
   -> agent socket on 127.0.0.1:3001/ws            (token required)
```

- The agent socket and Vite stay on `127.0.0.1`. Remote mode never widens the bind (unlike `AGENT_UI_LAN`).
- The page and the socket share one HTTPS URL: the dashboard connects to `wss://<same host>/ws` and Vite forwards it.
- In remote mode every connection needs the control token (no read-only guests), and the browser origin `https://<tailnet host>` is added to the allowlist.
- LM Studio (`localhost:1234`) is never exposed.

## One-time setup

1. Install Tailscale on the home computer and on every device you want to use remotely, and sign in with the **same account** on all of them. Free Personal plan is enough. https://tailscale.com/download
2. In the Tailscale admin console (DNS page) make sure **MagicDNS** and **HTTPS Certificates** are enabled. Tailscale Serve asks for this the first time.
3. Create a fixed token in `.env` (git-ignored, NOT `.env.local`):
   ```
   AGENT_UI_TOKEN=<output of: openssl rand -hex 24>
   ```
4. Publish the dashboard to your tailnet (once; it survives restarts):
   ```
   npm run remote:on
   ```

## Every day

```
npm run chat:ui:remote
```

The terminal prints a line like `🌍 Remote (Tailscale): https://my-mac.tail1234.ts.net/?token=...`. Open it on your phone (Tailscale app connected) and bookmark it. With a fixed `AGENT_UI_TOKEN` the bookmark keeps working. The token is removed from the address bar after the page loads and kept for that tab only, so reopen the bookmark in a new tab.

The computer must stay awake and online. If it sleeps, the dashboard is unreachable (macOS: System Settings > Battery/Energy, or run `caffeinate -s` in a terminal).

## Commands

| Command | What it does |
| --- | --- |
| `npm run chat:ui:remote` | chat + dashboard with remote mode on |
| `npm run remote:on` | `tailscale serve --bg http://127.0.0.1:5173` (tailnet only) |
| `npm run remote:status` | Tailscale and Serve status |
| `npm run remote:off` | `tailscale serve reset` (removes ALL Serve mappings on this machine) |

`scripts/remote.sh` finds the Tailscale CLI even when it is not on the PATH (macOS app).

## Settings

| Variable | Purpose |
| --- | --- |
| `AGENT_UI_REMOTE=1` | Remote mode (set by `chat:ui:remote`). |
| `AGENT_UI_REMOTE_HOST` | Tailnet host name. Auto-detected from `tailscale status --json` when unset. Set it if detection fails. |
| `AGENT_UI_TOKEN` | Fixed control token. Use at least 24 characters; a warning is printed otherwise. |
| `AGENT_UI_WEB_PORT` | Vite port used by `remote.sh` (default 5173). |

## Security notes

- The agent can write files and run commands. Anyone on your tailnet who has the token URL can drive it. Keep the URL private and keep the tailnet to your own devices.
- **Never use Tailscale Funnel** for this. Funnel publishes to the whole internet. `remote.sh` never uses it.
- Optional hardening: in the Tailscale admin console, restrict access to this machine with an ACL so only your own devices can reach it.
- Approvals from the dashboard show the message only; the file diff is printed in the terminal. Check the command or file in the live feed before approving from a phone.
- Vite stays on `127.0.0.1` and `allowedHosts` lists the tailnet host explicitly (never `true`, which would allow DNS rebinding).

## Troubleshooting

- **Page does not load:** Tailscale connected on both devices? `npm run remote:status` should list the mapping to `127.0.0.1:5173`. Is `chat:ui:remote` running (it starts Vite)?
- **"Blocked request. This host is not allowed" from Vite:** the host name was not detected. Set `AGENT_UI_REMOTE_HOST` in `.env` and restart.
- **Page loads, stays "Waiting for the agent…":** the socket was rejected. Check that the URL has the token and matches `AGENT_UI_TOKEN`, and that `AGENT_UI_PORT` matches the agent port (default 3001).
- **Read-only badge:** the token was missing or wrong.
- **Terminal says no tailnet host name found:** install Tailscale, sign in, or set `AGENT_UI_REMOTE_HOST`.
- **Hot reload errors in the browser console:** harmless; HMR is pointed at port 443.
