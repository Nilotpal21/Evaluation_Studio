'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Rocket, PartyPopper, Calendar, Activity, FileText, ArrowRight } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { projectAppMap } from '@/lib/mock-data';

const STEPS = [
  'Recording configuration snapshot…',
  'Validating evaluation snapshot…',
  'Capturing approval signatures…',
  'Provisioning channels…',
  'Activating Mission Control surfaces…',
];

interface Props {
  appId: string;
  appName: string;
  version: number;
  prevDeployedVersion: number | null;
  channels: ('digital' | 'voice' | 'sms' | 'email')[];
  evaluationScore: number;
  reviewerInitials: string[];
}

type Phase = 'idle' | 'running' | 'done';

export function DeployFlow({
  appId,
  appName,
  version,
  prevDeployedVersion,
  channels,
  evaluationScore,
  reviewerInitials,
}: Props) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('idle');
  const [step, setStep] = useState(0);
  const projectId = projectAppMap[appId];

  const deploy = () => {
    setPhase('running');
    setStep(0);
    let i = 0;
    const interval = setInterval(() => {
      i += 1;
      setStep(i);
      if (i >= STEPS.length) {
        clearInterval(interval);
        setTimeout(() => {
          setPhase('done');
          toast.success(`${appName} v${version} deployed.`);
        }, 600);
      }
    }, 900);
  };

  if (phase === 'done') {
    return (
      <section className="rounded-lg border border-success/30 bg-success-subtle/40 p-8 text-center animate-fade-in">
        <div className="size-12 mx-auto rounded-full bg-success/20 flex items-center justify-center text-success mb-4">
          <PartyPopper className="size-6" />
        </div>
        <h2 className="text-xl font-semibold tracking-tight">
          <span className="font-mono">{appName}</span> v{version} deployed.
        </h2>
        <p className="text-sm text-foreground-muted mt-2 max-w-md mx-auto">
          Available to all 47,200 members across {channels.join(', ')}. Continuous evaluation
          begins now.
        </p>
        <div className="mt-6 flex items-center justify-center gap-2 flex-wrap">
          <Link
            href={projectId ? `/projects/${projectId}/monitoring` : '/mission-control'}
            className="h-9 px-4 rounded-md text-xs font-medium bg-accent text-accent-foreground hover:bg-accent-muted transition-colors flex items-center gap-1.5"
          >
            <Activity className="size-3.5" />
            Open Monitoring
            <ArrowRight className="size-3" />
          </Link>
          <button
            type="button"
            onClick={() =>
              toast.info(`Deployment record: ${appName} v${version} · snapshot stored`, {
                description: `Includes config v${version}, evaluation snapshot, approver signatures.`,
              })
            }
            className="h-9 px-3 rounded-md text-xs font-medium border border-border-muted text-foreground-muted hover:text-foreground hover:bg-background-elevated transition-colors flex items-center gap-1.5"
          >
            <FileText className="size-3.5" />
            View deployment record
          </button>
          <button
            type="button"
            onClick={() => router.push('/projects')}
            className="h-9 px-3 rounded-md text-xs font-medium text-foreground-muted hover:text-foreground hover:bg-background-elevated transition-colors"
          >
            Back to projects
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-border bg-background-subtle p-6">
      <div className="space-y-3 mb-5">
        <Row label="Audience" value="All members (~47,200)" />
        <Row label="Channels" value={channels.join(', ')} />
        <Row
          label="Deployment record"
          value={`Config snapshot v${version} · evaluation snapshot (score ${evaluationScore}) · approvers: ${reviewerInitials.join(', ')}`}
        />
        <Row
          label="Rollback target"
          value={
            prevDeployedVersion
              ? `Previous deployed version v${prevDeployedVersion}`
              : 'None — this is the first deployed version'
          }
        />
      </div>

      <div className="rounded-md border border-info/30 bg-info-subtle/40 p-3 mb-5 text-xs text-foreground">
        <span className="text-foreground-muted">What happens at deploy: </span>
        The app becomes available to your target audience. Mission Control starts surfacing live
        metrics within a few minutes. Continuous evaluation keeps running against sampled live
        traffic. If you change this app after deployment, you&apos;ll need to re-evaluate and
        re-submit for approval before re-deploying.
      </div>

      {phase === 'idle' ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={deploy}
            className="h-10 px-5 rounded-md text-sm font-medium bg-accent text-accent-foreground hover:bg-accent-muted transition-colors flex items-center gap-2"
          >
            <Rocket className="size-4" />
            Deploy now
          </button>
          <button
            type="button"
            onClick={() => toast.info('Schedule deployment — not wired in the prototype')}
            className="h-10 px-4 rounded-md text-sm font-medium border border-border-muted text-foreground-muted hover:text-foreground hover:bg-background-elevated transition-colors flex items-center gap-1.5"
          >
            <Calendar className="size-3.5" />
            Schedule deployment
          </button>
          <button
            type="button"
            onClick={() => router.push(`/apps/${appId}`)}
            className="h-10 px-4 rounded-md text-sm font-medium text-foreground-muted hover:text-foreground hover:bg-background-elevated transition-colors"
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="rounded-md border border-border-muted bg-background-muted/40 p-4">
          <div className="space-y-2">
            {STEPS.map((s, i) => {
              const status = i < step ? 'done' : i === step ? 'running' : 'pending';
              return (
                <div key={s} className="flex items-center gap-2.5 text-xs">
                  <span
                    className={cn(
                      'size-4 rounded-full flex items-center justify-center text-[8px] font-mono shrink-0',
                      status === 'done'
                        ? 'bg-success/20 text-success'
                        : status === 'running'
                          ? 'bg-info/20 text-info animate-pulse'
                          : 'bg-background-elevated text-foreground-subtle',
                    )}
                  >
                    {status === 'done' ? '✓' : i + 1}
                  </span>
                  <span
                    className={cn(
                      status === 'done'
                        ? 'text-foreground-muted line-through decoration-foreground-subtle'
                        : status === 'running'
                          ? 'text-foreground'
                          : 'text-foreground-subtle',
                    )}
                  >
                    {s}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[max-content_1fr] gap-4 text-xs">
      <div className="text-[10px] uppercase tracking-wide text-foreground-meta font-medium pt-0.5">
        {label}
      </div>
      <div className="text-foreground">{value}</div>
    </div>
  );
}
