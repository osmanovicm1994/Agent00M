# Recipe: opaque server-side session (cookie token, SHA-256 hash in a Session table) + bcryptjs + roles

Use this when the request asks for opaque sessions, a `Session` table or `tokenHash`. No JWT, no `jose`, no auth framework. Checked against Next 16 and Prisma 7 (`import { prisma } from "@/lib/db"`; client recipe in 03).

## Schema (the request's models win; this is the minimum)
`model Session { id String @id @default(cuid()); tokenHash String @unique; userId String; expiresAt DateTime; createdAt DateTime @default(now()); user User @relation(fields: [userId], references: [id], onDelete: Cascade); @@index([userId, expiresAt]) }` and `User { id, email @unique, name, passwordHash, role UserRole @default(CUSTOMER) }`. Do NOT add columns the request's schema does not have (no `active` unless the schema lists it): a query that selects a missing column is a typecheck error.

## `src/lib/auth/session.ts` (the one module that touches the cookie)
```ts
import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";

const COOKIE = "session";
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const hash = (token: string): string => createHash("sha256").update(token).digest("hex");

/** Creates a session row and sets the cookie. Call it on login AFTER deleting the user's old sessions (rotation). */
export async function createSession(userId: string): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + TTL_MS);
  await prisma.session.deleteMany({ where: { userId } });
  await prisma.session.create({ data: { tokenHash: hash(token), userId, expiresAt } });
  (await cookies()).set(COOKIE, token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", expires: expiresAt });
}

/** The signed-in user, or null (no cookie, unknown token, expired row). */
export async function readSession() {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  const row = await prisma.session.findUnique({ where: { tokenHash: hash(token) }, include: { user: { select: { id: true, email: true, name: true, role: true } } } });
  if (!row || row.expiresAt <= new Date()) return null;
  return row.user;
}

export async function deleteSession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) await prisma.session.deleteMany({ where: { tokenHash: hash(token) } });
  jar.delete(COOKIE);
}
```
Only the SHA-256 hash is stored; the raw token exists only in the cookie. `cookies()` is async in Next 16.

## `src/lib/auth/guards.ts`
```ts
import "server-only";
import { redirect } from "next/navigation";
import { readSession } from "@/lib/auth/session";

export type Actor = NonNullable<Awaited<ReturnType<typeof readSession>>>;

export const currentActor = readSession;
export async function requireActor(loginPath = "/login"): Promise<Actor> {
  const actor = await readSession();
  if (!actor) redirect(loginPath);
  return actor;
}
export async function requireRole(role: Actor["role"], loginPath: string): Promise<Actor> {
  const actor = await requireActor(loginPath);
  if (actor.role !== role) redirect(loginPath);
  return actor;
}
```
In route handlers do not redirect: `const actor = await readSession(); if (!actor) return 401; if (actor.role !== "ADMIN") return 403;`. A customer page uses `requireRole("CUSTOMER", "/login?next=/bookings")`, an admin page `requireRole("ADMIN", "/admin/login")`.

## Passwords and registration
`src/lib/auth/password.ts`: `hashPassword(p) = bcrypt.hash(p, 12)`, `verifyPassword(p, hash) = bcrypt.compare(p, hash)` (bcryptjs, no `@types`). Zod for the body: email trimmed and lowercased, password `min(12)` and `refine(p => Buffer.byteLength(p, "utf8") <= 72)`. Registration ALWAYS creates the lowest role (`CUSTOMER`); the role is never read from the body. Login answers the same `401 INVALID_CREDENTIALS` for an unknown email and a wrong password. To avoid revealing which emails exist, compare against a dummy hash when the user is not found.

## Origin check for mutations (CSRF)
`src/lib/http.ts`: `export function assertSameOrigin(req: Request): Response | null` returns a `403 { error: { code: "BAD_ORIGIN", message: "..." } }` when the request has an `Origin` header that differs from `process.env.APP_ORIGIN`; call it first in every POST/PATCH/PUT/DELETE route handler. Responses use `{ data }` on success and `{ error: { code, message, fieldErrors? } }` on failure, as the request defines.

## Checks that prove it
Register then `GET /api/auth/session` returns the user without `passwordHash`; wrong password gives 401; logout deletes the row (the old cookie then gives `user: null`); a CUSTOMER on an admin route gets 403; another customer's booking gets 403 (or the 404 the request documents).
