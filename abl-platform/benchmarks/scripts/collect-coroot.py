#!/usr/bin/env python3
"""
collect-coroot.py — Fetch Coroot metrics for a time window and write structured JSON.

Called by cluster-poll.sh every poll cycle to add observability data alongside
kubectl metrics. Reads environment config from the MCP server's environments.json.

Usage:
    python3 benchmarks/scripts/collect-coroot.py \
        --env qa \
        --from-ms 1778056000000 \
        --to-ms 1778058000000 \
        --output /tmp/coroot-poll.json

    # Or use relative time (seconds before now):
    python3 benchmarks/scripts/collect-coroot.py \
        --env qa \
        --lookback 300 \
        --output /tmp/coroot-poll.json

Output JSON:
    {
      "timestamp": "2026-05-06T09:00:00Z",
      "environment": "qa",
      "timeWindow": { "fromMs": ..., "toMs": ... },
      "runtime": { "cpu": {...}, "nodejs": {...}, "memory": {...} },
      "mongodb": { "cpu": {...}, "storage": {...}, "database": {...} },
      "redis":   { "cpu": {...}, "database": {...} },
      "clickhouse": { "cpu": {...}, "storage": {...} },
      "errors": [...]
    }
"""

import argparse
import http.cookiejar
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

ENVS_PATHS = [
    os.path.expanduser("~/mcp-servers/mcp-coroot/environments.json"),
    os.path.join(os.path.dirname(__file__), "..", "config", "coroot-environments.json"),
]

# App catalog — must match MCP server's catalog.ts
APP_CATALOG = {
    "runtime":    {"kind": "Deployment",       "deploy": "runtime"},
    "mongodb":    {"kind": "StatefulSet",      "deploy": "mongodb"},
    "redis":      {"kind": "DatabaseCluster",  "deploy": "redis"},
    "clickhouse": {"kind": "StatefulSet",      "deploy": "clickhouse-shard-0"},
}

# Reports to extract per service
SERVICE_REPORTS = {
    "runtime":    ["CPU", "Node.js", "Memory"],
    "mongodb":    ["CPU", "Storage"],
    "redis":      ["CPU"],
    "clickhouse": ["CPU", "Storage"],
}

API_TIMEOUT = 10  # seconds per request

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def load_env_config(env: str) -> dict:
    for path in ENVS_PATHS:
        if os.path.exists(path):
            with open(path) as f:
                envs = json.load(f)
            if env in envs:
                return envs[env]
    raise RuntimeError(
        f"Environment '{env}' not found. Checked: {ENVS_PATHS}. "
        f"Copy environments.json from mcp-coroot or create benchmarks/config/coroot-environments.json"
    )


def coroot_login(base_url: str, username: str, password: str):
    """Login and return (opener_with_cookies, session_token)."""
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    data = json.dumps({"email": username, "password": password}).encode()
    req = urllib.request.Request(
        f"{base_url}/api/login",
        data=data,
        headers={"Content-Type": "application/json"},
    )
    resp = opener.open(req, timeout=API_TIMEOUT)
    if resp.status != 200:
        raise RuntimeError(f"Coroot login failed: HTTP {resp.status}")
    session = None
    for c in jar:
        if c.name == "coroot_session":
            session = c.value
    if not session:
        raise RuntimeError("Coroot login succeeded but no coroot_session cookie returned")
    return opener, session


def build_app_id(project_id: str, namespace: str, short_name: str) -> str:
    entry = APP_CATALOG.get(short_name)
    if not entry:
        raise ValueError(f"Unknown service: {short_name}")
    return f"{project_id}:{namespace}:{entry['kind']}:{namespace}-{entry['deploy']}"


def fetch_app(opener, base_url: str, project_id: str, app_id: str, from_ms: int, to_ms: int) -> dict:
    encoded = urllib.parse.quote(app_id, safe="")
    url = f"{base_url}/api/project/{project_id}/app/{encoded}?from={from_ms}&to={to_ms}"
    req = urllib.request.Request(url)
    resp = opener.open(req, timeout=API_TIMEOUT)
    return json.loads(resp.read().decode())


