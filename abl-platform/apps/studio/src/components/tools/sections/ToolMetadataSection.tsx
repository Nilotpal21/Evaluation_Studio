/**
 * ToolMetadataSection Component
 *
 * Editable tool metadata: name, description, and basic settings.
 * Clean layout with inline editing and save state management.
 */

import { useState } from 'react';
import { Check, X } from 'lucide-react';
import { Input } from '../../ui/Input';
import { Button } from '../../ui/Button';
import { InfoCard } from '../../ui/InfoCard';
import { ErrorAlert } from '../../ui/ErrorAlert';
import { sanitizeErrors } from '../../../lib/sanitize-error';

interface ToolMetadataSectionProps {
  name: string;
  description: string;
  onUpdate: (data: { name: string; description: string }) => Promise<void>;
  toolType: string;
}

export function ToolMetadataSection({
  name: initialName,
  description: initialDescription,
  onUpdate,
  toolType,
}: ToolMetadataSectionProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | string[] | null>(null);
  const [success, setSuccess] = useState(false);

  const hasChanges = name !== initialName || description !== initialDescription;
  const isValid = name.trim().length >= 2;

  const handleSave = async () => {
    if (!isValid) {
      setError('Tool name must be at least 2 characters');
      return;
    }

    setSaving(true);
    setError(null);
    setSuccess(false);

    try {
      await onUpdate({
        name: name.trim(),
        description: description.trim(),
      });
      setSuccess(true);
      setIsEditing(false);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError(sanitizeErrors(err, 'Failed to update metadata'));
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setName(initialName);
    setDescription(initialDescription);
    setIsEditing(false);
    setError(null);
  };

  return (
    <div className="space-y-5">
      {/* Actions bar */}
      <div className="flex items-center justify-end">
        {!isEditing ? (
          <Button variant="ghost" size="sm" onClick={() => setIsEditing(true)}>
            Edit
          </Button>
        ) : (
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={handleCancel} disabled={saving}>
              <X className="w-3.5 h-3.5" />
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleSave}
              disabled={!hasChanges || !isValid || saving}
              loading={saving}
              icon={<Check className="w-3.5 h-3.5" />}
            >
              Save
            </Button>
          </div>
        )}
      </div>

      {success && (
        <InfoCard
          variant="success"
          message="Metadata updated successfully"
          size="sm"
          onDismiss={() => setSuccess(false)}
        />
      )}

      {error && <ErrorAlert error={error} onDismiss={() => setError(null)} />}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <Input
            label="Tool Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={!isEditing}
            error={
              isEditing && name.length > 0 && !isValid
                ? 'Name must be at least 2 characters'
                : undefined
            }
            placeholder="my_tool_name"
          />
          <p className="text-xs text-muted mt-1.5">
            Unique identifier used by agents to call this tool
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-foreground mb-1.5">Tool Type</label>
          <div className="px-3 py-2 rounded-lg bg-background-muted border border-default text-sm font-medium text-foreground capitalize">
            {toolType}
          </div>
          <p className="text-xs text-muted mt-1.5">Tool type cannot be changed after creation</p>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-foreground mb-1.5">Description</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={!isEditing}
          placeholder="Describe what this tool does and when agents should use it..."
          rows={3}
          className="w-full rounded-lg border border-default bg-background-subtle text-foreground text-sm p-3 transition-default focus:outline-none focus:border-border-focus focus:ring-1 focus:ring-border-focus resize-y disabled:opacity-60 disabled:cursor-not-allowed"
        />
        <p className="text-xs text-muted mt-1.5">
          Clear description helps the LLM decide when to use this tool
        </p>
      </div>

      {isEditing && hasChanges && (
        <InfoCard
          variant="info"
          message="You have unsaved changes. Click Save to update the tool metadata."
          size="sm"
        />
      )}
    </div>
  );
}
