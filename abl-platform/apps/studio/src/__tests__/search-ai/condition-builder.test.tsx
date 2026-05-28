/**
 * Tests for ConditionBuilder component.
 *
 * The global setup.tsx mock loads real English translations from studio.json.
 * Tests query by the resolved English text.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Mock lucide-react to avoid happy-dom hangs
vi.mock('lucide-react', () => {
  const n = () => null;
  return { Plus: n, X: n, Trash2: n };
});

import {
  ConditionBuilder,
  type ConditionGroup,
} from '../../components/search-ai/sharepoint/ConditionBuilder';

// Real English translations (resolved by setup.tsx from studio.json)
const LABELS = {
  field: 'Field',
  operator: 'Operator',
  value: 'Value',
  addCondition: '+ Add Condition',
  removeCondition: 'Remove condition',
  addGroup: '+ Add Group',
  removeGroup: 'Remove group',
};

const MOCK_FIELDS = [
  { name: 'title', type: 'string' },
  { name: 'size', type: 'number' },
  { name: 'author', type: 'string' },
];

function defaultGroup(): ConditionGroup {
  return {
    logic: 'AND',
    conditions: [{ field: '', operator: 'equals', value: '' }],
  };
}

describe('ConditionBuilder', () => {
  let onChange: Mock<(groups: ConditionGroup[]) => void>;

  beforeEach(() => {
    onChange = vi.fn<(groups: ConditionGroup[]) => void>();
  });

  // ─── Rendering ───────────────────────────────────────────────────────

  it('renders a group with one condition row', () => {
    render(<ConditionBuilder groups={[defaultGroup()]} onChange={onChange} fields={MOCK_FIELDS} />);

    const fieldSelect = screen.getByLabelText(LABELS.field);
    expect(fieldSelect).toBeInTheDocument();

    const operatorSelect = screen.getByLabelText(LABELS.operator);
    expect(operatorSelect).toBeInTheDocument();

    const valueInput = screen.getByLabelText(LABELS.value);
    expect(valueInput).toBeInTheDocument();
  });

  it('renders all 15 operator options', () => {
    render(<ConditionBuilder groups={[defaultGroup()]} onChange={onChange} fields={MOCK_FIELDS} />);

    const operatorSelect = screen.getByLabelText(LABELS.operator);
    const options = operatorSelect.querySelectorAll('option');
    expect(options).toHaveLength(15);
  });

  it('renders field options including placeholder', () => {
    render(<ConditionBuilder groups={[defaultGroup()]} onChange={onChange} fields={MOCK_FIELDS} />);

    const fieldSelect = screen.getByLabelText(LABELS.field);
    const options = fieldSelect.querySelectorAll('option');
    // placeholder + 3 fields
    expect(options).toHaveLength(4);
  });

  // ─── Add condition ───────────────────────────────────────────────────

  it('calls onChange with new condition when Add Condition is clicked', () => {
    render(<ConditionBuilder groups={[defaultGroup()]} onChange={onChange} fields={MOCK_FIELDS} />);

    const addBtn = screen.getByRole('button', { name: /\+ Add Condition/i });
    fireEvent.click(addBtn);

    expect(onChange).toHaveBeenCalledOnce();
    const newGroups = onChange.mock.calls[0][0];
    expect(newGroups[0].conditions).toHaveLength(2);
    expect(newGroups[0].conditions[1]).toEqual({
      field: '',
      operator: 'equals',
      value: '',
    });
  });

  // ─── Remove condition ────────────────────────────────────────────────

  it('calls onChange to remove a condition when X is clicked (2+ conditions)', () => {
    const group: ConditionGroup = {
      logic: 'AND',
      conditions: [
        { field: 'title', operator: 'equals', value: 'doc' },
        { field: 'size', operator: 'greater_than', value: '100' },
      ],
    };

    render(<ConditionBuilder groups={[group]} onChange={onChange} fields={MOCK_FIELDS} />);

    // There should be remove buttons for each condition when >1
    const removeBtns = screen.getAllByLabelText(/Remove condition/i);
    expect(removeBtns).toHaveLength(2);

    fireEvent.click(removeBtns[0]);

    expect(onChange).toHaveBeenCalledOnce();
    const newGroups = onChange.mock.calls[0][0];
    expect(newGroups[0].conditions).toHaveLength(1);
    expect(newGroups[0].conditions[0].field).toBe('size');
  });

  it('does not show remove button when only one condition', () => {
    render(<ConditionBuilder groups={[defaultGroup()]} onChange={onChange} fields={MOCK_FIELDS} />);

    const removeBtns = screen.queryAllByLabelText(/Remove condition/i);
    expect(removeBtns).toHaveLength(0);
  });

  // ─── AND/OR toggle ───────────────────────────────────────────────────

  it('toggles logic from AND to OR', () => {
    render(<ConditionBuilder groups={[defaultGroup()]} onChange={onChange} fields={MOCK_FIELDS} />);

    const orButton = screen.getByRole('button', { name: 'OR' });
    fireEvent.click(orButton);

    expect(onChange).toHaveBeenCalledOnce();
    const newGroups = onChange.mock.calls[0][0];
    expect(newGroups[0].logic).toBe('OR');
  });

  it('toggles logic from OR to AND', () => {
    const orGroup: ConditionGroup = {
      logic: 'OR',
      conditions: [{ field: '', operator: 'equals', value: '' }],
    };

    render(<ConditionBuilder groups={[orGroup]} onChange={onChange} fields={MOCK_FIELDS} />);

    const andButton = screen.getByRole('button', { name: 'AND' });
    fireEvent.click(andButton);

    expect(onChange).toHaveBeenCalledOnce();
    const newGroups = onChange.mock.calls[0][0];
    expect(newGroups[0].logic).toBe('AND');
  });

  // ─── Add group (nested) ─────────────────────────────────────────────

  it('adds a new group when Add Group is clicked', () => {
    render(<ConditionBuilder groups={[defaultGroup()]} onChange={onChange} fields={MOCK_FIELDS} />);

    const addGroupBtn = screen.getByRole('button', { name: /\+ Add Group/i });
    fireEvent.click(addGroupBtn);

    expect(onChange).toHaveBeenCalledOnce();
    const newGroups = onChange.mock.calls[0][0];
    expect(newGroups).toHaveLength(2);
    expect(newGroups[1].logic).toBe('AND');
    expect(newGroups[1].conditions).toHaveLength(1);
  });

  // ─── Remove group ───────────────────────────────────────────────────

  it('shows remove group button when 2+ groups', () => {
    render(
      <ConditionBuilder
        groups={[defaultGroup(), defaultGroup()]}
        onChange={onChange}
        fields={MOCK_FIELDS}
      />,
    );

    const removeGroupBtns = screen.getAllByLabelText(/Remove group/i);
    expect(removeGroupBtns.length).toBeGreaterThanOrEqual(1);
  });

  it('does not show remove group button when only 1 group', () => {
    render(<ConditionBuilder groups={[defaultGroup()]} onChange={onChange} fields={MOCK_FIELDS} />);

    const removeGroupBtns = screen.queryAllByLabelText(/Remove group/i);
    expect(removeGroupBtns).toHaveLength(0);
  });

  // ─── Field/operator/value changes ────────────────────────────────────

  it('updates field value when field select changes', () => {
    render(<ConditionBuilder groups={[defaultGroup()]} onChange={onChange} fields={MOCK_FIELDS} />);

    const fieldSelect = screen.getByLabelText(LABELS.field);
    fireEvent.change(fieldSelect, { target: { value: 'title' } });

    expect(onChange).toHaveBeenCalledOnce();
    const newGroups = onChange.mock.calls[0][0];
    expect(newGroups[0].conditions[0].field).toBe('title');
  });

  it('updates operator when operator select changes', () => {
    render(<ConditionBuilder groups={[defaultGroup()]} onChange={onChange} fields={MOCK_FIELDS} />);

    const operatorSelect = screen.getByLabelText(LABELS.operator);
    fireEvent.change(operatorSelect, { target: { value: 'contains' } });

    expect(onChange).toHaveBeenCalledOnce();
    const newGroups = onChange.mock.calls[0][0];
    expect(newGroups[0].conditions[0].operator).toBe('contains');
  });

  it('hides value input for no-value operators (exists)', () => {
    const group: ConditionGroup = {
      logic: 'AND',
      conditions: [{ field: 'title', operator: 'exists', value: '' }],
    };

    render(<ConditionBuilder groups={[group]} onChange={onChange} fields={MOCK_FIELDS} />);

    const valueInputs = screen.queryAllByLabelText(LABELS.value);
    expect(valueInputs).toHaveLength(0);
  });

  // ─── Disabled state ──────────────────────────────────────────────────

  it('disables all controls when disabled prop is true', () => {
    render(
      <ConditionBuilder
        groups={[defaultGroup()]}
        onChange={onChange}
        fields={MOCK_FIELDS}
        disabled
      />,
    );

    const fieldSelect = screen.getByLabelText(LABELS.field);
    expect(fieldSelect).toBeDisabled();

    const operatorSelect = screen.getByLabelText(LABELS.operator);
    expect(operatorSelect).toBeDisabled();

    // Add condition button should be disabled
    const addBtn = screen.getByRole('button', { name: /\+ Add Condition/i });
    expect(addBtn).toBeDisabled();
  });

  // ─── Max groups limit ───────────────────────────────────────────────

  it('does not show Add Group button at max (5) groups', () => {
    const groups = Array.from({ length: 5 }, () => defaultGroup());

    render(<ConditionBuilder groups={groups} onChange={onChange} fields={MOCK_FIELDS} />);

    const addGroupBtn = screen.queryByRole('button', { name: /\+ Add Group/i });
    expect(addGroupBtn).not.toBeInTheDocument();
  });
});
