# Distributed Architecture & Eventual Consistency

## 1. The network is not reliable
- Every network call (database, third-party API, internal service) needs a timeout, a bounded retry policy (exponential backoff with jitter), and a fallback or circuit breaker.
- Retry only idempotent operations, or operations carrying an idempotency key. Retrying everything multiplies an outage.

## 2. Messages are at-least-once
- Brokers and queues (Kafka, RabbitMQ, SQS) deliver a message more than once and sometimes out of order. Consumers must be idempotent: keep a processed-id table or make the write naturally repeatable.
- Dead-letter failed messages after a few attempts and alert on them; do not retry forever.
- Writing to the database and publishing an event must not be two independent steps: use the outbox pattern (write the event in the same transaction, a relay publishes it).

## 3. Cross-service transactions
- Avoid distributed two-phase commit. Use a saga: each step has a compensating action (refund, release stock), and the state of the saga is stored so it can resume after a crash.
- Define what the user sees while a saga is pending or has failed.

## 4. Eventual consistency
- Read replicas, caches and downstream services lag. Do not read your own write from a replica right after writing; do not assume a cache is fresh.
- Design the UI for it: optimistic updates with rollback, "processing" states, polling or push updates.

## 5. Operate it
- Correlation ids through every service and log line; structured logs; metrics on queue depth, retries and latency.
- Keep service contracts versioned and backward compatible; deploy consumers before producers when adding fields.
