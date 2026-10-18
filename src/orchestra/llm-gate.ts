// src/orchestra/llm-gate.ts
//
// A local model server (LM Studio) usually answers one request at a time. If three parallel agents all call it at
// once, requests queue inside the server, time out in the client, and nothing gets faster. The gate limits how many
// chat() calls are in flight at once (default 1 for a local model), so parallel agents overlap their SHELL time
// (installs, builds, tests) with each other's MODEL time, which is the real win, without flooding the model.

export class Semaphore {
  private waiting: Array<() => void> = [];
  private active = 0;

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Semaphore limit must be an integer >= 1");
  }

  get inFlight(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiting.length;
  }

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active++;
    } else {
      // The slot is handed over directly by release(), so `active` stays the same for the waiter.
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    };
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/** Wraps `provider.chat` so calls go through the semaphore. Every other member is passed through unchanged. */
export function gateProvider<T extends { chat: (...args: never[]) => Promise<unknown> }>(provider: T, sem: Semaphore): T {
  return new Proxy(provider, {
    get(target, prop) {
      // No receiver: getters and #private fields of the provider must see the real object, not the proxy.
      const value = Reflect.get(target, prop);
      if (prop === "chat" && typeof value === "function") {
        return (...args: unknown[]) => sem.run(() => (value as (...a: unknown[]) => Promise<unknown>).apply(target, args));
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Default 2: LM Studio's "Max Concurrent Predictions" is 4 by default, so 2 leaves headroom. Set AGENT_LLM_CONCURRENCY=1 for a server that handles one request at a time. */
export const DEFAULT_LLM_CONCURRENCY = 2;

export function llmConcurrencyFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.AGENT_LLM_CONCURRENCY);
  return Number.isInteger(n) && n >= 1 ? n : DEFAULT_LLM_CONCURRENCY;
}
