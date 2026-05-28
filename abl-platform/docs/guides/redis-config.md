# Redis Configuration Guide

## Required Production Settings

The runtime Redis instance must be configured with a memory eviction policy to
prevent unbounded memory growth. BullMQ keys accumulate without TTL by default.

### Memory Policy

```conf
maxmemory <target>         # e.g. 2gb — set based on available pod memory
maxmemory-policy allkeys-lru
```

Without this, Redis will run with `noeviction` (the default), which rejects all
writes when memory is full and causes runtime failures.

### BullMQ Key TTLs

BullMQ job keys default to permanent retention (`TTL=-1`). The runtime sets
`removeOnComplete: { age: 86400 }` (24h) and `removeOnFail: { age: 604800 }`
(7 days) on all queues. Verify with:

```bash
redis-cli --scan --pattern 'bull:*' | wc -l     # should stay bounded
redis-cli TTL bull:some-queue:completed          # should not be -1
```

## Session TTL Defaults

| Tier           | Default             | Config key              |
| -------------- | ------------------- | ----------------------- |
| Hot (Redis)    | 24 hours (1440 min) | `SESSION_TTL_MINUTES`   |
| Cold (MongoDB) | 90 days             | `SESSION_COLD_TTL_DAYS` |

These values reflect the current defaults in `apps/runtime/src/config/index.ts`.
They can be overridden per-tenant via the tenant configuration API.

## Cold Persist Debounce

`SESSION_COLD_PERSIST_DEBOUNCE_MS` controls how long the runtime waits before
writing a changed session to MongoDB. Default: 2000ms, minimum: 500ms.
Setting it too low causes write amplification (multiple upserts per session per second).
