# Prisma: Schema First, Names Copied, Nothing Guessed

## Writing schema.prisma
- Enum values go on SEPARATE LINES. Wrong (P1012 "This line is not an enum value definition"): `enum UserRole { CUSTOMER ADMIN }`. Right:
```
enum UserRole {
  CUSTOMER
  ADMIN
}
```
- Comments are `//`, never `#`.
- `@@index([...])` and `@@unique([...])` list SCALAR fields only (`userId`, `status`), never relation fields (`user`).
- Every relation has both sides and a scalar foreign key: `userId String` + `user User @relation(fields: [userId], references: [id])`, and `bookings Booking[]` on the other model.
- Write the WHOLE schema in one `write_file`, then run `npx prisma validate && npx prisma generate`. Fix the FIRST validation error, rewrite the whole file, run again.

## Using the client
- Client property = lowerCamel model name: `model OpeningHour` -> `prisma.openingHour`. Field names and enum values stay exactly as written in the schema. Read the model block before every query, seed or API route that touches it.
- `select` narrows the result type: a field you did not select does not exist on the result (TS2339). Add it to `select` or stop using it.
- `upsert` / `findUnique` `where` accepts only `@id`, `@unique` fields or a compound `a_b` from `@@unique([a, b])`. Otherwise use `findFirst` + `create` / `update`.
- Prisma 7: `new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) })`; import from the generated output folder, not `@prisma/client` (see the known fixes).
- Money as integer cents, times as `DateTime` in UTC, ids as `String @id @default(cuid())` unless the project already uses another style.

## Handing the schema to the other tasks
- The database task ends its report with a compact list, one line per model: `Model: field:type, field:type, ...` plus the enum values. The API and UI tasks copy names from that list and from `prisma/schema.prisma`, never from the request text or from memory.
- After any schema change: `npx prisma validate && npx prisma generate`, then the typecheck, then (needs a running database) `npx prisma migrate dev --name <change>`. Never `prisma db pull` over a schema that has unmigrated models; never `migrate reset` without the person's yes.
