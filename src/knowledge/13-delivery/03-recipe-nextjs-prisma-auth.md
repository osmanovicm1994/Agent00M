# Recipe: Next.js 16 + Prisma 7 + Postgres + sessions + validated forms

Exact, working code. Session, schema and form code below typechecked and built with Next 16.4.3 (zod 4, react-hook-form 7, @hookform/resolvers 5, jose 6, bcryptjs 3). The Prisma client lines follow the official Prisma 7 guide; `prisma generate` itself was NOT run in the checking sandbox (the engine download was blocked), so on a real machine its exit code is the proof. For NextAuth, roles and per-user data see recipe 06; for the page set (login, list, wizard, print) recipe 07.

## 1. Prisma 7 files (apps/web)
`prisma/schema.prisma` (comments are `//`, NEVER `#`; no `url` in the datasource):
```
generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
}

datasource db {
  provider = "postgresql"
}

model User {
  id           String   @id @default(cuid())
  email        String   @unique
  passwordHash String
  createdAt    DateTime @default(now())
}
```
`prisma.config.ts` (next to package.json). Import from `"prisma/config"`, nothing else works. `env("X")` THROWS when X is unset, which also breaks `validate` and `generate`, so use a fallback:
```ts
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env.DATABASE_URL ?? "postgresql://user:password@localhost:5432/app" },
});
```
`src/lib/db.ts` (one client per process):
```ts
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ?? new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
```
Commands, in this order: `npx prisma validate`, `npx prisma generate` (both need no database), then `npx prisma migrate dev --name init` (needs a reachable database; if none, report "migration not applied: no database reachable").

## 2. Session cookie (no auth library)
`src/lib/session.ts`:
```ts
import "server-only";
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";

const secret = process.env.SESSION_SECRET;
if (!secret) throw new Error("SESSION_SECRET is not set (see .env.example)");
const key = new TextEncoder().encode(secret);

export async function createSession(userId: string): Promise<void> {
  const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const token = await new SignJWT({ userId }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime(expires).sign(key);
  (await cookies()).set("session", token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", expires, path: "/" });
}

export async function readSession(): Promise<{ userId: string } | null> {
  const token = (await cookies()).get("session")?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"] });
    return typeof payload.userId === "string" ? { userId: payload.userId } : null;
  } catch {
    return null;
  }
}

export async function deleteSession(): Promise<void> {
  (await cookies()).delete("session");
}
```
`.env.example`: `DATABASE_URL=postgresql://user:password@localhost:5432/app` and `SESSION_SECRET=` (the person generates it: `openssl rand -base64 32`). Never write a real secret.
Protect data in server code: call `readSession()` in each page, action and route handler that needs a user and return 401 or `redirect("/login")`. A `proxy.ts` redirect is only a convenience on top.

## 3. Validated form (zod on both sides)
`src/lib/schemas.ts`: `export const registerSchema = z.object({ email: z.email("Enter a valid email"), password: z.string().min(8, "At least 8 characters") });` and `export type RegisterInput = z.infer<typeof registerSchema>;`
Server action `src/app/register/actions.ts` (`"use server"`): `const parsed = registerSchema.safeParse(input); if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };` then `bcrypt.hash(parsed.data.password, 12)`, `prisma.user.create(...)` (catch Prisma error code `P2002` = email taken), `createSession(user.id)`.
Client form `form.tsx` (`"use client"`): `useForm<RegisterInput>({ resolver: zodResolver(registerSchema) })` with `import { zodResolver } from "@hookform/resolvers/zod"`; call the action in `handleSubmit`; show `errors.email?.message` with `role="alert"`; label every input (`aria-label` or `<label>`).

## 4. A page that reads data (cacheComponents is on)
```tsx
import { Suspense } from "react";

async function UserList() {
  const users = await prisma.user.findMany({ select: { id: true, email: true } });
  return <ul>{users.map((u) => <li key={u.id}>{u.email}</li>)}</ul>;
}

export default function Page() {
  return (
    <Suspense fallback={<p>Loading...</p>}>
      <UserList />
    </Suspense>
  );
}
```
Without `<Suspense>` this page fails `next build`. Dynamic routes: `export default async function Page({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; ... }`.
