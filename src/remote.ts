// Remote access helpers (Tailscale). Used by src/server.ts.
//
// Remote mode (AGENT_UI_REMOTE=1, or `npm run chat:ui:remote`) lets you open the dashboard from
// outside your home network through a private Tailscale network (a "tailnet"). It works behind
// CGNAT because no port is opened on the router. The agent itself never listens on a public or LAN
// address: Tailscale Serve (`npm run remote:on`) proxies HTTPS from your tailnet to the local Vite
// dev server, and Vite forwards /ws to the agent socket on 127.0.0.1.
//
// Nothing here changes the Tailscale configuration. It only reads the machine's tailnet host name.
// Details: docs/REMOTE.md.

import { execFileSync } from "child_process";

const TRUE_VALUES = ["1", "on", "true", "yes"];

export const REMOTE_MODE = TRUE_VALUES.includes((process.env.AGENT_UI_REMOTE ?? "").trim().toLowerCase());

// Where the Tailscale CLI may live. The macOS app does not put it on the PATH.
const TAILSCALE_BINARIES = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];

// A plain DNS name such as "my-mac.tail1234.ts.net". Anything else is ignored, because the value
// ends up in an allowed-origin list and in a printed URL.
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export interface TailscaleInfo {
  host?: string;
  state?: string;
}

export function normalizeHost(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/\.$/, "");
  return HOST_RE.test(cleaned) ? cleaned : undefined;
}

// Asks the local Tailscale client who this machine is. Best effort: returns {} when Tailscale is
// not installed, not running, or not signed in.
export function detectTailscale(): TailscaleInfo {
  for (const bin of TAILSCALE_BINARIES) {
    try {
      const out = execFileSync(bin, ["status", "--json"], {
        timeout: 4000,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 8 * 1024 * 1024,
      });
      const data = JSON.parse(out) as { BackendState?: string; Self?: { DNSName?: string } };
      return { host: normalizeHost(data.Self?.DNSName), state: data.BackendState };
    } catch {
      // try the next location
    }
  }
  return {};
}

// AGENT_UI_REMOTE_HOST wins; otherwise the host name reported by the local Tailscale client.
export function resolveRemoteHost(): string | undefined {
  return normalizeHost(process.env.AGENT_UI_REMOTE_HOST) ?? detectTailscale().host;
}
