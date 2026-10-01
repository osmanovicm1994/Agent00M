# src/knowledge/api-standards/02-validation-pipes.md
# Request Validation & Sanitization

## 1. Strict Payload Typing (DTOs)
- All incoming payloads must map to a strictly typed Data Transfer Object (DTO) or Schema (e.g., Zod, Pydantic, class-validator).
- **Mass-Assignment Prevention:** Validation layers MUST be configured to strip unknown properties automatically (e.g., `whitelist: true` in NestJS). If an unknown property is sent, reject the request entirely (`forbidNonWhitelisted: true`).

## 2. Deep Validation
- Do not rely solely on structural typing (`string`, `number`). Use semantic validation:
  - Strings must have `minLength` and `maxLength`.
  - Numbers must have `min` and `max` constraints.
  - Enums must be strictly validated against allowed values.
  - Email, UUID, and URL strings must pass strict regex/format validators.

## 3. Path & Query Parameter Validation
- Query parameters must be explicitly parsed and validated (e.g., ensuring `limit` is parsed as an integer and capped at a maximum of 100).
- Path parameters (e.g., `/users/{id}`) must be validated as valid UUIDs/ULIDs or integers before reaching the controller logic.