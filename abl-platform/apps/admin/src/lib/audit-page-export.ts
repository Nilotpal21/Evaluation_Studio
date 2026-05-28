export interface ExportableAuditEntry {
  timestamp: Date | string;
  actor: string;
  actorRole: string;
  action: string;
  target: string;
  environment?: string;
  ipAddress?: string;
}

export function formatAuditEntriesAsCsv(entries: ExportableAuditEntry[]): string {
  const header = 'Timestamp,Actor,Role,Action,Target,Environment,IP Address';
  const rows = entries.map((entry) =>
    [
      new Date(entry.timestamp).toISOString(),
      entry.actor,
      entry.actorRole,
      entry.action,
      entry.target,
      entry.environment ?? '',
      entry.ipAddress ?? '',
    ]
      .map((value) => `"${String(value).replace(/"/g, '""')}"`)
      .join(','),
  );

  return [header, ...rows].join('\n');
}
