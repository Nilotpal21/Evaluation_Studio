#!/usr/bin/env bash
# collect-datastore-ops.sh — Scrape per-turn datastore ops from live cluster.
#
# Takes two snapshots N seconds apart and computes delta rates.
# Outputs JSON with per-turn MongoDB/Redis/ClickHouse operation counts.
#
# Usage:
#   ENV=qa SAMPLE_SECONDS=60 TURNS=<expected-turns-in-window> \
#     ./benchmarks/scripts/collect-datastore-ops.sh
#
# Or during a saturation run:
#   ENV=qa SAMPLE_SECONDS=120 ./benchmarks/scripts/collect-datastore-ops.sh
#
# Output: benchmarks/results/datastore-ops-<timestamp>.json

set -euo pipefail

ENV="${ENV:-qa}"
SAMPLE_SECONDS="${SAMPLE_SECONDS:-60}"
CONTEXT="aks-abl-${ENV}-centralus"
NS="abl-platform-${ENV}"
OUT_DIR="benchmarks/results"
TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="${OUT_DIR}/datastore-ops-${TIMESTAMP}.json"

mkdir -p "$OUT_DIR"

echo "[collect] Environment: $ENV, sample window: ${SAMPLE_SECONDS}s"

# ── Secrets ──────────────────────────────────────────────────────────────────
MONGO_CONN=$(kubectl --context "$CONTEXT" -n "$NS" get secret "${NS}-mongodb-admin-root" \
  -o jsonpath='{.data.connectionString\.standard}' | base64 -d)
# Extract just user:pass for localhost connection
MONGO_USER=$(echo "$MONGO_CONN" | sed -n 's|mongodb://\([^:]*\):.*|\1|p')
MONGO_PASS=$(echo "$MONGO_CONN" | sed -n 's|mongodb://[^:]*:\([^@]*\)@.*|\1|p')
MONGO_POD="${NS}-mongodb-0"

REDIS_PASS=$(kubectl --context "$CONTEXT" -n "$NS" get secret "${NS}-redis-auth" \
  -o jsonpath='{.data.redis-password}' | base64 -d)
REDIS_POD="${NS}-redis-master-0"

CH_POD="${NS}-clickhouse-shard-0-0"

# ── Helper: MongoDB opcounters ───────────────────────────────────────────────
mongo_opcounters() {
  kubectl --context "$CONTEXT" -n "$NS" exec "$MONGO_POD" -c mongod -- \
    mongosh --quiet --norc \
    "mongodb://${MONGO_USER}:${MONGO_PASS}@localhost:27017/admin" \
    --eval '
var ss = db.adminCommand({serverStatus:1});
var o = ss.opcounters;
var wt = ss.wiredTiger;
function n(v) { return typeof v === "object" && v !== null && "low" in v ? Number(v) : (v || 0); }
print(JSON.stringify({
  insert: n(o.insert), update: n(o.update), delete: n(o.delete),
  query: n(o.query), getmore: n(o.getmore), command: n(o.command),
  pagesWritten: n(wt.cache["pages written from cache"]),
  pagesRead: n(wt.cache["pages read into cache"]),
  dirtyBytes: n(wt.cache["tracked dirty bytes in the cache"]),
  checkpoints: n(wt.transaction["transaction checkpoints"]),
  connections: n(ss.connections.current),
  epoch: Date.now()
}));
' 2>/dev/null | grep -v "Warning\|EACCES"
}

# ── Helper: MongoDB collection-level write profile ───────────────────────────
mongo_profile_writes() {
  local duration="$1"
  kubectl --context "$CONTEXT" -n "$NS" exec "$MONGO_POD" -c mongod -- \
    mongosh --quiet --norc \
    "mongodb://${MONGO_USER}:${MONGO_PASS}@localhost:27017/admin" \
    --eval "
db = db.getSiblingDB('abl-platform');
db.system.profile.drop();
db.createCollection('system.profile', {capped: true, size: 10485760});
db.setProfilingLevel(2, {slowms: 0});
sleep(${duration}000);
db.setProfilingLevel(0);

var ops = db.system.profile.find({ns: /abl-platform\./}).toArray();
var groups = {};
ops.forEach(function(o) {
  var coll = o.ns.replace('abl-platform.','');
  var op = o.op;
  var key = op + ':' + coll;
  if (!groups[key]) groups[key] = {op:op, collection:coll, count:0, matched:0, modified:0, deleted:0, inserted:0, totalMs:0};
  groups[key].count++;
  groups[key].matched += (o.nMatched || 0);
  groups[key].modified += (o.nModified || 0);
  groups[key].deleted += (o.ndeleted || 0);
  groups[key].inserted += (o.ninserted || 0);
  groups[key].totalMs += (o.millis || 0);
});
print(JSON.stringify({duration: ${duration}, totalOps: ops.length, groups: Object.values(groups)}));
" 2>/dev/null | grep -v "Warning\|EACCES" | tail -1
}

