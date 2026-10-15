# RESTful Resource & Endpoint Design

Follow the API conventions already in the project (naming, versioning, envelope) over the defaults below.

## 1. Resources and URIs
- Nouns, plural, hierarchical: `GET /users`, `POST /users/{userId}/roles`. No verbs (`POST /createUser`). For actions that are not CRUD use a sub-resource: `POST /users/{userId}/suspend`.
- kebab-case path segments (`/user-profiles`); consistent casing in JSON bodies (follow the project, usually camelCase).
- Version the API when a breaking change is unavoidable (`/v1/...` or a header); additive changes need no new version.

## 2. Methods and status codes
- **GET** safe and idempotent, `200`. **POST** creates, `201` with a `Location` header (or `202` for async work). **PUT** full replace, idempotent, `200`/`204`. **PATCH** partial update, `200`. **DELETE** idempotent, `204`.
- Errors: `400` malformed or invalid, `401` not authenticated, `403` not allowed, `404` not found (also for resources the caller may not know exist), `409` conflict (duplicate, version mismatch), `422` semantic validation (if the project uses it), `429` rate limited. Never `200` with an error inside.

## 3. Idempotency
- Mutations that must not run twice (payments, order creation) accept an `Idempotency-Key` header; the same key returns the stored result without repeating the work. Store keys with a unique constraint and an expiry.

## 4. Collections
- Never return unbounded arrays. Cursor pagination (`?cursor=...&limit=50`) for large or changing data; offset pagination only for small stable sets. Cap `limit` (for example 100) and return the next cursor.
- Allow filtering and sorting only on indexed, whitelisted fields.

## 5. Responses
- Return DTOs, never database entities. Do not leak internal ids, hashes, stack traces or fields the caller may not see.
