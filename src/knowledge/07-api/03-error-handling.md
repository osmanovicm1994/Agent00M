# Error Handling & Telemetry

## 1. One error format
- Every 4xx/5xx response uses one shape, never a raw stack trace or ad-hoc JSON. Prefer RFC 9457 / 7807 Problem Details (`application/problem+json`) unless the project already has a documented format; then follow that.

````json
{
  "type": "https://api.example.com/errors/validation-failed",
  "title": "Validation Failed",
  "status": 400,
  "detail": "The request payload contains invalid fields.",
  "instance": "/users/123/profile",
  "errors": [{ "field": "email", "message": "Must be a valid email address." }]
}
````

- `status` matches the HTTP status. `type` is a stable identifier clients can switch on; `detail` is for humans; `errors` lists field problems. Add a request or correlation id.

## 2. One place to translate errors
- A global exception filter / middleware / handler maps domain errors to responses. Handlers throw typed domain errors (`NotFound`, `Conflict`, `Forbidden`), they do not build HTTP responses by hand.
- Unknown errors become `500` with a generic message. Never expose exception text, SQL, file paths, or internal ids to the client.

## 3. Logging
- Log server errors once, at the boundary, with the stack, the correlation id and the request route. Log expected client errors (4xx) at a lower level.
- Never log secrets, tokens, passwords, full card numbers or personal data (mask or omit). Use structured logs (JSON key/value), not string concatenation.

## 4. Resilience
- Calls to other services have timeouts; map their failures to `502`/`503`/`504` with a retry hint (`Retry-After`) where it helps.
- Return `429` with `Retry-After` when rate limited.
