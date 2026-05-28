import { describe, expect, test } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Input } from '../../components/ui/Input';

describe('Input showToggle (password reveal)', () => {
  test('does not render a toggle button when showToggle is omitted', () => {
    render(<Input label="API Key" type="password" />);
    expect(screen.queryByRole('button', { name: /show value|hide value/i })).toBeNull();
    expect((screen.getByLabelText('API Key') as HTMLInputElement).type).toBe('password');
  });

  test('does not render a toggle button when type is not password', () => {
    render(<Input label="Name" type="text" showToggle />);
    expect(screen.queryByRole('button', { name: /show value|hide value/i })).toBeNull();
  });

  test('renders a toggle button when showToggle and type=password are both set', () => {
    render(<Input label="API Key" type="password" showToggle />);
    const toggle = screen.getByRole('button', { name: /show value/i });
    expect(toggle).toBeTruthy();
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect((screen.getByLabelText('API Key') as HTMLInputElement).type).toBe('password');
  });

  test('clicking the toggle flips input type between password and text and updates aria-pressed', () => {
    render(<Input label="API Key" type="password" showToggle />);
    const input = screen.getByLabelText('API Key') as HTMLInputElement;
    const toggle = screen.getByRole('button', { name: /show value/i });

    fireEvent.click(toggle);
    expect(input.type).toBe('text');
    const hideButton = screen.getByRole('button', { name: /hide value/i });
    expect(hideButton.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(hideButton);
    expect(input.type).toBe('password');
    expect(screen.getByRole('button', { name: /show value/i }).getAttribute('aria-pressed')).toBe(
      'false',
    );
  });
});
