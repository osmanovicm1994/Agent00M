// Local WebSocket server for the live dashboard.
//  - Every connection can WATCH: it gets the recent history, then live events from the bus.
//  - A connection that presents the control token (?token=...) can also DRIVE the agent: answer the
//    chat startup questions, submit a task and answer approvals. The agent can run commands and
//    write files, so this is the sensitive part: loopback only, Origin allowlist, random token
//    printed in the terminal.
//  - Token holders also get the project tree (list_files), live file-change pushes (files_changed) and
//    the design-preview route (GET /preview/<key>/<path>, see core/preview.ts).
// The server never imports agent logic; it talks to the core only through `bus` and `control`.

import Fastify from "fastify";
import websocket from "@fastify/websocket";
import pc from "picocolors";
import { randomBytes, timingSafeEqual } from "crypto";
import * as fs from "fs";
import * as os from "os";
import { AGENTS } from "./agents/definitions";
import { bus } from "./core/events";
import { control, MAX_ANSWER_CHARS } from "./core/control";
import { DEFAULT_TREE_IGNORE, listWorkspace, sanitizeIgnore } from "./core/file-tree";
import { readGuide } from "./core/guide";
import { contentTypeFor, injectPreviewHtml, PREVIEW_CSP, previewBaseHref, resolvePreviewFile } from "./core/preview";
import { watchWorkspace, type WorkspaceWatcher } from "./core/workspace-watch";
import type { AgentInfo, ClientCommand, ServerMessage, SettingKey } from "./core/event-types";
import { REMOTE_MODE, detectTailscale, resolveRemoteHost } from "./remote";
import { startNotifier } from "./notify";

export interface DashboardServer {
  port: number;
  token: string;
  // Dashboard page including the control token. Keep private.
  url: string;
  close(): Promise<void>;
}

const DEFAULT_PORT = Number(process.env.AGENT_UI_PORT) || 3001;
export const UI_BASE_URL = process.env.AGENT_UI_URL || "http://localhost:5173";
const WS_OPEN = 1;
const MAX_MESSAGE_BYTES = 64 * 1024;
const WEB_PORT = Number(process.env.AGENT_UI_WEB_PORT) || 5173;
const MIN_REMOTE_TOKEN_CHARS = 24;
// The full project tree (list_files with full:true): deep, but bounded so one huge folder cannot freeze the browser.
const FULL_TREE_DEPTH = 40;
const FULL_TREE_MAX_ENTRIES = 20000;

// LAN mode (AGENT_UI_LAN=1, or `npm run chat:ui:lan`): the socket and the web app are reachable from
// other devices on your home network, e.g. your phone. Off by default (loopback only).
// Because the agent can run commands and write files, LAN mode requires the token for EVERY connection
// (no read-only guests) and only accepts browser origins that are one of this machine's own addresses.
export const LAN_MODE = ["1", "on", "true", "yes"].includes((process.env.AGENT_UI_LAN ?? "").trim().toLowerCase());

// Remote mode (AGENT_UI_REMOTE=1, or `npm run chat:ui:remote`): reachable from outside your home
// network through Tailscale (works behind CGNAT). The socket STILL binds to 127.0.0.1: Tailscale
// Serve proxies HTTPS to the Vite dev server, which forwards /ws and /preview to this server. The token is
// required for every connection and the Tailscale host name is added to the origin allowlist.
// See src/remote.ts and docs/REMOTE.md.
export { REMOTE_MODE };

// This machine's private IPv4 addresses (Wi-Fi / Ethernet), without loopback.
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const n of nets ?? []) {
      if (n.family === "IPv4" && !n.internal) out.push(n.address);
    }
  }
  return out;
}

