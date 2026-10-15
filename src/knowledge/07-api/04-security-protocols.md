# API Security Hardening

## 1. Authentication and authorization
- Authentication (who) and authorization (what they may do) are separate. Check both on every request that touches data.
- Validate JWT signature, expiry (`exp`), issuer and audience; pin the allowed algorithms. Keep access tokens short-lived; refresh tokens rotate and are stored server-side or in httpOnly cookies, never in localStorage.
- Authorize at the object level: a valid user can still request another user's id (IDOR). Check ownership or tenant in the service layer, not only the controller, and always filter queries by the caller's tenant.
- Passwords: a slow hash (argon2id, bcrypt, scrypt), never a fast hash, never logged or returned. Compare secrets in constant time.

## 2. Input and output
- Validate every input (see `02-validation-pipes.md`); parameterized queries only, never string-built SQL. Escape or sanitize anything rendered as HTML.
- Return only the fields the caller may see (DTOs); no stack traces or internal details.
- File uploads: check size, type (by content, not name) and store outside the web root with generated names.

## 3. Rate limiting and abuse
- Global limit by IP, stricter limits by `userId` / `tenantId` for authenticated routes and the tightest limits on login, password reset and other expensive or enumerable endpoints. Return `429` with `Retry-After`.

## 4. Transport and browser
- HTTPS only with HSTS. CORS: an explicit allowlist of origins, never `*` together with credentials, no `*` in production. CSRF protection when cookies authenticate the browser (SameSite plus a token).
- Security headers (CSP, `X-Content-Type-Options`, `frame-ancestors`) via the framework's helper (helmet and similar).

## 5. Secrets and dependencies
- Secrets come from the environment or a secret manager, never from code, tests or logs; rotate on exposure.
- Keep dependencies patched (`npm audit`, `dotnet list package --vulnerable`); do not add an unmaintained package for a small job.
