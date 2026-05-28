/**
 * Studio Interactions Contract Test
 *
 * Imports the ACTUAL studio constants (EVENT_TO_STEP, EVENT_LABELS,
 * LIFECYCLE_EVENTS, SESSION_EVENTS) and validates them against
 * RUNTIME_EVENT_TYPES from shared-kernel.
 *
 * Unlike the shared-kernel contract test (which uses hardcoded copies
 * of these sets), this test catches drift when studio constants change
 * without updating the cross-package test.
 */

import { describe, it, expect } from 'vitest';
import { RUNTIME_EVENT_TYPES } from '@agent-platform/shared-kernel';
import {
  EVENT_TO_STEP,
  EVENT_LABELS,
  LIFECYCLE_EVENTS,
  SESSION_EVENTS,
} from '../components/observatory/interactions/constants';

describe('Studio Interactions Contract', () => {
  it('every RUNTIME_EVENT_TYPES entry is covered by EVENT_TO_STEP | LIFECYCLE_EVENTS | SESSION_EVENTS', () => {
    const mappedEvents = new Set(Object.keys(EVENT_TO_STEP));
    const allCovered = new Set([...mappedEvents, ...LIFECYCLE_EVENTS, ...SESSION_EVENTS]);
    const unmapped = RUNTIME_EVENT_TYPES.filter((t) => !allCovered.has(t));

    expect(unmapped).toEqual([]);
  });

  it('every event in EVENT_TO_STEP has a human-readable label in EVENT_LABELS', () => {
    const labelKeys = new Set(Object.keys(EVENT_LABELS));
    const missingLabels = Object.keys(EVENT_TO_STEP).filter((k) => !labelKeys.has(k));

    expect(missingLabels).toEqual([]);
  });

  it('every LIFECYCLE_EVENTS entry has a label in EVENT_LABELS', () => {
    const labelKeys = new Set(Object.keys(EVENT_LABELS));
    const missingLabels = [...LIFECYCLE_EVENTS].filter((k) => !labelKeys.has(k));

    expect(missingLabels).toEqual([]);
  });

  it('every SESSION_EVENTS entry has a label in EVENT_LABELS', () => {
    const labelKeys = new Set(Object.keys(EVENT_LABELS));
    const missingLabels = [...SESSION_EVENTS].filter((k) => !labelKeys.has(k));

    expect(missingLabels).toEqual([]);
  });
});
