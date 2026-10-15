# Custom JWT Authentication (done safely)

Use the project's auth library choice (`@nestjs/jwt`, Passport) if there is one. Do not invent your own crypto.

## Passwords and accounts
- Hash with argon2id (or bcrypt with a sane cost). Never store, log or return the password or its hash. Constant-time comparison for secrets and tokens.
- Normalize email (trim, lowercase) and enforce a unique index. Login, register and reset return the same generic message for "unknown user" and "wrong password"; rate-limit them strictly (per IP and per account).
- Reset and verification tokens: random, single use, short expiry, stored hashed.

## Tokens
- Access token: short-lived (minutes), signed with a strong secret or an asymmetric key from the environment; claims limited to user id, role, token id. Pin the algorithm on verification and check `exp`, `iss`, `aud`.
- Refresh token: long-lived, random or JWT, stored HASHED in the database with user, device, expiry and a family id. Rotate on every use; if an already-used refresh token is presented, revoke the whole family (theft detection). Logout deletes it.
- Web delivery: httpOnly + Secure + SameSite cookies (refresh token path-limited to the refresh route). Not localStorage. With cookies, add CSRF protection for state-changing requests. For non-browser clients, send the access token in `Authorization: Bearer`.

## Authorization
- Authentication proves who; authorization decides what. Check role AND ownership/tenant on every object access (IDOR): a valid user must not read another user's record by changing an id.
- Default-deny: a global auth guard with an explicit public marker for open routes. Do not trust a role sent by the client.

## Operations
- Secrets differ per environment and rotate without a code change. Log auth events (login failure, refresh reuse) without tokens or passwords. Test: expired token, tampered token, wrong audience, reused refresh token, missing ownership, brute-force limit.
