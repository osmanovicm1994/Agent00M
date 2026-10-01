# src/knowledge/db-standards/03-query-performance.md
# Performance & Query Optimization

## 1. Indexing Strategies
- Do not over-index. Indexes speed up reads but slow down writes. 
- Always index Foreign Keys.
- Use Partial Indexes for highly skewed data (e.g., `CREATE INDEX ON orders (status) WHERE status = 'PENDING'`).
- Use Composite Indexes for queries that frequently filter by multiple columns. The order of columns in the index MUST match the cardinality and query pattern (most selective column first).

## 2. N+1 Query Eradication
- Loops executing database queries are strictly prohibited.
- Use ORM eager loading (`include` in Prisma, `.Include()` in EF Core, `select_related` in Django).
- For GraphQL or complex nested resolvers, utilize DataLoader patterns to batch and cache queries at the request level.

## 3. Connection Management
- Web applications must never open direct persistent connections to the database per request. 
- Utilize a connection pooler (like PgBouncer for PostgreSQL) to manage transaction-level pooling and prevent connection exhaustion.