import { z } from 'zod';

/**
 * Sandbox / Gvisor Pod configuration.
 * Configures direct communication with gvisor-sandboxed Kubernetes pods
 * for isolated code execution.
 */

export const SandboxConfigSchema = z.object({
  /** Legacy: tool pod host (used by PodSandboxRunner) */
  podHost: z.string().default('http://localhost'),
  /** Legacy: tool pod port (used by PodSandboxRunner) */
  podPort: z.coerce.number().int().positive().default(3015),
  /** Pod endpoint path */
  podPath: z.string().default('/execute-script'),
  /** VM timeout in ms */
  timeoutMs: z.coerce.number().int().positive().default(60000),
  /** Python gvisor pod URL (direct) */
  pythonPodUrl: z.string().default('http://kr-python-svc'),
  /** JavaScript gvisor pod URL (direct) */
  javascriptPodUrl: z.string().default('https://usaz-dev-agent-platform.kore.ai/gvisor'),
  /** JWT secret for gvisor pod memory access */
  jwtSecret: z.string().optional(),
  /** JWT expiry in seconds (default: 300 = 5 minutes) */
  jwtExpirySeconds: z.coerce.number().int().positive().default(300),
  /** Base URL for memory API callbacks from sandbox pods (e.g., http://abl-platform-runtime:3113) */
  memoryApiBaseUrl: z.string().default(''),
});

export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;
