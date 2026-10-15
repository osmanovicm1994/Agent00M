# Schema Design & Data Modeling

Follow the project's existing conventions (key type, naming, soft-delete style) over the defaults below; these apply to new tables and projects with no convention.

## 1. Keys and identifiers
- Do not expose auto-incrementing integers in public URLs: they leak volume and invite enumeration. Use UUIDv7 or ULID (time-ordered, so B-tree inserts stay compact; UUIDv4 fragments indexes). Internal join tables may keep integers.

## 2. Constraints do the enforcing
- Put rules in the database, not only in code: `NOT NULL`, `UNIQUE`, `CHECK`, foreign keys. Application validation can be bypassed by a second code path, a script or a race.
- Choose `ON DELETE` on purpose (RESTRICT by default, CASCADE only for true ownership). Index every foreign key.
- Money: `numeric(p,s)` or integer minor units, never float. Timestamps: `timestamptz` (UTC). Enums: a native enum or a lookup table, not free strings.

## 3. Audit columns and soft deletes
- Core tables get `created_at` (immutable) and `updated_at` (trigger or ORM hook).
- For core domain entities prefer `deleted_at` over hard `DELETE`; every read path must filter it (ORM global scope or a view). A unique constraint on a soft-deleted table needs a partial index (`WHERE deleted_at IS NULL`).

## 3b. Multi-tenancy
- Shared-schema tenancy: every tenant table has `tenant_id`, included in composite unique indexes and in every query. Enforce isolation in the database with Row-Level Security (PostgreSQL), not only in application code.

## 4. Change safely
- Schema changes go through the project's migration tool as new migrations; see `02-migration-safety.md`.
