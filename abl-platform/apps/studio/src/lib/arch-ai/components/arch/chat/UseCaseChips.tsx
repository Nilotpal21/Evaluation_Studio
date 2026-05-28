'use client';

/**
 * UseCaseChips — Zone C of the Arch entry state.
 * Horizontal pill chips describing what the user wants to automate.
 */

import { Headphones, Calendar, UserCheck } from 'lucide-react';

interface ChipSelectPayload {
  chatPrompt: string;
  projectName: string;
  projectDescription: string;
}

interface UseCaseChipsProps {
  onSelect: (payload: ChipSelectPayload) => void;
}

const USE_CASES = [
  {
    icon: Headphones,
    label: 'Automate customer support',
    projectName: 'Customer Support Agent',
    projectDescription:
      'Automate customer support with intelligent query routing, FAQ handling, and seamless escalation to human agents.',
    chatPrompt: 'Build a customer support agent for e-commerce',
  },
  {
    icon: Calendar,
    label: 'Let customers book appointments',
    projectName: 'Appointment Booking Agent',
    projectDescription:
      'Allow customers to check availability, book appointments, and receive confirmations without human intervention.',
    chatPrompt: 'Create an appointment booking system',
  },
  {
    icon: UserCheck,
    label: 'Qualify leads before sales',
    projectName: 'Lead Qualification Agent',
    projectDescription:
      'Engage inbound leads with targeted questions, score them by fit, and route high-value prospects to sales.',
    chatPrompt: 'Help me build a lead qualification agent',
  },
] as const;

export function UseCaseChips({ onSelect }: UseCaseChipsProps) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-foreground/35">What do you want to automate?</p>
      <div className="flex flex-wrap gap-2">
        {USE_CASES.map(({ icon: Icon, label, projectName, projectDescription, chatPrompt }) => (
          <button
            key={label}
            onClick={() => onSelect({ chatPrompt, projectName, projectDescription })}
            className="inline-flex items-center gap-2 rounded-full border border-border bg-background-elevated px-4 py-2 text-sm font-medium text-foreground/60 transition-colors hover:border-foreground/20 hover:text-foreground/80"
          >
            <Icon className="h-3.5 w-3.5 shrink-0" />
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
