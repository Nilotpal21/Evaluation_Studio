/**
 * BgeM3Client — HTTP client for the local BGE-M3 embedding endpoint.
 *
 * Design decisions (from LLD D-L12):
 * - Exported `BgeM3Client` interface + `createBgeM3Client` factory
 * - Graceful degradation: when the endpoint is unreachable the client
 *   logs a warning and returns `null`, letting the caller skip embedding
 *   without blocking the pipeline.
 * - `embedBatch` respects `maxBatchSize` and retries once on 5xx.
 * - `healthCheck` is a lightweight liveness probe (GET /health).
 */

export interface EmbedResponse {
  embeddings: number[][];
  model: string;
  dimensions: number;
}

export interface BgeM3ClientConfig {
  baseUrl: string;
  timeoutMs: number;
  maxBatchSize: number;
  /** Optional Bearer token for authenticated endpoints. */
  authToken?: string;
}

export interface BgeM3Client {
  /**
   * Embed a batch of texts. Returns null when the endpoint is unreachable
   * or returns a server error, so callers can degrade gracefully.
   */
  embedBatch(texts: string[]): Promise<EmbedResponse | null>;

  /**
   * Lightweight liveness probe. Returns true when the endpoint is reachable.
   * Never throws — returns false on any error.
   */
  healthCheck(): Promise<boolean>;
}

export function createBgeM3Client(config: BgeM3ClientConfig): BgeM3Client {
  const { baseUrl, timeoutMs, maxBatchSize, authToken } = config;

  function buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }
    return headers;
  }

  async function fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMsOverride?: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const ms = timeoutMsOverride ?? timeoutMs;
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function embedBatch(texts: string[]): Promise<EmbedResponse | null> {
    if (texts.length === 0) {
      return { embeddings: [], model: 'bge-m3', dimensions: 1024 };
    }

    // Chunk into maxBatchSize slices
    const allEmbeddings: number[][] = [];
    const chunks: string[][] = [];
    for (let i = 0; i < texts.length; i += maxBatchSize) {
      chunks.push(texts.slice(i, i + maxBatchSize));
    }

    let model = 'bge-m3';
    let dimensions = 1024;

    for (const chunk of chunks) {
      const chunkResult = await embedChunk(chunk);
      if (chunkResult === null) {
        return null;
      }
      allEmbeddings.push(...chunkResult.embeddings);
      model = chunkResult.model;
      dimensions = chunkResult.dimensions;
    }

    return { embeddings: allEmbeddings, model, dimensions };
  }

  async function embedChunk(texts: string[]): Promise<EmbedResponse | null> {
    const body = JSON.stringify({ texts });
    let attempt = 0;
    const MAX_ATTEMPTS = 2;

    while (attempt < MAX_ATTEMPTS) {
      attempt++;
      try {
        const response = await fetchWithTimeout(`${baseUrl}/embed`, {
          method: 'POST',
          headers: buildHeaders(),
          body,
        });

        if (response.ok) {
          const data = (await response.json()) as {
            embeddings: number[][];
            model?: string;
            dimensions?: number;
          };
          return {
            embeddings: data.embeddings,
            model: data.model ?? 'bge-m3',
            dimensions: data.dimensions ?? 1024,
          };
        }

        // 5xx: retry once; 4xx: give up immediately
        if (response.status < 500) {
          process.stderr.write(
            `[helix:bge-m3] embed request failed with status ${response.status} — skipping embeddings\n`,
          );
          return null;
        }

        if (attempt < MAX_ATTEMPTS) {
          process.stderr.write(
            `[helix:bge-m3] embed request failed with status ${response.status} (attempt ${attempt}/${MAX_ATTEMPTS}), retrying…\n`,
          );
          // short back-off before retry
          await sleep(500);
          continue;
        }

        process.stderr.write(
          `[helix:bge-m3] embed request failed with status ${response.status} after ${MAX_ATTEMPTS} attempts — skipping embeddings\n`,
        );
        return null;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (attempt < MAX_ATTEMPTS && !message.includes('aborted')) {
          process.stderr.write(
            `[helix:bge-m3] embed request error (attempt ${attempt}/${MAX_ATTEMPTS}): ${message}, retrying…\n`,
          );
          await sleep(500);
          continue;
        }
        process.stderr.write(
          `[helix:bge-m3] embed endpoint unreachable (${message}) — skipping embeddings\n`,
        );
        return null;
      }
    }

    return null;
  }

  async function healthCheck(): Promise<boolean> {
    try {
      const response = await fetchWithTimeout(
        `${baseUrl}/health`,
        {
          method: 'GET',
          headers: buildHeaders(),
        },
        5_000, // short timeout for health probe
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  return { embedBatch, healthCheck };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
