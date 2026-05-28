import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { SidebarShell } from '../components/SidebarShell.js';
import { NavSection } from '../components/NavSection.js';
import { NavItem } from '../components/NavItem.js';
import { Bot, Wrench, Activity, Settings, LayoutDashboard } from 'lucide-react';

const meta: Meta<typeof SidebarShell> = {
  title: 'Navigation/SidebarShell',
  component: SidebarShell,
  parameters: { layout: 'fullscreen' },
};

export default meta;
type Story = StoryObj<typeof SidebarShell>;

function SidebarDemo({ initialCollapsed = false }: { initialCollapsed?: boolean }) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [active, setActive] = useState('agents');

  return (
    <div className="flex h-screen bg-background">
      <SidebarShell
        collapsed={collapsed}
        onCollapseToggle={() => setCollapsed((c) => !c)}
        header={
          !collapsed ? (
            <div className="flex items-center gap-2 px-1">
              <div className="w-6 h-6 rounded bg-accent-subtle text-accent flex items-center justify-center text-xs font-bold">
                A
              </div>
              <span className="text-sm font-semibold text-foreground truncate">My Project</span>
            </div>
          ) : (
            <div className="flex justify-center">
              <div className="w-6 h-6 rounded bg-accent-subtle text-accent flex items-center justify-center text-xs font-bold">
                A
              </div>
            </div>
          )
        }
      >
        <NavSection title="Project" collapsed={collapsed}>
          <NavItem
            icon={LayoutDashboard}
            label="Overview"
            collapsed={collapsed}
            active={active === 'overview'}
            onClick={() => setActive('overview')}
          />
          <NavItem
            icon={Bot}
            label="Agents"
            collapsed={collapsed}
            active={active === 'agents'}
            onClick={() => setActive('agents')}
            badge={3}
          />
          <NavItem
            icon={Wrench}
            label="Tools"
            collapsed={collapsed}
            active={active === 'tools'}
            onClick={() => setActive('tools')}
          />
        </NavSection>
        <NavSection title="Observe" collapsed={collapsed}>
          <NavItem
            icon={Activity}
            label="Traces"
            collapsed={collapsed}
            active={active === 'traces'}
            onClick={() => setActive('traces')}
            badge={42}
          />
        </NavSection>
        <NavSection title="Configure" collapsed={collapsed}>
          <NavItem
            icon={Settings}
            label="Settings"
            collapsed={collapsed}
            active={active === 'settings'}
            onClick={() => setActive('settings')}
          />
        </NavSection>
      </SidebarShell>
      <div className="flex-1 p-8">
        <p className="text-muted text-sm">Main content area</p>
      </div>
    </div>
  );
}

export const Expanded: Story = { render: () => <SidebarDemo /> };
export const Collapsed: Story = { render: () => <SidebarDemo initialCollapsed /> };
