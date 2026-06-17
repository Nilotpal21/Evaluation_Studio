import Link from 'next/link';
import { FileText, Bot, Activity, ArrowUpRight, type LucideIcon } from 'lucide-react';
import { useActiveProjectId } from '@/lib/persona';

interface ActionTile {
  href: string;
  icon: LucideIcon;
  title: string;
  description: string;
}

const tiles: ActionTile[] = [
  {
    href: '/sops/new',
    icon: FileText,
    title: 'Upload a new SOP',
    description:
      'Start a new app from a Standard Operating Procedure. The platform reads it, the Helper guides you, the Evaluation Harness scores it.',
  },
  {
    href: '/apps',
    icon: Bot,
    title: 'Review your apps',
    description: '3 apps deployed · 1 in review · 1 draft. Open Review Studio.',
  },
  {
    href: '/mission-control',
    icon: Activity,
    title: 'Open Mission Control',
    description: 'See live conversations, continuous evaluation, drift alerts.',
  },
];

export function ActionRow() {
  const activeProjectId = useActiveProjectId();
  const resolvedTiles = tiles.map((tile) => {
    if (tile.href === '/mission-control') {
      return { ...tile, href: `/projects/${activeProjectId}/monitoring` };
    }
    return tile;
  });

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
      {resolvedTiles.map((t) => {
        const Icon = t.icon;
        return (
          <Link
            key={t.href}
            href={t.href}
            className="group rounded-lg border border-border-muted bg-background-subtle hover:border-border hover:bg-background-muted/40 transition-colors p-4 flex flex-col"
          >
            <div className="flex items-start justify-between mb-3">
              <div className="size-8 rounded-md bg-background-elevated border border-border-muted flex items-center justify-center group-hover:border-border transition-colors">
                <Icon className="size-4 text-foreground-muted group-hover:text-foreground transition-colors" />
              </div>
              <ArrowUpRight className="size-3.5 text-foreground-subtle group-hover:text-foreground-muted transition-colors" />
            </div>
            <div className="text-sm font-medium tracking-tight">{t.title}</div>
            <p className="text-xs text-foreground-muted mt-1 leading-relaxed">{t.description}</p>
          </Link>
        );
      })}
    </div>
  );
}
