import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as zlib from "zlib";
import type { ChatMessage } from "./types";

const CACHE_DIR = path.resolve(process.cwd(), process.env.AGENT_CACHE_DIR ?? ".agent_cache");

// Set AI_CACHE=off to bypass the cache entirely (e.g. while debugging prompts).
export const CACHE_ENABLED = (process.env.AI_CACHE ?? "on").toLowerCase() !== "off";

export class LLMCache {
  constructor() {
    if (CACHE_ENABLED && !fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
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
