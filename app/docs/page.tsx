import { BookOpen, FileText, FolderKanban, Radar, ShieldCheck, Sparkles } from 'lucide-react';
import { Footer } from '@/components/shell/Footer';

const sections = [
  {
    icon: Sparkles,
    title: 'Evaluation Studio',
    description:
      'Project-first autonomous evaluation across pre-prod qualification and production analysis.',
    items: [
      'Project -> Pre-prod | Prod -> Agent -> Version | Duration flow',
      'Autonomous persona inference, scenario generation, and validator attachment',
      'Benchmark-driven product decisioning for pre-prod promotion',
      'Real-time monitoring, revert, and kill switch controls',
      'Source PRD: 13 — Evaluation Studio',
    ],
  },
  {
    icon: FolderKanban,
    title: 'Projects',
    description:
      'Business-area operating boundaries for agents, reviewers, knowledge, evaluations, and monitoring.',
    items: [
      'Projects list, detail view, and project settings structure',
      'Per-project reviewer pools, knowledge scope, tools, and model overrides',
      'Cost envelope and budget controls',
      'Project-scoped dashboards and audit boundaries',
      'Source PRD: 11 — Projects',
    ],
  },
  {
    icon: ShieldCheck,
    title: 'Approval, Deployment, and Monitoring',
    description:
      'Operational controls that span review, deployment, continuous evaluation, and production safety.',
    items: [
      'Approval workflow and reviewer detail surfaces',
      'Deployment confirmation and post-deploy activation flow',
      'Mission Control, audit log, and production findings',
      'Operator-facing revert and kill switch expectations',
      'Source PRDs: 06 — Approval + Deployment, 07 — Mission Control + Audit',
    ],
  },
  {
    icon: BookOpen,
    title: 'Knowledge and Models',
    description:
      'Reference surfaces for project-scoped knowledge, model configuration, and supporting governance.',
    items: [
      'Knowledge Library tenant-wide and project-scoped source model',
      'Model Integration and project override patterns',
      'How knowledge and model policy feed evaluation and production behavior',
      'Source PRDs: 08 — Knowledge Library, 09 — Model Integration',
    ],
  },
  {
    icon: FileText,
    title: 'Core Product Flows',
    description:
      'The main prototype surfaces that define how users move from SOP to app to evaluation and deployment.',
    items: [
      '00 — Overview',
      '01 — App Shell + Process Owner Dashboard',
      '02 — SOP-to-App Flow',
      '03 — Review Studio',
      '04 — AI Helper',
      '05 — Evaluation Report',
    ],
  },
  {
    icon: Radar,
    title: 'Reference and Prototype Assets',
    description:
      'Supporting artifacts used by design and engineering while building the UI prototype.',
    items: [
      '10 — Marketplace',
      '12 — Auth',
      '99 — Mock Data',
      'BRD_Agentic_AI_Platform.md',
      'BRD_Executive_Summary.md',
      'Prototype routes in app/ and mock data in lib/mock-data/',
    ],
  },
];

export default function DocsPage() {
  return (
    <div className="space-y-5">
      <header className="border-b border-border-muted pb-4">
        <h1 className="text-2xl font-semibold tracking-tight">Docs</h1>
        <p className="mt-1.5 max-w-3xl text-xs text-foreground-muted">
          Product, design, and engineering reference for the current Evaluation Studio prototype.
          This tab reflects the existing PRDs in `docs/prd/` rather than the older connector-builder
          placeholder content.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {sections.map((section) => {
          const Icon = section.icon;
          return (
            <section
              key={section.title}
              className="rounded-lg border border-border-muted bg-background-subtle p-5"
            >
              <header className="mb-4 flex items-start gap-3">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border-muted bg-background-elevated">
                  <Icon className="size-4 text-foreground-muted" />
                </div>
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold tracking-tight">{section.title}</h2>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-foreground-muted">
                    {section.description}
                  </p>
                </div>
              </header>

              <ul className="space-y-2">
                {section.items.map((item) => (
                  <li
                    key={item}
                    className="rounded-md border border-border-muted bg-background px-3 py-2 text-xs text-foreground-muted"
                  >
                    {item}
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>

      <section className="rounded-lg border border-border-muted bg-background-subtle p-4">
        <div className="text-sm font-semibold">Current source of truth</div>
        <p className="mt-1.5 text-sm text-foreground-muted">
          The most relevant product spec for the current prototype work is
          `docs/prd/13-evaluation-studio.md`, supported by `11-projects.md`, `06-approval-and-deployment.md`,
          `07-mission-control-and-audit.md`, and `12-auth.md`.
        </p>
      </section>

      <Footer />
    </div>
  );
}
