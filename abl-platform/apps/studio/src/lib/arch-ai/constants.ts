const DEFAULT_STUCK_SESSION_THRESHOLD_MS = 10 * 60 * 1000;

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Retry configuration */
export const ARCH_AI_RETRY = {
  TOPOLOGY_LLM_RETRIES: 1,
  AGENT_LLM_RETRIES: 1,
  CREATE_TRANSIENT_RETRIES: 1,
  MIN_VALID_AGENTS_PERCENT: 0.5,
} as const;

/** Timeout configuration */
export const ARCH_AI_TIMEOUTS = {
  LLM_CALL_MS: 30_000,
  LLM_STREAM_CHUNK_MS: 15_000,
  COMPILE_TOOL_MS: parsePositiveIntEnv('ARCH_AI_COMPILE_TOOL_TIMEOUT_MS', 20_000),
  BUILD_SESSION_VALIDATION_MS: parsePositiveIntEnv(
    'ARCH_AI_BUILD_SESSION_VALIDATION_TIMEOUT_MS',
    30_000,
  ),
  TOOL_TOTAL_MS: 300_000,
  ROUTE_MAX_DURATION: 300,
} as const;

/** Session recovery for stuck non-terminal sessions */
export const ARCH_AI_SESSION_RECOVERY = {
  STUCK_SESSION_THRESHOLD_MS: parsePositiveIntEnv(
    'ARCH_AI_STUCK_SESSION_THRESHOLD_MS',
    DEFAULT_STUCK_SESSION_THRESHOLD_MS,
  ),
} as const;

/** LLM generation defaults */
export const ARCH_AI_LLM_DEFAULTS = {
  MAX_OUTPUT_TOKENS: 2048,
  TEMPERATURE: 0.7,
  MAX_RETRIES: 0,
} as const;

/**
 * Agentic loop limits.
 * Raised into the low hundreds so larger onboarding and in-project Arch flows
 * can complete without step caps tripping before the existing timeout guards do.
 */
export const ARCH_AI_LIMITS = {
  MAX_STEPS: 200,
  MAX_ONBOARDING_STEPS: 200,
  MAX_MESSAGES: 100,
  MAX_MESSAGE_LENGTH: 10_000,
} as const;

/** BUILD phase — parallel per-agent generation */
export const ARCH_AI_BUILD = {
  /** Max parallel LLM calls for agent generation */
  AGENT_CONCURRENCY: 10,
  /** Higher output token limit for code generation (agents are ~80-120 lines each) */
  MAX_OUTPUT_TOKENS: 8192,
  /**
   * Max steps per-agent LLM call (generate → compile → fix → recompile).
   * Raised into the low hundreds to allow deeper repair loops for larger
   * generated agents before timeout-based guards take over.
   */
  AGENT_MAX_STEPS: 200,
  /** Per-agent worker timeout (ms) — 2 minutes. If an agent can't generate in 2min, it's stuck.
   *  Fix 5: Reduced from 300s to 120s to prevent timeout cascade.
   *  Previous: 5 agents × 300s = 1500s > 1200s total timeout → later agents always timed out. */
  AGENT_TIMEOUT_MS: 120_000,
  /** Total request timeout for parallel BUILD generation (all workers + reconciliation) — 20 minutes. */
  PARALLEL_GEN_TIMEOUT_MS: 1_200_000,
  /** Max retries per agent if worker errors out or produces no file */
  AGENT_MAX_RETRIES: 2,
  /** Temperature for code generation */
  TEMPERATURE: 0.5,
} as const;

/** File upload limits */
export const ARCH_AI_FILES = {
  ACCEPTED_TYPES: ['.pdf', '.md', '.json', '.yaml', '.yml', '.txt', '.docx'],
  ACCEPTED_UPLOAD_EXTENSIONS: [
    '.pdf',
    '.md',
    '.json',
    '.yaml',
    '.yml',
    '.txt',
    '.docx',
    '.png',
    '.jpg',
    '.jpeg',
    '.webp',
    '.gif',
  ],
  ACCEPTED_UPLOAD_MIME_TYPES: [
    'application/pdf',
    'text/markdown',
    'application/json',
    'application/x-yaml',
    'text/yaml',
    'text/plain',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
  ],
  MAX_FILES: 10,
  MAX_FILE_SIZE_BYTES: 10 * 1024 * 1024,
} as const;
