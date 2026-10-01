```markdown
# src/knowledge/api-standards/04-security-protocols.md
# API Security Hardening

## 1. Authentication & Authorization Boundaries
- Authentication (who you are) and Authorization (what you can do) are separate concerns.
- Always validate JWT signatures, expirations, and issuer claims at the gateway or framework middleware level.
- Apply strict Role-Based Access Control (RBAC) or Attribute-Based Access Control (ABAC) at the service layer, not just the controller.

## 2. Rate Limiting & Throttling
- Implement global rate limiting by IP.
- Implement strict rate limiting by `userId` or `tenantId` for authenticated routes to prevent noisy-neighbor degradation.

## 3. Transport Security
- Force HTTPS via HSTS headers.
- Configure strict CORS policies. Wildcard `*` origins are strictly prohibited in production. Explicitly whitelist frontend domains.