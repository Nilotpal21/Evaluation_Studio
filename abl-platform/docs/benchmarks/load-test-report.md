# Load Test Report

> **Tier:** unknown
> **Date:** 2026-03-25T14:44:10.117Z
> **Duration:** N/A
> **Total Requests:** 117799
> **Overall Error Rate:** 0.0%

---

## Summary

Load test completed for **unknown** tier deployment. 12 services were tested over **N/A**.

<span class="pass">PASS</span> **All services within acceptable error thresholds.**

---

## Per-Service Results

| Service                        | Requests | Error Rate | Throughput (req/s) | p50 (ms) | p95 (ms) | p99 (ms) | Max (ms) | Status                         |
| ------------------------------ | -------: | ---------: | -----------------: | -------: | -------: | -------: | -------: | ------------------------------ |
| runtime                        |     3998 |       0.0% |                5.9 |   1155.1 |  15178.1 |  30004.8 |  30004.8 | <span class="pass">PASS</span> |
| channel-message-e2e            |    43784 |       0.0% |               75.1 |     51.2 |    466.9 |    843.8 |   1371.5 | <span class="pass">PASS</span> |
| search-query-integration       |        1 |       0.0% |                0.0 |     55.9 |     55.9 |     55.9 |     55.9 | <span class="pass">PASS</span> |
| kb-ingestion-integration       |      902 |       0.0% |                0.7 |     37.1 |     48.1 |     56.6 |    252.9 | <span class="pass">PASS</span> |
| multi-agent-orchestration      |     7017 |       0.0% |                9.6 |     38.1 |     80.6 |    383.0 |    779.4 | <span class="pass">PASS</span> |
| agent-conversation-integration |    31054 |       0.0% |               31.9 |     39.2 |    105.5 |    430.1 |   2297.2 | <span class="pass">PASS</span> |
| crawler-service                |      184 |       0.0% |                0.5 |     39.4 |     53.9 |    166.8 |    206.4 | <span class="pass">PASS</span> |
| search-ai-runtime-per-service  |      347 |       0.0% |                0.5 |     42.5 |     49.7 |     56.5 |     86.8 | <span class="pass">PASS</span> |
| search-ai-per-service          |      869 |       0.0% |                2.0 |     35.6 |     46.8 |     58.4 |    365.8 | <span class="pass">PASS</span> |
| studio                         |    22990 |       0.0% |               34.2 |     32.1 |    671.7 |   3788.3 |  14552.0 | <span class="pass">PASS</span> |
| runtime-per-service            |     6651 |       0.0% |                9.9 |    198.7 |   5832.7 |   7766.0 |  30001.1 | <span class="pass">PASS</span> |
| bge-m3-per-service             |        2 |       0.0% |                0.3 |    232.4 |    418.9 |    435.4 |    439.6 | <span class="pass">PASS</span> |

---

## Per-Service Detail

### runtime

**Total requests:** 3998 | **Errors:** 0.0% | **Throughput:** 5.9 req/s

#### Latency Distribution

| Percentile | Value (ms) |
| ---------- | ---------: |
| min        |       37.0 |
| p50        |     1155.1 |
| p95        |    15178.1 |
| p99        |    30004.8 |
| max        |    30004.8 |

### channel-message-e2e

**Total requests:** 43784 | **Errors:** 0.0% | **Throughput:** 75.1 req/s

#### Latency Distribution

| Percentile | Value (ms) |
| ---------- | ---------: |
| min        |       23.6 |
| p50        |       51.2 |
| p95        |      466.9 |
| p99        |      843.8 |
| max        |     1371.5 |

### search-query-integration

**Total requests:** 1 | **Errors:** 0.0% | **Throughput:** 0.0 req/s

#### Latency Distribution

| Percentile | Value (ms) |
| ---------- | ---------: |
| min        |       55.9 |
| p50        |       55.9 |
| p95        |       55.9 |
| p99        |       55.9 |
| max        |       55.9 |

### kb-ingestion-integration

**Total requests:** 902 | **Errors:** 0.0% | **Throughput:** 0.7 req/s

#### Latency Distribution

| Percentile | Value (ms) |
| ---------- | ---------: |
| min        |       27.8 |
| p50        |       37.1 |
| p95        |       48.1 |
| p99        |       56.6 |
| max        |      252.9 |

### multi-agent-orchestration

**Total requests:** 7017 | **Errors:** 0.0% | **Throughput:** 9.6 req/s

#### Latency Distribution

| Percentile | Value (ms) |
| ---------- | ---------: |
| min        |       23.8 |
| p50        |       38.1 |
| p95        |       80.6 |
| p99        |      383.0 |
| max        |      779.4 |

### agent-conversation-integration

**Total requests:** 31054 | **Errors:** 0.0% | **Throughput:** 31.9 req/s

#### Latency Distribution

| Percentile | Value (ms) |
| ---------- | ---------: |
| min        |       24.6 |
| p50        |       39.2 |
| p95        |      105.5 |
| p99        |      430.1 |
| max        |     2297.2 |

### crawler-service

**Total requests:** 184 | **Errors:** 0.0% | **Throughput:** 0.5 req/s

#### Latency Distribution

| Percentile | Value (ms) |
| ---------- | ---------: |
| min        |       33.6 |
| p50        |       39.4 |
| p95        |       53.9 |
| p99        |      166.8 |
| max        |      206.4 |

### search-ai-runtime-per-service

**Total requests:** 347 | **Errors:** 0.0% | **Throughput:** 0.5 req/s

#### Latency Distribution

| Percentile | Value (ms) |
| ---------- | ---------: |
| min        |       33.3 |
| p50        |       42.5 |
| p95        |       49.7 |
| p99        |       56.5 |
| max        |       86.8 |

### search-ai-per-service

**Total requests:** 869 | **Errors:** 0.0% | **Throughput:** 2.0 req/s

#### Latency Distribution

| Percentile | Value (ms) |
| ---------- | ---------: |
| min        |       27.2 |
| p50        |       35.6 |
| p95        |       46.8 |
| p99        |       58.4 |
| max        |      365.8 |

### studio

**Total requests:** 22990 | **Errors:** 0.0% | **Throughput:** 34.2 req/s

#### Latency Distribution

| Percentile | Value (ms) |
| ---------- | ---------: |
| min        |       22.0 |
| p50        |       32.1 |
| p95        |      671.7 |
| p99        |     3788.3 |
| max        |    14552.0 |

### runtime-per-service

**Total requests:** 6651 | **Errors:** 0.0% | **Throughput:** 9.9 req/s

#### Latency Distribution

| Percentile | Value (ms) |
| ---------- | ---------: |
| min        |       23.8 |
| p50        |      198.7 |
| p95        |     5832.7 |
| p99        |     7766.0 |
| max        |    30001.1 |

### bge-m3-per-service

**Total requests:** 2 | **Errors:** 0.0% | **Throughput:** 0.3 req/s

#### Latency Distribution

| Percentile | Value (ms) |
| ---------- | ---------: |
| min        |       25.2 |
| p50        |      232.4 |
| p95        |      418.9 |
| p99        |      435.4 |
| max        |      439.6 |

---

## SLA Compliance

> No SLA targets defined.

---

_Generated 2026-03-25T14:44:10.117Z_
