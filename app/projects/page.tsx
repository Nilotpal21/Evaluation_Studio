'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Check,
  ChevronDown,
  Clock3,
  FolderOpen,
  Grid2X2,
  List,
  Plus,
  Search,
  Users,
  X,
} from 'lucide-react';
import { agentVersions, apps, projectAppMap, type Project } from '@/lib/mock-data';
import { personas } from '@/lib/mock-data/tenant';
import { usePersona } from '@/lib/persona';
import { useAllProjects, useProjectState } from '@/lib/project-state';
import { cn } from '@/lib/utils';

interface DropdownOption {
  label: string;
  value: string;
}

function formatCompactDate(iso: string) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(iso));
}

export default function ProjectsPage() {
  const allProjects = useAllProjects();
  const customProjects = useProjectState((state) => state.customProjects);
  const [query, setQuery] = useState('');
  const [view, setView] = useState<'grid' | 'list'>('grid');

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return allProjects.filter((project) => {
      return (
        normalized.length === 0 ||
        project.name.toLowerCase().includes(normalized) ||
        project.tag.toLowerCase().includes(normalized) ||
        project.description.toLowerCase().includes(normalized)
      );
    });
  }, [allProjects, query]);

  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-[40px] font-semibold leading-none tracking-tight">Projects</h1>
        </div>
        <div className="flex items-center">
          <NewProjectButton />
        </div>
      </header>

      <div className="relative">
        <Search className="pointer-events-none absolute left-5 top-1/2 size-[18px] -translate-y-1/2 text-foreground-subtle" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Ask Arch anything..."
          className="h-12 w-full rounded-[22px] border border-border-muted bg-background-subtle pl-14 pr-20 text-[15px] text-foreground placeholder:text-foreground-subtle focus:border-border focus:outline-none focus:ring-1 focus:ring-border-focus/40"
        />
        <div className="absolute right-5 top-1/2 -translate-y-1/2 rounded-[18px] border border-border-muted px-4 py-2 text-sm text-foreground-subtle">
          ⌘ K
        </div>
      </div>

      <div className="flex items-center justify-end">
        <div className="inline-flex rounded-[18px] bg-background-muted p-1">
          <button
            type="button"
            onClick={() => setView('grid')}
            className={cn(
              'rounded-[14px] px-3 py-2 transition-colors',
              view === 'grid' ? 'bg-background shadow-sm text-foreground' : 'text-foreground-muted',
            )}
            aria-label="Grid view"
          >
            <Grid2X2 className="size-[18px]" />
          </button>
          <button
            type="button"
            onClick={() => setView('list')}
            className={cn(
              'rounded-[14px] px-3 py-2 transition-colors',
              view === 'list' ? 'bg-background shadow-sm text-foreground' : 'text-foreground-muted',
            )}
            aria-label="List view"
          >
            <List className="size-[18px]" />
          </button>
        </div>
      </div>

      <div className={cn('grid gap-4', view === 'grid' ? 'grid-cols-1 lg:grid-cols-2 xl:grid-cols-3' : 'grid-cols-1')}>
        {filtered.length === 0 ? (
          <div className="col-span-full rounded-2xl border border-dashed border-border-muted bg-background-subtle px-6 py-12 text-center">
            <div className="text-lg font-semibold">No projects match the current filters</div>
            <div className="mt-2 text-sm text-foreground-muted">
              Try a different search or switch the project category.
            </div>
          </div>
        ) : (
          filtered.map((project, index) => (
            <ProjectCard
              key={project.id}
              project={project}
              accentIndex={index}
              environment={customProjects[project.id]?.environment ?? 'prod'}
            />
          ))
        )}
      </div>
    </div>
  );
}

