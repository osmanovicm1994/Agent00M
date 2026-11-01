import { describe, expect, it } from "vitest";
import { repeatsEarlierContent } from "./append-guard";

const SEED = [
  'import { PrismaClient } from "@prisma/client";',
  "import bcrypt from 'bcryptjs';",
  "const prisma = new PrismaClient();",
  "async function main() {",
  "  const admin = await prisma.user.upsert({ where: { email: 'admin@example.com' }, update: {}, create: {} });",
  "  console.log('seeded', admin.id);",
  "}",
  "main().finally(() => prisma.$disconnect());",
].join("\n");

describe("repeatsEarlierContent", () => {
  it("catches a chunk that starts the file over", () => {
    expect(repeatsEarlierContent(SEED, `${SEED}\n`)).toBe(true);
    expect(repeatsEarlierContent(`${SEED}\n${SEED}`, SEED)).toBe(true);
  });

  it("catches a restart that begins in the middle of the file", () => {
    const chunk = SEED.split("\n").slice(2).join("\n");
    expect(repeatsEarlierContent(SEED, chunk)).toBe(true);
  });

  it("ignores blank lines and indentation when comparing", () => {
    const chunk = SEED.split("\n").map((l) => `   ${l.trim()}\n`).join("\n");
    expect(repeatsEarlierContent(SEED, chunk)).toBe(true);
  });

  it("lets real continuations through", () => {
    const next = [
      "export async function listServices() {",
      "  return prisma.service.findMany({ where: { active: true }, orderBy: { name: 'asc' } });",
      "}",
      "export async function getService(id: string) {",
      "  return prisma.service.findUnique({ where: { id } });",
      "}",
    ].join("\n");
    expect(repeatsEarlierContent(SEED, next)).toBe(false);
  });

  it("never treats short or generic openings as a repeat", () => {
    const existing = "}\n}\n}\n)\n);\n});\n";
    expect(repeatsEarlierContent(existing, "}\n}\n}\n)\n")).toBe(false);
    expect(repeatsEarlierContent(SEED, "a\nb")).toBe(false);
    expect(repeatsEarlierContent("", SEED)).toBe(false);
  });
});
