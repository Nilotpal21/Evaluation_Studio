/** GPU service name prefixes. */
const GPU_SERVICE_PREFIXES = ['self-hosted-llm'];

/** Known data store names. */
const DATA_STORES = ['mongodb', 'redis', 'clickhouse', 'opensearch', 'qdrant', 'neo4j', 'restate'];

/** Round CPU to nearest 0.25 cores (ceiling). */
export function roundUpCpu(cores: number): number {
  return Math.ceil(cores * 4) / 4;
}

/** Round memory to nearest 256Mi / 0.25Gi (ceiling). */
export function roundUpMemoryGi(gi: number): number {
  return Math.ceil(gi * 4) / 4;
}

/** Parse a memory string like "3.2Gi" or "512Mi" to a number in Gi. Returns null if unparseable. */
export function parseMemoryGi(value: string | null): number | null {
  if (!value) return null;
  const match = value.match(/^([\d.]+)\s*(Gi|G|Mi|M)?$/i);
  if (!match) return null;
  const num = parseFloat(match[1]);
  const unit = (match[2] || 'Gi').toLowerCase();
  if (unit === 'mi' || unit === 'm') return num / 1024;
  return num;
}

/** Infer node pool based on service characteristics. */
export function inferNodePool(serviceName: string, cpu: number): string {
  if (GPU_SERVICE_PREFIXES.some((prefix) => serviceName.startsWith(prefix))) return 'gpu';
  if (DATA_STORES.includes(serviceName)) return 'data';
  if (cpu >= 4) return 'compute';
  return 'general';
}
