'use client';

/**
 * ProposalSecurityGate
 *
 * Displays the security gate status: pass/fail, scope breadth,
 * permission mode, and whether approval is required.
 */

import { ShieldCheck, ShieldAlert } from 'lucide-react';
import { Badge } from '../../ui/Badge';

interface ProposalSecurityGateProps {
  status: string;
  approvalRequired: boolean;
  scopeBreadth: string;
  permissionMode: string;
  labels: {
    status_label: string;
    status_pass: string;
    status_fail: string;
    approval_required: string;
    approval_not_required: string;
    scope_breadth: string;
    permission_mode: string;
  };
}

export function ProposalSecurityGate({
  status,
  approvalRequired,
  scopeBreadth,
  permissionMode,
  labels,
}: ProposalSecurityGateProps) {
  const isPass = status === 'pass';

  return (
    <div className="space-y-3">
      {/* Status */}
      <div className="flex items-center gap-2">
        {isPass ? (
          <ShieldCheck className="w-5 h-5 text-success flex-shrink-0" />
        ) : (
          <ShieldAlert className="w-5 h-5 text-error flex-shrink-0" />
        )}
        <span className="text-sm text-muted">{labels.status_label}:</span>
        <Badge variant={isPass ? 'success' : 'error'}>
          {isPass ? labels.status_pass : labels.status_fail}
        </Badge>
      </div>

      {/* Approval */}
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted">{labels.approval_required}:</span>
        <span className="text-sm font-medium text-foreground">
          {approvalRequired ? labels.approval_required : labels.approval_not_required}
        </span>
      </div>

      {/* Scope breadth */}
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted">{labels.scope_breadth}:</span>
        <Badge variant="default">{scopeBreadth}</Badge>
      </div>

      {/* Permission mode */}
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted">{labels.permission_mode}:</span>
        <Badge variant={permissionMode === 'enabled' ? 'success' : 'warning'}>
          {permissionMode}
        </Badge>
      </div>
    </div>
  );
}
