// Minimal MCP (Model Context Protocol) client over stdio.
//
// Deliberately dependency-free: MCP's stdio transport is just newline-delimited
// JSON-RPC 2.0 over a child process, which is all we need to discover a
// server's tools (tools/list) and call them (tools/call). Servers run as local
// child processes, so this keeps the agent fully local.

import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import * as fs from "fs";
import * as path from "path";
import pc from "picocolors";
import type { ToolSchema } from "../llm/types";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  // Tools of this server run without a y/n prompt (use for side-effect-free servers like sequential-thinking).
  autoApprove?: boolean;
  disabled?: boolean;
}

export interface McpConfig {
  servers: Record<string, McpServerConfig>;
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface Pending {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const PROTOCOL_VERSION = "2024-11-05";

class McpConnection {
  tools: McpTool[] = [];
  private proc?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private dead = false;

  constructor(
    readonly name: string,
    readonly cfg: McpServerConfig,
  ) {}

  async start(timeoutMs = 60_000): Promise<void> {
    this.proc = spawn(this.cfg.command, this.cfg.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(this.cfg.env ?? {}) },
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => this.onData(chunk));
    // Servers log to stderr; drain it so the pipe never fills up.
    this.proc.stderr.on("data", () => {});
    this.proc.on("error", (err) => this.fail(new Error(`failed to start "${this.cfg.command}": ${err.message}`)));
    this.proc.on("exit", (code) => this.fail(new Error(`server exited (code ${code})`)));

    await this.request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "agent-cli", version: "0.1.0" },
      },
      timeoutMs,
    );
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });

    const listed = await this.request("tools/list", {}, timeoutMs);
    this.tools = Array.isArray(listed?.tools) ? listed.tools : [];
  }

  async callTool(toolName: string, args: Record<string, unknown>, timeoutMs = 120_000): Promise<string> {
    const result = await this.request("tools/call", { name: toolName, arguments: args }, timeoutMs);
    const parts: string[] = [];
    for (const item of result?.content ?? []) {
      if (item?.type === "text" && typeof item.text === "string") parts.push(item.text);
      else if (item) parts.push(`[${item.type ?? "content"} omitted]`);
    }
    const text = parts.join("\n").trim() || "(empty result)";
    return result?.isError ? `MCP TOOL ERROR: ${text}` : text;
  }

  close(): void {
    this.dead = true;
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
    try {
      this.proc?.kill();
    } catch {
      // already gone
    }
  }

  private request(method: string, params: unknown, timeoutMs: number): Promise<any> {
    if (this.dead) return Promise.reject(new Error("connection closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout after ${Math.round(timeoutMs / 1000)}s waiting for "${method}"`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private send(message: object): void {
    try {
      this.proc?.stdin.write(JSON.stringify(message) + "\n");
    } catch {
      // process died; pending requests are rejected via the exit handler
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;

      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // not JSON (stray log line on stdout)
      }

      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const pending = this.pending.get(msg.id);
        if (!pending) continue;
        this.pending.delete(msg.id);
        clearTimeout(pending.timer);
        if (msg.error) pending.reject(new Error(msg.error.message ?? "MCP error"));
        else pending.resolve(msg.result);
      } else if (msg.method && msg.id !== undefined) {
        // Server -> client request. We support none except ping.
        if (msg.method === "ping") this.send({ jsonrpc: "2.0", id: msg.id, result: {} });
        else this.send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not supported" } });
      }
      // notifications are ignored
    }
  }

  private fail(err: Error): void {
    if (this.dead) return;
    this.dead = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}

interface ExposedTool {
  conn: McpConnection;
  tool: McpTool;
  exposedName: string;
}

export class McpManager {
  private conns: McpConnection[] = [];
  private byName = new Map<string, ExposedTool>();

  /** Path of the MCP config: $AGENT_MCP_CONFIG, else <project root>/mcp.config.json. */
  static defaultConfigPath(): string {
    return process.env.AGENT_MCP_CONFIG ?? path.resolve(__dirname, "../../mcp.config.json");
  }

  /**
   * Starts every enabled server in the config, in parallel. A server that
   * fails to start is reported and skipped — the agent keeps working without it.
   */
  async start(configPath: string = McpManager.defaultConfigPath()): Promise<void> {
    if (!fs.existsSync(configPath)) return;

    let config: McpConfig;
    try {
      config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch (err: any) {
      console.log(pc.yellow(`⚠ Could not parse MCP config ${configPath}: ${err.message}`));
      return;
    }

    const entries = Object.entries(config.servers ?? {}).filter(([, cfg]) => !cfg.disabled);
    const started = await Promise.all(
      entries.map(async ([name, cfg]) => {
        const conn = new McpConnection(name, cfg);
        try {
          await conn.start();
          return conn;
        } catch (err: any) {
          conn.close();
          console.log(pc.yellow(`⚠ MCP server "${name}" unavailable: ${err.message}`));
          return null;
        }
      }),
    );

    this.conns = started.filter((c): c is McpConnection => c !== null);
    this.registerTools();

    if (this.byName.size > 0) {
      console.log(pc.dim(`MCP tools ready: ${[...this.byName.keys()].join(", ")}`));
    }
  }

  private registerTools(): void {
    const counts = new Map<string, number>();
    for (const conn of this.conns) for (const t of conn.tools) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);

    const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");
    for (const conn of this.conns) {
      for (const tool of conn.tools) {
        // Bare tool name when unique (easier for small models); prefixed on collision.
        const exposedName = (counts.get(tool.name) ?? 0) > 1 ? `${clean(conn.name)}__${clean(tool.name)}` : clean(tool.name);
        this.byName.set(exposedName, { conn, tool, exposedName });
      }
    }
  }

  schemas(): ToolSchema[] {
    return [...this.byName.values()].map(({ conn, tool, exposedName }) => ({
      name: exposedName,
      description: `[MCP: ${conn.name}] ${tool.description ?? ""}`.trim(),
      parameters: (tool.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
    }));
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  autoApprove(name: string): boolean {
    return this.byName.get(name)?.conn.cfg.autoApprove === true;
  }

  async call(name: string, args: Record<string, unknown>): Promise<string> {
    const entry = this.byName.get(name);
    if (!entry) return `TOOL ERROR: unknown MCP tool ${name}`;
    return entry.conn.callTool(entry.tool.name, args);
  }

  close(): void {
    for (const c of this.conns) c.close();
    this.conns = [];
    this.byName.clear();
  }
}
