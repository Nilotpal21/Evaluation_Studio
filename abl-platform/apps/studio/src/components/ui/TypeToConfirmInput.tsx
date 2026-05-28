/**
 * TypeToConfirmInput Component
 *
 * A confirmation pattern requiring the user to type a specific phrase
 * before a destructive action is enabled. Used for disabling permissions,
 * deleting connectors, emergency revoke, etc.
 *
 * i18n: This component receives translated strings as props.
 * The parent is responsible for calling useTranslations() and passing
 * confirmLabel, cancelLabel, warningMessage, etc.
 */

import { useState, type ReactElement } from 'react';
import { Input } from './Input';
import { Button } from './Button';

interface TypeToConfirmInputProps {
  /** The exact text the user must type (case-insensitive match) */
  confirmText: string;
  /** Callback when the user confirms (types correct text and clicks confirm) */
  onConfirm: () => void;
  /** Callback to cancel */
  onCancel: () => void;
  /** Warning message displayed above the input */
  warningMessage: string;
  /** Bullet list of consequences */
  consequences?: string[];
  /** "Appropriate only when" guidance */
  appropriateWhen?: string[];
  /** Label for the confirm button (default: "Confirm") */
  confirmLabel?: string;
  /** Label for the cancel button (default: "Cancel") */
  cancelLabel?: string;
  /** Variant for styling (default: "danger") */
  variant?: 'danger' | 'warning';
  /** Whether the component is in a loading state */
  loading?: boolean;
}

export function TypeToConfirmInput({
  confirmText,
  onConfirm,
  onCancel,
  warningMessage,
  consequences,
  appropriateWhen,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'danger',
  loading = false,
}: TypeToConfirmInputProps): ReactElement {
  const [inputValue, setInputValue] = useState('');

  const isMatch = inputValue.toLowerCase().trim() === confirmText.toLowerCase();

  const borderColor = variant === 'danger' ? 'border-error' : 'border-warning';

  return (
    <div className="space-y-4">
      {/* Warning block */}
      <div className={`rounded-lg border ${borderColor} bg-background-subtle p-4 space-y-3`}>
        <p className="text-sm font-medium text-foreground">{warningMessage}</p>

        {consequences && consequences.length > 0 && (
          <div className="space-y-1">
            <ul className="list-disc list-inside text-sm text-muted space-y-1">
              {consequences.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
          </div>
        )}

        {appropriateWhen && appropriateWhen.length > 0 && (
          <div className="space-y-1">
            <ul className="list-disc list-inside text-sm text-muted space-y-1">
              {appropriateWhen.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Type-to-confirm input */}
      <Input
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        placeholder={`Type "${confirmText}" to confirm`}
        aria-label={`Type ${confirmText} to confirm`}
      />

      {/* Action buttons */}
      <div className="flex items-center justify-end gap-2">
        <Button variant="secondary" onClick={onCancel} disabled={loading}>
          {cancelLabel}
        </Button>
        <Button
          variant="danger"
          onClick={onConfirm}
          disabled={!isMatch || loading}
          loading={loading}
        >
          {confirmLabel}
        </Button>
      </div>
    </div>
  );
}
