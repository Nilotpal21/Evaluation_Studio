export interface IConnectorAuditEntry {
  _id: string;
  connectorId: string;
  tenantId: string;
  timestamp: Date;
  actor: string;
  actorType: 'user' | 'system';
  event: string;
  category: 'auth' | 'config' | 'sync' | 'permission' | 'lifecycle';
  metadata: Record<string, unknown>;
  _v: number;
  createdAt: Date;
  updatedAt: Date;
}
