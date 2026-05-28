'use client';

/**
 * ExternalAgentEditPanel
 *
 * Slide-out panel for editing an external agent configuration.
 * Also displays the discovered agent card if available.
 */

import { useState, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { SlidePanel } from '../ui/SlidePanel';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { Button } from '../ui/Button';
import { ErrorAlert } from '../ui/ErrorAlert';
import { Card } from '../ui/Card';
import {
  updateExternalAgent,
  type ExternalAgentConfig,
  type UpdateExternalAgentInput,
} from '../../api/external-agents';
import { sanitizeErrors } from '../../lib/sanitize-error';
import { SkillChips } from './SkillChips';

interface ExternalAgentEditPanelProps {
  agent: ExternalAgentConfig;
  projectId: string;
  onClose: () => void;
  onUpdated: (agent: ExternalAgentConfig) => void;
}

interface EditFormState {
  displayName: string;
  endpoint: string;
  protocol: 'a2a' | 'rest';
  authType: 'none' | 'bearer' | 'api_key';
  authValue: string;
  authHeader: string;
}

export function ExternalAgentEditPanel({
  agent,
  projectId,
  onClose,
  onUpdated,
}: ExternalAgentEditPanelProps) {
  const t = useTranslations('externalAgents.edit_panel');
  const tRoot = useTranslations('externalAgents');

  const [form, setForm] = useState<EditFormState>({
    displayName: agent.displayName ?? '',
    endpoint: agent.endpoint,
    protocol: agent.protocol,
    authType: agent.authType,
    authValue: '',
    authHeader: '',
  });
  const [saving, setSaving] = useState(false);
  const [apiError, setApiError] = useState<string[] | null>(null);

  const protocolOptions = useMemo(
    () => [
      { value: 'a2a', label: 'A2A' },
      { value: 'rest', label: 'REST' },
    ],
    [],
  );

  const authOptions = useMemo(
    () => [
      { value: 'none', label: tRoot('auth_none') },
      { value: 'bearer', label: tRoot('auth_bearer') },
      { value: 'api_key', label: tRoot('auth_api_key') },
    ],
    [tRoot],
  );

  const updateField = useCallback(
    <K extends keyof EditFormState>(field: K, value: EditFormState[K]) => {
      setForm((prev) => ({ ...prev, [field]: value }));
    },
    [],
  );

  const handleSave = useCallback(async () => {
    setSaving(true);
    setApiError(null);
    try {
      const patch: UpdateExternalAgentInput = {};

      // Only send fields that changed
      if ((form.displayName || null) !== agent.displayName) {
        patch.displayName = form.displayName.trim() || null;
      }
      if (form.endpoint !== agent.endpoint) {
        patch.endpoint = form.endpoint.trim();
      }
      if (form.protocol !== agent.protocol) {
        patch.protocol = form.protocol;
      }
      if (form.authType !== agent.authType) {
        patch.authType = form.authType;
      }

      // Auth config: send if auth value is provided or type changed to none
      if (form.authType === 'none' && agent.authConfigured) {
        patch.authConfig = null;
      } else if (form.authType !== 'none' && form.authValue.trim()) {
        patch.authConfig = {
          value: form.authValue,
          ...(form.authType === 'api_key' && form.authHeader.trim()
            ? { header: form.authHeader.trim() }
            : {}),
        };
      }

      // Only call API if there are changes
      if (Object.keys(patch).length === 0) {
        onClose();
        return;
      }

      const res = await updateExternalAgent(projectId, agent.id, patch);
      onUpdated(res.data);
    } catch (err: unknown) {
      setApiError(sanitizeErrors(err, t('save_error')));
    } finally {
      setSaving(false);
    }
  }, [form, agent, projectId, onUpdated, onClose, t]);

  // ─── Agent Card display ───────────────────────────────────────────────
  const card = agent.lastDiscoveredCard as Record<string, unknown> | null;

  return (
    <SlidePanel open onClose={onClose} title={t('title')} width="lg">
      <div className="space-y-6">
        {apiError && <ErrorAlert error={apiError} onDismiss={() => setApiError(null)} />}

        {/* Agent Card Section */}
        {card ? (
          <Card padding="md" hoverable={false} className="space-y-2">
            <h4 className="text-sm font-medium text-foreground">{t('agent_card')}</h4>
            {typeof card.name === 'string' && card.name && (
              <div>
                <span className="text-xs text-muted">{t('card_name')}</span>
                <p className="text-sm text-foreground">{card.name}</p>
              </div>
            )}
            {typeof card.description === 'string' && card.description && (
              <div>
                <span className="text-xs text-muted">{t('card_description')}</span>
                <p className="text-sm text-foreground">{card.description}</p>
              </div>
            )}
            {typeof card.url === 'string' && card.url && (
              <div>
                <span className="text-xs text-muted">{t('card_url')}</span>
                <p className="text-sm text-foreground truncate">{card.url}</p>
              </div>
            )}
            {Array.isArray(card.skills) && card.skills.length > 0 && (
              <div>
                <span className="text-xs text-muted">{t('card_skills')}</span>
                <SkillChips skills={card.skills as Array<Record<string, unknown>>} />
              </div>
            )}
          </Card>
        ) : (
          <Card padding="md" hoverable={false}>
            <p className="text-sm text-muted">{t('no_card')}</p>
          </Card>
        )}

        {/* Edit Form */}
        <Input
          label={tRoot('register_modal.display_name_label')}
          placeholder={tRoot('register_modal.display_name_placeholder')}
          value={form.displayName}
          onChange={(e) => updateField('displayName', e.target.value)}
        />

        <Input
          label={tRoot('register_modal.endpoint_label')}
          placeholder={tRoot('register_modal.endpoint_placeholder')}
          value={form.endpoint}
          onChange={(e) => updateField('endpoint', e.target.value)}
        />

        <Select
          label={tRoot('register_modal.protocol_label')}
          options={protocolOptions}
          value={form.protocol}
          onChange={(v) => updateField('protocol', v as 'a2a' | 'rest')}
        />

        <Select
          label={tRoot('register_modal.auth_type_label')}
          options={authOptions}
          value={form.authType}
          onChange={(v) => {
            updateField('authType', v as 'none' | 'bearer' | 'api_key');
            if (v === 'none') {
              updateField('authValue', '');
              updateField('authHeader', '');
            }
          }}
        />

        {form.authType !== 'none' && (
          <>
            <Input
              label={tRoot('register_modal.auth_value_label')}
              placeholder={tRoot('register_modal.auth_value_placeholder')}
              value={form.authValue}
              onChange={(e) => updateField('authValue', e.target.value)}
              type="password"
            />
            {form.authType === 'api_key' && (
              <Input
                label={tRoot('register_modal.auth_header_label')}
                placeholder={tRoot('register_modal.auth_header_placeholder')}
                value={form.authHeader}
                onChange={(e) => updateField('authHeader', e.target.value)}
              />
            )}
          </>
        )}

        <div className="flex justify-end gap-3 pt-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {t('cancel')}
          </Button>
          <Button onClick={handleSave} loading={saving} disabled={saving}>
            {saving ? t('saving') : t('save')}
          </Button>
        </div>
      </div>
    </SlidePanel>
  );
}
