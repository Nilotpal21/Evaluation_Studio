#!/usr/bin/env bash
# refresh-infra-snapshot.sh — Captures live infra state from kubectl into infra-snapshot.json
# Usage: ENV=qa ./benchmarks/scripts/refresh-infra-snapshot.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUT="$ROOT/benchmarks/config/sizing/infra-snapshot.json"

# Environment resolution (same as saturation-runner.sh)
ENV="${ENV:-dev}"
case "$ENV" in
  dev)  CONTEXT="aks-abl-dev-centralus";   NS="abl-platform-dev" ;;
  qa)   CONTEXT="aks-abl-qa-centralus";    NS="abl-platform-qa" ;;
  staging) CONTEXT="aks-abl-staging-centralus"; NS="abl-platform-staging" ;;
  *) echo "Unknown ENV=$ENV"; exit 1 ;;
esac

KC="kubectl --context $CONTEXT -n $NS"
KC_CLUSTER="kubectl --context $CONTEXT"

echo "[refresh] Cluster: $CONTEXT  Namespace: $NS"

# --- Runtime ---
RUNTIME_JSON=$($KC get deploy -l app.kubernetes.io/component=runtime -o json)
RT_CPU_REQ=$(echo "$RUNTIME_JSON" | python3 -c "
import json, sys; d=json.load(sys.stdin)
for item in d['items']:
  for c in item['spec']['template']['spec']['containers']:
    if c['name']=='runtime':
      print(c['resources'].get('requests',{}).get('cpu','1'))
      break
  break
")
RT_CPU_LIM=$(echo "$RUNTIME_JSON" | python3 -c "
import json, sys; d=json.load(sys.stdin)
for item in d['items']:
  for c in item['spec']['template']['spec']['containers']:
    if c['name']=='runtime':
      print(c['resources'].get('limits',{}).get('cpu','4'))
      break
  break
")
RT_MEM_REQ=$(echo "$RUNTIME_JSON" | python3 -c "
import json, sys; d=json.load(sys.stdin)
for item in d['items']:
  for c in item['spec']['template']['spec']['containers']:
    if c['name']=='runtime':
      print(c['resources'].get('requests',{}).get('memory','1Gi'))
      break
  break
")
RT_MEM_LIM=$(echo "$RUNTIME_JSON" | python3 -c "
import json, sys; d=json.load(sys.stdin)
for item in d['items']:
  for c in item['spec']['template']['spec']['containers']:
    if c['name']=='runtime':
      print(c['resources'].get('limits',{}).get('memory','2Gi'))
      break
  break
")
RT_IMAGE=$(echo "$RUNTIME_JSON" | python3 -c "
import json, sys; d=json.load(sys.stdin)
for item in d['items']:
  for c in item['spec']['template']['spec']['containers']:
    if c['name']=='runtime':
      img = c.get('image','?')
      print(img.split(':')[-1] if ':' in img else img)
      break
  break
")

# --- HPA ---
HPA_JSON=$($KC get hpa -l app.kubernetes.io/component=runtime -o json 2>/dev/null || echo '{"items":[]}')
HPA_MIN=$(echo "$HPA_JSON" | python3 -c "
import json, sys; d=json.load(sys.stdin)
print(d['items'][0]['spec']['minReplicas'] if d['items'] else 2)
")
HPA_MAX=$(echo "$HPA_JSON" | python3 -c "
import json, sys; d=json.load(sys.stdin)
print(d['items'][0]['spec']['maxReplicas'] if d['items'] else 10)
")
HPA_CPU=$(echo "$HPA_JSON" | python3 -c "
import json, sys; d=json.load(sys.stdin)
if not d['items']: print(70); sys.exit()
for m in d['items'][0]['spec'].get('metrics',[]):
  if m['type']=='Resource' and m['resource']['name']=='cpu':
    print(m['resource']['target'].get('averageUtilization',70)); break
else: print(70)
")

# --- MongoDB ---
MONGO_JSON=$($KC get sts -l app.kubernetes.io/component=mongodb -o json 2>/dev/null || $KC get sts -l app=abl-platform-qa-mongodb-svc -o json 2>/dev/null || echo '{"items":[]}')
if [ "$(echo "$MONGO_JSON" | python3 -c "import json,sys;print(len(json.load(sys.stdin)['items']))")" = "0" ]; then
  # Try by name
  MONGO_JSON=$($KC get sts abl-platform-qa-mongodb -o json 2>/dev/null | python3 -c "import json,sys;d=json.load(sys.stdin);print(json.dumps({'items':[d]}))" 2>/dev/null || echo '{"items":[]}')
fi
MONGO_SPEC=$(echo "$MONGO_JSON" | python3 -c "
import json, sys
d = json.load(sys.stdin)
if not d['items']:
    print(json.dumps({'replicas':3,'cpuReq':'500m','cpuLim':'1','memReq':'1Gi','memLim':'2Gi','pvcGi':20}))
    sys.exit()
item = d['items'][0]
replicas = item['spec']['replicas']
# Find the mongod container
for c in item['spec']['template']['spec']['containers']:
    if 'mongo' in c['name'].lower() and 'agent' not in c['name'].lower():
        res = c.get('resources',{})
        result = {
            'replicas': replicas,
            'cpuReq': res.get('requests',{}).get('cpu','500m'),
            'cpuLim': res.get('limits',{}).get('cpu','?'),
            'memReq': res.get('requests',{}).get('memory','1Gi'),
            'memLim': res.get('limits',{}).get('memory','2Gi'),
        }
        break
else:
    result = {'replicas': replicas, 'cpuReq':'?','cpuLim':'?','memReq':'?','memLim':'?'}
# PVC
vcts = item['spec'].get('volumeClaimTemplates',[])
pvc_gi = 20
for v in vcts:
    if 'data' in v['metadata']['name']:
        storage = v['spec']['resources']['requests']['storage']
        pvc_gi = int(storage.replace('Gi','').replace('G',''))
        break
result['pvcGi'] = pvc_gi
print(json.dumps(result))
")

# --- Redis ---
REDIS_MASTER_JSON=$($KC get sts abl-platform-qa-redis-master -o json 2>/dev/null || echo '{}')
REDIS_REPLICA_JSON=$($KC get sts abl-platform-qa-redis-replicas -o json 2>/dev/null || echo '{}')
REDIS_SPEC=$(python3 -c "
import json
master = json.loads('''$REDIS_MASTER_JSON''') if '''$REDIS_MASTER_JSON'''.strip() != '{}' else None
replica = json.loads('''$REDIS_REPLICA_JSON''') if '''$REDIS_REPLICA_JSON'''.strip() != '{}' else None
result = {'masterReplicas':1,'replicaReplicas':3,'master':{},'replica':{},'pvcGi':8}
if master:
    result['masterReplicas'] = master.get('spec',{}).get('replicas',1)
    for c in master.get('spec',{}).get('template',{}).get('spec',{}).get('containers',[]):
        if 'redis' in c['name']:
            res = c.get('resources',{})
            result['master'] = {
                'cpuReq': res.get('requests',{}).get('cpu','4'),
                'cpuLim': res.get('limits',{}).get('cpu','8'),
                'memReq': res.get('requests',{}).get('memory','8Gi'),
                'memLim': res.get('limits',{}).get('memory','16Gi'),
            }
            break
    vcts = master.get('spec',{}).get('volumeClaimTemplates',[])
    for v in vcts:
        storage = v.get('spec',{}).get('resources',{}).get('requests',{}).get('storage','8Gi')
        result['pvcGi'] = int(storage.replace('Gi','').replace('G',''))
        break
if replica:
    result['replicaReplicas'] = replica.get('spec',{}).get('replicas',3)
    for c in replica.get('spec',{}).get('template',{}).get('spec',{}).get('containers',[]):
        if 'redis' in c['name']:
            res = c.get('resources',{})
            result['replica'] = {
                'cpuReq': res.get('requests',{}).get('cpu','2'),
                'cpuLim': res.get('limits',{}).get('cpu','4'),
                'memReq': res.get('requests',{}).get('memory','8Gi'),
                'memLim': res.get('limits',{}).get('memory','16Gi'),
            }
            break
print(json.dumps(result))
" 2>/dev/null || echo '{"masterReplicas":1,"replicaReplicas":3,"master":{},"replica":{},"pvcGi":8}')

# --- Storage Class ---
SC_JSON=$($KC_CLUSTER get sc default -o json 2>/dev/null || echo '{}')
DISK_SKU=$(echo "$SC_JSON" | python3 -c "
import json, sys
d = json.load(sys.stdin)
params = d.get('parameters',{})
print(params.get('skuname', params.get('skuName', 'StandardSSD_LRS')))
")

# --- Nodes ---
NODES_JSON=$($KC_CLUSTER get nodes -o json)
NODE_POOLS=$(echo "$NODES_JSON" | python3 -c "
import json, sys
from collections import defaultdict
d = json.load(sys.stdin)
pools = defaultdict(lambda: {'count':0,'type':'?','cpu':0,'memGi':0})
for node in d['items']:
    labels = node['metadata'].get('labels',{})
    pool = labels.get('agentpool', labels.get('kubernetes.azure.com/agentpool','unknown'))
    instance = labels.get('node.kubernetes.io/instance-type','?')
    cpu = int(node['status']['capacity']['cpu'])
    mem_ki = int(node['status']['capacity']['memory'].replace('Ki',''))
    mem_gi = round(mem_ki / 1024 / 1024)
    pools[pool]['count'] += 1
    pools[pool]['type'] = instance
    pools[pool]['cpu'] = cpu
    pools[pool]['memGi'] = mem_gi
result = []
for name, info in sorted(pools.items()):
    result.append({'pool':name,'instanceType':info['type'],'count':info['count'],'cpuPerNode':info['cpu'],'memoryPerNodeGi':info['memGi']})
print(json.dumps(result))
")

# --- Assemble ---
python3 -c "
import json, sys
from datetime import datetime, timezone

runtime_cpu_req = '$RT_CPU_REQ'
runtime_cpu_lim = '$RT_CPU_LIM'
runtime_mem_req = '$RT_MEM_REQ'
runtime_mem_lim = '$RT_MEM_LIM'
runtime_image = '$RT_IMAGE'
hpa_min = int('$HPA_MIN')
hpa_max = int('$HPA_MAX')
hpa_cpu = int('$HPA_CPU')
disk_sku = '$DISK_SKU'

mongo = json.loads('$MONGO_SPEC')
redis = json.loads('$REDIS_SPEC')
nodes = json.loads('$NODE_POOLS')

# Convert CPU string to numeric
def cpu_to_cores(s):
    if s.endswith('m'):
        return int(s.replace('m','')) / 1000
    return float(s) if s != '?' else None

# Convert memory string to Gi
def mem_to_gi(s):
    if s.endswith('Gi'):
        return float(s.replace('Gi',''))
    if s.endswith('Mi'):
        return float(s.replace('Mi','')) / 1024
    if s.endswith('G'):
        return float(s.replace('G',''))
    if s.endswith('M'):
        return float(s.replace('M','')) / 1024
    return None

# Find runtime node pool
rt_node = next((n for n in nodes if n['pool'] == 'user'), nodes[0] if nodes else {'instanceType':'?'})

snapshot = {
    'snapshotDate': datetime.now(timezone.utc).strftime('%Y-%m-%d'),
    'capturedAt': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
    'hash': f'sha256:live-$ENV-{datetime.now(timezone.utc).strftime(\"%Y%m%d%H%M\")}',
    'cluster': '$CONTEXT',
    'namespace': '$NS',
    'source': 'kubectl-live (refresh-infra-snapshot.sh)',
    'runtimeDefaults': {
        'cpuRequestCores': cpu_to_cores(runtime_cpu_req),
        'cpuLimitCores': cpu_to_cores(runtime_cpu_lim),
        'memoryRequestGi': mem_to_gi(runtime_mem_req),
        'memoryLimitGi': mem_to_gi(runtime_mem_lim),
        'hpaMinReplicas': hpa_min,
        'hpaMaxReplicas': hpa_max,
        'hpaCpuTarget': hpa_cpu,
        'image': f'abl-platform/runtime:{runtime_image}',
        'placement': {
            'nodePool': 'user',
            'instanceType': rt_node['instanceType']
        }
    },
    'mongodb': {
        'replicas': mongo['replicas'],
        'cpuRequestCores': cpu_to_cores(mongo['cpuReq']),
        'cpuLimitCores': cpu_to_cores(mongo['cpuLim']),
        'memoryRequestGi': mem_to_gi(mongo['memReq']),
        'memoryLimitGi': mem_to_gi(mongo['memLim']),
        'pvcSizeGi': mongo['pvcGi'],
        'diskSku': disk_sku,
        'placement': {
            'nodePool': 'database',
            'instanceType': next((n['instanceType'] for n in nodes if n['pool']=='database'), '?')
        }
    },
    'redis': {
        'masterReplicas': redis['masterReplicas'],
        'replicaReplicas': redis['replicaReplicas'],
        'totalReplicas': redis['masterReplicas'] + redis['replicaReplicas'],
        'master': {
            'cpuRequestCores': cpu_to_cores(redis['master'].get('cpuReq','4')),
            'cpuLimitCores': cpu_to_cores(redis['master'].get('cpuLim','8')),
            'memoryRequestGi': mem_to_gi(redis['master'].get('memReq','8Gi')),
            'memoryLimitGi': mem_to_gi(redis['master'].get('memLim','16Gi')),
        },
        'replica': {
            'cpuRequestCores': cpu_to_cores(redis['replica'].get('cpuReq','2')),
            'cpuLimitCores': cpu_to_cores(redis['replica'].get('cpuLim','4')),
            'memoryRequestGi': mem_to_gi(redis['replica'].get('memReq','8Gi')),
            'memoryLimitGi': mem_to_gi(redis['replica'].get('memLim','16Gi')),
        },
        'pvcSizeGi': redis['pvcGi'],
        'diskSku': disk_sku,
        'persistence': 'aof',
        'placement': {
            'nodePool': 'database',
            'instanceType': next((n['instanceType'] for n in nodes if n['pool']=='database'), '?')
        }
    },
    'storage': {
        'storageClassName': 'default',
        'provisioner': 'disk.csi.azure.com',
        'skuName': disk_sku,
        'reclaimPolicy': 'Delete',
        'volumeBindingMode': 'WaitForFirstConsumer'
    },
    'nodes': nodes
}

with open('$OUT', 'w') as f:
    json.dump(snapshot, f, indent=2)
print(f'[refresh] Written {\"$OUT\"} (cluster=$CONTEXT, ns=$NS)')
print(f'  Runtime: {runtime_cpu_req}/{runtime_cpu_lim} CPU, {runtime_mem_req}/{runtime_mem_lim} mem')
print(f'  HPA: min={hpa_min} max={hpa_max} cpuTarget={hpa_cpu}%')
print(f'  MongoDB: {mongo[\"replicas\"]}×, {mongo[\"cpuReq\"]}/{mongo[\"cpuLim\"]} CPU, PVC={mongo[\"pvcGi\"]}Gi')
print(f'  Redis: master={redis[\"masterReplicas\"]}×, replicas={redis[\"replicaReplicas\"]}×')
print(f'  Disk: {disk_sku}')
print(f'  Nodes: {len(nodes)} pools, {sum(n[\"count\"] for n in nodes)} total')
"
