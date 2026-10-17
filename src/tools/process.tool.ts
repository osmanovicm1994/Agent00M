// Background processes (dev servers, watchers) that must keep running while the agent does other things,
// for example: start `npm run dev`, wait until port 3000 answers, then inspect_page or run Playwright against it.
//
// run_command cannot do this: it closes stdin, waits for exit and kills the process group at the timeout.
// Here the process is started detached, its output goes to a bounded buffer, and the agent gets a name to read
// logs from or stop it later. Every process is stopped when the CLI exits.

import { spawn, type ChildProcess } from "child_process";
import * as net from "net";
import type { ToolSchema } from "../llm/types";

const MAX_BUFFER = 20_000;
const MAX_PROCESSES = 4;
const DEFAULT_WAIT_S = 60;
const MAX_WAIT_S = 300;
const NO_SIGNAL_WAIT_MS = 3_000;
const POLL_MS = 250;

interface Managed {
  name: string;
  command: string;
  child: ChildProcess;
  startedAt: number;
  buffer: string;
  exited: boolean;
  exitCode: number | null;
}

export interface StartOptions {
  name?: unknown;
  command: string;
  port?: unknown;
  readyPattern?: unknown;
  waitSeconds?: unknown;
}

const managers = new Set<ProcessManager>();
let exitHooked = false;