# ── Helper: MongoDB index counts ─────────────────────────────────────────────
mongo_index_counts() {
  kubectl --context "$CONTEXT" -n "$NS" exec "$MONGO_POD" -c mongod -- \
    mongosh --quiet --norc \
    "mongodb://${MONGO_USER}:${MONGO_PASS}@localhost:27017/abl-platform?authSource=admin" \
    --eval '
var colls = ["sessions","session_states","messages","human_tasks","dek_registry","refresh_tokens","audit_logs"];
var result = {};
colls.forEach(function(c) {
  try { result[c] = db.getCollection(c).getIndexes().length; }
  catch(e) { result[c] = -1; }
});
print(JSON.stringify(result));
' 2>/dev/null | grep -v "Warning\|EACCES" | tail -1
}

# ── Helper: Redis commandstats ───────────────────────────────────────────────
redis_commandstats() {
  kubectl --context "$CONTEXT" -n "$NS" exec "$REDIS_POD" -- \
    redis-cli -a "$REDIS_PASS" INFO commandstats 2>/dev/null | \
    grep "^cmdstat_" | while IFS= read -r line; do
      cmd=$(echo "$line" | sed 's/cmdstat_\([^:]*\):.*/\1/')
      calls=$(echo "$line" | sed 's/.*calls=\([0-9]*\).*/\1/')
      usec=$(echo "$line" | sed 's/.*usec=\([0-9]*\),.*/\1/')
      echo "{\"cmd\":\"$cmd\",\"calls\":$calls,\"usec\":$usec}"
    done | python3 -c "
import json,sys
items = [json.loads(l) for l in sys.stdin]
print(json.dumps({i['cmd']: {'calls': i['calls'], 'usec': i['usec']} for i in items}))
"
}

# ── Helper: ClickHouse insert stats ──────────────────────────────────────────
clickhouse_stats() {
  kubectl --context "$CONTEXT" -n "$NS" exec "$CH_POD" -c clickhouse -- \
    clickhouse-client --query "
SELECT
    tables[1] as tbl,
    count() as cnt,
    sum(written_rows) as rows,
    sum(written_bytes) as bytes
FROM system.query_log
WHERE event_date = today()
    AND event_time > now() - INTERVAL ${SAMPLE_SECONDS} SECOND
    AND query_kind IN ('Insert', 'AsyncInsertFlush')
    AND type = 'QueryFinish'
GROUP BY tbl
FORMAT JSONEachRow
" 2>/dev/null
}

# ══════════════════════════════════════════════════════════════════════════════
# MAIN
# ══════════════════════════════════════════════════════════════════════════════

echo "[collect] Snapshot 1: MongoDB opcounters + Redis commandstats"
MONGO_S1=$(mongo_opcounters)
REDIS_S1=$(redis_commandstats)

echo "[collect] Profiling MongoDB writes for ${SAMPLE_SECONDS}s..."
MONGO_PROFILE=$(mongo_profile_writes "$SAMPLE_SECONDS")

echo "[collect] Snapshot 2: MongoDB opcounters + Redis commandstats"
MONGO_S2=$(mongo_opcounters)
REDIS_S2=$(redis_commandstats)

echo "[collect] Fetching MongoDB index counts..."
MONGO_INDEXES=$(mongo_index_counts)

echo "[collect] Fetching ClickHouse insert stats..."
CH_STATS=$(clickhouse_stats)

echo "[collect] Computing deltas..."

python3 -c "
import json, sys

sample_s = ${SAMPLE_SECONDS}

# MongoDB opcounter deltas
s1 = json.loads('''${MONGO_S1}''')
s2 = json.loads('''${MONGO_S2}''')

mongo_delta = {}
for k in ['insert','update','delete','query','getmore','command','pagesWritten','pagesRead','checkpoints']:
    mongo_delta[k] = s2[k] - s1[k]
    mongo_delta[k + '_per_sec'] = round(mongo_delta[k] / sample_s, 2)

# MongoDB profile (collection-level writes)
profile = json.loads('''${MONGO_PROFILE}''')

# MongoDB index counts
indexes = json.loads('''${MONGO_INDEXES}''')

# Redis deltas
r1 = json.loads('''${REDIS_S1}''')
r2 = json.loads('''${REDIS_S2}''')

redis_delta = {}
total_redis_calls = 0
for cmd in set(list(r1.keys()) + list(r2.keys())):
    c1 = r1.get(cmd, {}).get('calls', 0)
    c2 = r2.get(cmd, {}).get('calls', 0)
    delta = c2 - c1
    if delta > 0:
        redis_delta[cmd] = {'calls': delta, 'per_sec': round(delta / sample_s, 2)}
        total_redis_calls += delta

# ClickHouse
ch_lines = '''${CH_STATS}'''.strip().split('\n')
ch_tables = []
for line in ch_lines:
    if line.strip():
        try:
            ch_tables.append(json.loads(line))
        except:
            pass

