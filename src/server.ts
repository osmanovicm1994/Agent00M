// Local WebSocket server for the live dashboard. It only LISTENS to the event bus and forwards
// events to connected browsers; it never calls into the agents, so the dashboard is read-only.
// (Approvals stay in the terminal: the executor asks y/n through `prompts`.)

import Fastify from "fastify";
import websocket from "@fastify/websocket";
import pc from "picocolors";
import { AGENTS } from "./agents/definitions";
import { bus } from "./core/events";
import type { AgentInfo, ServerMessage } from "./core/event-types";

export interface DashboardServer {
  port: number;
  close(): Promise<void>;
}

const DEFAULT_PORT = Number(process.env.AGENT_UI_PORT) || 3001;
const WS_OPEN = 1;

// The dashboard exposes what the agent reads, runs and writes, so only the local Vite dev server
// (or origins you list in AGENT_UI_ORIGINS, comma separated) may connect from a browser.
function allowedOrigins(): Set<string> {
  const extra = (process.env.AGENT_UI_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set(["http://localhost:5173", "http://127.0.0.1:5173", ...extra]);
}

export async function startServer(port: number = DEFAULT_PORT): Promise<DashboardServer> {
  const origins = allowedOrigins();
  const roster: AgentInfo[] = AGENTS.map((a) => ({ id: a.id, name: a.name, description: a.description }));

  const app = Fastify({ logger: false });
  await app.register(websocket);

  app.get("/health", async () => ({ ok: true }));

  app.get("/ws", { websocket: true }, (socket, req) => {
    const origin = req.headers.origin;
    if (origin && !origins.has(origin)) {
      socket.close(1008, "origin not allowed");
      return;
    }

    const send = (message: ServerMessage) => {
      if (socket.readyState === WS_OPEN) socket.send(JSON.stringify(message));
    };

    // Catch the new client up, then stream live.
    send({ kind: "hello", version: 1, roster, history: bus.snapshot() });
    const unsubscribe = bus.subscribe((event) => send({ kind: "event", event }));
    socket.on("close", unsubscribe);
    socket.on("error", unsubscribe);
  });

  // Loopback only: never reachable from the network.
  await app.listen({ port, host: "127.0.0.1" });
  console.log(pc.cyan(`📡 Dashboard socket: ws://127.0.0.1:${port}/ws  (UI: npm run web)`));

  return { port, close: () => app.close() };
}
