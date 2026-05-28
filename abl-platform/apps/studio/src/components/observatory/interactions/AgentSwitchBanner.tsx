/**
 * AgentSwitchBanner — Dashed banner between interactions on agent change.
 *
 * Styled with dashed amber borders per design spec Section 12.
 */

import clsx from 'clsx';
import type { AgentSwitch } from './types';

interface AgentSwitchBannerProps {
  agentSwitch: AgentSwitch;
}

export function AgentSwitchBanner({ agentSwitch }: AgentSwitchBannerProps) {
  return (
    <div
      className={clsx(
        'mx-3 my-2 px-3 py-2 rounded-md',
        'border border-dashed border-warning/40',
        'bg-warning-subtle',
      )}
    >
      <div className="flex items-center gap-2 text-xs">
        <span className="text-warning font-medium">Agent switched:</span>
        <span className="text-foreground">{agentSwitch.fromAgent}</span>
        <span className="text-foreground-subtle">→</span>
        <span className="text-foreground font-medium">{agentSwitch.toAgent}</span>
      </div>
      <div className="text-[10px] text-foreground-subtle mt-0.5">
        Mode: {agentSwitch.fromMode} → {agentSwitch.toMode}
        {agentSwitch.reason ? ` · ${agentSwitch.reason}` : null}
      </div>
    </div>
  );
}