function ProjectCard({
  project,
  accentIndex,
  environment,
}: {
  project: Project;
  accentIndex: number;
  environment: 'prod' | 'pre_prod';
}) {
  const projectApps = apps.filter((app) => projectAppMap[app.id] === project.id);
  const owner = Object.values(personas).find((persona) => persona.id === project.ownerPersonaId) ?? personas.processOwner;
  const folderAccent = [
    'border-[#eadfcf] bg-[#fbf7ef] text-[#d18d18]',
    'border-[#f0dcdb] bg-[#fbf0ef] text-[#cb4335]',
    'border-[#dcefe5] bg-[#eff9f3] text-[#2f9e44]',
    'border-[#dcecf3] bg-[#eef7fb] text-[#2b7a94]',
    'border-[#e3e3e3] bg-[#f1f1f1] text-[#262626]',
  ][accentIndex % 5];

  return (
    <Link
      href={`/projects/${project.id}`}
      className="group flex min-h-[216px] flex-col rounded-2xl border border-border-muted bg-background-subtle p-6 transition-colors hover:border-border hover:bg-background"
    >
      <div className="flex items-start gap-4">
        <div className={cn('flex size-14 shrink-0 items-center justify-center rounded-[18px] border', folderAccent)}>
          <FolderOpen className="size-6" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="mb-2">
            <span
              className={cn(
                'inline-flex rounded-full border px-2.5 py-1 text-[11px] font-medium uppercase tracking-wide',
                environment === 'pre_prod'
                  ? 'border-info/20 bg-info-subtle text-info'
                  : 'border-success/20 bg-success-subtle text-success',
              )}
            >
              {environment === 'pre_prod' ? 'Pre-prod' : 'Prod'}
            </span>
          </div>
          <h2 className="truncate text-[18px] font-semibold tracking-tight text-foreground">{project.name}</h2>
          <p className="mt-1 line-clamp-2 text-[15px] leading-7 text-foreground-muted">
            {project.description}
          </p>
        </div>
      </div>

      <div className="mt-auto border-t border-border-muted pt-4">
        <div className="flex flex-wrap items-center gap-5 text-[13px] text-foreground-muted">
          <div className="inline-flex items-center gap-3">
            <span className="flex size-9 items-center justify-center rounded-full bg-foreground text-sm font-semibold text-background">
              {owner.initials}
            </span>
            <span className="text-foreground">{owner.name}</span>
          </div>
          <div className="inline-flex items-center gap-2">
            <Users className="size-4" />
            <span>{projectApps.length} {projectApps.length === 1 ? 'agent' : 'agents'}</span>
          </div>
          <div className="inline-flex items-center gap-2">
            <Clock3 className="size-4" />
            <span>{formatCompactDate(project.createdAt)}</span>
          </div>
        </div>
      </div>
    </Link>
  );
}

