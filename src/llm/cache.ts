import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as zlib from "zlib";
import type { ChatMessage } from "./types";

const CACHE_DIR = path.resolve(process.cwd(), process.env.AGENT_CACHE_DIR ?? ".agent_cache");

// Set AI_CACHE=off to bypass the cache entirely (e.g. while debugging prompts).
export const CACHE_ENABLED = (process.env.AI_CACHE ?? "on").toLowerCase() !== "off";

// The key contains the WHOLE message history, so every agent step has its own entry and a hit only happens
// when a run is repeated identically. LM Studio's own prompt-prefix cache covers normal speed-ups. To stop
// the folder from growing forever, old entries are removed when the CLI starts:
//   AI_CACHE_TTL_DAYS  entries older than this are deleted (default 7, 0 = never expire)
//   AI_CACHE_MAX_MB    when the folder is bigger, the oldest entries go first (default 300, 0 = no limit)
const TTL_DAYS = envNumber("AI_CACHE_TTL_DAYS", 7);
const MAX_MB = envNumber("AI_CACHE_MAX_MB", 300);

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Deletes expired entries, then the oldest ones until the folder fits the size limit. Never throws. */
export function pruneCache(dir: string = CACHE_DIR, ttlDays: number = TTL_DAYS, maxMb: number = MAX_MB): number {
  let removed = 0;
  try {
    const entries = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".gz"))
      .map((f) => {
        const full = path.join(dir, f);
        const st = fs.statSync(full);
        return { full, size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => a.mtime - b.mtime); // oldest first

    const drop = (e: { full: string; size: number }) => {
      try {
        fs.unlinkSync(e.full);
        removed++;
        return true;
      } catch {
        return false;
      }
    };

    const cutoff = ttlDays > 0 ? Date.now() - ttlDays * 86_400_000 : 0;
    const kept = entries.filter((e) => !(cutoff && e.mtime < cutoff && drop(e)));

    if (maxMb > 0) {
      let total = kept.reduce((n, e) => n + e.size, 0);
      const limit = maxMb * 1024 * 1024;
      for (const e of kept) {
        if (total <= limit) break;
        if (drop(e)) total -= e.size;
      }
    }
  } catch {
    // no cache folder yet, or unreadable: nothing to prune
  }
  return removed;
}

export class LLMCache {
  constructor() {
    if (!CACHE_ENABLED) return;
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    pruneCache();
  }

  // Deterministic SHA-256 of model + prompt + tools. The `salt` (model id and
  // endpoint) keeps responses from different models from ever being mixed up.
  private generateKey(messages: ChatMessage[], tools?: any[], salt = ""): string {
    const payload = JSON.stringify({ salt, messages, tools });
    return crypto.createHash("sha256").update(payload).digest("hex");
  }

  private getFilePath(key: string): string {
    return path.join(CACHE_DIR, `${key}.gz`);
  }

  get(messages: ChatMessage[], tools?: any[], salt = ""): any | null {
    if (!CACHE_ENABLED) return null;
    const filePath = this.getFilePath(this.generateKey(messages, tools, salt));

    if (!fs.existsSync(filePath)) return null;
    try {
      const decompressed = zlib.gunzipSync(fs.readFileSync(filePath)).toString("utf-8");
      return JSON.parse(decompressed);
    } catch {
      // Corrupted entry: force a fresh fetch.
      return null;
    }
  }

  set(messages: ChatMessage[], tools: any[] | undefined, response: any, salt = ""): void {
    if (!CACHE_ENABLED) return;
    const filePath = this.getFilePath(this.generateKey(messages, tools, salt));

    try {
      fs.writeFileSync(filePath, zlib.gzipSync(JSON.stringify(response)));
    } catch (err) {
      console.warn(`\n[Cache] Failed to write cache to disk: ${err}`);
    }
  }
}
