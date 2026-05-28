'use client';

/**
 * UserDecisionsLog
 *
 * Read-only list of user decisions made during proposal review.
 * Shows timestamp, user, section, and decision type.
 */

import { Badge, type BadgeVariant } from '../../ui/Badge';

interface Decision {
  timestamp: string;
  user: string;
  section: string;
  decision: string;
  detail?: string;
}

interface UserDecisionsLogProps {
  decisions: Decision[];
  labels: {
    title: string;
    no_decisions: string;
    col_time: string;
    col_user: string;
    col_section: string;
    col_decision: string;
  };
}

const DECISION_BADGE_MAP: Record<string, BadgeVariant> = {
  accept: 'success',
  accept_all: 'success',
  modify: 'accent',
  skip: 'warning',
  disable: 'error',
};

export function UserDecisionsLog({ decisions, labels }: UserDecisionsLogProps) {
  if (decisions.length === 0) {
    return <p className="text-xs text-muted">{labels.no_decisions}</p>;
  }

  return (
    <div className="space-y-2">
      <h4 className="text-sm font-semibold text-foreground">{labels.title}</h4>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-default">
              <th className="text-left py-2 px-3 text-xs font-medium text-muted">
                {labels.col_time}
              </th>
              <th className="text-left py-2 px-3 text-xs font-medium text-muted">
                {labels.col_user}
              </th>
              <th className="text-left py-2 px-3 text-xs font-medium text-muted">
                {labels.col_section}
              </th>
              <th className="text-left py-2 px-3 text-xs font-medium text-muted">
                {labels.col_decision}
              </th>
            </tr>
          </thead>
          <tbody>
            {decisions.map((d, idx) => (
              <tr key={idx} className="border-b border-default last:border-b-0">
                <td className="py-2 px-3 text-muted text-xs">
                  {new Date(d.timestamp).toLocaleString(undefined, {
                    dateStyle: 'short',
                    timeStyle: 'short',
                  })}
                </td>
                <td className="py-2 px-3 text-foreground">{d.user}</td>
                <td className="py-2 px-3 text-foreground">{d.section}</td>
                <td className="py-2 px-3">
                  <Badge variant={DECISION_BADGE_MAP[d.decision] ?? 'default'}>{d.decision}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
