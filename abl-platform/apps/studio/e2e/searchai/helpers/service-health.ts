/**
 * Service Health Checker for E2E Tests
 *
 * Verify all required services are running before starting tests.
 * Zero assumptions — every service is explicitly checked.
 */

import type { APIRequestContext } from '@playwright/test';

export interface ServiceHealth {
  name: string;
  url: string;
  healthy: boolean;
  responseTime?: number;
  error?: string;
}

export interface ServicesHealthReport {
  allHealthy: boolean;
  services: ServiceHealth[];
  timestamp: string;
}

/**
 * Service health checker
 */
export class ServiceHealthChecker {
  constructor(private request: APIRequestContext) {}

  /**
   * Check a single service health
   */
  async checkService(name: string, url: string, timeoutMs = 5000): Promise<ServiceHealth> {
    const startTime = Date.now();

    try {
      const response = await this.request.get(url, {
        timeout: timeoutMs,
      });

      const responseTime = Date.now() - startTime;
      const healthy = response.ok();

      return {
        name,
        url,
        healthy,
        responseTime,
        error: healthy ? undefined : `HTTP ${response.status()}`,
      };
    } catch (error) {
      return {
        name,
        url,
        healthy: false,
        responseTime: Date.now() - startTime,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Check all required services
   * Only checks HTTP endpoints - MongoDB, Redis, OpenSearch verified separately
   */
  async checkAllServices(): Promise<ServicesHealthReport> {
    const services = [
      { name: 'Runtime', url: 'http://localhost:3112/health' },
      { name: 'Studio', url: 'http://localhost:5173' },
      { name: 'SearchAI', url: 'http://localhost:3113/health' },
      { name: 'SearchAI Runtime', url: 'http://localhost:3114/health' },
      { name: 'Docling', url: 'http://localhost:8085/health' },
      { name: 'BGE-M3', url: 'http://localhost:8006/health' },
    ];

    const results = await Promise.all(
      services.map(({ name, url }) => this.checkService(name, url)),
    );

    const allHealthy = results.every((result) => result.healthy);

    return {
      allHealthy,
      services: results,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Wait for a service to become healthy
   */
  async waitForService(
    name: string,
    url: string,
    timeoutMs = 30000,
    pollIntervalMs = 1000,
  ): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const health = await this.checkService(name, url, pollIntervalMs);

      if (health.healthy) {
        console.log(`✓ ${name} is healthy (${health.responseTime}ms)`);
        return;
      }

      console.log(`⏳ Waiting for ${name}... (${health.error})`);
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    throw new Error(`Timeout waiting for ${name} to become healthy`);
  }

  /**
   * Wait for all services to become healthy
   */
  async waitForAllServices(timeoutMs = 60000): Promise<void> {
    console.log('⏳ Waiting for all services to be healthy...');

    const services = [
      { name: 'Runtime', url: 'http://localhost:3112/health' },
      { name: 'Studio', url: 'http://localhost:5173' },
      { name: 'SearchAI', url: 'http://localhost:3113/health' },
      { name: 'SearchAI Runtime', url: 'http://localhost:3114/health' },
      { name: 'Docling', url: 'http://localhost:8085/health' },
      { name: 'BGE-M3', url: 'http://localhost:8006/health' },
    ];

    const startTime = Date.now();
    const results = await Promise.allSettled(
      services.map(({ name, url }) =>
        this.waitForService(name, url, timeoutMs - (Date.now() - startTime)),
      ),
    );

    const failed = results.filter((r) => r.status === 'rejected');

    if (failed.length > 0) {
      const errors = failed
        .map((r, i) => `${services[i].name}: ${r.status === 'rejected' ? r.reason : 'unknown'}`)
        .join('\n');
      throw new Error(`Services failed to start:\n${errors}`);
    }

    console.log('✓ All services are healthy');
  }

  /**
   * Print health report
   */
  printHealthReport(report: ServicesHealthReport): void {
    console.log('\n=== Service Health Report ===');
    console.log(`Timestamp: ${report.timestamp}`);
    console.log(`All Healthy: ${report.allHealthy ? '✓' : '✗'}\n`);

    for (const service of report.services) {
      const status = service.healthy ? '✓' : '✗';
      const time = service.responseTime ? `(${service.responseTime}ms)` : '';
      const error = service.error ? ` - ${service.error}` : '';
      console.log(`${status} ${service.name.padEnd(20)} ${time}${error}`);
    }

    console.log('=============================\n');
  }

  /**
   * Check Docling service specifically
   */
  async checkDoclingService(): Promise<{
    healthy: boolean;
    version?: string;
    models?: string[];
    error?: string;
  }> {
    try {
      const response = await this.request.get('http://localhost:8085/health');

      if (!response.ok()) {
        return {
          healthy: false,
          error: `HTTP ${response.status()}`,
        };
      }

      const body = await response.json();

      return {
        healthy: true,
        version: body.version,
        models: body.models,
      };
    } catch (error) {
      return {
        healthy: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Check BGE-M3 embedding service specifically
   */
  async checkBGEM3Service(): Promise<{
    healthy: boolean;
    modelName?: string;
    dimensions?: number;
    error?: string;
  }> {
    try {
      const response = await this.request.get('http://localhost:8006/health');

      if (!response.ok()) {
        return {
          healthy: false,
          error: `HTTP ${response.status()}`,
        };
      }

      const body = await response.json();

      return {
        healthy: true,
        modelName: body.model_name || 'BAAI/bge-m3',
        dimensions: body.dimensions || 1024,
      };
    } catch (error) {
      return {
        healthy: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
