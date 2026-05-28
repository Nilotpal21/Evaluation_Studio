# Extraction Service Metrics

The Docling extraction service emits structured metrics via log messages that can be parsed by log aggregators (DataDog, Splunk, ELK, etc.) or upgraded to Prometheus later.

## Metric Format

All metrics are logged with the prefix `[METRIC]` followed by the metric name and key-value pairs:

```
[METRIC] <metric_name> key1=value1 key2=value2 ...
```

## Available Metrics

### extraction.route

Emitted when a request is routed to an engine.

**Labels:**

- `content_type` - MIME type of the document
- `engine` - Routing engine (`docling`, `llamaindex`, or `unsupported`)
- `file_size` - File size in bytes
- `filename` - Original filename

**Example:**

```
[METRIC] extraction.route content_type=application/pdf engine=docling file_size=1048576 filename=document.pdf
```

### extraction.success

Emitted when extraction completes successfully.

**Labels:**

- `content_type` - MIME type of the document
- `engine` - Engine that processed the document (`docling` or `llamaindex`)
- `duration_total` - Total processing time in seconds (including I/O)
- `duration_engine` - Engine-only processing time in seconds
- `pages` - Number of pages/chunks extracted
- `tables` - Number of tables detected
- `images` - Number of images detected
- `file_size` - File size in bytes
- `doc_type` - Detected document type

**Example:**

```
[METRIC] extraction.success content_type=application/pdf engine=docling duration_total=2.543 duration_engine=2.401 pages=10 tables=3 images=2 file_size=1048576 doc_type=pdf
```

### extraction.error

Emitted when extraction fails.

**Labels:**

- `content_type` - MIME type of the document
- `engine` - Engine that was processing (`docling`, `llamaindex`, or `unknown`)
- `error_type` - Error classification (`unsupported_format`, `http_error`, or exception class name)
- `status_code` - HTTP status code (for HTTP errors)
- `duration` - Time until failure in seconds

**Example:**

```
[METRIC] extraction.error content_type=application/xyz engine=unsupported error_type=unsupported_format status_code=400 duration=0.012
```

## Parsing Metrics

### Python (regex)

```python
import re

log_line = '[METRIC] extraction.success content_type=application/pdf engine=docling duration_total=2.543 pages=10'
match = re.match(r'\[METRIC\] (\S+) (.+)', log_line)
if match:
    metric_name = match.group(1)  # 'extraction.success'
    labels = dict(re.findall(r'(\w+)=(\S+)', match.group(2)))
    # labels = {'content_type': 'application/pdf', 'engine': 'docling', ...}
```

### DataDog Log Pipeline

```json
{
  "name": "Extract Docling metrics",
  "is_enabled": true,
  "filter": {
    "query": "@message:[METRIC]*"
  },
  "processors": [
    {
      "type": "grok-parser",
      "name": "Parse metric line",
      "is_enabled": true,
      "source": "message",
      "grok": {
        "support_rules": "",
        "match_rules": "\\[METRIC\\] %{notSpace:metric.name} %{data:metric.labels}"
      }
    },
    {
      "type": "key-value-parser",
      "name": "Parse labels",
      "is_enabled": true,
      "source": "metric.labels",
      "target": "metric"
    }
  ]
}
```

### Prometheus (upgrade path)

To upgrade to Prometheus, replace the `logger.info()` metric calls with Prometheus client:

```python
from prometheus_client import Counter, Histogram

extraction_requests = Counter(
    'extraction_requests_total',
    'Total extraction requests',
    ['content_type', 'engine']
)

extraction_duration = Histogram(
    'extraction_duration_seconds',
    'Extraction processing time',
    ['content_type', 'engine']
)

# In code:
extraction_requests.labels(content_type=content_type, engine=engine).inc()
extraction_duration.labels(content_type=content_type, engine=engine).observe(duration)
```

## Monitoring Queries

### DataDog

**Requests per engine:**

```
count:extraction.route{*} by {engine}
```

**Average duration by format:**

