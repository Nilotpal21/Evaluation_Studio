# Agents-Dev Follow-Up Single-Pod Capacity

This file turns the 2026-04-15 `followup_only` run into explicit math inputs for later sizing work.

Source snapshot:

- k6 Cloud run `7281213`
- runtime pinned to `1` replica during measurement
- workload shape: `SINGLE_SESSION=true`, `TURNS=1`, mock LLM, no tools, no KB, no attachments
- Mongo disk assumption reused from [`agents-dev-mongodb-storage.json`](./agents-dev-mongodb-storage.json)
- follow-up per-message logical datastore cost reused from [`local-chat-agent-datastore-baseline.json`](./local-chat-agent-datastore-baseline.json)

## What Is Measured vs Theoretical

Measured:

- `20 VUs` -> `9.66 msg/s`, `p95 1098ms`
- `25 VUs` -> `12.03 msg/s`, `p95 1106ms`
- `30 VUs` -> `14.09 msg/s`, `p95 1376ms`
- `35 VUs` -> `13.55 msg/s`, `p95 2359ms`
- `40 VUs` -> `8.49 msg/s`, `p95 7766ms`, `3.24%` HTTP failures

Derived from the measured run:

- practical smooth single-pod throughput: `12.03 msg/s`
- stricter Mongo-clean point using `< 10ms` write latency: `9.66 msg/s`
- first latency miss against the `1300ms` p95 target: `14.09 msg/s`
- Mongo write-degradation onset by the study rule: `25 VUs` / `12.03 msg/s`

Theoretical proxy only:

- Mongo base disk limit is `500` write IOPS
- observed Mongo write IOPS per successful message was:
  - `5.799` at `20 VUs`
  - `3.490` at `25 VUs`
  - `4.518` as the weighted coefficient across the `20` and `25` VU windows

If Mongo disk write IOPS were the only bottleneck and scaling stayed linear, that weighted coefficient implies:

- `500 / 4.518 = 110.66 msg/s`
- `70%` planning proxy: `77.46 msg/s`
- `80%` planning proxy: `88.53 msg/s`

Do not treat those proxy numbers as committed capacity. This run did not hit Mongo first.

## Why Theoretical Mongo Capacity Is Still Loose

The run shows three different boundaries:

- system smooth limit on one runtime pod: about `12 msg/s`
- Mongo write-latency threshold crossing: also about `12 msg/s`
- runtime saturation cliff: between `25` and `30` VUs, then severe by `35` and `40`

That means:

- the measured run is excellent for the practical question, "what can one runtime pod handle smoothly?"
- the measured run is not sufficient for the absolute question, "what is Mongo's real max msg/s ceiling?"

The reason is simple: runtime CPU and throttling became the first dominant limiter.

Examples from the same run:

- at `30 VUs`, runtime averaged about `0.863` cores and already missed the p95 target
- at `35 VUs`, runtime averaged about `1.34` cores with very heavy throttling
- at `40 VUs`, runtime averaged about `2.60` cores, restarted once, and throughput collapsed

So the best use of this snapshot is:

- use `12.03 msg/s` as the measured smooth throughput for this exact single-pod setup
- use `9.66 msg/s` if you want a stricter number that stays below the `10ms` Mongo write-latency threshold
- use the `77-89 msg/s` band only as a provisional Mongo-only write-IOPS planning proxy

## Logical Datastore Load At The Measured Points

Using the follow-up per-message coefficients from the local baseline:

- `15.73` Mongo reads per message
- `4.13` Mongo writes per message
- `48.4` Redis reads per message
- `84.27` Redis writes per message
- `12.6` Redis scripts per message

That gives:

- at `9.66 msg/s`
  - Mongo: `151.90` reads/s, `39.88` writes/s
  - Redis: `467.39` reads/s, `813.78` writes/s, `121.68` scripts/s
- at `12.03 msg/s`
  - Mongo: `189.28` reads/s, `49.70` writes/s
  - Redis: `582.41` reads/s, `1014.04` writes/s, `151.62` scripts/s
- at `14.09 msg/s`
  - Mongo: `221.67` reads/s, `58.20` writes/s
  - Redis: `682.06` reads/s, `1187.55` writes/s, `177.56` scripts/s

## Recommended Next Step

If the next question is Mongo's real ceiling rather than the runtime pod's ceiling, rerun the same follow-up-only ladder with `2` or `3` runtime pods pinned so Mongo becomes easier to isolate as the first bottleneck.