function NewProjectButton() {
  const router = useRouter();
  const setActiveProject = usePersona((state) => state.setActiveProject);
  const createProject = useProjectState((state) => state.createProject);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [environment, setEnvironment] = useState<'prod' | 'pre_prod'>('pre_prod');
  const [dataDuration, setDataDuration] = useState('7 days');
  const [selectedAgentId, setSelectedAgentId] = useState(
    apps.find((app) => agentVersions.some((version) => version.appId === app.id && version.environment === 'candidate'))?.id ?? '',
  );
  const [selectedVersionId, setSelectedVersionId] = useState(
    agentVersions.find((version) => version.environment === 'candidate')?.id ?? '',
  );

  const availableAgents =
    environment === 'pre_prod'
      ? apps.filter((app) =>
          agentVersions.some((version) => version.appId === app.id && version.environment === 'candidate'),
        )
      : apps.filter((app) => agentVersions.some((version) => version.appId === app.id && version.environment === 'prod'));

  const availableVersions =
    environment === 'pre_prod'
      ? agentVersions.filter((version) => version.appId === selectedAgentId && version.environment === 'candidate')
      : agentVersions.filter((version) => version.appId === selectedAgentId && version.environment === 'prod');
  const durationOptions = ['1 hr', '2 hr', '1 day', '2 day', '7 days', '30 days'];
  const selectedAgent = apps.find((app) => app.id === selectedAgentId);
  const selectedVersion = agentVersions.find((version) => version.id === selectedVersionId);
  const canSubmit =
    name.trim().length > 0 &&
    selectedAgentId.length > 0 &&
    (environment === 'pre_prod' ? selectedVersionId.length > 0 : dataDuration.length > 0);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          className="inline-flex h-12 items-center gap-3 rounded-2xl bg-[#202225] px-5 text-[16px] font-medium text-white transition-colors hover:bg-[#2b2e33]"
        >
          <Plus className="size-4" />
          New Project
          <ChevronDown className="size-4 text-white/80" />
        </button>
      </Dialog.Trigger>

      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-background/40 backdrop-blur-[2px] animate-fade-in" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(440px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl border border-border bg-background-subtle shadow-2xl animate-fade-in">
          <div className="flex flex-col">
          <div className="flex items-start justify-between gap-4 border-b border-border-muted px-4 py-4">
            <div>
              <Dialog.Title className="text-sm font-semibold tracking-tight">
                Create project
              </Dialog.Title>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                className="rounded-md p-1.5 text-foreground-subtle transition-colors hover:bg-background-muted hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </Dialog.Close>
          </div>

          <div className="px-4 py-4">
          <div className="space-y-4">
            <Field label="Project name">
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Enter project name"
                className="h-10 w-full rounded-md border border-border-muted bg-background px-3 text-sm text-foreground placeholder:text-foreground-subtle focus:outline-none focus:ring-1 focus:ring-border-focus/40"
              />
            </Field>

            <Field label="Environment">
              <DropdownSelect
                value={environment}
                onChange={(nextValue) => {
                  const nextEnvironment = nextValue as 'prod' | 'pre_prod';
                  if (nextEnvironment === 'pre_prod') {
                    const nextAgent =
                      apps.find((app) =>
                        agentVersions.some(
                          (version) => version.appId === app.id && version.environment === 'candidate',
                        ),
                      )?.id ?? '';
                    setEnvironment('pre_prod');
                    setSelectedAgentId(nextAgent);
                    setSelectedVersionId(
                      agentVersions.find(
                        (version) => version.appId === nextAgent && version.environment === 'candidate',
                      )?.id ?? '',
                    );
                    return;
                  }

                  const nextAgent =
                    apps.find((app) =>
                      agentVersions.some((version) => version.appId === app.id && version.environment === 'prod'),
                    )?.id ?? '';
                  setEnvironment('prod');
                  setSelectedAgentId(nextAgent);
                  setSelectedVersionId(
                    agentVersions.find(
                      (version) => version.appId === nextAgent && version.environment === 'prod',
                    )?.id ?? '',
                  );
                  setDataDuration('7 days');
                }}
                options={[
                  { label: 'Pre-Prod', value: 'pre_prod' },
                  { label: 'Prod', value: 'prod' },
                ]}
              />
            </Field>

            <Field label="Agent">
              <DropdownSelect
                value={selectedAgentId}
                onChange={(nextAgentId) => {
                  setSelectedAgentId(nextAgentId);
                  setSelectedVersionId(
                    agentVersions.find(
                      (version) =>
                        version.appId === nextAgentId &&
                        version.environment === (environment === 'pre_prod' ? 'candidate' : 'prod'),
                    )?.id ?? '',
                  );
                }}
                options={availableAgents.map((agent) => ({
                  label: agent.name,
                  value: agent.id,
                }))}
              />
              {selectedAgent ? (
                <p className="mt-2 text-xs leading-5 text-foreground-muted">{selectedAgent.description}</p>
              ) : null}
            </Field>

            {environment === 'pre_prod' ? (
              <Field label="Version">
                <DropdownSelect
                  value={selectedVersionId}
                  onChange={setSelectedVersionId}
                  options={availableVersions.map((version) => ({
                    label: version.label,
                    value: version.id,
                  }))}
                />
                {selectedVersion ? (
                  <p className="mt-2 text-xs leading-5 text-foreground-muted">{selectedVersion.summary}</p>
                ) : null}
              </Field>
            ) : (
              <Field label="Data duration">
                <DropdownSelect
                  value={dataDuration}
                  onChange={setDataDuration}
                  options={durationOptions.map((option) => ({
                    label: option,
                    value: option,
                  }))}
                  openUpward
                />
              </Field>
            )}

            <div className="rounded-lg border border-border-muted bg-background px-3 py-3 text-xs leading-5 text-foreground-muted">
              {environment === 'pre_prod'
                ? 'Pre-prod journey: qualify the selected candidate version, unlock session evaluation and monitoring, and let the product decide promotion.'
                : `Prod journey: analyze live production behavior over the selected ${dataDuration} window, score drift and health, and surface the results in monitoring.`}
            </div>
          </div>
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-border-muted px-4 py-3">
            <Dialog.Close asChild>
              <button
                type="button"
              className="inline-flex h-8 items-center rounded-md border border-border-muted px-3 text-xs text-foreground-muted transition-colors hover:bg-background-muted hover:text-foreground"
              >
                Cancel
              </button>
            </Dialog.Close>
            <button
              type="button"
              onClick={() => {
                const trimmedName = name.trim();
                const targetProjectId = createProject({
                  name: trimmedName,
                  selectedAgentId,
                  environment,
                  selectedVersionId: environment === 'pre_prod' ? selectedVersionId : undefined,
                  duration: environment === 'prod' ? dataDuration : undefined,
                });
                const params = new URLSearchParams({
                  mode: environment,
                  agentId: selectedAgentId,
                });

                if (environment === 'pre_prod') {
                  params.set('versionId', selectedVersionId);
                } else {
                  params.set('duration', dataDuration);
                }

                setActiveProject(targetProjectId);
                router.push(`/projects/${targetProjectId}/evaluations/new?${params.toString()}`);

                setOpen(false);
                setName('');
                setEnvironment('pre_prod');
                setDataDuration('7 days');
                setSelectedAgentId(
                  apps.find((app) =>
                    agentVersions.some((version) => version.appId === app.id && version.environment === 'candidate'),
                  )?.id ?? '',
                );
                setSelectedVersionId(
                  agentVersions.find((version) => version.environment === 'candidate')?.id ?? '',
                );
              }}
              disabled={!canSubmit}
              className={cn(
                'inline-flex h-8 items-center gap-2 rounded-md px-3 text-xs font-medium transition-colors',
                canSubmit
                  ? 'bg-accent text-accent-foreground hover:bg-accent-muted'
                  : 'cursor-not-allowed bg-background-muted text-foreground-subtle',
              )}
            >
              {environment === 'pre_prod' ? 'Create pre-prod project' : 'Create prod project'}
            </button>
          </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-2 text-[10px] font-medium uppercase tracking-wide text-foreground-meta">
        {label}
      </div>
      {children}
    </label>
  );
}

