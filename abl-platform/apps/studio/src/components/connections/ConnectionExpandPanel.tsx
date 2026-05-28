/**
 * ConnectionExpandPanel Component
 *
 * Inline expand panel that slides open below a card row.
 * Shows connection details, status, and action buttons (test/edit/disconnect).
 */

'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Badge } from '../ui/Badge';
import { testConnection, deleteConnection, updateConnection } from '../../api/connections';
import { sanitizeError } from '../../lib/sanitize-error';
import type { ConnectionSummary } from '../../api/connections';
import { DoclingQuotaView } from '../projects/DoclingQuotaView';

interface ConnectionExpandPanelProps {
  connection: ConnectionSummary;
  projectId: string;
  onDeleted: () => void;
  onUpdated: () => void;
}

type TestState = 'idle' | 'testing' | 'success' | 'error';
type PanelMode = 'view' | 'edit' | 'confirm-disconnect';

export function ConnectionExpandPanel({
  connection,
  projectId,
  onDeleted,
  onUpdated,
}: ConnectionExpandPanelProps) {
  const [testState, setTestState] = useState<TestState>('idle');
  const [testError, setTestError] = useState<string | null>(null);
  const [mode, setMode] = useState<PanelMode>('view');
  const [editName, setEditName] = useState(connection.displayName);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function handleTest() {
    setTestState('testing');
    setTestError(null);
    try {
      await testConnection(projectId, connection.id);
      setTestState('success');
      setTimeout(() => setTestState('idle'), 2000);
    } catch (err) {
      setTestState('error');
      setTestError(sanitizeError(err, 'Connection test failed'));
      setTimeout(() => setTestState('idle'), 3000);
    }
  }

  async function handleSave() {
    setSaving(true);
    setActionError(null);
    try {
      await updateConnection(projectId, connection.id, {
        displayName: editName,
      });
      onUpdated();
      setMode('view');
    } catch (err) {
      setActionError(sanitizeError(err, 'Failed to save connection'));
    } finally {
      setSaving(false);
    }
  }

  async function handleDisconnect() {
    setDeleting(true);
    setActionError(null);
    try {
      await deleteConnection(projectId, connection.id);
      onDeleted();
    } catch (err) {
      setActionError(sanitizeError(err, 'Failed to disconnect'));
      setDeleting(false);
    }
  }

  const formatDate = (d: string) =>
    new Date(d).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });

  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className="overflow-hidden col-span-full"
    >
      <div className="rounded-xl border border-default bg-background-elevated p-5 mt-2 mb-4">
        {/* Info grid */}
        <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
          <div>
            <span className="text-muted">Status</span>
            <span className="ml-2">
              <Badge variant={connection.status === 'active' ? 'success' : 'error'} dot>
                {connection.status}
              </Badge>
            </span>
          </div>
          <div>
            <span className="text-muted">Created</span>
            <span className="ml-2 text-foreground">{formatDate(connection.createdAt)}</span>
          </div>
        </div>

        {/* Connector-specific operational panels (rate-limit, usage caps, etc.) */}
        {connection.connectorName === 'docling' && (
          <div className="mt-4 border-t border-default pt-4">
            <DoclingQuotaView projectId={projectId} />
          </div>
        )}
        {/* Actions */}
        <div className="mt-4 border-t border-default pt-4">
          <AnimatePresence mode="wait">
            {mode === 'view' && (
              <motion.div
                key="actions"
                className="flex items-center gap-2"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleTest}
                  loading={testState === 'testing'}
                >
                  {testState === 'success'
                    ? 'Connected'
                    : testState === 'error'
                      ? 'Failed'
                      : 'Test Connection'}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setMode('edit')}>
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setMode('confirm-disconnect')}
                  className="text-error hover:text-error"
                >
                  Disconnect
                </Button>
              </motion.div>
            )}

            {mode === 'edit' && (
              <motion.div
                key="edit"
                className="space-y-3"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                <Input
                  label="Connection name"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                />
                <div className="flex items-center gap-2">
                  <Button variant="primary" size="sm" onClick={handleSave} loading={saving}>
                    Save
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setMode('view');
                      setEditName(connection.displayName);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </motion.div>
            )}

            {mode === 'confirm-disconnect' && (
              <motion.div
                key="confirm"
                className="space-y-2"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
              >
                <p className="text-sm text-error">
                  Disconnect {connection.displayName}? This cannot be undone.
                </p>
                <div className="flex items-center gap-2">
                  <Button variant="danger" size="sm" onClick={handleDisconnect} loading={deleting}>
                    Disconnect
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setMode('view')}>
                    Cancel
                  </Button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          {testError && <p className="mt-2 text-xs text-error">{testError}</p>}
          {actionError && <p className="mt-2 text-xs text-error">{actionError}</p>}
        </div>
      </div>
    </motion.div>
  );
}
