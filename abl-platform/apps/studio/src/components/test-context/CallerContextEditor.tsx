/**
 * CallerContextEditor — Caller identity form.
 * Allows setting userId, channel, and custom attributes.
 */

import { useTranslations } from 'next-intl';
import { useTestContextStore } from '../../store/test-context-store';
import { VariableEditor } from './VariableEditor';

const CHANNEL_OPTIONS = ['web_debug', 'web_chat', 'api', 'voice', 'sms', 'whatsapp'];

export function CallerContextEditor() {
  const t = useTranslations('test_context.caller');
  const callerContext = useTestContextStore((s) => s.callerContext);
  const updateCallerContext = useTestContextStore((s) => s.updateCallerContext);

  return (
    <div className="space-y-2">
      {/* User ID */}
      <div>
        <label className="text-xs text-subtle">{t('user_id')}</label>
        <input
          type="text"
          value={callerContext.userId || ''}
          onChange={(e) => updateCallerContext({ userId: e.target.value || undefined })}
          placeholder={t('user_id_placeholder')}
          className="w-full px-2 py-1 text-xs bg-background-elevated border border-default rounded text-foreground font-mono placeholder:text-subtle"
        />
      </div>

      {/* Channel */}
      <div>
        <label className="text-xs text-subtle">{t('channel')}</label>
        <select
          value={callerContext.channel || ''}
          onChange={(e) => updateCallerContext({ channel: e.target.value || undefined })}
          className="w-full px-2 py-1 text-xs bg-background-elevated border border-default rounded text-foreground"
        >
          <option value="">{t('default')}</option>
          {CHANNEL_OPTIONS.map((ch) => (
            <option key={ch} value={ch}>
              {ch}
            </option>
          ))}
        </select>
      </div>

      {/* Custom Attributes */}
      <div>
        <label className="text-xs text-subtle">{t('custom_attributes')}</label>
        <VariableEditor
          values={callerContext.customAttributes || {}}
          onUpdate={(key, value) =>
            updateCallerContext({
              customAttributes: { ...callerContext.customAttributes, [key]: value },
            })
          }
          onRemove={(key) => {
            const { [key]: _, ...rest } = callerContext.customAttributes || {};
            updateCallerContext({
              customAttributes: Object.keys(rest).length > 0 ? rest : undefined,
            });
          }}
          placeholder={t('attribute_placeholder')}
        />
      </div>
    </div>
  );
}
