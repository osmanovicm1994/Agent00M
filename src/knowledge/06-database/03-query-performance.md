# Performance & Query Optimization

## 1. Measure first
- Use `EXPLAIN (ANALYZE, BUFFERS)` (or the ORM's query log) on the real query before adding an index. Look for sequential scans on big tables, row estimates far from actual rows, and sorts spilling to disk.

## 2. Indexing
- Index foreign keys and the columns used in `WHERE`, `JOIN` and `ORDER BY` of frequent queries. Do not over-index: every index slows writes.
- Composite index order: equality-filtered columns first, then the range or sort column. A query can use only the leading columns.
- Partial indexes for skewed data (`CREATE INDEX ON orders (created_at) WHERE status = 'PENDING'`). Covering indexes (`INCLUDE`) when an index-only scan pays off.
- Functions on an indexed column (`WHERE lower(email) = ...`) skip the index unless it is an expression index.

## 3. N+1 and round trips
- No queries inside loops. Use eager loading (`include` in Prisma, `.Include()` in EF Core, `select_related` / `selectinload`) or one query with `IN` / a join; DataLoader-style batching for GraphQL resolvers.
- Select only the columns you need on hot paths. Paginate with keyset (cursor) pagination on large tables; `OFFSET` gets slower with depth.

## 4. Connections
- Use a connection pool sized to the database, not one connection per request; add a pooler (PgBouncer) for many app instances or serverless. Set statement and idle timeouts.
