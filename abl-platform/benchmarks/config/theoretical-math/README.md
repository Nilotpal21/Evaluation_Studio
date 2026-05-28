# Theoretical Math Inputs

This folder stores fixed infrastructure assumptions that we want to reuse in later benchmark math, capacity estimates, and saturation back-of-the-envelope calculations.

Current inputs:

- `agents-dev-clickhouse-storage.json`: Live ClickHouse storage and topology profile captured on 2026-04-15 for the `agents-dev` / `abl-platform-dev` environment.
- `agents-dev-redis-storage.json`: Live Redis storage and topology profile captured on 2026-04-15 for the `agents-dev` / `abl-platform-dev` environment.
- `agents-dev-mongodb-storage.json`: Live Mongo storage profile captured on 2026-04-15 for the `agents-dev` / `abl-platform-dev` environment.
- `agents-dev-followup-single-pod-capacity.json`: Measured single-runtime-pod follow-up-only capacity snapshot from run `7281213`, plus derived Mongo write-IOPS proxy math for later planning.
- `agents-dev-followup-single-pod-capacity.md`: Human-readable explanation of what was measured versus what remains only a theoretical Mongo proxy from the same run.
- `local-chat-agent-datastore-baseline.json`: Empirical local `/api/v1/chat/agent` datastore baseline captured on 2026-04-15 for theoretical query-per-turn math.
- `local-chat-agent-datastore-baseline.md`: Human-readable explanation of what one measured local `/api/v1/chat/agent` session actually contained.
- `local-chat-agent-datastore-breakdown.json`: Machine-readable detailed attribution for local `/api/v1/chat/agent`, including command mixes, Mongo namespaces, BullMQ paths, and code anchors.
- `local-chat-agent-latency-breakdown.json`: Machine-readable local `/api/v1/chat/agent` latency timeline, including per-turn trace timestamps and derived phase timings.
- `local-chat-agent-latency-breakdown.md`: Human-readable explanation of where local `/api/v1/chat/agent` time was spent for the same `1 + 15` session shape.

What is recorded:

- Kubernetes requested capacity per PVC
- Azure managed disk SKU
- Effective Azure performance tier used for math
- Per-disk throughput and IOPS limits
- Replica count and total cluster-level capacity
- Current observed usage when the data was captured
- Measured single-pod follow-up throughput and latency windows from k6/Coroot
- Derived practical capacity points such as smooth throughput, first p95 miss, and Mongo write-latency threshold crossing
- Mongo write-IOPS-per-message coefficients and loose disk-limit projections when Mongo is not yet the proven first bottleneck
- Local request-shape datastore cost for `/api/v1/chat/agent`
- First-turn versus steady-state follow-up Mongo and Redis operations per turn
- Simple per-turn formulas for turning TPS assumptions into datastore QPS assumptions
- Local request-shape latency for `/api/v1/chat/agent`
- First-turn versus steady-state follow-up timing splits such as pre-LLM overhead, LLM duration, and response tail

Important:

- For Standard SSD-backed disks, theoretical performance math should use the Azure E-series tier, not just the raw requested PVC size. Examples in this folder: `8Gi -> E2`, `10Gi -> E3`, `20Gi -> E4`, `50Gi -> E6`, `100Gi -> E10`.
- Treat this folder as a snapshot. If infra changes, update the JSON with a new capture date before reusing the numbers.
