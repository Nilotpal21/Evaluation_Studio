import Link from 'next/link';
import { BookOpen, FileText, Sparkles, Bot, GitPullRequestArrow, ArrowUpRight } from 'lucide-react';
import { Footer } from '@/components/shell/Footer';

const sections = [
  {
    icon: BookOpen,
    title: 'Getting started',
    description:
      'A 10-minute tour of the platform: upload your first SOP, review the generated app, submit for approval, and deploy.',
    items: [
      { label: 'What is Eltropy for credit unions?', href: '#' },
      { label: 'Your first SOP upload', href: '#' },
      { label: 'Walking through Review Studio', href: '#' },
      { label: 'Submitting and getting approved', href: '#' },
    ],
  },
  {
    icon: Bot,
    title: 'Building apps',
    description: 'Concepts and how-tos for the app-authoring layer.',
    items: [
      { label: 'How auto-generation works', href: '#' },
      { label: 'Sub-agents reference', href: '#' },
      { label: 'Knowledge attachment', href: '#' },
      { label: 'Guardrails: baseline vs custom', href: '#' },
      { label: 'Memory modes', href: '#' },
    ],
  },
  {
    icon: GitPullRequestArrow,
    title: 'Evaluation',
    description: 'Understanding the score-based evaluation system.',
    items: [
      { label: 'Three test sources explained', href: '#' },
      { label: 'Reading the Evaluation Report', href: '#' },
      { label: 'Continuous evaluation in production', href: '#' },
      { label: 'Authoring your own scenarios', href: '#' },
    ],
  },
  {
    icon: Sparkles,
    title: 'AI Helper',
    description: 'How to use the always-on Helper effectively.',
    items: [
      { label: 'When to ask the Helper', href: '#' },
      { label: 'Context-anchored conversations', href: '#' },
      { label: 'Suggested actions: Confirm vs Skip', href: '#' },
      { label: 'What the Helper can and can\'t do', href: '#' },
    ],
  },
  {
    icon: FileText,
    title: 'Reference',
    description: 'Specs and source documents.',
    items: [
      { label: 'Business Requirements Document (BRD)', href: '#' },
      { label: 'Executive brief (CXO summary)', href: '#' },
      { label: 'Visual prototype PRD', href: '#' },
      { label: 'BRD glossary', href: '#' },
    ],
  },
];

export default function DocsPage() {
  return (
    <div className="space-y-5">
      <header className="pb-4 border-b border-border-muted">
        <h1 className="text-2xl font-semibold tracking-tight">Docs</h1>
        <p className="text-xs text-foreground-muted mt-1.5">
          Concepts, how-tos, and reference material for the Eltropy platform.
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
        Docs in this prototype are placeholders. The real platform serves a versioned doc site
        federated through your AI Helper.
      </p>

      <Footer />
    </div>
  );
}