# ---------------------------------------------------------------------------
# Extractors — pull structured metrics from Coroot's raw report JSON
# ---------------------------------------------------------------------------

def window_stats(series_list: list, from_ms: int, to_ms: int, ctx: dict, min_avg: float = 0.0) -> list:
    """Compute per-series avg/max within the time window."""
    fr = ctx.get("from", 0)
    step = ctx.get("step", 15000)
    results = []
    for s in series_list:
        name = s.get("name", "")
        data = s.get("data", [])
        vals = [
            v for i, v in enumerate(data)
            if v is not None and from_ms <= fr + i * step <= to_ms
        ]
        if vals:
            avg = sum(vals) / len(vals)
            if avg >= min_avg:
                results.append({"name": name, "avg": round(avg, 4), "max": round(max(vals), 4), "n": len(vals)})
    return sorted(results, key=lambda x: -x["avg"])


def find_chart_group(reports: list, report_name: str, widget_idx: int):
    """Get chart_group widget by report name and index. Return 'total' chart."""
    for r in reports:
        if r.get("name") == report_name:
            widgets = r.get("widgets") or []
            if widget_idx < len(widgets):
                cg = widgets[widget_idx].get("chart_group") or {}
                charts = cg.get("charts", [])
                # Prefer "total" chart
                for ch in charts:
                    if ch.get("title", "").lower() == "total":
                        return ch
                return charts[-1] if charts else None
    return None


def find_chart(reports: list, report_name: str, title_substr: str):
    """Find a direct chart widget by report name and title substring."""
    for r in reports:
        if r.get("name") == report_name:
            for w in r.get("widgets") or []:
                ch = w.get("chart")
                if ch and title_substr.lower() in ch.get("title", "").lower():
                    return ch
    return None


def extract_cpu(reports: list, from_ms: int, to_ms: int) -> dict:
    """Extract CPU usage, delay, throttle from CPU report."""
    result = {}
    labels = {0: "usage", 1: "delay", 2: "throttle"}
    for idx, key in labels.items():
        chart = find_chart_group(reports, "CPU", idx)
        if chart:
            ctx = chart.get("ctx", {})
            stats = window_stats(chart.get("series", []), from_ms, to_ms, ctx)
            total = sum(s["avg"] for s in stats)
            peak = max((s["max"] for s in stats), default=0)
            result[key] = {
                "avg": round(total, 4),
                "peak": round(peak, 4),
                "perPod": stats,
            }
            if key == "usage":
                # Convert cores to millicores for consistency with kubectl
                result[f"{key}AvgMilli"] = round(total * 1000)
                result[f"{key}PeakMilli"] = round(peak * 1000)
    return result


def extract_nodejs(reports: list, from_ms: int, to_ms: int) -> dict:
    """Extract event loop blocked time from Node.js report."""
    chart = find_chart(reports, "Node.js", "event loop")
    if not chart:
        return {"available": False}
    ctx = chart.get("ctx", {})
    stats = window_stats(chart.get("series", []), from_ms, to_ms, ctx, min_avg=0.0001)
    if not stats:
        return {"available": True, "eventLoopBlockedAvg": 0, "eventLoopBlockedPeak": 0, "perPod": []}
    avg = sum(s["avg"] for s in stats) / len(stats)
    peak = max(s["max"] for s in stats)
    return {
        "available": True,
        "eventLoopBlockedAvg": round(avg, 4),
        "eventLoopBlockedPeak": round(peak, 4),
        "eventLoopBlockedAvgMs": round(avg * 1000, 1),
        "eventLoopBlockedPeakMs": round(peak * 1000, 1),
        "perPod": stats,
    }


def extract_memory(reports: list, from_ms: int, to_ms: int) -> dict:
    """Extract RSS from Memory report."""
    # Memory widget 0 is usually RSS chart_group
    chart = find_chart_group(reports, "Memory", 0)
    if not chart:
        return {"available": False}
    ctx = chart.get("ctx", {})
    stats = window_stats(chart.get("series", []), from_ms, to_ms, ctx)
    if not stats:
        return {"available": True, "rssAvgBytes": 0, "rssPeakBytes": 0}
    total_avg = sum(s["avg"] for s in stats)
    total_peak = max(s["max"] for s in stats)
    return {
        "available": True,
        "rssAvgBytes": round(total_avg),
        "rssPeakBytes": round(total_peak),
        "rssAvgMi": round(total_avg / (1024 * 1024)),
        "rssPeakMi": round(total_peak / (1024 * 1024)),
        "perPod": stats,
    }