```
avg:extraction.success.duration_total{*} by {content_type}
```

**Error rate:**

```
(count:extraction.error{*} / (count:extraction.error{*} + count:extraction.success{*})) * 100
```

**Pages extracted (throughput):**

```
sum:extraction.success.pages{*}
```

### Splunk

**Requests per engine:**

```
index=app [METRIC] extraction.route | stats count by engine
```

**P95 duration by format:**

```
index=app [METRIC] extraction.success | stats perc95(duration_total) by content_type
```

**Top error types:**

```
index=app [METRIC] extraction.error | stats count by error_type | sort -count
```

## Dashboard Recommendations

### Key Metrics to Monitor

1. **Request Volume by Engine**
   - Chart: Time series
   - Metric: `count(extraction.route)` grouped by `engine`
   - Purpose: Track load distribution between Docling and LlamaIndex

2. **Processing Duration (P50, P95, P99)**
   - Chart: Time series with percentiles
   - Metric: `extraction.success.duration_total`
   - Group by: `content_type` and `engine`
   - Purpose: Identify performance issues by format

3. **Error Rate**
   - Chart: Gauge with alert threshold
   - Metric: `(errors / (errors + success)) * 100`
   - Alert: > 5% error rate
   - Purpose: Detect extraction failures

4. **Pages Extracted (Throughput)**
   - Chart: Time series
   - Metric: `sum(extraction.success.pages)`
   - Purpose: Track overall system throughput

5. **Engine Performance Comparison**
   - Chart: Bar chart
   - Metric: `avg(duration_engine)` by `engine`
   - Purpose: Compare Docling vs LlamaIndex performance

6. **Format Distribution**
   - Chart: Pie chart
   - Metric: `count(extraction.route)` by `content_type`
   - Purpose: Understand format usage patterns

## Example Grafana Dashboard

```json
{
  "dashboard": {
    "title": "Docling Extraction Service",
    "panels": [
      {
        "title": "Requests per Engine",
        "targets": [
          {
            "expr": "rate(extraction_requests_total[5m])",
            "legendFormat": "{{engine}}"
          }
        ]
      },
      {
        "title": "P95 Duration by Format",
        "targets": [
          {
            "expr": "histogram_quantile(0.95, rate(extraction_duration_seconds_bucket[5m]))",
            "legendFormat": "{{content_type}} - {{engine}}"
          }
        ]
      },
      {
        "title": "Error Rate",
        "targets": [
          {
            "expr": "rate(extraction_errors_total[5m]) / (rate(extraction_requests_total[5m]) + rate(extraction_errors_total[5m])) * 100"
          }
        ]
      }
    ]
  }
}
```

## Alerting Rules

### High Error Rate

```
Alert when: (extraction.error / (extraction.error + extraction.success)) > 0.05
For: 5 minutes
Severity: WARNING
```

### Slow Processing

```
Alert when: P95(extraction.success.duration_total) > 30s
For: 10 minutes
Severity: WARNING
```

### Engine Unavailable

```
Alert when: count(extraction.error{error_type="ImportError"}) > 0
For: 1 minute
Severity: CRITICAL
```

## Best Practices

1. **Log Aggregation**: Send logs to a centralized system (DataDog, Splunk, CloudWatch)
2. **Retention**: Keep metric logs for at least 30 days for trend analysis
3. **Indexing**: Index the `[METRIC]` prefix for fast querying
4. **Sampling**: For high-volume deployments, consider sampling (e.g., log 10% of successes, 100% of errors)
5. **Correlation**: Include request IDs to correlate metrics with application logs
6. **Cost**: Log-based metrics can be cheaper than Prometheus for low-volume services

## Migration Path to Prometheus

When ready to migrate from log-based metrics to Prometheus:

1. Add `prometheus-client` to `pyproject.toml`
2. Add `/metrics` endpoint to expose Prometheus metrics
3. Keep log-based metrics during transition period
4. Switch monitoring dashboards to Prometheus queries
5. Remove log-based metrics after validation
