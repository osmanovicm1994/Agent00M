# src/knowledge/api-standards/01-endpoint-design.md
# RESTful Resource & Endpoint Design

## 1. Resource Naming & URI Structure
- URIs must be nouns, always pluralized, and hierarchical (e.g., `GET /users`, `POST /users/{userId}/roles`).
- Never use verbs in URIs (prohibited: `POST /createUser`). For remote procedure calls (RPC) that don't fit REST, use a standardized sub-resource action pattern (e.g., `POST /users/{userId}/suspend`).
- Use kebab-case for all URI segments (`/user-profiles`, not `/userProfiles`).

## 2. HTTP Methods & Status Codes
- **GET:** Safe, cacheable, idempotent. Returns `200 OK`.
- **POST:** Non-idempotent creation. Returns `201 Created` with a `Location` header pointing to the new resource.
- **PUT:** Complete replacement of a resource. Idempotent. Returns `200 OK` or `204 No Content`.
- **PATCH:** Partial update. Returns `200 OK`.
- **DELETE:** Idempotent removal. Returns `204 No Content`.

## 3. Idempotency & Mutations
- All state-mutating requests (POST, PATCH, PUT, DELETE) critical to business flow (e.g., payments, order creation) MUST accept an `Idempotency-Key` header.
- The API must guarantee that identical requests with the same Idempotency Key yield the same result without duplicating the underlying operation.

## 4. Pagination & Filtering
- Never return unbounded arrays. Default to cursor-based pagination for large datasets (e.g., `?cursor=xyz123&limit=50`).
- Offset-based pagination (`?page=2&size=50`) is only permitted for small, non-volatile datasets where performance degradation is mathematically impossible.