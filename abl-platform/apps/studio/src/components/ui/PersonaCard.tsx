/**
 * PersonaCard — display card for an eval persona.
 *
 * Shows name, description, communication style, domain knowledge, behavior
 * traits, and adversarial status. Used in the Evals › Personas tab and the
 * design system gallery.
 */

import { Users, Pencil, Copy, Trash2, Shield } from 'lucide-react';
import { Badge } from './Badge';

export interface PersonaData {
  id: string;
  name: string;
  description?: string;
  communicationStyle: string;
  domainKnowledge: string;
  behaviorTraits?: string[];
  isAdversarial: boolean;
  adversarialType?: string;
  source: string;
  version: number;
  createdAt: string;
}

export interface PersonaCardProps {
  persona: PersonaData;
  onEdit?: () => void;
  onDelete?: () => void;
  onDuplicate?: () => void;
}

export function PersonaCard({ persona, onEdit, onDelete, onDuplicate }: PersonaCardProps) {
  const hasActions = onEdit || onDuplicate || onDelete;

  return (
    <div className="border border-default rounded-xl p-4 bg-background-elevated hover:border-subtle transition-default group">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-background-muted flex items-center justify-center shrink-0">
            <Users className="w-4 h-4 text-muted" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-foreground truncate">{persona.name}</h3>
            {persona.description && (
              <p className="text-xs text-muted truncate">{persona.description}</p>
            )}
          </div>
        </div>
        {hasActions && (
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-default">
            {onEdit && (
              <button
                onClick={onEdit}
                className="p-1 text-muted hover:text-foreground rounded transition-default"
              >
                <Pencil className="w-3.5 h-3.5" />
              </button>
            )}
            {onDuplicate && (
              <button
                onClick={onDuplicate}
                className="p-1 text-muted hover:text-foreground rounded transition-default"
              >
                <Copy className="w-3.5 h-3.5" />
              </button>
            )}
            {onDelete && (
              <button
                onClick={onDelete}
                className="p-1 text-muted hover:text-error rounded transition-default"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5 mb-3">
        <Badge variant={persona.isAdversarial ? 'error' : 'default'}>
          {persona.isAdversarial ? (
            <span className="flex items-center gap-1">
              <Shield className="w-3 h-3" />
              {persona.adversarialType?.replace(/_/g, ' ') ?? 'adversarial'}
            </span>
          ) : (
            persona.source
          )}
        </Badge>
        <Badge variant="accent">{persona.communicationStyle}</Badge>
        <Badge variant="info">{persona.domainKnowledge}</Badge>
      </div>

      {persona.behaviorTraits && persona.behaviorTraits.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {persona.behaviorTraits.slice(0, 4).map((trait) => (
            <span
              key={trait}
              className="text-xs px-1.5 py-0.5 rounded bg-background-muted text-muted"
            >
              {trait}
            </span>
          ))}
          {persona.behaviorTraits.length > 4 && (
            <span className="text-xs px-1.5 py-0.5 text-muted">
              +{persona.behaviorTraits.length - 4}
            </span>
          )}
        </div>
      )}

      <div className="flex items-center justify-between text-xs text-subtle mt-2 pt-2 border-t border-default">
        <span>v{persona.version}</span>
        <span>{new Date(persona.createdAt).toLocaleDateString()}</span>
      </div>
    </div>
  );
}
