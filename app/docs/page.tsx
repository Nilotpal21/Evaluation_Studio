import {
  BookOpen,
  Database,
  FileText,
  FolderKanban,
  Gauge,
  ShieldCheck,
  Sparkles,
  Waypoints,
} from 'lucide-react';
import { Footer } from '@/components/shell/Footer';

const sections = [
  {
    icon: FolderKanban,
    title: 'Projects',
    description:
      'Projects are the operating boundary for agents, evaluations, validators, knowledge, monitoring, and operator controls.',
    items: [
      'Projects page uses the lighter catalog-style layout with search and grid/list toggle',
      'Clicking a project opens Evaluation Studio instead of a separate overview surface',
      'Project tiles show the project owner, agent count, created date, and environment chip',
      'Custom project creation stores project name, selected environment, selected agent, and either version or duration',
      'Custom projects are persisted in client state so the user can reopen the same seeded flow without rebuilding it',
      'Project root routing is environment-aware for custom projects and falls back to the seeded evaluation landing for default projects',
    ],
  },
  {
    icon: Sparkles,
    title: 'Evaluation Studio',
    description:
      'Evaluation Studio is the primary project landing surface and the control plane for autonomous evaluation.',
    items: [
      'Evaluation Studio remains project-scoped and is the default project destination',
      'Users create either a Pre-prod or Prod project flow from New Project',
      'Pre-prod uses selected agent + version',
      'Prod uses selected agent + production-data duration window',
      'Run history and environment-specific detail pages remain available under /projects/[projectId]/evaluations',
      'Evaluation Studio remains the canonical project landing even when project tiles are opened from the global Projects catalog',
      'Project-level summary surfaces are intentionally lighter than run-detail screens so they act as a control plane rather than an analysis canvas',
    ],
  },
  {
    icon: Waypoints,
    title: 'Pre-prod And Prod Journeys',
    description:
      'Environment choice changes routing state, stored context, and downstream operator surfaces.',
    items: [
      'Pre-prod projects persist selected candidate agent and version',
      'Prod projects persist selected production agent and duration',
      'Custom project state stores the last launched run so reopening a project can return to its active run flow',
      'Session evaluation and Monitoring access are unlocked from project state rather than being treated as global pages',
      'Pre-prod run launches store a lastLaunchedRunId so the user can re-enter the exact run they started',
      'Prod run launches follow the same stored-run behavior to avoid dropping the user back onto the generic evaluation dashboard',
    ],
  },
  {
    icon: Gauge,
    title: 'Session Evaluation',
    description:
      'Session evaluation provides stored Sessions and Traces with drill-down inspectors for transcripts, evaluators, and input/output.',
    items: [
      'Dedicated left-nav tab below Mode hub',
      'Sessions tab opens a session drawer with Evaluation and Transcript views',
      'Traces tab opens a trace inspector with Evaluators and Input / output tabs',
      'Trace tree nodes and evaluator cards are interactive and open node-specific inspector content',
      'All dummy session and trace rows now have fallback detail so every row opens correctly',
      'Session drawers default to transcript-first behavior while still supporting evaluation summaries and trace handoff',
      'Trace drawers support node-level inspection, evaluator summaries, and pretty/JSON IO switching so the product story can be demonstrated end to end',
    ],
  },
  {
    icon: ShieldCheck,
    title: 'Validators',
    description:
      'Validators are managed as a dedicated project tab with catalog rows, configuration drawers, and custom-validator creation.',
    items: [
      'Validator rows open a right-side configuration drawer',
      'Model dropdown is driven by configured Mode hub models',
      'New custom validator uses the simplified setup flow requested in the prototype',
      'Removed evaluator type, variable mapping, output config, global-save toggle, templates, and test button from the custom validator flow',
      'Validators remain the project-level home for benchmark and policy configuration',
      'Built-in and custom validators are both presented in the same catalog so users can see where benchmark ownership differs',
      'Validator drawers now better match the rest of the platform by using the same spacing, card styling, and right-side edit pattern as other inspectors',
    ],
  },
  {
    icon: Database,
    title: 'Knowledge Base',
    description:
      'Knowledge Base is now a dedicated left-nav surface below Mode hub and remains available as its own workflow.',
    items: [
      'Knowledge Base tab is separate from validators and evaluations',
      'The add-source wizard now starts with General Settings',
      'General Settings captures Knowledge base name and Description before ingestion setup',
      'The wizard now totals five steps',
      'Knowledge-base creation remains wizard-driven so later ingestion choices such as upload, crawl, or service connection can stay contextual',
      'The tab is positioned next to Mode hub and Session evaluation because knowledge is treated as a core project configuration surface',
    ],
  },
  {
    icon: BookOpen,
    title: 'Navigation Model',
    description:
      'The prototype navigation has been simplified to match the requested product structure.',
    items: [
      'Overview has been removed from the left-nav project flow',
      'Left nav now centers on Evaluation Studio, Mode hub, Knowledge Base, Session evaluation, Monitoring, Validators, Docs, and Settings',
      'Monitoring is represented as a dedicated nav tab instead of a header CTA',
      'Workspace/account popover now reflects the active project and signed-in user rather than older tenant placeholders',
      'Session evaluation and Monitoring are intended to feel like downstream operational surfaces rather than alternate top-level home pages',
      'Project navigation emphasizes setup, execution, inspection, and governance instead of the earlier connector-builder structure',
    ],
  },
  {
    icon: FileText,
    title: 'First-Time User Guide',
    description:
      'A lightweight walkthrough for someone opening the prototype for the first time and trying to understand the main flows.',
    items: [
      'How to create a new Pre-prod project with project name, agent, and version',
      'How to create a new Prod project with project name, agent, and duration',
      'How to reopen and inspect existing projects from the Projects catalog',
      'How Session evaluation works, including that clicking Session IDs and Trace IDs opens more details',
      'Source guide: docs/first-time-user-guide.md',
    ],
  },
  {
    icon: FileText,
    title: 'Current Prototype Notes',
    description:
      'These notes explain the current implementation boundaries so design and engineering are aligned on what is intentionally mocked.',
    items: [
      'Project creation is still mock-persisted client state, not a backend-created resource',
      'Run progression, session data, traces, validators, and monitoring are seeded dummy data',
      'Routing and unlocking behavior for custom projects is persisted in local project state',
      'The prototype is optimized for end-to-end flow demonstration rather than final production architecture',
      'Several screens intentionally privilege clarity of user journey over backend realism so design review can focus on product behavior first',
      'This docs page is meant to reflect what the prototype currently does, not only what the PRD originally described',
    ],
  },
];

export default function DocsPage() {
  return (
    <div className="space-y-5">
      <header className="border-b border-border-muted pb-4">
        <h1 className="text-2xl font-semibold tracking-tight">Docs</h1>
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
                    className="rounded-md border border-border-muted bg-background px-3 py-2 text-xs leading-5 text-foreground-muted"
                  >
                    {item}
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>

      <Footer />
    </div>
  );
}
