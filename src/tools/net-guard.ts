// src/tools/net-guard.ts
//
// Shared network safety checks for every tool that fetches a URL the model supplied (web_fetch, download_file).
// A model must never be able to reach the user's own machine or network (localhost services, router pages,
// cloud metadata endpoints at 169.254.169.254, ...), so every URL, and every redirect target, goes through here.

import * as dns from "dns";
import * as net from "net";

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const p = ip.split(".").map(Number);
    const [a, b] = p;
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 192 && b === 0 && p[2] === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === "::" || l === "::1") return true;
    if (l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe8") || l.startsWith("fe9") || l.startsWith("fea") || l.startsWith("feb")) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l);
    if (mapped) return isPrivateIp(mapped[1]);
    return false;
  }
  return true;
}

export interface PublicUrlOptions {
  /** Allowed URL schemes. web_fetch reads http and https; downloads are https only. */
  protocols?: string[];
}

/** Throws unless the URL points at a host on the public internet. DNS answers are checked too (rebinding to a private IP). */
export async function assertPublicUrl(u: URL, options: PublicUrlOptions = {}): Promise<void> {
  const protocols = options.protocols ?? ["http:", "https:"];
  if (!protocols.includes(u.protocol)) {
    throw new Error(`only ${protocols.map((p) => p.replace(":", "")).join("/")} URLs are allowed (got ${u.protocol})`);
  }
  if (u.username || u.password) throw new Error("refused: URLs with embedded credentials are not fetched");
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan")) {
    throw new Error("refused: local addresses are not fetched");
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error("refused: private network addresses are not fetched");
    return;
  }
  let addrs: Array<{ address: string }>;
  try {
    addrs = await dns.promises.lookup(host, { all: true });
  } catch {
    throw new Error(`could not resolve ${host}`);
  }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error("refused: the address resolves to a private network");
}
