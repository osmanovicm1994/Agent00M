# Request Validation & Sanitization

## 1. Typed payloads
- Every incoming body, query and path parameter maps to a typed schema or DTO (Zod, Pydantic, class-validator, FluentValidation, Bean Validation). Use the one the project already has.
- Reject unknown properties (`whitelist: true` with `forbidNonWhitelisted: true` in NestJS; `extra = "forbid"` in Pydantic; `.strict()` in Zod). This blocks mass assignment (a client setting `role` or `isAdmin`).
- Never bind a request body straight onto an entity.

## 2. Semantic validation
- Strings: min and max length, trimmed where appropriate, format validators for email, UUID, URL, date.
- Numbers: min and max, integer vs decimal. Enums: only allowed values. Arrays: max length. Nested objects: validate deeply.
- Cross-field rules (end after start, one-of fields) live in the schema too.

## 3. Path and query parameters
- Parse and validate them: `limit` is an integer capped at a maximum, `id` is a valid UUID/ULID/integer before the controller logic runs, sort fields come from a whitelist.

## 4. Where validation lives
- Validate at the edge (pipe, middleware, schema) so handlers only see valid data. Validation passes are not authorization: still check that the caller may touch this resource.
- The same rules back the UI form validation where possible, but the server is the source of truth.
- Validation failures return `400` with field-level details in the shared error format (see `03-error-handling.md`).
