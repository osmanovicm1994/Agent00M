# OWASP Top 10: Concrete Checks for Web and API Code

Report or fix only real problems you can point to. Each item lists what to look for in the code.

1. **Broken access control:** every route checks authentication AND ownership/role (IDOR: change an id, get someone else's data); admin routes guarded; tenant filter in every query; CORS allowlist.
2. **Cryptographic failures:** passwords hashed with argon2id/bcrypt; TLS everywhere; no secrets or tokens in URLs, logs or client bundles; strong random for tokens (`crypto.randomBytes`, not `Math.random`).
3. **Injection:** parameterized queries / ORM only; no string-built SQL or shell commands from input; output encoding for HTML (no `dangerouslySetInnerHTML` with untrusted data); validate and whitelist input.
4. **Insecure design:** rate limits on login, reset and expensive endpoints; business-rule limits (amounts, quantities); abuse cases considered in the plan.
5. **Security misconfiguration:** helmet and security headers, no debug mode or stack traces in production, default credentials removed, least-privilege database user, `.env` not committed, containers non-root.
6. **Vulnerable components:** run `npm audit` and fix or explain findings; pin and update dependencies; avoid unmaintained packages; commit the lockfile.
7. **Authentication failures:** short access tokens, refresh rotation, lockout or throttling, no user enumeration in messages, secure cookie flags, session invalidation on logout and password change.
8. **Software and data integrity:** verify webhook signatures; do not deserialize untrusted data into code; CI secrets protected; lockfile-based installs (`npm ci`).
9. **Logging and monitoring failures:** log auth failures and permission denials with a correlation id; never log secrets or personal data; errors reach monitoring.
10. **SSRF:** server-side fetches of user-supplied URLs use an allowlist and block private and link-local addresses; no redirects to internal hosts.

Also check: file uploads (type by content, size limit, storage outside the web root, generated names), open redirects, mass assignment (DTO whitelist), and verbose error responses.
