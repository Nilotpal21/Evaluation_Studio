/**
 * Base HTTP Client
 *
 * Combines rate limiting, retry logic, and standard HTTP methods.
 * Provider-specific clients extend this class.
 */

import { RateLimiter } from './rate-limiter.js';
import { RetryHandler, type RetryOptions } from './retry-handler.js';
import { ConnectorCircuitBreaker, type CircuitBreakerOptions } from './circuit-breaker.js';

// ─── Types ───────────────────────────────────────────────────────────────

export interface HttpClientConfig {
  /** Base URL for API requests */
  baseUrl: string;
  /** Default headers */
  defaultHeaders?: Record<string, string>;
  /** Rate limiter (optional) */
  rateLimiter?: RateLimiter;
  /** Retry options (optional) */
  retryOptions?: Partial<RetryOptions>;
  /** Request timeout in milliseconds */
  timeoutMs?: number;
  /** Optional token provider for dynamic token refresh */
  tokenProvider?: () => Promise<string>;
  /** Optional circuit breaker configuration. When provided, all requests are
   *  protected by a per-client circuit breaker that opens after consecutive
   *  failures and prevents further requests until the reset timeout elapses. */
  circuitBreaker?: CircuitBreakerOptions;
}

export interface RequestOptions {
  /** Request headers */
  headers?: Record<string, string>;
  /** Query parameters */
  query?: Record<string, string | number | boolean>;
  /** Request body */
  body?: any;
  /** Request timeout (overrides default) */
  timeoutMs?: number;
  /** Skip rate limiting for this request */
  skipRateLimit?: boolean;
  /** Skip retry for this request */
  skipRetry?: boolean;
}

export interface HttpResponse<T = any> {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  data: T;
}

export class HttpError extends Error {
  constructor(
    message: string,
    public status: number,
    public statusText: string,
    public response?: any,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

// ─── HTTP Client ─────────────────────────────────────────────────────────

export class HttpClient {
  protected readonly config: HttpClientConfig;
  private readonly rateLimiter?: RateLimiter;
  private readonly retryHandler: RetryHandler;
  private readonly breaker?: ConnectorCircuitBreaker;

  constructor(config: HttpClientConfig) {
    this.config = config;
    this.rateLimiter = config.rateLimiter;
    this.retryHandler = new RetryHandler(config.retryOptions);
    if (config.circuitBreaker) {
      this.breaker = new ConnectorCircuitBreaker(config.circuitBreaker);
    }
  }

  /**
   * Perform GET request.
   */
  async get<T = any>(path: string, options: RequestOptions = {}): Promise<HttpResponse<T>> {
    return this.request<T>('GET', path, options);
  }

  /**
   * Perform POST request.
   */
  async post<T = any>(path: string, options: RequestOptions = {}): Promise<HttpResponse<T>> {
    return this.request<T>('POST', path, options);
  }

  /**
   * Perform PUT request.
   */
  async put<T = any>(path: string, options: RequestOptions = {}): Promise<HttpResponse<T>> {
    return this.request<T>('PUT', path, options);
  }

  /**
   * Perform PATCH request.
   */
  async patch<T = any>(path: string, options: RequestOptions = {}): Promise<HttpResponse<T>> {
    return this.request<T>('PATCH', path, options);
  }

  /**
   * Perform DELETE request.
   */
  async delete<T = any>(path: string, options: RequestOptions = {}): Promise<HttpResponse<T>> {
    return this.request<T>('DELETE', path, options);
  }

  /**
   * Perform HTTP request with circuit breaker, rate limiting, and retry logic.
   */
  private async request<T>(
    method: string,
    path: string,
    options: RequestOptions,
  ): Promise<HttpResponse<T>> {
    // Apply rate limiting
    if (this.rateLimiter && !options.skipRateLimit) {
      await this.rateLimiter.acquire();
    }

    // Execute with retry logic
    const executeRequest = async () => {
      return await this.executeRequest<T>(method, path, options);
    };

    // Wrap in circuit breaker if configured
    const protectedRequest = this.breaker
      ? () => this.breaker!.execute(executeRequest)
      : executeRequest;

    if (options.skipRetry) {
      return await protectedRequest();
    } else {
      return await this.retryHandler.execute(protectedRequest);
    }
  }

  /**
   * Execute HTTP request.
   */
  private async executeRequest<T>(
    method: string,
    path: string,
    options: RequestOptions,
  ): Promise<HttpResponse<T>> {
    // Build URL with query parameters
    const url = this.buildUrl(path, options.query);

    // Refresh token if tokenProvider is configured
    if (this.config.tokenProvider) {
      const freshToken = await this.config.tokenProvider();
      this.config.defaultHeaders = {
        ...this.config.defaultHeaders,
        Authorization: `Bearer ${freshToken}`,
      };
    }

    // Build headers
    const headers = {
      ...this.config.defaultHeaders,
      ...options.headers,
    };

    // Build request options
    const fetchOptions: RequestInit = {
      method,
      headers,
      signal: this.createAbortSignal(options.timeoutMs ?? this.config.timeoutMs),
    };

    // Add body for POST/PUT/PATCH
    if (options.body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
      if (typeof options.body === 'object') {
        fetchOptions.body = JSON.stringify(options.body);
        headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      } else {
        fetchOptions.body = options.body;
      }
    }

    // Execute request
    const response = await fetch(url, fetchOptions);

    // Parse response
    const data = await this.parseResponse<T>(response);

    // Check for errors
    if (!response.ok) {
      // Extract detailed error message from API response body (e.g., Microsoft Graph error format)
      let detailMessage = '';
      if (data && typeof data === 'object') {
        const apiError = (data as any).error;
        if (apiError?.message) {
          detailMessage = ` — ${apiError.code || 'Error'}: ${apiError.message}`;
        }
      }
      throw new HttpError(
        `HTTP ${response.status}: ${response.statusText}${detailMessage}`,
        response.status,
        response.statusText,
        data,
      );
    }

    return {
      status: response.status,
      statusText: response.statusText,
      headers: this.parseHeaders(response.headers),
      data,
    };
  }

  /**
   * Build full URL with query parameters.
   */
  private buildUrl(path: string, query?: Record<string, string | number | boolean>): string {
    // If path is already a full URL (from pagination nextLink), use it directly
    if (path.startsWith('http://') || path.startsWith('https://')) {
      return path;
    }

    const baseUrl = this.config.baseUrl.replace(/\/$/, '');
    const fullPath = path.startsWith('/') ? path : `/${path}`;
    let url = `${baseUrl}${fullPath}`;

    if (query && Object.keys(query).length > 0) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        params.append(key, String(value));
      }
      url += `?${params.toString()}`;
    }

    return url;
  }

  /**
   * Create abort signal for timeout.
   */
  private createAbortSignal(timeoutMs?: number): AbortSignal | undefined {
    if (!timeoutMs) return undefined;

    const controller = new AbortController();
    setTimeout(() => controller.abort(), timeoutMs);
    return controller.signal;
  }

  /**
   * Parse response body.
   */
  private async parseResponse<T>(response: Response): Promise<T> {
    const contentType = response.headers.get('Content-Type') || '';

    if (contentType.includes('application/json')) {
      return (await response.json()) as T;
    } else if (contentType.includes('text/')) {
      return (await response.text()) as T;
    } else {
      return (await response.arrayBuffer()) as T;
    }
  }

  /**
   * Parse response headers into object.
   */
  private parseHeaders(headers: Headers): Record<string, string> {
    const result: Record<string, string> = {};
    headers.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }
}
