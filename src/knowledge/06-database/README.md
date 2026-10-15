---
name: db-standards
description: Database standards: schema design, zero-downtime migrations, query performance and transactional integrity.
---

# Database Standards

Design for scale, concurrency and data integrity. Data loss, long table locks and N+1 queries are not acceptable. Follow the project's existing conventions first. Injected for the db agent, and by task rules for other agents:
- **`01-schema-patterns.md`**: keys, constraints, audit columns, soft deletes, multi-tenancy.
- **`02-migration-safety.md`**: expand and contract, lock avoidance, rollbacks (added when a task mentions migrations or schemas).
- **`03-query-performance.md`**: measuring, indexing, N+1, connections (added for slow-query tasks).
- **`04-data-integrity.md`**: transactions, locking, uniqueness, idempotency (added with migrations).
