import type { Meta, StoryObj } from '@storybook/react';
import { Badge } from '../components/Badge.js';

const meta: Meta<typeof Badge> = {
  title: 'Components/Badge',
  component: Badge,
  args: { children: 'Badge' },
  argTypes: {
    variant: {
      control: 'select',
      options: ['default', 'accent', 'success', 'warning', 'error', 'info', 'purple'],
    },
    dot: { control: 'boolean' },
  },
};

export default meta;
type Story = StoryObj<typeof Badge>;

export const Default: Story = { args: { variant: 'default' } };
export const Accent: Story = { args: { variant: 'accent' } };
export const Success: Story = { args: { variant: 'success', children: 'Active' } };
export const Warning: Story = { args: { variant: 'warning', children: 'Pending' } };
export const Error: Story = { args: { variant: 'error', children: 'Failed' } };
export const Info: Story = { args: { variant: 'info', children: 'Info' } };
export const Purple: Story = { args: { variant: 'purple', children: 'AI' } };

export const WithDot: Story = { args: { variant: 'success', dot: true, children: 'Online' } };

export const AllVariants: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      {(['default', 'accent', 'success', 'warning', 'error', 'info', 'purple'] as const).map(
        (v) => (
          <Badge key={v} variant={v}>
            {v}
          </Badge>
        ),
      )}
    </div>
  ),
};
