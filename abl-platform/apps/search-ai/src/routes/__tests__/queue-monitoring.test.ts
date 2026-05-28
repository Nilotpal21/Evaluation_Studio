/**
 * Queue Monitoring API Tests
 *
 * Integration tests for queue monitoring HTTP endpoints.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import queueMonitoringRouter from '../queue-monitoring.js';

// Mock queue-monitor functions
vi.mock('../../workers/queue-monitor.js', () => ({
  getAllQueueStats: vi.fn(),
  getAllQueueHealth: vi.fn(),
  monitorQueues: vi.fn(),
}));

import { getAllQueueStats, getAllQueueHealth, monitorQueues } from '../../workers/queue-monitor.js';

describe('Queue Monitoring API', () => {
  let app: Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/admin/queues', queueMonitoringRouter);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('GET /api/admin/queues/stats', () => {
    test('should return queue statistics', async () => {
      const mockStats = [
        {
          queueName: 'search-embedding',
          waiting: 10,
          active: 5,
          completed: 100,
          failed: 2,
          delayed: 0,
          total: 117,
          timestamp: new Date('2026-02-23T12:00:00Z'),
        },
        {
          queueName: 'search-page-processing',
          waiting: 5,
          active: 2,
          completed: 50,
          failed: 0,
          delayed: 0,
          total: 57,
          timestamp: new Date('2026-02-23T12:00:00Z'),
        },
      ];

      (getAllQueueStats as any).mockResolvedValue(mockStats);

      const response = await request(app).get('/api/admin/queues/stats').expect(200);

      expect(response.body).toMatchObject({
        success: true,
        timestamp: expect.any(String),
        queues: expect.arrayContaining([
          expect.objectContaining({
            queueName: 'search-embedding',
            waiting: 10,
            active: 5,
            completed: 100,
            failed: 2,
          }),
        ]),
      });

      expect(getAllQueueStats).toHaveBeenCalledOnce();
    });

    test('should handle errors gracefully', async () => {
      (getAllQueueStats as any).mockRejectedValue(new Error('Redis connection failed'));

      const response = await request(app).get('/api/admin/queues/stats').expect(500);

      expect(response.body).toMatchObject({
        success: false,
        error: {
          code: 'STATS_FETCH_FAILED',
          message: 'Redis connection failed',
        },
      });
    });

    test('should return empty array when no queues', async () => {
      (getAllQueueStats as any).mockResolvedValue([]);

      const response = await request(app).get('/api/admin/queues/stats').expect(200);

      expect(response.body).toMatchObject({
        success: true,
        queues: [],
      });
    });
  });

  describe('GET /api/admin/queues/health', () => {
    test('should return health assessment for all queues', async () => {
      const mockHealth = [
        {
          queueName: 'search-embedding',
          status: 'healthy' as const,
          waiting: 10,
          active: 5,
          failed: 2,
          issues: [],
          timestamp: new Date('2026-02-23T12:00:00Z'),
        },
        {
          queueName: 'search-page-processing',
          status: 'degraded' as const,
          waiting: 150,
          active: 10,
          failed: 5,
          issues: ['Moderate backlog: 150 jobs waiting'],
          timestamp: new Date('2026-02-23T12:00:00Z'),
        },
        {
          queueName: 'search-docling-extraction',
          status: 'critical' as const,
          waiting: 1500,
          active: 20,
          failed: 50,
          issues: [
            'Very high backlog: 1500 jobs waiting',
            'High failure rate: 50 failed jobs (3.2%)',
          ],
          timestamp: new Date('2026-02-23T12:00:00Z'),
        },
      ];

      (getAllQueueHealth as any).mockResolvedValue(mockHealth);

      const response = await request(app).get('/api/admin/queues/health').expect(200);

      expect(response.body).toMatchObject({
        success: true,
        timestamp: expect.any(String),
        summary: {
          total: 3,
          healthy: 1,
          degraded: 1,
          critical: 1,
          overallStatus: 'critical', // Critical takes precedence
        },
        queues: expect.arrayContaining([
          expect.objectContaining({
            queueName: 'search-embedding',
            status: 'healthy',
          }),
          expect.objectContaining({
            queueName: 'search-page-processing',
            status: 'degraded',
            issues: ['Moderate backlog: 150 jobs waiting'],
          }),
          expect.objectContaining({
            queueName: 'search-docling-extraction',
            status: 'critical',
          }),
        ]),
      });

      expect(getAllQueueHealth).toHaveBeenCalledOnce();
    });

    test('should return degraded overall status when no critical', async () => {
      const mockHealth = [
        {
          queueName: 'search-embedding',
          status: 'healthy' as const,
          waiting: 10,
          active: 5,
          failed: 2,
          issues: [],
          timestamp: new Date(),
        },
        {
          queueName: 'search-page-processing',
          status: 'degraded' as const,
          waiting: 150,
          active: 10,
          failed: 5,
          issues: ['Moderate backlog: 150 jobs waiting'],
          timestamp: new Date(),
        },
      ];

      (getAllQueueHealth as any).mockResolvedValue(mockHealth);

      const response = await request(app).get('/api/admin/queues/health').expect(200);

      expect(response.body.summary.overallStatus).toBe('degraded');
    });

    test('should return healthy overall status when all healthy', async () => {
      const mockHealth = [
        {
          queueName: 'search-embedding',
          status: 'healthy' as const,
          waiting: 10,
          active: 5,
          failed: 2,
          issues: [],
          timestamp: new Date(),
        },
        {
          queueName: 'search-page-processing',
          status: 'healthy' as const,
          waiting: 20,
          active: 8,
          failed: 1,
          issues: [],
          timestamp: new Date(),
        },
      ];

      (getAllQueueHealth as any).mockResolvedValue(mockHealth);

      const response = await request(app).get('/api/admin/queues/health').expect(200);

      expect(response.body.summary.overallStatus).toBe('healthy');
    });

    test('should handle errors gracefully', async () => {
      (getAllQueueHealth as any).mockRejectedValue(new Error('Network timeout'));

      const response = await request(app).get('/api/admin/queues/health').expect(500);

      expect(response.body).toMatchObject({
        success: false,
        error: {
          code: 'HEALTH_CHECK_FAILED',
          message: 'Network timeout',
        },
      });
    });
  });

  describe('POST /api/admin/queues/monitor', () => {
    test('should trigger on-demand monitoring', async () => {
      (monitorQueues as any).mockResolvedValue(undefined);

      const response = await request(app).post('/api/admin/queues/monitor').expect(200);

      expect(response.body).toMatchObject({
        success: true,
        message: 'Queue monitoring logged to console',
        timestamp: expect.any(String),
      });

      expect(monitorQueues).toHaveBeenCalledOnce();
    });

    test('should handle errors gracefully', async () => {
      (monitorQueues as any).mockRejectedValue(new Error('Internal error'));

      const response = await request(app).post('/api/admin/queues/monitor').expect(500);

      expect(response.body).toMatchObject({
        success: false,
        error: {
          code: 'MONITORING_FAILED',
          message: 'Internal error',
        },
      });
    });
  });

  describe('response structure', () => {
    test('GET /stats should include timestamp', async () => {
      (getAllQueueStats as any).mockResolvedValue([]);

      const response = await request(app).get('/api/admin/queues/stats').expect(200);

      expect(response.body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    test('GET /health should include summary with counts', async () => {
      (getAllQueueHealth as any).mockResolvedValue([
        {
          status: 'healthy',
          queueName: 'q1',
          waiting: 0,
          active: 0,
          failed: 0,
          issues: [],
          timestamp: new Date(),
        },
        {
          status: 'healthy',
          queueName: 'q2',
          waiting: 0,
          active: 0,
          failed: 0,
          issues: [],
          timestamp: new Date(),
        },
      ]);

      const response = await request(app).get('/api/admin/queues/health').expect(200);

      expect(response.body.summary).toMatchObject({
        total: 2,
        healthy: 2,
        degraded: 0,
        critical: 0,
        overallStatus: 'healthy',
      });
    });
  });
});
