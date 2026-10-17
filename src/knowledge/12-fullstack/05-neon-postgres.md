# Neon (serverless PostgreSQL)

## Connections
- Neon gives a pooled host (name contains `-pooler`, PgBouncer in transaction mode) and a direct host. Use the POOLED string for the running application, and the DIRECT string for migrations and anything that needs session features (advisory locks, `LISTEN/NOTIFY`, long transactions, prepared statements on a pooled connection can fail).
- Prisma (before the config-file move): `url` = pooled, `directUrl` = direct. Newer majors and Drizzle: set the migration URL in the tool's config file. Name the variables clearly (`DATABASE_URL`, `DIRECT_URL`) and list them in `.env.example`.
- Require TLS: `sslmode=require` is part of Neon's connection string; keep it.

## Behavior to design for
- Compute scales to zero: the first query after idle can be slow. Use sensible connect and query timeouts, retry the first connection a couple of times, and keep health checks cheap.
- Connection limits are real: use one pool per process with a small `max`, and the pooled host. A NestJS server needs a pool; a serverless function should use the Neon serverless driver (HTTP/WebSocket) or the pooled host with one connection.
- Idle connections are closed by the server: handle `connection terminated` errors by retrying.

## Branches and environments
- Use a branch per environment (development, test, preview); never develop against the production branch. Test runs use a throwaway branch or a local Postgres, reset between suites.
- Migrations are applied to a branch first, reviewed, then deployed (`migrate deploy`) to production by the deploy pipeline or a person.

## Security
- Connection strings and API keys only in environment variables or the host's secret store; never in code, tests, logs or committed `.env` files. Rotate on exposure. The agent must not receive a production connection string.
