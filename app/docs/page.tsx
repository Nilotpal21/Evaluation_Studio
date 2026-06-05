import Link from 'next/link';
import { BookOpen, FileText, Sparkles, Bot, ShieldCheck, ArrowUpRight } from 'lucide-react';
import { Footer } from '@/components/shell/Footer';

const sections = [
  {
    icon: BookOpen,
    title: 'Getting started',
    description:
      'Set up projects, browse app catalogs, and create your first connector safely.',
    items: [
      { label: 'What is cloudagle.ai Integrations?', href: '#' },
      { label: 'Project → App → Connector hierarchy', href: '#' },
      { label: 'Creating your first connection', href: '#' },
      { label: 'Sandbox-first activation flow', href: '#' },
    ],
  },
  {
    icon: Bot,
    title: 'Connector builder',
    description: 'Concepts and how-tos for scratch creation and template-based setup.',
    items: [
      { label: 'Start from scratch vs use template', href: '#' },
      { label: 'Parsed spec as source of truth', href: '#' },
      { label: 'Component generation for v1', href: '#' },
      { label: 'Connector lifecycle: active, disabled, revoked', href: '#' },
      { label: 'Reauthorize, revoke, and delete behavior', href: '#' },
    ],
  },
  {
    icon: ShieldCheck,
    title: 'Safeguards',
    description: 'Guardrails and operational checks for customer-configured integrations.',
    items: [
      { label: 'Why sandbox testing is required first', href: '#' },
      { label: 'Credential handling and secret safety', href: '#' },
      { label: 'Read-only v1 constraints', href: '#' },
      { label: 'Activation, disable, and revoke rules', href: '#' },
    ],
  },
  {
    icon: Sparkles,
    title: 'Mode hub',
    description: 'Manage the AI providers and models exposed during integration setup.',
    items: [
      { label: 'Provider and model configuration', href: '#' },
      { label: 'Parsing defaults vs generation defaults', href: '#' },
      { label: 'Multiple API-key-backed model entries', href: '#' },
      { label: 'Exposing models in integration setup', href: '#' },
    ],
  },
  {
    icon: FileText,
    title: 'Reference',
    description: 'Product rules, mock data, and supporting artifacts for this prototype.',
    items: [
      { label: 'Integration builder PRD', href: '#' },
      { label: 'UI prototype specification', href: '#' },
      { label: 'Connector state model', href: '#' },
      { label: 'Mode hub model inventory', href: '#' },
    ],
  },
];

export default function DocsPage() {
  return (
    <div className="space-y-5">
      <header className="pb-4 border-b border-border-muted">
        <h1 className="text-2xl font-semibold tracking-tight">Docs</h1>
        <p className="text-xs text-foreground-muted mt-1.5">
          Concepts, how-tos, and reference material for the integration platform.
        </p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {sections.map((s) => {
          const Icon = s.icon;
          return (
            <section
              key={s.title}
              className="rounded-lg border border-border-muted bg-background-subtle p-5"
            >
              <header className="flex items-start gap-3 mb-4">
                <div className="size-8 rounded-md bg-background-elevated border border-border-muted flex items-center justify-center shrink-0">
                  <Icon className="size-4 text-foreground-muted" />
                </div>
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold tracking-tight">{s.title}</h2>
                  <p className="text-[11px] text-foreground-muted mt-0.5 leading-relaxed">
                    {s.description}
                  </p>
                </div>
              </header>
              <ul className="space-y-1">
                {s.items.map((item) => (
                  <li key={item.label}>
                    <Link
                      href={item.href}
                      className="flex items-center justify-between gap-2 px-2.5 py-1.5 -mx-2.5 rounded-md text-xs text-foreground-muted hover:text-foreground hover:bg-background-muted/60 transition-colors group"
                    >
                      <span>{item.label}</span>
                      <ArrowUpRight className="size-3 text-foreground-subtle group-hover:text-foreground-muted transition-colors shrink-0" />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>

      <p className="text-[11px] text-foreground-subtle text-center">
        Docs in this prototype are placeholders. The production platform would serve versioned
        guidance for projects, apps, connectors, safeguards, and mode configuration.
      </p>

      <Footer />
    </div>
  );
}