// The dashboard exposes what the agent reads, runs and writes, so only the local Vite dev server
// (or origins you list in AGENT_UI_ORIGINS, comma separated) may connect from a browser.
function allowedOrigins(remoteHost?: string): Set<string> {
  const extra = (process.env.AGENT_UI_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const lan = LAN_MODE ? [...lanAddresses(), os.hostname()].map((h) => `http://${h}:${WEB_PORT}`) : [];
  const remote = remoteHost ? [`https://${remoteHost}`] : [];
  return new Set(["http://localhost:5173", "http://127.0.0.1:5173", ...lan, ...remote, ...extra]);
}

function tokenMatches(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseCommand(raw: unknown): ClientCommand | undefined {
  let value: any;
  try {
    value = JSON.parse(String(raw));
  } catch {
    return undefined;
  }
  if (value?.kind === "submit_task" && typeof value.task === "string") {
    return { kind: "submit_task", task: value.task, agentId: typeof value.agentId === "string" ? value.agentId : undefined };
  }
  if (value?.kind === "answer_approval" && typeof value.approved === "boolean") {
    return { kind: "answer_approval", approved: value.approved };
  }
  if (value?.kind === "answer_question" && typeof value.id === "string" && typeof value.answer === "string") {
    return { kind: "answer_question", id: value.id, answer: value.answer.slice(0, MAX_ANSWER_CHARS) };
  }
  if (value?.kind === "list_files") {
    return { kind: "list_files", full: value.full === true, ignore: sanitizeIgnore(value.ignore) };
  }
  if (value?.kind === "get_guide") return { kind: "get_guide" };
  if (value?.kind === "stop_command") return { kind: "stop_command" };
  if (value?.kind === "set_team" && typeof value.on === "boolean") return { kind: "set_team", on: value.on };
  if (value?.kind === "set_setting" && typeof value.key === "string" && (typeof value.value === "boolean" || typeof value.value === "string")) {
    return { kind: "set_setting", key: value.key as SettingKey, value: value.value };
  }
  return undefined;
}

export async function startServer(port: number = DEFAULT_PORT): Promise<DashboardServer> {
  // Remote mode: find this machine's tailnet host name BEFORE the origin list is built. It is also
  // exported to the environment so the Vite dev server (started right after by ui-launcher.ts)
  // accepts that Host header.
  const remoteHost = REMOTE_MODE ? resolveRemoteHost() : undefined;
  if (remoteHost) process.env.AGENT_UI_REMOTE_HOST = remoteHost;

  const origins = allowedOrigins(remoteHost);
  const fixedToken = process.env.AGENT_UI_TOKEN?.trim();
  const token = fixedToken || randomBytes(16).toString("hex");
  // A separate key for the preview route: it only reads project files (never drives the agent), so a page that
  // learns it cannot do more than the route already allows.
  const previewKey = randomBytes(16).toString("hex");
  const requireToken = LAN_MODE || REMOTE_MODE;
  const roster: AgentInfo[] = AGENTS.map((a) => ({ id: a.id, name: a.name, description: a.description }));
  const agentIds = new Set(AGENTS.map((a) => a.id));

  const app = Fastify({ logger: false });
  await app.register(websocket, { options: { maxPayload: MAX_MESSAGE_BYTES } });

  app.get("/health", async () => ({ ok: true }));

  // Design preview: read-only files of the project folder, for the dashboard's Preview panel.
  // Reached through the Vite proxy (/preview), so the page and the preview share one URL (also over Tailscale).
  app.get("/preview/:key/*", async (req, reply) => {
    const params = req.params as { key?: string; "*"?: string };
    const query = req.query as { raw?: string };
    const text = (status: number, message: string) => reply.code(status).type("text/plain; charset=utf-8").send(message);

    if (!tokenMatches(params.key, previewKey)) return text(404, "Not found.");
    const root = control.getWorkspace();
    if (!root) return text(404, "No project folder yet.");
    const found = resolvePreviewFile(root, params["*"] ?? "");
    if (!found.ok || !found.file || found.rel === undefined) return text(found.status ?? 404, found.reason ?? "Not found.");

    reply.headers({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": PREVIEW_CSP,
      "Access-Control-Allow-Origin": "*",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Referrer-Policy": "no-referrer",
    });
    const type = contentTypeFor(found.file);
    try {
      if (type.startsWith("text/html") && query.raw !== "1") {
        const html = await fs.promises.readFile(found.file, "utf8");
        return reply.type(type).send(injectPreviewHtml(html, previewBaseHref(previewKey, found.rel)));
      }
      return reply.type(type).send(await fs.promises.readFile(found.file));
    } catch {
      return text(404, "Not found.");
    }
  });

  // One watcher for all token-holding connections; it only runs while at least one is connected.
  let watcher: WorkspaceWatcher | undefined;
  const changeListeners = new Set<(paths: string[]) => void>();
  const ensureWatcher = (root: string): void => {
    if (watcher && watcher.root === root) return;
    watcher?.close();
    watcher = watchWorkspace(root, (paths) => {
      for (const listener of changeListeners) listener(paths);
    });
  };
  const releaseWatcher = (): void => {
    if (changeListeners.size > 0) return;
    watcher?.close();
    watcher = undefined;
  };

  let controllers = 0;

  app.get("/ws", { websocket: true }, (socket, req) => {
    const origin = req.headers.origin;
    if (origin && !origins.has(origin)) {
      socket.close(1008, "origin not allowed");
      return;
    }

    const query = req.query as { token?: string };
    const canControl = tokenMatches(query.token, token);
    if (requireToken && !canControl) {
      socket.close(1008, "token required");
      return;
    }

    const send = (message: ServerMessage) => {
      if (socket.readyState === WS_OPEN) socket.send(JSON.stringify(message));
    };

    // Catch the new client up (history includes any open setup question), then stream live.
    send({
      kind: "hello",
      version: 1,
      roster,
      history: bus.snapshot(),
      canControl,
      acceptsTasks: control.acceptsTasks(),
      busy: control.isBusy(),
    });
    send({ kind: "settings", ...control.getSettings() });
    if (canControl) send({ kind: "preview", key: previewKey });
    const unsubscribeTeam = control.onSettingsChange((settings) => send({ kind: "settings", ...settings }));
    const unsubscribeEvents = bus.subscribe((event) => send({ kind: "event", event }));
    const unsubscribeBusy = control.onBusyChange((busy) => send({ kind: "busy", busy }));
    const unsubscribeSession = control.onSessionChange((acceptsTasks) => send({ kind: "session", acceptsTasks }));
    const onFilesChanged = (paths: string[]) => send({ kind: "files_changed", paths });

    if (canControl) {
      controllers++;
      changeListeners.add(onFilesChanged);
    }

    socket.on("message", (raw: unknown) => {
      const command = parseCommand(raw);
      if (!command) return;
      // The tutorial is plain documentation: any connection may read it (even a read-only one).
      if (command.kind === "get_guide") {
        const markdown = readGuide();
        send(markdown ? { kind: "guide", markdown } : { kind: "notice", level: "error", text: "The prompting guide (docs/PROMPTING.md) was not found next to the agent." });
        return;
      }
      if (!canControl) {
        send({ kind: "notice", level: "error", text: "This dashboard is read-only: open the URL printed in the terminal (it carries the control token)." });
        return;
      }

      if (command.kind === "submit_task") {
        if (command.agentId && !agentIds.has(command.agentId)) {
          send({ kind: "notice", level: "error", text: `Unknown agent '${command.agentId}'.` });
          return;
        }
        const result = control.submitTask(command.task, command.agentId);
        if (!result.ok) send({ kind: "notice", level: "error", text: result.reason ?? "The task was not accepted." });
      } else if (command.kind === "answer_approval") {
        if (!control.answerApproval(command.approved)) {
          send({ kind: "notice", level: "info", text: "Nothing is waiting for approval right now." });
        }
      } else if (command.kind === "answer_question") {
        if (!control.answerQuestion(command.id, command.answer)) {
          send({ kind: "notice", level: "info", text: "That question was already answered." });
        }
      } else if (command.kind === "list_files") {
        const root = control.getWorkspace();
        if (!root) {
          send({ kind: "notice", level: "error", text: "No project folder yet: finish the chat startup questions first." });
          return;
        }
        try {
          if (command.full) {
            const ignore = command.ignore && command.ignore.length > 0 ? command.ignore : DEFAULT_TREE_IGNORE;
            send({ kind: "files", ...listWorkspace(root, { maxDepth: FULL_TREE_DEPTH, maxEntries: FULL_TREE_MAX_ENTRIES, ignore }) });
          } else {
            send({ kind: "files", ...listWorkspace(root) });
          }
          ensureWatcher(root);
        } catch (err) {
          send({ kind: "notice", level: "error", text: `Could not read the project folder: ${(err as Error).message}` });
        }
      } else if (command.kind === "set_team") {
        control.setTeam(command.on);
        console.log(pc.dim(`\n🏢 Team mode ${command.on ? "ON" : "OFF"} (switched in the dashboard).`));
      } else if (command.kind === "set_setting") {
        const result = control.setSetting(command.key, command.value);
        if (!result.ok) {
          send({ kind: "notice", level: "error", text: result.reason ?? "That switch was not accepted." });
        } else {
          console.log(pc.dim(`\n⚙  ${command.key} = ${String(command.value)} (switched in the dashboard).`));
        }
      } else if (command.kind === "stop_command") {
        const n = control.interrupt();
        send({ kind: "notice", level: "info", text: n > 0 ? `Stopped ${n} running command(s).` : "No command is running." });
      }
    });

    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      unsubscribeEvents();
      unsubscribeTeam();
      unsubscribeBusy();
      unsubscribeSession();
      if (canControl) {
        controllers--;
        changeListeners.delete(onFilesChanged);
        releaseWatcher();
        // Nobody left who could answer: reject instead of leaving the agent hanging.
        if (controllers <= 0) control.cancelPendingApproval();
      }
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);
  });

  // Loopback only unless LAN mode is on. Remote mode never widens the bind: Tailscale Serve and
  // the Vite proxy reach this server over 127.0.0.1.
  await app.listen({ port, host: LAN_MODE ? "0.0.0.0" : "127.0.0.1" });
  const url = `${UI_BASE_URL}/?token=${token}`;
  console.log(pc.cyan(`📡 Dashboard socket: ws://127.0.0.1:${port}/ws`));
  console.log(pc.cyan(`🖥  Dashboard (with control): ${url}`));
  if (LAN_MODE) {
    const ips = lanAddresses();
    if (ips.length === 0) {
      console.log(pc.yellow("⚠ LAN mode is on but no network address was found. Are you connected to Wi-Fi?"));
    }
    for (const ip of ips) {
      console.log(pc.green(`📱 Open on your phone (same Wi-Fi): http://${ip}:${WEB_PORT}/?token=${token}`));
    }
    console.log(pc.yellow("   LAN mode: anyone with this URL can control the agent. Keep it private; it changes every start."));
  } else if (!REMOTE_MODE) {
    console.log(pc.dim("   Without the token it is read-only. Keep this URL private."));
    console.log(pc.dim("   Want it on your phone? Use `npm run chat:ui:lan` (home Wi-Fi) or `npm run chat:ui:remote` (anywhere, via Tailscale)."));
  }

  if (REMOTE_MODE) {
    if (remoteHost) {
      console.log(pc.green(`🌍 Remote (Tailscale): https://${remoteHost}/?token=${token}`));
      console.log(pc.dim("   Needs `npm run remote:on` once (Tailscale Serve), and Tailscale running on the device you open it from."));
    } else {
      const info = detectTailscale();
      const why = info.state && info.state !== "Running" ? `Tailscale reports '${info.state}'.` : "The Tailscale CLI was not found or you are not signed in.";
      console.log(pc.yellow(`⚠ Remote mode is on but no tailnet host name was found. ${why}`));
      console.log(pc.yellow("   Install Tailscale and sign in, or set AGENT_UI_REMOTE_HOST=<name>.<tailnet>.ts.net in .env. See docs/REMOTE.md."));
    }
    if (!fixedToken) {
      console.log(pc.yellow("   The token changes every start. Set a fixed AGENT_UI_TOKEN in .env (not .env.local) so a phone bookmark keeps working."));
    } else if (fixedToken.length < MIN_REMOTE_TOKEN_CHARS) {
      console.log(pc.yellow(`⚠ AGENT_UI_TOKEN is only ${fixedToken.length} characters. Use at least ${MIN_REMOTE_TOKEN_CHARS} (for example: openssl rand -hex 24).`));
    }
    console.log(pc.yellow("   Anyone on your tailnet with the token URL can run commands on this machine. Never use Tailscale Funnel for this."));
  }

  // Optional phone push (AGENT_NOTIFY_URL): approvals and failures. Text only, never the command.
  const stopNotifier = startNotifier();
  if (stopNotifier) console.log(pc.dim("🔔 Phone notifications on (AGENT_NOTIFY_URL): approval requests and failed runs."));

  return {
    port,
    token,
    url,
    close: () => {
      stopNotifier?.();
      watcher?.close();
      watcher = undefined;
      return app.close();
    },
  };
}