function DropdownSelect({
  value,
  onChange,
  options,
  openUpward = false,
}: {
  value: string;
  onChange: (value: string) => void;
  options: DropdownOption[];
  openUpward?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const selected = options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (!ref.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex h-11 w-full items-center justify-between rounded-md border border-border-muted bg-background px-3 text-left text-sm text-foreground transition-colors hover:border-border focus:outline-none focus:ring-1 focus:ring-border-focus/40"
      >
        <span>{selected?.label ?? 'Select option'}</span>
        <ChevronDown
          className={cn(
            'size-4 text-foreground-subtle transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>

      {open ? (
        <div
          className={cn(
            'absolute left-0 right-0 z-30 overflow-hidden rounded-xl border border-border bg-background-subtle shadow-2xl',
            openUpward ? 'bottom-[calc(100%+0.5rem)]' : 'top-[calc(100%+0.5rem)]',
          )}
        >
          <div className="p-1.5">
            {options.map((option) => {
              const isSelected = option.value === value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                  className={cn(
                    'flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left text-sm transition-colors',
                    isSelected
                      ? 'bg-accent text-accent-foreground'
                      : 'text-foreground hover:bg-background-muted',
                  )}
                >
                  <span>{option.label}</span>
                  {isSelected ? <Check className="size-4" /> : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
