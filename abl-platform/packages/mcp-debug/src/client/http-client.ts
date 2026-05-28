/**
 * HTTP Client for Runtime REST API
 *
 * Makes HTTP requests to the runtime server's REST endpoints.
 */

import type { AgentsResponse, AgentDetails } from '../types.js';
import { DEFAULT_HTTP_URL } from '../constants.js';
import { fetchWithTimeout, FetchError, type FetchErrorCode } from '../utils/fetch.js';

export interface HealthCheckResult {
  reachable: boolean;
  status?: number;
  details?: Record<string, unknown>;
  error?: string;
  errorCode?: FetchErrorCode;
}

export class HttpClient {
  private baseUrl: string;
  private authToken: string | null = null;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || DEFAULT_HTTP_URL || '';
  }

  /**
   * Set auth token for authenticated requests
   */
  setAuthToken(token: string): void {
    this.authToken = token;
  }

  /**
   * Get the current auth token (if set).
   * @internal Use only for cross-service requests where HttpClient methods can't be used
   */
  getAuthToken(): string | null {
    return this.authToken;
  }

  /**
   * Get headers with optional auth
   */
  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.authToken) {
      headers['Authorization'] = `Bearer ${this.authToken}`;
    }
    return headers;
  }

  /**
   * List all available agents
   */
  async listAgents(): Promise<AgentsResponse> {
    const response = await fetchWithTimeout(`${this.baseUrl}/api/agents`, {
      headers: this.getHeaders(),
    });
    if (!response.ok) {
      throw new Error(`Failed to list agents: ${response.statusText}`);
    }
    return response.json() as Promise<AgentsResponse>;
  }

  /**
   * Get agent details
   */
  async getAgent(_domain: string, name: string): Promise<AgentDetails | null> {
    const safeName = encodeURIComponent(name);
    const response = await fetchWithTimeout(`${this.baseUrl}/api/agents/${safeName}`, {
      headers: this.getHeaders(),
    });
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`Failed to get agent: ${response.statusText}`);
    }
    const data = (await response.json()) as { success: boolean; agent: AgentDetails };
    return data.agent;
  }

  /**
   * Runtime health check — hits GET /health with a 5s timeout.
   * Returns structured result with reachability, status, and details.
   */
  async runtimeHealthCheck(): Promise<HealthCheckResult> {
    try {
      const response = await fetchWithTimeout(`${this.baseUrl}/health`);

      if (response.ok) {
        try {
          const details = (await response.json()) as Record<string, unknown>;
          return { reachable: true, status: response.status, details };
        } catch {
          return { reachable: true, status: response.status };
        }
      }

      // 401/403 means server is reachable but auth is needed — still counts as reachable
      if (response.status === 401 || response.status === 403) {
        return { reachable: true, status: response.status };
      }

      return { reachable: false, status: response.status };
    } catch (err) {
      if (err instanceof FetchError) {
        return { reachable: false, error: err.message, errorCode: err.code };
      }
      const message = err instanceof Error ? err.message : String(err);
      return { reachable: false, error: message };
    }
  }

  /**
   * Health check (deprecated — use runtimeHealthCheck() instead)
   * @deprecated
   */
  async healthCheck(): Promise<boolean> {
    const result = await this.runtimeHealthCheck();
    return result.reachable;
  }

  /**
   * Generic authenticated GET request.
   * Returns the parsed JSON body or throws on non-2xx responses.
   */
  async get<T = unknown>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetchWithTimeout(url, {
      headers: this.getHeaders(),
    });
    if (!response.ok) {
      throw new Error(`GET ${path} failed: ${response.status} ${response.statusText}`);
    }
    return response.json() as Promise<T>;
  }

  /**
   * Generic authenticated POST request.
   * Returns the parsed JSON body or throws on non-2xx responses.
   */
  async post<T = unknown>(path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { ...this.getHeaders(), 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      throw new Error(`POST ${path} failed: ${response.status} ${response.statusText}`);
    }
    return response.json() as Promise<T>;
  }

  /**
   * Generic authenticated PUT request.
   * Returns the parsed JSON body or throws on non-2xx responses.
   */
  async put<T = unknown>(path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetchWithTimeout(url, {
      method: 'PUT',
      headers: { ...this.getHeaders(), 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      throw new Error(`PUT ${path} failed: ${response.status} ${response.statusText}`);
    }
    return response.json() as Promise<T>;
  }

  /**
   * Generic authenticated DELETE request.
   * Returns the parsed JSON body or throws on non-2xx responses.
   * Returns empty object for 204 No Content or zero-length responses.
   */
  async del<T = unknown>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetchWithTimeout(url, {
      method: 'DELETE',
      headers: this.getHeaders(),
    });
    if (!response.ok) {
      throw new Error(`DELETE ${path} failed: ${response.status} ${response.statusText}`);
    }
    const contentLength = response.headers.get('content-length');
    if (response.status === 204 || contentLength === '0') {
      return {} as T;
    }
    return response.json() as Promise<T>;
  }

  /**
   * Set base URL
   */
  setBaseUrl(url: string): void {
    this.baseUrl = url;
  }

  /**
   * Get base URL
   */
  getBaseUrl(): string {
    return this.baseUrl;
  }
}
