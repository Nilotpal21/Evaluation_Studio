import type { Meta, StoryObj } from '@storybook/react';
import { NavItem } from '../components/NavItem.js';
import { Bot, Settings, Wrench, Activity } from 'lucide-react';

const meta: Meta<typeof NavItem> = {
  title: 'Navigation/NavItem',
  component: NavItem,
  args: {
    icon: Bot,
    label: 'Agents',
  },
  argTypes: {
    active: { control: 'boolean' },
    collapsed: { control: 'boolean' },
    badge: { control: 'text' },
  },
};

export default meta;
type Story = StoryObj<typeof NavItem>;

export const Default: Story = {};
export const Active: Story = { args: { active: true } };
export const WithBadge: Story = { args: { badge: 12 } };
export const ActiveWithBadge: Story = { args: { active: true, badge: 3 } };
export const Collapsed: Story = { args: { collapsed: true } };
export const CollapsedActive: Story = { args: { collapsed: true, active: true } };

export const NavList: Story = {
  render: () => (
    <div className="w-60 space-y-0.5 px-2 py-4 bg-background-subtle rounded-lg">
      <NavItem icon={Bot} label="Agents" active badge={5} />
      <NavItem icon={Wrench} label="Tools" />
      <NavItem icon={Activity} label="Traces" badge={42} />
      <NavItem icon={Settings} label="Settings" />
    </div>
  ),
};

export const CollapsedList: Story = {
  render: () => (
    <div className="w-14 space-y-0.5 px-2 py-4 bg-background-subtle rounded-lg">
      <NavItem icon={Bot} label="Agents" active collapsed />
      <NavItem icon={Wrench} label="Tools" collapsed />
      <NavItem icon={Activity} label="Traces" collapsed />
      <NavItem icon={Settings} label="Settings" collapsed />
    </div>
  ),
};
