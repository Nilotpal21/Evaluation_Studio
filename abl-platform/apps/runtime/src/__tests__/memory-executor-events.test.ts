import { describe, it, expect } from 'vitest';
import { eventMatches } from '../services/execution/event-matching.js';

describe('eventMatches', () => {
  it('matches exact event', () => {
    expect(eventMatches('session:start', ['session:start', 'session:end'])).toBe(true);
  });

  it('rejects non-matching event', () => {
    expect(eventMatches('session:end', ['session:start'])).toBe(false);
  });

  it('matches wildcard agent:*:before against specific agent', () => {
    expect(eventMatches('agent:*:before', ['agent:Billing_Agent:before'])).toBe(true);
  });

  it('matches wildcard agent:*:after against specific agent', () => {
    expect(eventMatches('agent:*:after', ['agent:Visa_Agent:after'])).toBe(true);
  });

  it('matches wildcard tool:*:after against specific tool', () => {
    expect(eventMatches('tool:*:after', ['tool:search_hotels:after'])).toBe(true);
  });

  it('does not match wildcard against wrong phase', () => {
    expect(eventMatches('agent:*:before', ['agent:Billing_Agent:after'])).toBe(false);
  });

  it('resolves legacy alias session_start to session:start', () => {
    expect(eventMatches('session_start', ['session:start'])).toBe(true);
  });

  it('resolves legacy alias agent_enter to agent:*:after', () => {
    expect(eventMatches('agent_enter', ['agent:Billing_Agent:after'])).toBe(true);
  });

  it('resolves legacy alias delegate_complete to agent:*:after', () => {
    expect(eventMatches('delegate_complete', ['agent:Support_Agent:after'])).toBe(true);
  });

  it('matches specific named agent event directly', () => {
    expect(eventMatches('agent:Billing_Agent:before', ['agent:Billing_Agent:before'])).toBe(true);
  });

  it('does not match different named agent', () => {
    expect(eventMatches('agent:Billing_Agent:before', ['agent:Visa_Agent:before'])).toBe(false);
  });
});
