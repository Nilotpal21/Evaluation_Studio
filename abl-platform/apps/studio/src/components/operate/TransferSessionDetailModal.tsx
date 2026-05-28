'use client';

/**
 * TransferSessionDetailModal
 *
 * Shows full details for a single transfer session in a dialog overlay.
 */

import { useState, useEffect, useCallback } from 'react';
import { Dialog } from '../ui/Dialog';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import type { TransferSession } from '../../api/agent-transfer';
import { STATUS_CONFIG } from './TransferSessionsPage';

interface TransferSessionDetailModalProps {
  session: TransferSession | null;
  open: boolean;
  onClose: () => void;
  onEndSession?: (sessionId: string) => Promise<void>;
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-2 border-b border-default last:border-b-0">
      <span className="text-xs font-medium text-muted w-36 shrink-0 pt-0.5">{label}</span>
      <span className="text-sm text-foreground break-all">{children}</span>
    </div>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

export function TransferSessionDetailModal({
  session,
  open,
  onClose,
  onEndSession,
}: TransferSessionDetailModalProps) {
  const [isEnding, setIsEnding] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);

  // Reset confirmation state on modal close or session change
  useEffect(() => {
    if (!open) setConfirmEnd(false);
  }, [open]);

  // Auto-reset confirmation after 5 seconds
  useEffect(() => {
    if (!confirmEnd) return;
    const timer = setTimeout(() => setConfirmEnd(false), 5_000);
    return () => clearTimeout(timer);
  }, [confirmEnd]);

  const handleClose = useCallback(() => {
    setConfirmEnd(false);
    onClose();
  }, [onClose]);

  if (!session) return null;

  const statusCfg = STATUS_CONFIG[session.state] ?? STATUS_CONFIG.pending;

  const handleEndSession = async () => {
    if (!onEndSession) return;
    if (!confirmEnd) {
      setConfirmEnd(true);
      return;
    }
    setIsEnding(true);
    try {
      await onEndSession(session.id);
      handleClose();
    } finally {
      setIsEnding(false);
      setConfirmEnd(false);
    }
  };

  return (
    <Dialog open={open} onClose={handleClose} title="Transfer Session Details" maxWidth="lg">
      <div className="space-y-1">
        <DetailRow label="Session ID">
          <code className="text-xs bg-background-muted px-1.5 py-0.5 rounded">{session.id}</code>
        </DetailRow>

        <DetailRow label="Contact ID">
          <code className="text-xs bg-background-muted px-1.5 py-0.5 rounded">
            {session.contactId}
          </code>
        </DetailRow>

        <DetailRow label="Agent">{session.agentName ?? session.agentId}</DetailRow>

        <DetailRow label="Provider">{session.provider}</DetailRow>

        <DetailRow label="Status">
          <Badge variant={statusCfg.variant} dot>
            {statusCfg.label}
          </Badge>
        </DetailRow>

        <DetailRow label="Channel">{session.channel}</DetailRow>

        {session.queue && <DetailRow label="Queue">{session.queue}</DetailRow>}

        {session.skills && session.skills.length > 0 && (
          <DetailRow label="Skills">
            <div className="flex flex-wrap gap-1">
              {session.skills.map((skill) => (
                <Badge key={skill} variant="accent">
                  {skill}
                </Badge>
              ))}
            </div>
          </DetailRow>
        )}

        {session.priority != null && <DetailRow label="Priority">{session.priority}</DetailRow>}

        {session.providerSessionId && (
          <DetailRow label="Provider Session ID">
            <code className="text-xs bg-background-muted px-1.5 py-0.5 rounded">
              {session.providerSessionId}
            </code>
          </DetailRow>
        )}

        <DetailRow label="Created At">{formatDate(session.createdAt)}</DetailRow>
        <DetailRow label="Updated At">{formatDate(session.updatedAt)}</DetailRow>

        {session.csatSurveyType && (
          <DetailRow label="CSAT Survey Type">{session.csatSurveyType}</DetailRow>
        )}

        {session.csatDialogId && (
          <DetailRow label="CSAT Dialog ID">
            <code className="text-xs bg-background-muted px-1.5 py-0.5 rounded">
              {session.csatDialogId}
            </code>
          </DetailRow>
        )}

        {session.dispositionCode && (
          <DetailRow label="Disposition Code">{session.dispositionCode}</DetailRow>
        )}

        {session.wrapUpNotes && <DetailRow label="Wrap-Up Notes">{session.wrapUpNotes}</DetailRow>}

        {session.metadata && Object.keys(session.metadata).length > 0 && (
          <div className="pt-3">
            <p className="text-xs font-medium text-muted mb-2">Metadata</p>
            <pre className="text-xs bg-background-muted border border-default rounded-lg p-3 overflow-auto max-h-48">
              {JSON.stringify(session.metadata, null, 2)}
            </pre>
          </div>
        )}

        {session.providerData && Object.keys(session.providerData).length > 0 && (
          <div className="pt-3">
            <p className="text-xs font-medium text-muted mb-2">Provider Data</p>
            <pre className="text-xs bg-background-muted border border-default rounded-lg p-3 overflow-auto max-h-48">
              {JSON.stringify(session.providerData, null, 2)}
            </pre>
          </div>
        )}

        {onEndSession && session.state !== 'ended' && (
          <div className="pt-4 flex justify-end">
            <Button variant="danger" size="sm" loading={isEnding} onClick={handleEndSession}>
              {confirmEnd ? 'Confirm End?' : 'End Session'}
            </Button>
          </div>
        )}
      </div>
    </Dialog>
  );
}
