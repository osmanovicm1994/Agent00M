---
name: api-standards
description: API standards: REST resource design, request validation, error format and logging, security hardening.
---

# API & Backend Standards

Production-grade API work: no fragile, unversioned or insecure endpoints. Follow the project's existing conventions first. Injected for the api agent, and by task rules for other agents:
- **`01-endpoint-design.md`**: resources, methods, status codes, idempotency, pagination.
- **`02-validation-pipes.md`**: typed payloads, mass-assignment prevention, parameter validation (added for endpoint/validation tasks).
- **`03-error-handling.md`**: one error format (Problem Details), exception filters, safe logging (added for endpoint/validation tasks).
- **`04-security-protocols.md`**: auth, object-level authorization, rate limiting, CORS, secrets (added for auth/security tasks).