# Compute dirty pages per write (index amplification)
dirty_pages_per_write = {}
for g in profile.get('groups', []):
    coll = g['collection']
    op = g['op']
    if op in ('update', 'insert', 'remove'):
        idx_count = indexes.get(coll, 1)
        g['indexes'] = idx_count
        g['dirty_pages_per_op'] = 1 + idx_count
        g['total_dirty_pages'] = g['count'] * (1 + idx_count)
        dirty_pages_per_write[f'{op}:{coll}'] = g

# Summary
total_mongo_writes = sum(g['count'] for g in profile.get('groups', []) if g['op'] in ('update','insert','remove'))
total_dirty_pages = sum(g.get('total_dirty_pages', 0) for g in profile.get('groups', []) if g['op'] in ('update','insert','remove'))

result = {
    'timestamp': '${TIMESTAMP}',
    'environment': '${ENV}',
    'sampleSeconds': sample_s,
    'mongoOpcounterDelta': mongo_delta,
    'mongoProfiledWrites': {
        'durationSeconds': profile.get('duration', sample_s),
        'totalOps': profile.get('totalOps', 0),
        'totalWrites': total_mongo_writes,
        'totalDirtyPages': total_dirty_pages,
        'writesPerSec': round(total_mongo_writes / sample_s, 2),
        'dirtyPagesPerSec': round(total_dirty_pages / sample_s, 2),
        'byCollection': sorted(profile.get('groups', []), key=lambda x: -x['count'])
    },
    'mongoIndexes': indexes,
    'redisDelta': {
        'totalCalls': total_redis_calls,
        'callsPerSec': round(total_redis_calls / sample_s, 2),
        'byCommand': dict(sorted(redis_delta.items(), key=lambda x: -x[1]['calls']))
    },
    'clickhouse': {
        'tables': ch_tables,
        'totalInsertFlushes': sum(t.get('cnt', 0) for t in ch_tables),
        'totalRowsWritten': sum(t.get('rows', 0) for t in ch_tables),
    },
    'projections': {}
}

# Per-turn projections (if we know msg/s from opcounters)
# Estimate turns from mongo writes: session_states updates ~ turns
ss_updates = next((g['count'] for g in profile.get('groups',[]) if g['collection']=='session_states' and g['op']=='update'), 0)
if ss_updates > 0:
    estimated_turns = ss_updates  # ~1 session_states update per turn
    result['estimatedTurns'] = estimated_turns
    result['estimatedMsgPerSec'] = round(estimated_turns / sample_s, 2)

    # Per-turn breakdown
    per_turn = {
        'mongoReads': round(mongo_delta['query'] / estimated_turns, 1),
        'mongoWrites': round(total_mongo_writes / estimated_turns, 1),
        'mongoTotal': round((mongo_delta['query'] + total_mongo_writes) / estimated_turns, 1),
        'dirtyPagesPerTurn': round(total_dirty_pages / estimated_turns, 1),
        'redisOpsPerTurn': round(total_redis_calls / estimated_turns, 1),
        'clickhouseRowsPerTurn': round(sum(t.get('rows',0) for t in ch_tables) / estimated_turns, 1),
    }
    result['perTurn'] = per_turn

    # IOPS projections at target msg/s
    for target in [10, 25, 50, 100, 200]:
        result['projections'][f'{target}_msg_s'] = {
            'mongoWritesPerSec': round(per_turn['mongoWrites'] * target, 0),
            'dirtyPagesPerSec': round(per_turn['dirtyPagesPerTurn'] * target, 0),
            'iopsProjection': round(per_turn['dirtyPagesPerTurn'] * target, 0),
            'pctOfP15_1100': round(per_turn['dirtyPagesPerTurn'] * target / 1100 * 100, 0),
            'redisOpsPerSec': round(per_turn['redisOpsPerTurn'] * target, 0),
            'clickhouseRowsPerSec': round(per_turn['clickhouseRowsPerTurn'] * target, 0),
        }

print(json.dumps(result, indent=2))
" > "$OUT"

echo "[collect] Output: $OUT"
echo "[collect] Summary:"
python3 -c "
import json
d = json.load(open('${OUT}'))
pt = d.get('perTurn', {})
if pt:
    print(f'  Estimated turns: {d[\"estimatedTurns\"]} ({d[\"estimatedMsgPerSec\"]} msg/s)')
    print(f'  Per turn: {pt[\"mongoReads\"]} mongo reads, {pt[\"mongoWrites\"]} mongo writes, {pt[\"dirtyPagesPerTurn\"]} dirty pages')
    print(f'  Per turn: {pt[\"redisOpsPerTurn\"]} redis ops, {pt[\"clickhouseRowsPerTurn\"]} clickhouse rows')
    print(f'  IOPS at 100 msg/s: {d[\"projections\"][\"100_msg_s\"][\"iopsProjection\"]} ({d[\"projections\"][\"100_msg_s\"][\"pctOfP15_1100\"]}% of P15)')
else:
    print('  No load detected (0 session_states updates)')
"
