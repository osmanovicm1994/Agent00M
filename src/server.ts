// Local WebSocket server for the live dashboard.
//  - Every connection can WATCH: it gets the recent history, then live events from the bus.
//  - A connection that presents the control token (?token=...) can also DRIVE the agent: answer the
//    chat startup questions, submit a task and answer approvals. The agent can run commands and
//    write files, so this is the sensitive part: loopback only, Origin allowlist, random token
//    printed in the terminal.
// The server never imports agent logic; it talks to the core only through `bus` and `control`.

import Fastify from "fastify";
import websocket from "@fastify/websocket";
import pc from "picocolors";
import { randomBytes, timingSafeEqual } from "crypto";
import * as os from "os";
import { AGENTS } from "./agents/definitions";
import { bus } from "./core/events";
import { control, MAX_ANSWER_CHARS } from "./core/control";
import type { AgentInfo, ClientCommand, ServerMessage } from "./core/event-types";

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

// LAN mode (AGENT_UI_LAN=1, or `npm run chat:ui:lan`): the socket and the web app are reachable from
// other devices on your home network, e.g. your phone. Off by default (loopback only).
// Because the agent can run commands and write files, LAN mode requires the token for EVERY connection
// (no read-only guests) and only accepts browser origins that are one of this machine's own addresses.
export const LAN_MODE = ["1", "on", "true", "yes"].includes((process.env.AGENT_UI_LAN ?? "").trim().toLowerCase());

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
function allowedOrigins(): Set<string> {
  const extra = (process.env.AGENT_UI_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const lan = LAN_MODE ? [...lanAddresses(), os.hostname()].map((h) => `http://${h}:${WEB_PORT}`) : [];
  return new Set(["http://localhost:5173", "http://127.0.0.1:5173", ...lan, ...extra]);
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
  return undefined;
}

export async function startServer(port: number = DEFAULT_PORT): Promise<DashboardServer> {
  const origins = allowedOrigins();
  const token = process.env.AGENT_UI_TOKEN?.trim() || randomBytes(16).toString("hex");
  const roster: AgentInfo[] = AGENTS.map((a) => ({ id: a.id, name: a.name, description: a.description }));
  const agentIds = new Set(AGENTS.map((a) => a.id));

  const app = Fastify({ logger: false });
  await app.register(websocket, { options: { maxPayload: MAX_MESSAGE_BYTES } });

  app.get("/health", async () => ({ ok: true }));

  let controllers = 0;

  app.get("/ws", { websocket: true }, (socket, req) => {
    const origin = req.headers.origin;
    if (origin && !origins.has(origin)) {
      socket.close(1008, "origin not allowed");
      return;
    }

    const query = req.query as { token?: string };
    const canControl = tokenMatches(query.token, token);
    if (LAN_MODE && !canControl) {
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
    const unsubscribeEvents = bus.subscribe((event) => send({ kind: "event", event }));
    const unsubscribeBusy = control.onBusyChange((busy) => send({ kind: "busy", busy }));
    const unsubscribeSession = control.onSessionChange((acceptsTasks) => send({ kind: "session", acceptsTasks }));

    if (canControl) controllers++;

    socket.on("message", (raw: unknown) => {
      const command = parseCommand(raw);
      if (!command) return;
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
      }
    });

    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      unsubscribeEvents();
      unsubscribeBusy();
      unsubscribeSession();
      if (canControl) {
        controllers--;
        // Nobody left who could answer: reject instead of leaving the agent hanging.
        if (controllers <= 0) control.cancelPendingApproval();
      }
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);
  });

  // Loopback only unless LAN mode is on.
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
  } else {
    console.log(pc.dim("   Without the token it is read-only. Keep this URL private."));
    console.log(pc.dim("   Want it on your phone? Use `npm run chat:ui:lan`."));
  }

  return { port, token, url, close: () => app.close() };
}
