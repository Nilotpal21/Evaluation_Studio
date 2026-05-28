import Link from 'next/link';
import { notFound } from 'next/navigation';
import { MoreHorizontal } from 'lucide-react';
import {
  apps,
  getEvalReport,
  getProjectById,
  projectAppMap,
} from '@/lib/mock-data';
import { ScoreHero } from '@/components/evaluation/ScoreHero';
import { SourceBreakdown } from '@/components/evaluation/SourceBreakdown';
import { CategoryScores } from '@/components/evaluation/CategoryScores';
import { FailingExamples } from '@/components/evaluation/FailingExamples';
import { CitationCoverage } from '@/components/evaluation/CitationCoverage';
import { CompareRuns } from '@/components/evaluation/CompareRuns';
import { ReRunButton } from '@/components/evaluation/ReRunButton';
import { Footer } from '@/components/shell/Footer';

interface PageProps {
  params: Promise<{ appId: string }>;
}

export function generateStaticParams() {
  return apps.map((a) => ({ appId: a.id }));
}

export default async function EvaluationPage({ params }: PageProps) {
  const { appId } = await params;
  const app = apps.find((a) => a.id === appId);
  if (!app) notFound();

  const report = getEvalReport(app.id);
  const project = getProjectById(projectAppMap[app.id]);

  return (
    <div className="space-y-5">
      <nav className="text-xs text-foreground-muted flex items-center gap-2">
        {project && (
          <>
            <Link
              href={`/projects/${project.id}`}
              className="hover:text-foreground transition-colors"
            >
              {project.name}
            </Link>
            <span className="text-foreground-subtle">/</span>
          </>
        )}
        <Link href="/apps" className="hover:text-foreground transition-colors">
          Apps
        </Link>
        <span className="text-foreground-subtle">/</span>
        <Link
          href={`/apps/${app.id}`}
          className="hover:text-foreground transition-colors font-mono"
        >
          {app.name}
        </Link>
        <span className="text-foreground-subtle">/</span>
        <span className="text-foreground">Evaluation</span>
      </nav>

      <header className="flex items-end justify-between gap-3 pb-4 border-b border-border-muted">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">Evaluation Report</h1>
          <p className="text-xs text-foreground-muted mt-1 font-mono">
            Run #{report.runNumber} · ran {report.ranAgo} · triggered by:{' '}
            {report.trigger.replace(/_/g, ' ')}
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <ReRunButton />
          <button
            type="button"
            className="size-9 rounded-md border border-border-muted text-foreground-muted hover:text-foreground hover:bg-background-elevated transition-colors flex items-center justify-center"
            aria-label="More options"
          >
            <MoreHorizontal className="size-4" />
          </button>
        </div>
      </header>

      <ScoreHero report={report} />

      <SourceBreakdown sources={report.sources} />

      <CategoryScores categories={report.categories} />

      <FailingExamples categories={report.categories} />

      <CitationCoverage report={report} />

      <CompareRuns runNumber={report.runNumber} categories={report.categories} />

      <Footer />
    </div>
  );
}
