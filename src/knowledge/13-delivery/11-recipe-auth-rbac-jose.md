# Recipe: jose session cookie + bcryptjs + roles (ADMIN/USER/…) + per-user data (NO auth library)

This is the DEFAULT for accounts with roles. Use NextAuth (recipe 06) only when the request names NextAuth or Auth.js. Never install `next-auth` next to this: two auth systems in one app is the most common reason a run ends with a failing review.
Versions checked with Next 16, jose 6, bcryptjs 3, zod 4. The Prisma client lines are in recipe 03 (`import { prisma } from "@/lib/db"`).

## Install (one command, exact, by the infrastructure task only if the plan says so; otherwise the API task)
`npm install jose bcryptjs zod server-only` (bcryptjs, jose and zod ship their own types: NO `@types/...`). Do not install `next-auth`, `passport` or `iron-session`.
`.env.example`: `SESSION_SECRET=` as a NAME only (the person generates it: `openssl rand -base64 32`). A real secret is never written. For local development the team may put a long random dev value in `.env` (not committed).

## Roles and ownership (schema)
`enum Role { ADMIN USER }` (a barbershop might add `STAFF`); `User { id, email @unique, name, passwordHash, role Role @default(USER), active Boolean @default(true) }`. Every user-owned table has `userId String` (the OWNER, taken from the session, never from the request body) and `@@index([userId])`.

## ONE auth module owns everything: `src/lib/auth/session.ts` + `src/lib/auth/guards.ts`
Exports (other tasks import these exact names and never write their own): `createSession`, `readSession`, `deleteSession`, `currentActor`, `requireActor`, `requireAdmin`, `ownerFilter`.

`src/lib/auth/session.ts`:
```ts
import "server-only";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";

export type Role = "ADMIN" | "USER";
export type SessionData = { userId: string; role: Role };

const COOKIE = "session";
const secret = process.env.SESSION_SECRET;
if (!secret) throw new Error("SESSION_SECRET is not set (see .env.example)");
const key = new TextEncoder().encode(secret);

export async function createSession(data: SessionData): Promise<void> {
  const expires = new Date(Date.now() + 8 * 60 * 60 * 1000);
  const token = await new SignJWT({ ...data }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime(expires).sign(key);
  (await cookies()).set(COOKIE, token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", expires, path: "/" });
}

export async function readSession(): Promise<SessionData | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"] });
    return typeof payload.userId === "string" && (payload.role === "ADMIN" || payload.role === "USER") ? { userId: payload.userId, role: payload.role } : null;
  } catch {
    return null;
  }
}

export async function deleteSession(): Promise<void> {
  (await cookies()).delete(COOKIE);
}
```

`src/lib/auth/guards.ts` (the one place the rule lives):
```ts
import "server-only";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { readSession, type Role } from "@/lib/auth/session";

export type Actor = { id: string; role: Role; name: string | null };

export async function currentActor(): Promise<Actor | null> {
  const session = await readSession();
  if (!session) return null;
  const user = await prisma.user.findUnique({ where: { id: session.userId }, select: { id: true, role: true, name: true } });
  return user ? { id: user.id, role: user.role, name: user.name } : null;
}
export async function requireActor(loginPath = "/login"): Promise<Actor> {
  const actor = await currentActor();
  if (!actor) redirect(loginPath);
  return actor;
}
export async function requireAdmin(): Promise<Actor> {
  const actor = await requireActor("/admin/login");
  if (actor.role !== "ADMIN") redirect("/");
  return actor;
}
/** ADMIN sees every row, a USER only rows with their own id. Put it in EVERY list query. */
export function ownerFilter(actor: Actor): { userId?: string } {
  return actor.role === "ADMIN" ? {} : { userId: actor.id };
}
```
`redirect()` returns `never`: write `if (!actor) redirect(...)` and then use `actor`. The role is read from the database, not from the cookie, so a demoted user loses access at once. Select only columns that exist in schema.prisma: add `active` to the `select` and the check ONLY if the schema has an `active` column (a missing column is a typecheck error). If the request asks for opaque server-side sessions stored in a Session table, use recipe 12 instead of this one.

## Login, register, logout (route handlers; zod on the body)
`src/app/api/auth/login/route.ts`: parse `{ email, password }` with zod (`422` on failure) -> `prisma.user.findUnique({ where: { email: email.toLowerCase() } })` -> `bcrypt.compare(password, user.passwordHash)`; wrong email, wrong password and inactive user all answer the SAME `401 { error: "Invalid email or password" }` -> `await createSession({ userId: user.id, role: user.role })` -> `NextResponse.json({ data: { id: user.id, role: user.role } })`.
`register/route.ts`: zod (`email`, `password` min 8, `name`), `bcrypt.hash(password, 12)`, `prisma.user.create({ data: { ..., role: "USER" } })` (the role is NEVER taken from the body), catch Prisma code `P2002` -> `409`, then `createSession`. Select only `id,email,name,role`: never return `passwordHash`.
`logout/route.ts`: `await deleteSession(); return NextResponse.json({ ok: true });`
An admin site is the same accounts with `role = ADMIN`: `/admin/login` posts to the same login route and then checks `role === "ADMIN"` (otherwise it shows "Not an admin account" and calls logout).

## `src/proxy.ts` (Next 16 name; `middleware.ts` is deprecated)
```ts
import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify } from "jose";

const key = new TextEncoder().encode(process.env.SESSION_SECRET ?? "");

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname === "/admin/login") return NextResponse.next();
  const token = req.cookies.get("session")?.value;
  let role: string | null = null;
  if (token) {
    try {
      role = ((await jwtVerify(token, key, { algorithms: ["HS256"] })).payload.role as string) ?? null;
    } catch {
      role = null;
    }
  }
  if (pathname.startsWith("/admin") && role !== "ADMIN") return NextResponse.redirect(new URL("/admin/login", req.url));
  if (pathname.startsWith("/account") && !role) return NextResponse.redirect(new URL("/login", req.url));
  return NextResponse.next();
}
export const config = { matcher: ["/admin/:path*", "/account/:path*"] };
```
Only a redirect: pages, actions and route handlers still call `requireActor()` / `requireAdmin()` / `currentActor()` themselves. Never create both `middleware.ts` and `proxy.ts`.

## API status codes the tests check
`401` without session, `403` for a USER on an admin route or on another user's row, `404` missing row, `422` zod failure, `409` duplicate (`P2002`). Single-row routes: `params` is a Promise in Next 16: `type Ctx = { params: Promise<{ id: string }> }` and `const { id } = await params`. Load the row, then `if (actor.role !== "ADMIN" && row.userId !== actor.id) return 403`.

## Checks that prove it (tests or a script)
Wrong password -> `401`; right one -> cookie set (`httpOnly`); USER A creates a row, USER B `GET /api/.../<A's id>` -> `403`; unauthenticated -> `401`; USER on an admin route -> `403`.