def extract_storage(reports: list, from_ms: int, to_ms: int) -> dict:
    """Extract IOPS, latency, utilization from Storage report.

    Storage widget ordering (verified):
      0: chart — disk space
      1: chart_group — I/O utilization per volume
      2: chart_group — I/O latency per volume
      3: chart_group — IOPS per volume (read/write series)
      4: chart_group — bandwidth per volume (read/write series)
      5: chart_group — I/O load per volume
      6: chart_group — disk space per volume
    """
    result = {"available": False}

    for r in reports:
        if r.get("name") != "Storage":
            continue
        widgets = r.get("widgets") or []
        if len(widgets) < 4:
            return result
        result["available"] = True

        # Widget 1: IO utilization
        cg = widgets[1].get("chart_group", {})
        for chart in cg.get("charts", []):
            if "/data" in chart.get("title", "").lower() or chart.get("title", "").startswith("/data"):
                ctx = chart.get("ctx", {})
                stats = window_stats(chart.get("series", []), from_ms, to_ms, ctx)
                if stats:
                    result["ioUtilizationAvg"] = round(stats[0]["avg"] * 100, 1)  # percent
                    result["ioUtilizationPeak"] = round(stats[0]["max"] * 100, 1)
                break

        # Widget 2: IO latency per volume (series are per-pod, NOT read/write)
        cg = widgets[2].get("chart_group", {}) if len(widgets) > 2 else {}
        for chart in cg.get("charts", []):
            title = chart.get("title", "")
            if "/data" in title.lower() or title.startswith("/data"):
                ctx = chart.get("ctx", {})
                all_series = chart.get("series", [])
                # Aggregate across all pods for this volume
                all_vals = []
                for s in all_series:
                    vals = [v for v in s.get("data", []) if v is not None]
                    all_vals.extend(vals)
                if all_vals:
                    result["ioLatencyAvgMs"] = round(sum(all_vals) / len(all_vals) * 1000, 2)
                    result["ioLatencyPeakMs"] = round(max(all_vals) * 1000, 2)
                break

        # Widget 3: IOPS
        cg = widgets[3].get("chart_group", {}) if len(widgets) > 3 else {}
        for chart in cg.get("charts", []):
            if "/data" in chart.get("title", "").lower() or chart.get("title", "").startswith("/data"):
                ctx = chart.get("ctx", {})
                all_series = chart.get("series", [])
                for s in all_series:
                    name = s.get("name", "").lower()
                    vals = [v for v in s.get("data", []) if v is not None]
                    if not vals:
                        continue
                    avg_val = sum(vals) / len(vals)
                    peak_val = max(vals)
                    if "write" in name:
                        result["iopsWriteAvg"] = round(avg_val, 1)
                        result["iopsWritePeak"] = round(peak_val, 1)
                    elif "read" in name:
                        result["iopsReadAvg"] = round(avg_val, 1)
                        result["iopsReadPeak"] = round(peak_val, 1)
                break

        # Widget 5: IO load
        cg = widgets[5].get("chart_group", {}) if len(widgets) > 5 else {}
        for chart in cg.get("charts", []):
            if "/data" in chart.get("title", "").lower() or chart.get("title", "").startswith("/data"):
                ctx = chart.get("ctx", {})
                stats = window_stats(chart.get("series", []), from_ms, to_ms, ctx)
                if stats:
                    result["ioLoadAvg"] = round(stats[0]["avg"] * 1000, 1)  # ms/s
                    result["ioLoadPeak"] = round(stats[0]["max"] * 1000, 1)
                break

        break

    return result


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def collect_service(opener, base_url, project_id, namespace, service, from_ms, to_ms):
    """Fetch + extract metrics for one service. Returns (service_name, data_dict)."""
    try:
        app_id = build_app_id(project_id, namespace, service)
        raw = fetch_app(opener, base_url, project_id, app_id, from_ms, to_ms)
        reports = raw.get("data", {}).get("reports", [])

        result = {"appId": app_id, "reportsAvailable": [r.get("name") for r in reports]}

        needed = SERVICE_REPORTS.get(service, [])
        if "CPU" in needed:
            result["cpu"] = extract_cpu(reports, from_ms, to_ms)
        if "Node.js" in needed:
            result["nodejs"] = extract_nodejs(reports, from_ms, to_ms)
        if "Memory" in needed:
            result["memory"] = extract_memory(reports, from_ms, to_ms)
        if "Storage" in needed:
            result["storage"] = extract_storage(reports, from_ms, to_ms)

        return service, result
    except Exception as e:
        return service, {"error": str(e)}


