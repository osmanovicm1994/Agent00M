import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const env: Record<string, string | undefined> = (globalThis as any).process?.env ?? {};
const flag = (name: string): boolean => ["1", "on", "true", "yes"].includes(String(env[name] ?? "").trim().toLowerCase());

// `npm run chat:ui:lan` sets AGENT_UI_LAN=1 so the dashboard is also served to other devices on
// your Wi-Fi (e.g. your phone). Without it Vite stays on localhost only.
const lan = flag("AGENT_UI_LAN");

// `npm run chat:ui:remote` sets AGENT_UI_REMOTE=1 (see docs/REMOTE.md). Tailscale Serve terminates
// HTTPS on https://<machine>.<tailnet>.ts.net and proxies to this dev server, which stays on
// 127.0.0.1. The agent server prints and exports the machine's host name as AGENT_UI_REMOTE_HOST.
const remote = flag("AGENT_UI_REMOTE");
const remoteHost = String(env.AGENT_UI_REMOTE_HOST ?? "").trim().toLowerCase();

// Port of the agent's WebSocket server (src/server.ts, AGENT_UI_PORT).
const agentPort = Number(env.AGENT_UI_PORT) || 3001;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The agent server only accepts browser WebSocket connections from known origins (src/server.ts).
  server: {
    port: 5173,
    strictPort: true,
    // The Guide screen imports ../docs/PROMPTING.md (one source for the tutorial); that folder is next to web/.
    fs: { allow: [".."] },
    host: lan ? true : remote ? "127.0.0.1" : undefined,
    // Explicit host list only (never `true`: that would allow DNS rebinding against the dev server).
    // Without a known host name, remote mode accepts any *.ts.net name; the token still protects control.
    ...(remote ? { allowedHosts: remoteHost ? [remoteHost] : [".ts.net"] } : {}),
    // The page is served over HTTPS on port 443 by Tailscale Serve, so hot reload must connect there.
    ...(remote ? { hmr: { clientPort: 443 } } : {}),
    // One URL for page and socket: the dashboard connects to wss://<same host>/ws, which is
    // forwarded to the agent socket on 127.0.0.1. Local use (ws://127.0.0.1:3001/ws) is unchanged.
    proxy: {
      "/ws": { target: `ws://127.0.0.1:${agentPort}`, ws: true },
    },
  },
});
