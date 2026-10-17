// src/orchestra/blackboard.ts
//
// Shared state between parallel agents. Two things live here:
//  1. an append-only event log (who did what: file written, command run, contract changed, failure seen),
//  2. versioned "contracts": small named documents one agent publishes and others read
//     (e.g. "api-contract": endpoints and DTO shapes; "db-schema": the Prisma models).
//
// Agents never talk to each other directly. They post events and read a short digest of what the OTHERS did
// since they last looked. That keeps prompts small (a local model has a small context) and keeps the runs decoupled.

export type EventType = "task-start" | "task-done" | "task-failed" | "file-written" | "command" | "contract" | "debug" | "note";

export interface BoardEvent {
  seq: number;
  at: number;
  agent: string;
  type: EventType;
  text: string;
  path?: string;
}

export interface Contract {
  name: string;
  version: number;
  owner: string;
  body: string;
}

type Listener = (e: BoardEvent) => void;

const MAX_CONTRACT_CHARS = 6000;

export class Blackboard {
  private events: BoardEvent[] = [];
  private contracts = new Map<string, Contract>();
  private listeners = new Set<Listener>();
  private cursors = new Map<string, number>(); // agent -> last seq it has seen

  post(agent: string, type: EventType, text: string, filePath?: string): BoardEvent {
    const e: BoardEvent = { seq: this.events.length + 1, at: Date.now(), agent, type, text: text.slice(0, 400), path: filePath };
    this.events.push(e);
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        /* a broken listener must never break an agent */
      }
    }
    return e;
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  all(): readonly BoardEvent[] {
    return this.events;
  }

  /** Events with seq greater than `seq`, optionally without one agent's own events. */
  since(seq: number, exceptAgent?: string): BoardEvent[] {
    return this.events.filter((e) => e.seq > seq && e.agent !== exceptAgent);
  }

  /** Publishes (or replaces) a contract. The version goes up on every change so readers can tell it moved. */
  setContract(name: string, owner: string, body: string): Contract {
    const prev = this.contracts.get(name);
    const c: Contract = { name, owner, version: (prev?.version ?? 0) + 1, body: body.slice(0, MAX_CONTRACT_CHARS) };
    this.contracts.set(name, c);
    this.post(owner, "contract", `${name} v${c.version} published`);
    return c;
  }

  getContract(name: string): Contract | undefined {
    return this.contracts.get(name);
  }

  contractNames(): string[] {
    return [...this.contracts.keys()];
  }

  /**
   * What `agent` should know about the others, as a short text block for its next prompt. Marks everything as seen,
   * so calling it twice in a row returns nothing the second time. Empty string when nothing is new.
   */
  digestFor(agent: string, maxLines = 12): string {
    const last = this.cursors.get(agent) ?? 0;
    const fresh = this.since(last, agent).filter((e) => e.type !== "command");
    this.cursors.set(agent, this.events.length);
    if (fresh.length === 0) return "";
    const lines = fresh.slice(-maxLines).map((e) => `- [${e.agent}] ${e.type}${e.path ? " " + e.path : ""}: ${e.text}`);
    return `TEAM UPDATE (what the other agents did since you last looked):\n${lines.join("\n")}`;
  }

  /** The full text of the contracts an agent depends on, for the start of its task. */
  contractsText(names: string[]): string {
    const parts: string[] = [];
    for (const n of names) {
      const c = this.contracts.get(n);
      if (c) parts.push(`### ${c.name} (v${c.version}, by ${c.owner})\n${c.body}`);
    }
    return parts.join("\n\n");
  }
}
