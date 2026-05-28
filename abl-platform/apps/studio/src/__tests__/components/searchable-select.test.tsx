/**
 * SearchableSelect Component Tests
 *
 * Tests rendering, search filtering, selection, disabled state,
 * and error display.
 */

import { describe, test, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SearchableSelect } from '../../components/ui/SearchableSelect';

const OPTIONS = [
  { value: 'en-US', label: 'English (US)' },
  { value: 'es-ES', label: 'Spanish (Spain)' },
  { value: 'fr-FR', label: 'French (France)' },
  { value: 'de-DE', label: 'German (Germany)' },
];

describe('SearchableSelect', () => {
  test('renders with placeholder when no value selected', () => {
    render(<SearchableSelect options={OPTIONS} value="" onChange={vi.fn()} />);
    expect(screen.getByText('Select...')).toBeInTheDocument();
  });

  test('renders custom placeholder', () => {
    render(
      <SearchableSelect
        options={OPTIONS}
        value=""
        onChange={vi.fn()}
        placeholder="Pick a language"
      />,
    );
    expect(screen.getByText('Pick a language')).toBeInTheDocument();
  });

  test('displays selected option label', () => {
    render(<SearchableSelect options={OPTIONS} value="fr-FR" onChange={vi.fn()} />);
    expect(screen.getByText('French (France)')).toBeInTheDocument();
  });

  test('renders label when provided', () => {
    render(<SearchableSelect label="Language" options={OPTIONS} value="" onChange={vi.fn()} />);
    expect(screen.getByText('Language')).toBeInTheDocument();
  });

  test('opens dropdown on click and shows all options', async () => {
    render(<SearchableSelect options={OPTIONS} value="" onChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('button'));

    expect(screen.getByText('English (US)')).toBeInTheDocument();
    expect(screen.getByText('Spanish (Spain)')).toBeInTheDocument();
    expect(screen.getByText('French (France)')).toBeInTheDocument();
    expect(screen.getByText('German (Germany)')).toBeInTheDocument();
  });

  test('filters options based on search input', async () => {
    const user = userEvent.setup();
    render(<SearchableSelect options={OPTIONS} value="" onChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('button'));

    const searchInput = screen.getByPlaceholderText('Search...');
    await user.type(searchInput, 'span');

    expect(screen.getByText('Spanish (Spain)')).toBeInTheDocument();
    expect(screen.queryByText('English (US)')).not.toBeInTheDocument();
    expect(screen.queryByText('French (France)')).not.toBeInTheDocument();
  });

  test('shows no results message when search matches nothing', async () => {
    const user = userEvent.setup();
    render(<SearchableSelect options={OPTIONS} value="" onChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('button'));

    const searchInput = screen.getByPlaceholderText('Search...');
    await user.type(searchInput, 'zzzzz');

    expect(screen.getByText('No results')).toBeInTheDocument();
  });

  test('calls onChange when option is selected', () => {
    const onChange = vi.fn();
    render(<SearchableSelect options={OPTIONS} value="" onChange={onChange} />);

    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByText('Spanish (Spain)'));

    expect(onChange).toHaveBeenCalledWith('es-ES');
  });

  test('closes dropdown after selection', () => {
    render(<SearchableSelect options={OPTIONS} value="" onChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText('English (US)')).toBeInTheDocument();

    fireEvent.click(screen.getByText('English (US)'));
    expect(screen.queryByPlaceholderText('Search...')).not.toBeInTheDocument();
  });

  test('does not open when disabled', () => {
    render(<SearchableSelect options={OPTIONS} value="" onChange={vi.fn()} disabled />);

    fireEvent.click(screen.getByRole('button'));
    expect(screen.queryByPlaceholderText('Search...')).not.toBeInTheDocument();
  });

  test('displays error message', () => {
    render(
      <SearchableSelect options={OPTIONS} value="" onChange={vi.fn()} error="Required field" />,
    );
    expect(screen.getByText('Required field')).toBeInTheDocument();
  });

  test('search is case-insensitive', async () => {
    const user = userEvent.setup();
    render(<SearchableSelect options={OPTIONS} value="" onChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('button'));

    const searchInput = screen.getByPlaceholderText('Search...');
    await user.type(searchInput, 'GERMAN');

    expect(screen.getByText('German (Germany)')).toBeInTheDocument();
    expect(screen.queryByText('English (US)')).not.toBeInTheDocument();
  });
});
