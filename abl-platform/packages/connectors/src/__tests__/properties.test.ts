import { describe, it, expect } from 'vitest';
import { Property } from '../properties.js';

describe('Property builder', () => {
  it('creates a string property', () => {
    const prop = Property.string('channel', 'Channel', {
      description: 'Slack channel name',
      required: true,
    });
    expect(prop).toEqual({
      name: 'channel',
      displayName: 'Channel',
      description: 'Slack channel name',
      type: 'string',
      required: true,
      defaultValue: undefined,
    });
  });

  it('creates a number property', () => {
    const prop = Property.number('amount', 'Amount', {
      required: true,
      defaultValue: 0,
    });
    expect(prop.type).toBe('number');
    expect(prop.required).toBe(true);
    expect(prop.defaultValue).toBe(0);
  });

  it('creates a boolean property with false default', () => {
    const prop = Property.boolean('notify', 'Send Notification');
    expect(prop.type).toBe('boolean');
    expect(prop.required).toBe(false);
    expect(prop.defaultValue).toBe(false);
  });

  it('creates a dropdown property with options', () => {
    const prop = Property.dropdown('priority', 'Priority', [
      { label: 'Low', value: 'low' },
      { label: 'Medium', value: 'medium' },
      { label: 'High', value: 'high' },
    ]);
    expect(prop.type).toBe('dropdown');
    expect(prop.options).toHaveLength(3);
    expect(prop.options![0]).toEqual({ label: 'Low', value: 'low' });
  });

  it('creates a dynamic dropdown property with refreshers', () => {
    const prop = Property.dynamicDropdown('board', 'Board', ['projectId'], {
      description: 'Select a board',
      required: true,
    });
    expect(prop.type).toBe('dynamic_dropdown');
    expect(prop.refreshers).toEqual(['projectId']);
    expect(prop.required).toBe(true);
  });

  it('creates a json property', () => {
    const prop = Property.json('body', 'Request Body', {
      description: 'JSON request body',
    });
    expect(prop.type).toBe('json');
    expect(prop.description).toBe('JSON request body');
  });

  it('defaults required to false', () => {
    const prop = Property.string('optional', 'Optional Field');
    expect(prop.required).toBe(false);
  });
});
