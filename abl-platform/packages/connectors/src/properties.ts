/**
 * Property Builder
 *
 * Static factory methods for creating typed ConnectorProperty objects.
 * Used by connector definitions to declare their input parameters.
 */

import type { ConnectorProperty, DropdownOption } from './types.js';

interface PropertyOptions {
  description?: string;
  required?: boolean;
  defaultValue?: unknown;
}

export const Property = {
  string(name: string, displayName: string, opts: PropertyOptions = {}): ConnectorProperty {
    return {
      name,
      displayName,
      description: opts.description,
      type: 'string',
      required: opts.required ?? false,
      defaultValue: opts.defaultValue,
    };
  },

  number(name: string, displayName: string, opts: PropertyOptions = {}): ConnectorProperty {
    return {
      name,
      displayName,
      description: opts.description,
      type: 'number',
      required: opts.required ?? false,
      defaultValue: opts.defaultValue,
    };
  },

  boolean(name: string, displayName: string, opts: PropertyOptions = {}): ConnectorProperty {
    return {
      name,
      displayName,
      description: opts.description,
      type: 'boolean',
      required: opts.required ?? false,
      defaultValue: opts.defaultValue ?? false,
    };
  },

  dropdown(
    name: string,
    displayName: string,
    options: DropdownOption[],
    opts: PropertyOptions = {},
  ): ConnectorProperty {
    return {
      name,
      displayName,
      description: opts.description,
      type: 'dropdown',
      required: opts.required ?? false,
      defaultValue: opts.defaultValue,
      options,
    };
  },

  dynamicDropdown(
    name: string,
    displayName: string,
    refreshers: string[],
    opts: PropertyOptions = {},
  ): ConnectorProperty {
    return {
      name,
      displayName,
      description: opts.description,
      type: 'dynamic_dropdown',
      required: opts.required ?? false,
      defaultValue: opts.defaultValue,
      refreshers,
    };
  },

  json(name: string, displayName: string, opts: PropertyOptions = {}): ConnectorProperty {
    return {
      name,
      displayName,
      description: opts.description,
      type: 'json',
      required: opts.required ?? false,
      defaultValue: opts.defaultValue,
    };
  },

  oauth(name: string, displayName: string, opts: PropertyOptions = {}): ConnectorProperty {
    return {
      name,
      displayName,
      description: opts.description,
      type: 'oauth',
      required: opts.required ?? true,
      defaultValue: opts.defaultValue,
    };
  },
};
