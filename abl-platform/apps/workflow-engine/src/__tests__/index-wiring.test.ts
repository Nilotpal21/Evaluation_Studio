import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('index.ts wiring', () => {
  const indexPath = path.resolve(__dirname, '../index.ts');
  const source = fs.readFileSync(indexPath, 'utf-8');

  it('should not contain createStub functions in production code', () => {
    expect(source).not.toContain('createStubModel');
    expect(source).not.toContain('createStubRestateClient');
    expect(source).not.toContain('createStubPublisher');
    expect(source).not.toContain('createStubRegistry');
  });

  it('should contain real service imports', () => {
    expect(source).toContain('initDatabase');
    expect(source).toContain('initRedis');
    expect(source).toContain('EncryptionService');
    expect(source).toContain('ConnectorRegistry');
    expect(source).toContain('RestateWorkflowClient');
  });

  it('should contain real model imports', () => {
    expect(source).toContain('Workflow');
    expect(source).toContain('WorkflowExecution');
    expect(source).toContain('ConnectorConnection');
  });

  it('should contain shutdown hooks for Redis and MongoDB', () => {
    expect(source).toContain('disconnectRedis');
    expect(source).toContain('disconnectDatabase');
  });

  it('should check database availability in readiness probe', () => {
    expect(source).toContain('isDatabaseAvailable');
  });

  it('should gate readiness on Restate health, not registration', () => {
    expect(source).toContain('isRestateHealthy');
    expect(source).toContain('checkRestateHealth');
    expect(source).toContain('startRestateHealthCheck');
    // Readiness must NOT gate on registration to avoid the bootstrap deadlock
    expect(source).not.toMatch(/if\s*\(\s*!isRestateRegistered\s*\)/);
  });

  it('should use async startup pattern', () => {
    expect(source).toContain('async function start()');
    expect(source).toContain('start().catch');
  });

  it('should wire Restate endpoint with persistence and publisher', () => {
    expect(source).toContain('ExecutionStore');
    expect(source).toContain('publisherAdapter');
    expect(source).toContain('buildRestateEndpoint');
    expect(source).toContain('restateEndpoint.listen');
  });

  it('should wire notification dispatcher with real class', () => {
    expect(source).toContain('NotificationDispatcher');
    expect(source).not.toContain("log.warn('Notification sendTest is stubbed");
  });

  it('should register Restate endpoint URL, not Express URL', () => {
    expect(source).toContain('RESTATE_ENDPOINT_URL');
    expect(source).toContain('RESTATE_ENDPOINT_PORT');
  });
});
