// src/tools/download.tool.ts
//
// download_file: saves ONE file from a public https URL into the workspace (sample images for a seed script, a PDF
// the user linked, a JSON/CSV data set). It is the only tool that puts bytes from the internet on disk, so it is strict:
//
//   - https only, public hosts only (net-guard.ts, re-checked on every redirect, at most 3)
//   - 10 MB cap (AGENT_DOWNLOAD_MAX_MB), 30 s timeout (AGENT_DOWNLOAD_TIMEOUT_MS)
//   - the CONTENT is verified, not just the header: images and PDFs by their magic bytes, JSON by parsing, text by
//     UTF-8 decoding; an HTML error or consent page saved as "photo.jpg" is refused
//   - the file extension must match what the bytes really are
//   - SVG files with scripts / event handlers are refused
//   - never overwrites an existing file, never writes outside the workspace or into secret files
//
// The URL must come from the user, web_search or web_fetch. A URL recalled from the model's memory is usually dead.

import * as path from "path";
import pc from "picocolors";
import type { ToolSchema } from "../llm/types";
import type { FsTools } from "./fs.tool";
import { assertPublicUrl } from "./net-guard";

export type DownloadKind = "png" | "jpeg" | "gif" | "webp" | "avif" | "svg" | "pdf" | "json" | "csv" | "text";

export const downloadToolSchema: ToolSchema = {
  name: "download_file",
  description:
    "Downloads ONE file from a public https URL into the project (images for a seed script or mockup, a PDF, a JSON or CSV data set). " +
    "Allowed: .png .jpg .jpeg .webp .gif .avif .svg .pdf .json .csv .txt, up to 10 MB. The URL must come from the user, web_search or web_fetch " +
    "(never invent one from memory: it is almost always dead). The file name's extension must match the real content type; HTML pages are refused. " +
    "It never overwrites an existing file. If the download fails, fall back to a local placeholder (for images: a generated SVG or a gradient) " +
    "instead of retrying other guessed URLs.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Public https URL of the file." },
      path: { type: "string", description: "Where to save it, relative to the project root, e.g. public/uploads/cars/audi-rs6.jpg" },
    },
    required: ["url", "path"],
  },
};

export const DEFAULT_MAX_DOWNLOAD_MB = 10;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 3;
export const MAX_DOWNLOADS_PER_RUN = Number(process.env.AGENT_DOWNLOAD_MAX_FILES) || 40;

const EXTENSION_KIND: Record<string, DownloadKind> = {
  ".png": "png",
  ".jpg": "jpeg",
  ".jpeg": "jpeg",
  ".webp": "webp",
  ".gif": "gif",
  ".avif": "avif",
  ".svg": "svg",
  ".pdf": "pdf",
  ".json": "json",
  ".csv": "csv",
  ".txt": "text",
};

export const ALLOWED_EXTENSIONS = Object.keys(EXTENSION_KIND);

function maxBytes(): number {
  const mb = Number(process.env.AGENT_DOWNLOAD_MAX_MB);
  return Math.floor((Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_MAX_DOWNLOAD_MB) * 1024 * 1024);
}

function timeoutMs(): number {
  const ms = Number(process.env.AGENT_DOWNLOAD_TIMEOUT_MS);
  return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_TIMEOUT_MS;
}

export interface DownloadRequest {
  url: URL;
  path: string;
}

/** Checks the model's arguments before anything is asked or fetched. `normalizedPath` is the executor's cleaned relative path. */
export function parseDownloadArgs(rawUrl: unknown, normalizedPath: string): DownloadRequest | { error: string } {
  const text = typeof rawUrl === "string" ? rawUrl.trim() : "";
  if (!text) return { error: 'download_file requires a "url".' };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { error: `not a valid URL: ${text.slice(0, 120)}` };
  }
  if (url.protocol !== "https:") return { error: "only https URLs can be downloaded." };
  if (!normalizedPath || normalizedPath === ".") return { error: 'download_file requires a "path" to save to.' };
  const ext = path.posix.extname(normalizedPath).toLowerCase();
  if (!EXTENSION_KIND[ext]) {
    return { error: `the file name must end in one of: ${ALLOWED_EXTENSIONS.join(" ")} (got "${ext || "no extension"}").` };
  }
  return { url, path: normalizedPath };
}

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((b, i) => bytes[offset + i] === b);
}

function ascii(bytes: Uint8Array, from: number, to: number): string {
  let s = "";
  for (let i = from; i < Math.min(to, bytes.length); i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function sniffBinary(bytes: Uint8Array): DownloadKind | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") return "gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "webp";
  if (ascii(bytes, 4, 8) === "ftyp" && ["avif", "avis"].includes(ascii(bytes, 8, 12))) return "avif";
  if (ascii(bytes, 0, 1024).includes("%PDF-")) return "pdf";
  return undefined;
}

const HTML_START = /^\s*(<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>])/i;
const UNSAFE_SVG = /<script|\son[a-z]+\s*=|javascript:|<foreignObject/i;

export type ContentCheck = { ok: true; kind: DownloadKind } | { ok: false; reason: string };

