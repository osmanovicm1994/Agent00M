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

## iPhone home-screen app

The dashboard is also a phone-friendly web app (bottom tabs: Agents, Live, Prompt, Project, History). Open the token URL in Safari, choose Share > Add to Home Screen, then open it once from the icon and press "Remember on this device" (iOS keeps home-screen storage separate from Safari tabs). The Tailscale app must be connected.

There is also a native SwiftUI iPhone app in `ios/` (see `ios/README.md`).

## What the dashboard shows

- **Team mode switch** (Prompt panel): same as `/team` in the terminal. In team mode a pinned "Only me" agent is not used, because the Project Manager assigns the roles. Dashboard-started team runs start the plan without asking.
- **Live screen:** the full terminal-style feed (stack, model, standards, command and reason, exit code, output, model timings, team plan and steps) with filters.

- **Agents:** pick "Only me" on an agent and every prompt goes to it (sent as `agentId`; the choice is remembered on the device). "Back to auto" restores orchestrator routing.
- **Live:** what the agent wants to do (newest tool call), why (newest reasoning text), recent steps, the live feed and a Stop button for a running command (same as Ctrl+C).
- **Prompt:** send tasks with optional file context chips.
- **Project:** folder tree of the workspace (secret `.env*` files, `node_modules`, `.git` are never listed).
- **History:** last 40 runs, kept in the browser.
- **Token usage:** model calls of the agent (`llm_usage` events). Numbers come from the model server when it reports them (LM Studio with `stream_options.include_usage`); otherwise they are character estimates marked `est.`. Set `AI_STREAM_USAGE=0` if a model server rejects that option. This is not a Claude subscription meter.

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
| `AGENT_NOTIFY_URL` | Optional phone push (ntfy): the agent POSTs "needs approval" / "run failed" (agent name only, never the command) to this URL, e.g. `https://ntfy.sh/<long-random-topic>`. `AGENT_NOTIFY_DONE=0` skips the failure message. See `src/notify.ts`. |
| `AGENT_UI_HISTORY` | Events replayed to a newly opened dashboard (default 1500). |

## Security notes

- The agent can write files and run commands. Anyone on your tailnet who has the token URL can drive it. Keep the URL private and keep the tailnet to your own devices.
- **Never use Tailscale Funnel** for this. Funnel publishes to the whole internet. `remote.sh` never uses it.
- Optional hardening: in the Tailscale admin console, restrict access to this machine with an ACL so only your own devices can reach it.
- Approvals from the dashboard show the message AND the real command or diff (`detail`, up to 6000 characters). Read it before you approve from a phone.
- "Remember on this device" (header button) stores the control token in the browser's localStorage so the home-screen app stays signed in. Use it only on your own phone and press "Forget token" when you lose it. Rotate `AGENT_UI_TOKEN` if a token URL was ever pasted somewhere shared.
- Vite stays on `127.0.0.1` and `allowedHosts` lists the tailnet host explicitly (never `true`, which would allow DNS rebinding).

## Troubleshooting

- **Page does not load:** Tailscale connected on both devices? `npm run remote:status` should list the mapping to `127.0.0.1:5173`. Is `chat:ui:remote` running (it starts Vite)?
- **"Blocked request. This host is not allowed" from Vite:** the host name was not detected. Set `AGENT_UI_REMOTE_HOST` in `.env` and restart.
- **Page loads, stays "Waiting for the agent…":** the socket was rejected. Check that the URL has the token and matches `AGENT_UI_TOKEN`, and that `AGENT_UI_PORT` matches the agent port (default 3001).
- **Read-only badge:** the token was missing or wrong.
- **Terminal says no tailnet host name found:** install Tailscale, sign in, or set `AGENT_UI_REMOTE_HOST`.
- **Hot reload errors in the browser console:** harmless; HMR is pointed at port 443.
