# src/knowledge/db-standards/02-migration-safety.md
# Zero-Downtime Migrations

## 1. The Expand and Contract Pattern
- Destructive schema changes (renaming a column, changing a data type) are strictly prohibited in a single deployment.
- **Step 1 (Expand):** Add the new column/table. Deploy. Both old and new code write to both columns.
- **Step 2 (Migrate):** Run a background script to backfill data from the old column to the new column in small, non-locking batches.
- **Step 3 (Contract):** Deploy new code that only reads/writes to the new column. Drop the old column in a final, separate migration.

## 2. Preventing Table Locks
- **Indexes:** Never run standard `CREATE INDEX` on large tables in production—it acquires an exclusive lock and halts reads/writes. Always use `CREATE INDEX CONCURRENTLY` (PostgreSQL).
- **Default Values:** Adding a column with a constant `DEFAULT` value to a massive table can rewrite the entire table. Add the column without a default, backfill it, and then apply the default constraint.

## 3. Migration Rollbacks
- Every `up` migration MUST have a mathematically sound and tested `down` migration. If data is mutated or dropped, a strategy for data recovery must exist.