function hookExit(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.on("exit", () => managers.forEach((m) => m.stopAll()));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** True when something accepts connections on the port (IPv4 or IPv6 loopback). */
export function isPortOpen(port: number, timeoutMs = 400): Promise<boolean> {
  const tryHost = (host: string) =>
    new Promise<boolean>((resolve) => {
      const socket = net.connect({ port, host });
      const done = (ok: boolean) => {
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(timeoutMs, () => done(false));
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
    });
  return Promise.all([tryHost("127.0.0.1"), tryHost("::1")]).then(([a, b]) => a || b);
}

function toRegExp(pattern: string): RegExp {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
}

function validPort(p: unknown): number | undefined {
  const n = typeof p === "number" ? p : Number(p);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : undefined;
}

export class ProcessManager {
  private procs = new Map<string, Managed>();
  private counter = 0;

  constructor(private readonly workspaceRoot: string) {
    managers.add(this);
    hookExit();
  }

  names(): string[] {
    return [...this.procs.keys()];
  }

  async start(opts: StartOptions): Promise<string> {
    const command = String(opts.command ?? "").trim();
    if (!command) return 'TOOL ERROR: start_process requires a non-empty "command".';

    const name = (typeof opts.name === "string" && opts.name.trim() ? opts.name.trim() : `proc-${++this.counter}`).slice(0, 40);
    const existing = this.procs.get(name);
    if (existing && !existing.exited) {
      return `TOOL ERROR: a process named "${name}" is already running (${existing.command}). Use process_logs to read it or stop_process to stop it first.`;
    }
    const running = [...this.procs.values()].filter((p) => !p.exited).length;
    if (running >= MAX_PROCESSES) {
      return `TOOL ERROR: ${running} background processes are already running (limit ${MAX_PROCESSES}). Stop one with stop_process first.`;
    }

    const port = validPort(opts.port);
    if (port && (await isPortOpen(port))) {
      return `TOOL ERROR: port ${port} is already in use. Something else is listening there (maybe a server from earlier). Use a different port, or ask the user to stop it. Do not start a second copy.`;
    }

    const isWindows = process.platform === "win32";
    const child = spawn(command, {
      cwd: this.workspaceRoot,
      shell: true,
      detached: !isWindows,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    const m: Managed = { name, command, child, startedAt: Date.now(), buffer: "", exited: false, exitCode: null };
    this.procs.set(name, m);

    const add = (buf: Buffer) => {
      m.buffer += buf.toString("utf8");
      if (m.buffer.length > MAX_BUFFER * 2) m.buffer = m.buffer.slice(-MAX_BUFFER);
    };
    child.stdout?.on("data", add);
    child.stderr?.on("data", add);
    child.on("error", (err) => {
      add(Buffer.from(`Failed to start the process: ${err.message}\n`));
      m.exited = true;
      m.exitCode = 1;
    });
    child.on("close", (code, signal) => {
      m.exited = true;
      m.exitCode = typeof code === "number" ? code : signal ? 1 : 0;
    });

    const readyRe = typeof opts.readyPattern === "string" && opts.readyPattern ? toRegExp(opts.readyPattern) : undefined;
    const hasSignal = Boolean(port || readyRe);
    const waitS = Math.min(Math.max(Number(opts.waitSeconds) || DEFAULT_WAIT_S, 1), MAX_WAIT_S);
    const deadline = Date.now() + (hasSignal ? waitS * 1000 : NO_SIGNAL_WAIT_MS);

    let status: "ready" | "running_unconfirmed" | "exited" = "running_unconfirmed";
    while (Date.now() < deadline) {
      if (m.exited) {
        status = "exited";
        break;
      }
      if (readyRe && readyRe.test(m.buffer)) {
        status = "ready";
        break;
      }
      if (port && (await isPortOpen(port))) {
        status = "ready";
        break;
      }
      await sleep(POLL_MS);
    }
    if (m.exited) status = "exited";

    return JSON.stringify({
      name,
      status,
      pid: child.pid,
      ...(port ? { port } : {}),
      ...(status === "exited" ? { exitCode: m.exitCode, note: "The process ended on its own. Read the output for the error." } : {}),
      ...(status === "running_unconfirmed"
        ? {
            note: hasSignal
              ? `Not ready after ${waitS}s (no match for the ready pattern / port). It is still running: read process_logs, then fix the cause or stop_process.`
              : "Still running after the first seconds. Pass port or ready_pattern next time to wait until it is really ready.",
          }
        : {}),
      output: m.buffer.slice(-3000).trim() || "(no output yet)",
    });
  }

  logs(name: unknown, tailChars?: unknown): string {
    const m = this.procs.get(String(name ?? ""));
    if (!m) return `TOOL ERROR: no process named "${String(name)}". Running: ${this.names().join(", ") || "none"}.`;
    const n = Math.min(Math.max(Number(tailChars) || 4000, 200), MAX_BUFFER);
    return JSON.stringify({
      name: m.name,
      running: !m.exited,
      ...(m.exited ? { exitCode: m.exitCode } : {}),
      uptimeSeconds: Math.round((Date.now() - m.startedAt) / 1000),
      output: m.buffer.slice(-n).trim() || "(no output)",
    });
  }

  async stop(name: unknown): Promise<string> {
    const m = this.procs.get(String(name ?? ""));
    if (!m) return `TOOL ERROR: no process named "${String(name)}". Running: ${this.names().join(", ") || "none"}.`;
    if (m.exited) {
      this.procs.delete(m.name);
      return JSON.stringify({ name: m.name, stopped: true, note: "It had already exited.", exitCode: m.exitCode });
    }
    this.kill(m, "SIGTERM");
    const forceAt = Date.now() + 3_000;
    while (!m.exited && Date.now() < forceAt) await sleep(100);
    if (!m.exited) {
      this.kill(m, "SIGKILL");
      const giveUp = Date.now() + 2_000;
      while (!m.exited && Date.now() < giveUp) await sleep(100);
    }
    this.procs.delete(m.name);
    return JSON.stringify({ name: m.name, stopped: m.exited });
  }

  /** Synchronous best effort, used when the CLI exits. */
  stopAll(): void {
    for (const m of this.procs.values()) if (!m.exited) this.kill(m, "SIGTERM");
  }

  private kill(m: Managed, signal: NodeJS.Signals): void {
    try {
      if (process.platform !== "win32" && m.child.pid) process.kill(-m.child.pid, signal);
      else m.child.kill(signal);
    } catch {
      // already gone
    }
  }
}

export const processToolSchemas: ToolSchema[] = [
  {
    name: "start_process",
    description:
      "Start a long-running process in the background (dev server, watcher, preview) and wait until it is ready. Use this instead of run_command for anything that never exits, " +
      "for example `npm run dev`, so it keeps running while you call inspect_page or run end-to-end tests against it. Same approval rules as run_command. " +
      "Pass port (preferred) or ready_pattern so the call returns when the server really answers. Stop it with stop_process when you are done.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short name to refer to it later, e.g. web or api" },
        command: { type: "string", description: "The exact shell command, e.g. npm run dev" },
        port: { type: "number", description: "TCP port the server listens on; the call waits until it accepts connections" },
        ready_pattern: { type: "string", description: "Regex that appears in the output when it is ready, e.g. Ready in|listening on" },
        wait_seconds: { type: "number", description: "How long to wait for readiness (default 60, max 300)" },
      },
      required: ["command"],
    },
  },
  {
    name: "process_logs",
    description: "Read the latest output of a background process started with start_process, and whether it is still running.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The process name" },
        tail_chars: { type: "number", description: "How many characters from the end to return (default 4000)" },
      },
      required: ["name"],
    },
  },
  {
    name: "stop_process",
    description: "Stop a background process started with start_process (the whole process group, so child servers stop too).",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "The process name" } },
      required: ["name"],
    },
  },
];
