/**
 * Encryption Availability Analyzer
 *
 * Checks whether the infrastructure prerequisites for credential
 * decryption and database access are available. Reports warnings/errors
 * when the encryption master key is missing or the database is disconnected.
 */

import mongoose from 'mongoose';
import { createLogger } from '@abl/compiler/platform';
import type { Analyzer, DiagnosticContext, DiagnosticFinding } from '../types.js';

const log = createLogger('diag-encryption-availability');

export class EncryptionAvailabilityAnalyzer implements Analyzer {
  name = 'encryption-availability';
  category = 'infra' as const;

  async analyze(context: DiagnosticContext): Promise<DiagnosticFinding[]> {
    const findings: DiagnosticFinding[] = [];

    try {
      const hasMasterKey = !!process.env.ENCRYPTION_MASTER_KEY;
      const dbReadyState = mongoose.connection.readyState;
      // mongoose readyState: 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
      const dbConnected = dbReadyState === 1;

      if (!hasMasterKey) {
        findings.push({
          analyzer: this.name,
          severity: 'warning',
          code: 'ENCRYPTION_UNAVAILABLE',
          title: 'Encryption master key not set',
          detail:
            'Encrypted credentials cannot be decrypted. The ENCRYPTION_MASTER_KEY environment variable is not configured.',
          suggestion:
            'Set the ENCRYPTION_MASTER_KEY environment variable in your deployment configuration.',
          evidence: [
            {
              type: 'config' as const,
              label: 'ENCRYPTION_MASTER_KEY',
              data: { set: false },
            },
          ],
        });
      }

      if (!dbConnected) {
        findings.push({
          analyzer: this.name,
          severity: 'error',
          code: 'DB_UNAVAILABLE',
          title: 'Database unavailable',
          detail: `Database unavailable, model resolution degraded. Mongoose connection readyState: ${dbReadyState}.`,
          suggestion:
            'Check MongoDB connection string and ensure the database server is reachable.',
          evidence: [
            {
              type: 'config' as const,
              label: 'Mongoose readyState',
              data: { readyState: dbReadyState, connected: false },
            },
          ],
        });
      }

      if (hasMasterKey && dbConnected) {
        findings.push({
          analyzer: this.name,
          severity: 'info',
          code: 'INFRA_OK',
          title: 'Infrastructure prerequisites available',
          detail: 'Encryption master key is set and database is connected.',
          suggestion: 'No action needed.',
          evidence: [
            {
              type: 'config' as const,
              label: 'Infrastructure status',
              data: { encryptionKeySet: true, dbConnected: true, dbReadyState: dbReadyState },
            },
          ],
        });
      }
    } catch (err) {
      log.error('Encryption availability analysis failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      findings.push({
        analyzer: this.name,
        severity: 'warning',
        code: 'ANALYSIS_ERROR',
        title: 'Encryption availability analysis encountered an error',
        detail: err instanceof Error ? err.message : String(err),
        suggestion: 'Check service configuration and try again.',
        evidence: [],
      });
    }

    return findings;
  }
}
