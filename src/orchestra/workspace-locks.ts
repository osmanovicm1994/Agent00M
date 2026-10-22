// src/orchestra/workspace-locks.ts
//
// Path-scope write leases. Each parallel agent owns a set of path scopes (e.g. "apps/api/", "prisma/").
// A write is allowed when the target is inside the agent's own scope and not inside another agent's scope.
// Shared files (package.json at the root, lockfiles) can be given to nobody ("shared") and then every write
// is refused for parallel agents; a supervisor or a sequential phase has to handle them.
//
// Scopes are directory prefixes or exact files, always relative to the workspace root with forward slashes.
// Pure logic, no filesystem access.

import path from "node:path";

export function normalizeScope(scope: string): string {
  let s = scope.replace(/\\/g, "/").trim();
  s = s.replace(/^\.\//, "").replace(/\/+/g, "/");
  if (s === "." || s === "") return "";
  return s;
}

/** Relative, normalized path of `target` inside `root`, or null when it points outside the workspace. */
export function relativeInside(root: string, target: string): string | null {
  const abs = path.isAbsolute(target) ? path.resolve(target) : path.resolve(root, target);
  const rel = path.relative(path.resolve(root), abs).replace(/\\/g, "/");
  if (rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) return null;
  return rel;
}

/** True when `rel` is the scope itself or below it. A scope ending in "/" is a directory; otherwise an exact file or directory. */
export function inScope(rel: string, scope: string): boolean {
  const s = normalizeScope(scope);
  if (s === "") return true; // whole workspace
  const dir = s.endsWith("/") ? s : s + "/";
  return rel === s.replace(/\/$/, "") || rel.startsWith(dir);
}

/** Two scopes overlap when one contains the other. */
export function scopesOverlap(a: string, b: string): boolean {
  const x = normalizeScope(a);
  const y = normalizeScope(b);
  if (x === "" || y === "") return true;
  const xd = x.endsWith("/") ? x : x + "/";
  const yd = y.endsWith("/") ? y : y + "/";
  return xd.startsWith(yd) || yd.startsWith(xd) || x === y;
}

export interface WriteDecision {
  allowed: boolean;
  reason?: string;
}

export class WorkspaceLocks {
  private leases = new Map<string, string[]>(); // owner -> scopes
  /** Paths nobody may write while parallel agents run (root manifests, lockfiles). */
  private readonly shared: string[];
  private readonly log: Array<{ at: number; owner: string; path: string; allowed: boolean }> = [];

  constructor(
    private readonly root: string,
    shared: string[] = ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", ".gitignore"],
  ) {
    this.shared = shared.map(normalizeScope);
  }

  /** Grants scopes to an owner. Returns the first conflict (owner + scope) instead of throwing, so callers can decide. */
  tryAcquire(owner: string, scopes: string[]): { ok: true } | { ok: false; conflictWith: string; scope: string } {
    const wanted = scopes.map(normalizeScope);
    for (const [other, held] of this.leases) {
      if (other === owner) continue;
      for (const w of wanted) for (const h of held) if (scopesOverlap(w, h)) return { ok: false, conflictWith: other, scope: w };
    }
    this.leases.set(owner, [...(this.leases.get(owner) ?? []), ...wanted]);
    return { ok: true };
  }

  release(owner: string): void {
    this.leases.delete(owner);
  }

  scopesOf(owner: string): string[] {
    return this.leases.get(owner) ?? [];
  }

  /** The write guard the executor calls before every file write. */
  canWrite(owner: string, target: string): WriteDecision {
    const rel = relativeInside(this.root, target);
    const record = (allowed: boolean) => this.log.push({ at: Date.now(), owner, path: rel ?? target, allowed });
    if (rel === null) {
      record(false);
      return { allowed: false, reason: "path is outside the workspace" };
    }
    const mine = this.leases.get(owner);
    if (!mine) {
      // Not a managed agent (e.g. the supervisor itself or a sequential run): no restriction here.
      record(true);
      return { allowed: true };
    }
    // No exception for an exact-file scope: a plan that hands "package.json" to a worker does not make it writable.
    if (this.shared.some((s) => inScope(rel, s))) {
      record(false);
      return {
        allowed: false,
        reason: `"${rel}" is a shared file that parallel agents may not edit. Put the needed change in your final summary so the supervisor can apply it.`,
      };
    }
    for (const [other, held] of this.leases) {
      if (other !== owner && held.some((s) => inScope(rel, s))) {
        record(false);
        return { allowed: false, reason: `"${rel}" belongs to the "${other}" agent right now. Ask for the change through your summary instead of editing it.` };
      }
    }
    if (mine.some((s) => inScope(rel, s))) {
      record(true);
      return { allowed: true };
    }
    record(false);
    return { allowed: false, reason: `"${rel}" is outside your scope (${mine.join(", ") || "none"}). Stay inside it.` };
  }

  /** Denied writes, for the final report. */
  denials(): Array<{ owner: string; path: string }> {
    return this.log.filter((l) => !l.allowed).map((l) => ({ owner: l.owner, path: l.path }));
  }
}
