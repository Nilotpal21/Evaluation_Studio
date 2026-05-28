import { describe, expect, test } from 'vitest';
import { formatAuditEntriesAsCsv } from '../lib/audit-page-export';

describe('audit page CSV export', () => {
  test('formats compatibility-decoded audit rows as CSV safely', () => {
    const csv = formatAuditEntriesAsCsv([
      {
        timestamp: new Date('2026-04-20T10:00:00.000Z'),
        actor: 'admin-1',
        actorRole: 'ADMIN',
        action: 'secret_rotate',
        target: 'secrets/prod/api-key',
        environment: 'production',
        ipAddress: '10.0.0.1',
      },
      {
        timestamp: new Date('2026-04-20T11:00:00.000Z'),
        actor: 'admin-2',
        actorRole: 'OPERATOR',
        action: 'config_view',
        target: 'config/"quoted",value',
        environment: 'staging',
        ipAddress: undefined,
      },
    ]);

    expect(csv.split('\n')).toHaveLength(3);
    expect(csv).toContain('"2026-04-20T10:00:00.000Z","admin-1","ADMIN","secret_rotate"');
    expect(csv).toContain('"config/""quoted"",value"');
    expect(csv).toContain('"staging",""');
  });
});
