# src/knowledge/db-standards/01-schema-patterns.md
# Schema Design & Data Modeling

## 1. Primary Keys & Identifiers
- **Never use auto-incrementing integers (`SERIAL`) for public-facing primary keys.** They expose business volume and are vulnerable to enumeration attacks.
- Use UUIDv7 or ULID for primary keys. They are lexicographically sortable, which prevents B-Tree index fragmentation common with UUIDv4, while maintaining decentralized generation.

## 2. Audit Columns & Soft Deletes
- Every table must include `created_at` (immutable) and `updated_at` (auto-updating via trigger or ORM middleware).
- Do not use hard `DELETE` for core domain entities. Implement a `deleted_at` timestamp. Queries must automatically filter out `deleted_at IS NOT NULL` via ORM global scopes or database Row-Level Security (RLS).

## 3. Multi-Tenancy Architecture
- In a shared-schema multi-tenant environment, every table belonging to a tenant MUST have a `tenant_id` column.
- The `tenant_id` must be part of the composite primary key or included in a composite unique index for all unique constraints to prevent cross-tenant data collision.
- Use Row-Level Security (RLS) in PostgreSQL to enforce tenant isolation at the database engine level, independent of application logic.