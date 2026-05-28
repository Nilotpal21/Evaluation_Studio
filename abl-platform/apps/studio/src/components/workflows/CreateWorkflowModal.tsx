/**
 * CreateWorkflowModal Component
 *
 * Dialog for creating a new workflow in a project from the workflow list page.
 * Collects name, type, and optional description, then calls the createWorkflow API.
 */

import { useState, useCallback } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { sanitizeError } from '@/lib/sanitize-error';
import { AppError } from '@agent-platform/shared/errors';
import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Input';
import { Textarea } from '../ui/Textarea';
import { Button } from '../ui/Button';
import { createWorkflowCanvas } from '../../api/workflows';

// =============================================================================
// TYPES
// =============================================================================

interface CreateWorkflowModalProps {
  projectId: string;
  onCreated: (workflowId: string) => void;
  onClose: () => void;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const MAX_NAME_LENGTH = 30;
const MAX_DESCRIPTION_LENGTH = 500;

// =============================================================================
// COMPONENT
// =============================================================================

export function CreateWorkflowModal({ projectId, onCreated, onClose }: CreateWorkflowModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [nameError, setNameError] = useState('');

  const validateName = useCallback((value: string): string => {
    if (!value.trim()) return 'Workflow name is required';
    if (value.trim().length > MAX_NAME_LENGTH) {
      return `Name must be ${MAX_NAME_LENGTH} characters or fewer`;
    }
    return '';
  }, []);

  const handleSubmit = useCallback(async () => {
    const error = validateName(name);
    if (error) {
      setNameError(error);
      return;
    }

    setIsSubmitting(true);
    setNameError('');

    try {
      const workflow = await createWorkflowCanvas(projectId, {
        name: name.trim(),
        description: description.trim() || undefined,
      });

      toast.success('Workflow created');
      onCreated(workflow.id);
      handleClose();
    } catch (err) {
      if (err instanceof AppError && err.code === 'workflow_name_conflict') {
        setNameError(err.message);
        return;
      }
      const message = sanitizeError(err, 'Failed to create workflow');
      toast.error(message);
    } finally {
      setIsSubmitting(false);
    }
  }, [name, description, projectId, onCreated, validateName]);

  const handleClose = useCallback(() => {
    setName('');
    setDescription('');
    setNameError('');
    onClose();
  }, [onClose]);

  return (
    <Dialog
      open
      onClose={handleClose}
      title="Create Workflow"
      description="Define a new workflow to automate multi-step processes."
    >
      <div className="space-y-4">
        <div>
          <Input
            label="Name"
            placeholder="e.g. Order Fulfillment"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (nameError) setNameError(validateName(e.target.value));
            }}
            error={nameError}
            maxLength={MAX_NAME_LENGTH}
            autoFocus
          />
          <p className="text-xs text-subtle text-right mt-0.5">
            {name.length} / {MAX_NAME_LENGTH}
          </p>
        </div>

        <div>
          <Textarea
            label="Description"
            placeholder="Optional description of what this workflow does"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            maxLength={MAX_DESCRIPTION_LENGTH}
          />
          <p className="text-xs text-subtle text-right mt-0.5">
            {description.length} / {MAX_DESCRIPTION_LENGTH}
          </p>
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <Button variant="ghost" onClick={handleClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isSubmitting || !name.trim()}>
            {isSubmitting ? (
              <span className="flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" />
                Creating...
              </span>
            ) : (
              'Create Workflow'
            )}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
