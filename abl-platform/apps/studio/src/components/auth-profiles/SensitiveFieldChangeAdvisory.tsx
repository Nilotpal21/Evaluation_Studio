/**
 * SensitiveFieldChangeAdvisory (FR-25)
 *
 * Fires a sonner toast when a PUT response includes `sensitiveFieldsChanged: string[]`.
 * Not a rendered component — call `showSensitiveFieldAdvisory(t, fields)` from handlers.
 */

import { toast } from 'sonner';

/**
 * Show a toast advisory when sensitive fields were changed on a profile update.
 *
 * @param t - Translation function scoped to `auth_profiles.advisory`
 * @param sensitiveFieldsChanged - Array of field names from the PUT response
 */
export function showSensitiveFieldAdvisory(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- accepts next-intl Translator
  t: (key: string, values?: any) => string,
  sensitiveFieldsChanged: string[],
): void {
  if (sensitiveFieldsChanged.length === 0) return;

  const fieldsText = sensitiveFieldsChanged.join(', ');

  toast.warning(t('sensitive_field_changed_title'), {
    description: `${t('sensitive_field_changed_message')} ${t('fields_changed', { fields: fieldsText })}`,
    duration: 8000,
  });
}
