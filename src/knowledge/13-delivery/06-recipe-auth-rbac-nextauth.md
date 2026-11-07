# Recipe: NextAuth v4 credentials + roles (ADMIN/USER) + per-user data

Checked in a real build: Next 16.4.3, next-auth 4.24.15, bcryptjs 3, zod 4. The Prisma calls were checked against a stub client (see `03-recipe-nextjs-prisma-auth.md` for the real client files).

## Install (one command, exact)
`npm install next-auth@4.24.15 bcryptjs zod server-only` (bcryptjs and zod ship their own types: NO `@types/bcryptjs`, NO `@types/zod`). next-auth 4.24.7 or older refuses Next 16 (peer error); 4.24.15 accepts it. Do not use `next-auth@beta` unless the request says Auth.js v5.

## Schema rules for roles and ownership
- `enum Role { ADMIN USER }`; `User { id, email @unique, name, passwordHash, role Role @default(USER), active Boolean @default(true) }`.
- Every user-owned table has `userId String` (the OWNER) and `@@index([userId])`. The owner is the signed-in account that created the row, not a person named inside the document.
- Never `onDelete: Cascade` from User to records that must be kept (contracts, invoices). Use `onDelete: Restrict` and deactivate users with `active=false`.

## `src/lib/auth.ts`
```ts
import type { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/db";

const credentialsSchema = z.object({ email: z.email(), password: z.string().min(1) });

export const authOptions: NextAuthOptions = {
  session: { strategy: "jwt", maxAge: 60 * 60 * 8 },
  pages: { signIn: "/login" },
  providers: [
    CredentialsProvider({
      name: "Email and password",
      credentials: { email: { label: "Email", type: "email" }, password: { label: "Password", type: "password" } },
      async authorize(raw) {
        const parsed = credentialsSchema.safeParse(raw);
        if (!parsed.success) return null;
        const user = await prisma.user.findUnique({ where: { email: parsed.data.email.toLowerCase() } });
        if (!user || !user.active) return null;
        const ok = await bcrypt.compare(parsed.data.password, user.passwordHash);
        return ok ? { id: user.id, email: user.email, name: user.name, role: user.role } : null;
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) { token.id = user.id; token.role = user.role; }
      return token;
    },
    session({ session, token }) {
      session.user.id = token.id;
      session.user.role = token.role;
      return session;
    },
  },
};
```
`src/app/api/auth/[...nextauth]/route.ts`: `import NextAuth from "next-auth"; import { authOptions } from "@/lib/auth"; const handler = NextAuth(authOptions); export { handler as GET, handler as POST };`
`NEXTAUTH_SECRET` and `NEXTAUTH_URL` go in `.env.example` as NAMES only (the person generates the secret: `openssl rand -base64 32`).

`src/types/next-auth.d.ts` (without it `session.user.role` does not typecheck):
```ts
import "next-auth";
import "next-auth/jwt";
type Role = "ADMIN" | "USER";
declare module "next-auth" {
  interface User { id: string; role: Role }
  interface Session { user: { id: string; role: Role; name?: string | null; email?: string | null } }
}
declare module "next-auth/jwt" { interface JWT { id: string; role: Role } }
```

## `src/lib/guards.ts` (the one place the rule lives)
```ts
import "server-only";
import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";

export type Actor = { id: string; role: "ADMIN" | "USER"; name?: string | null };

export async function currentActor(): Promise<Actor | null> {
  const session = await getServerSession(authOptions);
  return session?.user ? { id: session.user.id, role: session.user.role, name: session.user.name } : null;
}
export async function requireActor(): Promise<Actor> {
  const actor = await currentActor();
  if (!actor) redirect("/login");
  return actor;
}
export async function requireAdmin(): Promise<Actor> {
  const actor = await requireActor();
  if (actor.role !== "ADMIN") redirect("/items");
  return actor;
}
/** ADMIN sees every row, a USER only rows with their own id. Put it in EVERY list query. */
export function ownerFilter(actor: Actor): { userId?: string } {
  return actor.role === "ADMIN" ? {} : { userId: actor.id };
}
```
`redirect()` returns `never`: write `if (!actor) redirect("/login");` then use `actor`. An async component that returns `Promise<void>` is a TS error (TS2786).

## `src/proxy.ts` (Next 16 name; `middleware.ts` is the old name)
```ts
import { withAuth } from "next-auth/middleware";
export default withAuth({
  pages: { signIn: "/login" },
  callbacks: { authorized: ({ token, req }) => (req.nextUrl.pathname.startsWith("/admin") ? token?.role === "ADMIN" : Boolean(token)) },
});
export const config = { matcher: ["/items/:path*", "/admin/:path*"] };
```
This is only a redirect. Pages, actions and route handlers still check the session themselves.

## API route handlers (status codes the tests check)
List/create `src/app/api/items/route.ts`: GET -> `401` without session, else `prisma.item.findMany({ where: ownerFilter(actor) })`. POST -> `401`, `422` on zod failure, create with `userId: actor.id` (the owner comes from the session, NEVER from the body; ignore any `userId`/`role` the client sends).
Single row `src/app/api/items/[id]/route.ts` (`params` is a Promise in Next 16):
```ts
type Ctx = { params: Promise<{ id: string }> };
async function load(id: string) {
  const actor = await currentActor();
  if (!actor) return { error: NextResponse.json({ error: "Not signed in" }, { status: 401 }) } as const;
  const row = await prisma.item.findUnique({ where: { id } });
  if (!row) return { error: NextResponse.json({ error: "Not found" }, { status: 404 }) } as const;
  if (actor.role !== "ADMIN" && row.userId !== actor.id) return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) } as const;
  return { row } as const;
}
export async function GET(_req: Request, { params }: Ctx) {
  const found = await load((await params).id);
  return "error" in found ? found.error : NextResponse.json({ data: found.row });
}
```
PUT and DELETE call `load(id)` first, then validate with zod (`422`) and update/delete. Admin-only routes (`/api/admin/users`): `401` without session, `403` for a USER, `422` bad body, `409` on Prisma code `P2002` (email taken); hash with `bcrypt.hash(password, 12)`; `select` only `id,email,name,role` (never return `passwordHash`).

## Checks that prove it (write them as tests or a script)
USER A creates a row; USER B `GET /api/items/<A's id>` -> 403; B's list does not contain it; unauthenticated -> 401; USER `POST /api/admin/users` -> 403; wrong password -> login refused.
