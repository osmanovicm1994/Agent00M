# Edge Cases & Resilience

## 1. Concurrency & race conditions
- Assume two identical requests arrive in the same millisecond. Will a user be charged twice, or a record duplicated?
- Defend with database constraints (unique indexes), atomic updates (`UPDATE ... WHERE balance >= x`), transactions, and idempotency keys. A check-then-insert in application code is a race.
- Retried and replayed messages are normal: every consumer and webhook handler must be safe to run twice (store the event id, ignore duplicates).

## 2. Partial failure
- Assume the network fails halfway. If the payment succeeds but the database write times out, what state is left, and who repairs it?
- Local state: one transaction. Third-party calls: record intent first, call, then record the result; reconcile by a job or a webhook. Never hold a database transaction open across an HTTP call.
- Retries need a limit, backoff with jitter, and a timeout on every call. Do not retry non-idempotent operations without an idempotency key.

## 3. Input and data
- Empty, null, missing, duplicate, oversized and wrongly typed input; unicode, very long strings, leading/trailing spaces, negative numbers, zero.
- Money: integers in the smallest unit or a decimal type, never floats; one currency per amount; define rounding.
- First run and "already done" state; deleting something that is referenced; two users editing the same record (optimistic version check).

## 4. Time
- Store UTC, convert at the display edge. Test daylight saving transitions, month ends (31st), leap days, and scheduled jobs that run twice or not at all on a shift.
- Do not compare timestamps from different machines for ordering; use a sequence or the database clock.

## 5. Scale and limits
- Assume 10,000 rows, not 10: pagination, limits, batch sizes, memory, timeouts. Uploads: size limit, type check, partial upload cleanup.
- Ordering: messages and events can arrive out of order or twice; design handlers that tolerate it.

## 6. Security edges
- Authorization on every object access (a valid user can still request someone else's id). Treat all input as hostile.
