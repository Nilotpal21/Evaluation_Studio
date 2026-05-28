import { Topbar } from '@/components/Topbar';
import { Sidebar } from '@/components/Sidebar';
import { StatsCards } from '@/components/dashboard/StatsCards';
import { ProjectsGrid } from '@/components/dashboard/ProjectsGrid';
import { ActivityFeed } from '@/components/dashboard/ActivityFeed';
import { RunsChart } from '@/components/dashboard/RunsChart';
import { currentUser } from '@/lib/mock-data';
import { Sparkles } from 'lucide-react';

export default function DashboardPage() {
  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <Topbar />
      <div className="flex-1 flex min-h-0">
        <Sidebar />
        <main className="flex-1 overflow-y-auto scrollbar-thin">
          <div className="max-w-[1400px] mx-auto px-6 py-6 space-y-6 animate-fade-in">
            <header className="flex items-end justify-between">
              <div>
                <h1 className="text-xl font-semibold tracking-tight">
                  Welcome back, {currentUser.name}
                </h1>
                <p className="text-xs text-foreground-muted mt-1">
                  {currentUser.org} · 3 deployments in the last 24 hours
                </p>
              </div>
              <button className="h-8 px-3 rounded-md bg-purple/15 text-purple hover:bg-purple/20 transition-colors text-xs font-medium flex items-center gap-1.5">
                <Sparkles className="size-3.5" />
                Ask Architect
              </button>
            </header>

            <StatsCards />

            <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
              <div className="lg:col-span-3">
                <RunsChart />
              </div>
              <div className="lg:col-span-2">
                <ActivityFeed />
              </div>
            </div>

            <ProjectsGrid />

            <footer className="pt-4 pb-2 text-[11px] text-foreground-subtle flex items-center justify-between border-t border-border-muted">
              <span>Studio prototype · mock data</span>
              <span className="font-mono">v0.1.0 · {new Date().getFullYear()}</span>
            </footer>
          </div>
        </main>
      </div>
    </div>
  );
}
