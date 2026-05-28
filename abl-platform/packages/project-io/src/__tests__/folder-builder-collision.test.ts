import { describe, it, expect } from 'vitest';
import {
  assignCollisionSafePath,
  buildFileMap,
  type AgentFileEntry,
} from '../export/folder-builder.js';

describe('buildFileMap collision handling', () => {
  it('should handle agents that normalize to the same filename', () => {
    const agents: AgentFileEntry[] = [
      { name: 'BookingAgent', dslContent: 'AGENT: BookingAgent\n', isSupervisor: false },
      { name: 'booking_agent', dslContent: 'AGENT: booking_agent\n', isSupervisor: false },
      { name: 'Booking-Agent', dslContent: 'AGENT: Booking-Agent\n', isSupervisor: false },
    ];
    const files = buildFileMap(agents, [], new Map(), new Map());
    expect(files.size).toBe(3);
    const paths = [...files.keys()];
    expect(new Set(paths).size).toBe(3);
  });

  it('should use suffix numbering for collisions', () => {
    const agents: AgentFileEntry[] = [
      { name: 'test', dslContent: 'AGENT: test\n', isSupervisor: false },
      { name: 'Test', dslContent: 'AGENT: Test\n', isSupervisor: false },
    ];
    const files = buildFileMap(agents, [], new Map(), new Map());
    const paths = [...files.keys()];
    expect(paths).toContain('agents/test.agent.yaml');
    expect(paths).toContain('agents/test_2.agent.yaml');
  });

  it('should use the same suffix numbering for behavior profile collisions', () => {
    const profiles = new Map([
      ['Formal-Tone', 'BEHAVIOR_PROFILE: Formal-Tone'],
      ['formal_tone', 'BEHAVIOR_PROFILE: formal_tone'],
    ]);

    const files = buildFileMap([], [], new Map(), new Map(), undefined, 'yaml', profiles);
    const paths = [...files.keys()];

    expect(paths).toContain('behavior_profiles/formal_tone.behavior_profile.abl');
    expect(paths).toContain('behavior_profiles/formal_tone_2.behavior_profile.abl');
    expect(files.get('behavior_profiles/formal_tone.behavior_profile.abl')).toContain(
      'BEHAVIOR_PROFILE: Formal-Tone',
    );
    expect(files.get('behavior_profiles/formal_tone_2.behavior_profile.abl')).toContain(
      'BEHAVIOR_PROFILE: formal_tone',
    );
  });

  it('should throw after max collision attempts for the shared path assigner', () => {
    const assignedPaths = new Set<string>(['behavior_profiles/test.behavior_profile.abl']);
    for (let suffix = 2; suffix <= 1000; suffix++) {
      assignedPaths.add(`behavior_profiles/test_${suffix}.behavior_profile.abl`);
    }

    expect(() =>
      assignCollisionSafePath('behavior_profiles/test.behavior_profile.abl', assignedPaths),
    ).toThrow(/collision/i);
  });
});
