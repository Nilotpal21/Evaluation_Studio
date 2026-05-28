import { Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';

interface AIAuthoredBadgeProps {
  label?: string;
}

/**
 * AIAuthoredBadge — consistent visual marker for AI-generated content.
 *
 * Use wherever a piece of content was produced by an AI model (personas,
 * scenarios, recommendations, etc.) so users can distinguish AI-generated
 * items from manually created ones at a glance.
 */
export function AIAuthoredBadge({ label = 'AI' }: AIAuthoredBadgeProps) {
  return (
    <Badge variant="accent">
      <span className="flex items-center gap-1">
        <Sparkles className="w-2.5 h-2.5" />
        {label}
      </span>
    </Badge>
  );
}
