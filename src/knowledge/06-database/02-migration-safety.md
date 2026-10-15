# Zero-Downtime Migrations

## 0. Ground rules
- Generate migrations with the project's tool (Prisma, EF Core, Alembic, TypeORM, Flyway ...). Never edit a migration that has already been applied or committed; add a new one.
- Read the current schema and the last migrations before writing one. State in your answer what the migration does to existing rows.

## 1. Expand and contract
- Do not rename a column or change its type in one deploy.
  1. **Expand:** add the new column/table (nullable or with a safe default). Deploy code that writes both.
  2. **Backfill:** copy old data to the new column in small batches, not one huge `UPDATE`.
  3. **Contract:** deploy code that uses only the new column; drop the old one in a separate, later migration.
- Adding `NOT NULL` to an existing column: add nullable, backfill, then add the constraint (in PostgreSQL, add it `NOT VALID` and `VALIDATE` afterwards to avoid a long lock).

## 2. Avoid long locks (PostgreSQL)
- `CREATE INDEX CONCURRENTLY` on large tables (it cannot run inside a transaction block; configure the tool accordingly).
- Adding a column with a constant default is fast on PostgreSQL 11+; on older versions or volatile defaults it rewrites the table, so add the column bare, backfill, then set the default.
- Set a `lock_timeout` for DDL so a blocked migration fails fast instead of queueing every request behind it.

## 3. Rollback
- Every `up` has a `down` that works, or the migration states plainly that it is irreversible and why. Dropping data needs a backup or a retained copy first.
- Test on a copy of realistic data: apply, roll back, apply again.
