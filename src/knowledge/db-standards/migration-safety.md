#### 2. `src/knowledge/db-standards/migration-safety.md`
```markdown
# Production Migration & Zero-Downtime Protocol

## 1. The Expand-and-Contract Pattern for Breaking Changes
When renaming a column, changing a type, or adding a mandatory constraint to an existing table with live data, never do it in a single migration:
- **Phase 1 (Expand):** Add the new column/table as nullable. Deploy application code that writes to both old and new columns.
- **Phase 2 (Backfill):** Run a data migration script to populate historical rows.
- **Phase 3 (Contract):** Deploy code reading exclusively from the new structure. Drop the old column in a subsequent migration.

## 2. Safe Indexing on Large Tables (`CONCURRENTLY`)
- PostgreSQL locks tables during `CREATE INDEX` by default, blocking writes.
- For tables with high transaction volume, raw SQL migrations must be utilized to build indexes concurrently:
  ```sql
  CREATE INDEX CONCURRENTLY idx_users_email ON "User"("email");