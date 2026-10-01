# src/knowledge/db-standards/04-data-integrity.md
# Transactions & Concurrency

## 1. Transaction Boundaries
- Wrap operations that modify multiple tables in a single ACID transaction. If step 3 fails, steps 1 and 2 must rollback.
- Keep transactions as short as possible. Never perform external HTTP requests or heavy CPU computations while a database transaction is open.

## 2. Optimistic & Pessimistic Locking
- Protect against lost updates. Use Optimistic Locking (`version` integer column) for highly concurrent web forms. If the version has changed since the user loaded the page, reject the update.
- Use Pessimistic Locking (`SELECT ... FOR UPDATE`) when dealing with critical financial balances or inventory reservation to serialize access.