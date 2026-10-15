# Transactions & Concurrency

## 1. Transaction boundaries
- Wrap operations that change several rows or tables in one transaction: if step 3 fails, steps 1 and 2 roll back.
- Keep transactions short. Never make an HTTP call, send an email or do heavy computation while one is open; do it before or after (outbox for events).
- Handle serialization failures and deadlocks: retry the whole transaction a few times, with the same ordering of locks everywhere.

## 2. Lost updates
- Optimistic locking: a `version` column (or `updated_at`) checked in the `UPDATE ... WHERE id = ? AND version = ?`; zero rows updated means a conflict, so report it instead of overwriting.
- Pessimistic locking (`SELECT ... FOR UPDATE`, or `SKIP LOCKED` for job queues) for balances and inventory reservation, where retries are not acceptable.
- Prefer atomic statements over read-modify-write in code: `UPDATE stock SET qty = qty - 1 WHERE id = ? AND qty > 0`, and check the affected row count.

## 3. Uniqueness and idempotency
- Enforce uniqueness with a unique index, and handle the violation (`INSERT ... ON CONFLICT`, catch the unique error). A "check then insert" is a race.
- Idempotency keys: store the key with the result in a table with a unique constraint; a repeated request returns the stored result.

## 4. Deletion and consistency
- Decide what happens to dependent rows (RESTRICT, CASCADE, soft delete). Orphaned rows come from missing foreign keys.
- Run backfills and cleanups in batches with a stable ordering, so they can resume after a failure.