def main():
    parser = argparse.ArgumentParser(description="Collect Coroot metrics for cluster-poll")
    parser.add_argument("--env", required=True, help="Environment: dev, qa, staging")
    parser.add_argument("--from-ms", type=int, help="Start time (epoch ms)")
    parser.add_argument("--to-ms", type=int, help="End time (epoch ms)")
    parser.add_argument("--lookback", type=int, default=300, help="Seconds before now (if --from-ms not set)")
    parser.add_argument("--output", required=True, help="Output JSON file path")
    parser.add_argument("--services", default="runtime,mongodb,redis,clickhouse",
                        help="Comma-separated services to collect")
    args = parser.parse_args()

    # Resolve time window
    now_ms = int(time.time() * 1000)
    to_ms = args.to_ms or now_ms
    from_ms = args.from_ms or (now_ms - args.lookback * 1000)

    services = [s.strip() for s in args.services.split(",") if s.strip()]

    try:
        cfg = load_env_config(args.env)
    except RuntimeError as e:
        output = {
            "error": str(e),
            "environment": args.env,
            "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }
        with open(args.output, "w") as f:
            json.dump(output, f, indent=2)
        print(f"WARN: {e}", file=sys.stderr)
        return

    base_url = cfg["baseUrl"]
    project_id = cfg["projectId"]
    namespace = cfg["namespace"]

    # Login
    try:
        opener, session = coroot_login(base_url, cfg["username"], cfg["password"])
    except Exception as e:
        output = {
            "error": f"Coroot login failed: {e}",
            "environment": args.env,
            "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }
        with open(args.output, "w") as f:
            json.dump(output, f, indent=2)
        print(f"WARN: Coroot login failed: {e}", file=sys.stderr)
        return

    # Fetch all services in parallel
    results = {}
    errors = []
    with ThreadPoolExecutor(max_workers=len(services)) as pool:
        futures = {
            pool.submit(collect_service, opener, base_url, project_id, namespace, svc, from_ms, to_ms): svc
            for svc in services
        }
        for future in as_completed(futures):
            svc = futures[future]
            try:
                name, data = future.result()
                results[name] = data
            except Exception as e:
                errors.append({"service": svc, "error": str(e)})

    output = {
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "environment": args.env,
        "timeWindow": {"fromMs": from_ms, "toMs": to_ms},
        **results,
        "errors": errors,
    }

    with open(args.output, "w") as f:
        json.dump(output, f, indent=2)

    # One-liner summary
    parts = []
    for svc in services:
        d = results.get(svc, {})
        if "error" in d:
            parts.append(f"{svc}=ERR")
            continue
        cpu = d.get("cpu", {})
        usage = cpu.get("usageAvgMilli", cpu.get("usage", {}).get("avg", "?"))
        parts.append(f"{svc}:cpu={usage}m")
        if "storage" in d and d["storage"].get("available"):
            iops = d["storage"].get("iopsWriteAvg", "?")
            parts.append(f"iops={iops}")
        if "nodejs" in d and d["nodejs"].get("available"):
            el = d["nodejs"].get("eventLoopBlockedAvgMs", "?")
            parts.append(f"el={el}ms")
    print(" | ".join(parts))


if __name__ == "__main__":
    main()
