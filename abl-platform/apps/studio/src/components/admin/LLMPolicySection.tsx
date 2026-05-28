/**
 * LLMPolicySection Component
 *
 * Admin UI for managing tenant-level LLM governance policies:
 * credential policy, allowed providers, project credentials toggle.
 *
 * platformDemoEnabled is intentionally excluded — it is a superadmin-only setting.
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import { Loader2, Info, Shield, Check } from 'lucide-react';
import { apiFetch } from '../../lib/api-client';
import { useAuthStore } from '../../store/auth-store';
import { Button } from '../ui/Button';
import { RadioGroup } from '../ui/RadioGroup';
import { Tooltip, TooltipProvider } from '../ui/Tooltip';
import { EmptyState } from '../ui/EmptyState';
import { toast } from 'sonner';

// =============================================================================
// TYPES
// =============================================================================

interface LLMPolicy {
  credentialPolicy: string;
  platformDemoEnabled: boolean;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const CREDENTIAL_POLICIES = [
  {
    value: 'org_first',
    label: 'Organization First',
    description: 'Try org credentials first, fall back to user-provided keys.',
  },
  {
    value: 'user_first',
    label: 'User First',
    description: 'Try user credentials first, fall back to org-managed keys.',
  },
  {
    value: 'org_only',
    label: 'Organization Only',
    description: 'Only org-managed credentials are allowed. Users cannot bring their own keys.',
  },
  {
    value: 'user_only',
    label: 'User Only',
    description: 'Only user-provided credentials are allowed. Org does not manage keys centrally.',
  },
] as const;

// =============================================================================
// INFO ICON HELPER
// =============================================================================

function InfoIcon({ tooltip }: { tooltip: string }) {
  return (
    <Tooltip content={tooltip} side="right">
      <button
        type="button"
        className="inline-flex items-center justify-center p-0.5 text-muted hover:text-foreground transition-default rounded"
      >
        <Info className="w-3.5 h-3.5" />
      </button>
    </Tooltip>
  );
}

// =============================================================================
// COMPONENT
// =============================================================================

export function LLMPolicySection() {
  const tenantId = useAuthStore((s) => s.tenantId);
  const [policy, setPolicy] = useState<LLMPolicy | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  // Editable state
  const [credentialPolicy, setCredentialPolicy] = useState('org_first');

  const load = useCallback(async () => {
    if (!tenantId) return;
    setIsLoading(true);
    try {
      const res = await apiFetch(`/api/tenant-llm-policy?tenantId=${tenantId}`);
      if (!res.ok) throw new Error('Failed to load');
      const data = await res.json();
      const p = data.policy;
      setPolicy(p);
      setCredentialPolicy(p.credentialPolicy);
    } catch {
      toast.error('Failed to load LLM policy');
    } finally {
      setIsLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSave = async () => {
    if (!tenantId) return;
    setIsSaving(true);
    try {
      const res = await apiFetch(`/api/tenant-llm-policy?tenantId=${tenantId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          credentialPolicy,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to save');
      }
      const data = await res.json();
      setPolicy(data.policy);
      toast.success('LLM policy saved');
    } catch (error: any) {
      toast.error(error?.message || 'Failed to save LLM policy');
    } finally {
      setIsSaving(false);
    }
  };

  if (!tenantId) {
    return (
      <EmptyState
        icon={<Shield className="w-6 h-6" />}
        title="No workspace selected"
        description="Select a workspace to manage LLM policies"
      />
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-5 h-5 text-muted animate-spin" />
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div className="space-y-8">
        {/* Credential Policy */}
        <section>
          <div className="flex items-center gap-2 mb-3">
            <h3 className="text-sm font-semibold text-foreground">Credential Policy</h3>
            <InfoIcon tooltip="Controls how credentials are resolved when an LLM call is made" />
          </div>
          <RadioGroup
            options={CREDENTIAL_POLICIES.map((cp) => ({
              value: cp.value,
              label: cp.label,
              description: cp.description,
            }))}
            value={credentialPolicy}
            onChange={(v) => setCredentialPolicy(v)}
          />
        </section>

        {/* Platform Demo (read-only info) */}
        {policy?.platformDemoEnabled && (
          <section>
            <div className="flex items-center gap-2 p-3 rounded-lg border border-success/30 bg-success-subtle/30">
              <div className="w-2 h-2 rounded-full bg-success shrink-0" />
              <span className="text-sm text-foreground">
                Platform demo mode is active for this workspace.
              </span>
              <span className="text-xs text-muted ml-auto">Managed by platform admin</span>
            </div>
          </section>
        )}

        {/* Save Button */}
        <div className="flex items-center gap-3 pt-2 border-t border-default">
          <Button
            variant="primary"
            size="sm"
            icon={<Check className="w-3.5 h-3.5" />}
            onClick={handleSave}
            loading={isSaving}
          >
            Save Policy
          </Button>
        </div>
      </div>
    </TooltipProvider>
  );
}