/** Verifies that the downloaded bytes really are what the file name claims. */
export function checkContent(bytes: Uint8Array, filePath: string): ContentCheck {
  const ext = path.posix.extname(filePath).toLowerCase();
  const expected = EXTENSION_KIND[ext];
  if (!expected) return { ok: false, reason: `unsupported file extension "${ext}".` };
  if (bytes.length === 0) return { ok: false, reason: "the server returned an empty file." };

  const binary = sniffBinary(bytes);
  if (binary) {
    if (binary !== expected) {
      return { ok: false, reason: `the content is a ${binary.toUpperCase()} file but the name ends in ${ext}. Use a matching extension.` };
    }
    return { ok: true, kind: binary };
  }

  // Not a known binary format: it can only be text (svg, json, csv, txt).
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: `the content is not a valid ${expected === "text" ? "text" : expected.toUpperCase()} file (unknown binary data).` };
  }
  if (text.includes("\u0000")) return { ok: false, reason: "the content is binary data, not a valid file of the requested type." };
  text = text.replace(/^﻿/, "");
  if (HTML_START.test(text)) {
    return { ok: false, reason: "the URL returned an HTML web page (an error, login or consent page), not the file. Find a direct link to the file." };
  }

  const looksSvg = /<svg[\s>]/i.test(text.slice(0, 4000));
  if (expected === "svg") {
    if (!looksSvg) return { ok: false, reason: "the content is not an SVG image." };
    if (UNSAFE_SVG.test(text)) return { ok: false, reason: "the SVG contains scripts or event handlers and is refused." };
    return { ok: true, kind: "svg" };
  }
  if (looksSvg) return { ok: false, reason: `the content is an SVG image but the name ends in ${ext}. Use .svg.` };
  if (["png", "jpeg", "gif", "webp", "avif", "pdf"].includes(expected)) {
    return { ok: false, reason: `the content is not a real ${expected.toUpperCase()} file (it is text). The URL probably does not point at the file itself.` };
  }
  if (expected === "json") {
    try {
      JSON.parse(text);
    } catch {
      return { ok: false, reason: "the content is not valid JSON." };
    }
    return { ok: true, kind: "json" };
  }
  return { ok: true, kind: expected };
}

export interface DownloadDeps {
  fetchImpl?: typeof fetch;
  assertUrl?: (u: URL) => Promise<void>;
  maxBytes?: number;
  timeoutMs?: number;
}

export interface Downloaded {
  bytes: Uint8Array;
  contentType: string;
  finalUrl: string;
}

async function readCapped(res: Response, limit: number): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > limit) throw new Error(`the file is larger than the ${Math.round(limit / 1024 / 1024)} MB limit.`);
    return buf;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.length;
    if (total > limit) {
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
      throw new Error(`the file is larger than the ${Math.round(limit / 1024 / 1024)} MB limit.`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** Fetches the bytes. Every hop (the first URL and each redirect) must be a public https address. Throws Error with a readable reason. */
export async function downloadBytes(url: URL, deps: DownloadDeps = {}): Promise<Downloaded> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const assertUrl = deps.assertUrl ?? ((u: URL) => assertPublicUrl(u, { protocols: ["https:"] }));
  const limit = deps.maxBytes ?? maxBytes();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? timeoutMs());

  try {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (current.protocol !== "https:") throw new Error("a redirect led to a non-https address, which is refused.");
      await assertUrl(current);
      const res = await fetchImpl(current.toString(), {
        headers: { "User-Agent": "agent-mustafa/1.0 (download_file)", Accept: "image/*,application/pdf,application/json,text/csv,text/plain;q=0.9,*/*;q=0.1" },
        redirect: "manual",
        signal: controller.signal,
      });

      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        if (hop === MAX_REDIRECTS) throw new Error(`too many redirects (more than ${MAX_REDIRECTS}).`);
        current = new URL(location, current);
        continue;
      }
      if (res.status !== 200) throw new Error(`the server answered HTTP ${res.status}.`);

      const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      if (/^(text\/html|application\/xhtml)/.test(contentType)) {
        throw new Error("the URL returned an HTML web page, not a file. Find a direct link to the file.");
      }
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > limit) {
        throw new Error(`the file is ${(declared / 1024 / 1024).toFixed(1)} MB, over the ${Math.round(limit / 1024 / 1024)} MB limit.`);
      }
      const bytes = await readCapped(res, limit);
      return { bytes, contentType, finalUrl: current.toString() };
    }
    throw new Error(`too many redirects (more than ${MAX_REDIRECTS}).`);
  } catch (err: any) {
    if (err?.name === "AbortError") throw new Error(`the download timed out after ${Math.round((deps.timeoutMs ?? timeoutMs()) / 1000)} s.`);
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    clearTimeout(timer);
  }
}

export interface DownloadOutcome {
  path: string;
  bytes: number;
  kind: DownloadKind;
  finalUrl: string;
}

/** Downloads, verifies the content and writes it (no overwrite). Throws Error with a readable reason; nothing is written on failure. */
export async function performDownload(req: DownloadRequest, fsTools: FsTools, deps: DownloadDeps = {}): Promise<DownloadOutcome> {
  console.error(pc.cyan(`\n⬇ Downloading ${req.url.toString().slice(0, 140)} → ${req.path}`));
  const got = await downloadBytes(req.url, deps);
  const check = checkContent(got.bytes, req.path);
  if (!check.ok) throw new Error(check.reason);
  fsTools.commitNewBinary(req.path, got.bytes);
  console.error(pc.green(`✅ Saved ${req.path} (${(got.bytes.length / 1024).toFixed(0)} KB, ${check.kind})`));
  return { path: req.path, bytes: got.bytes.length, kind: check.kind, finalUrl: got.finalUrl };
}

export function describeOutcome(o: DownloadOutcome): string {
  return `File downloaded: ${o.path} (${(o.bytes / 1024).toFixed(0)} KB, ${o.kind}) from ${o.finalUrl}. The file is binary/external data: do NOT read_file it; just reference its path.`;
}
