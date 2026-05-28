import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadPackageFiles, readPackageFilesFromData } from '../utils/package-files.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

describe('loadPackageFiles', () => {
  it('normalizes inline file maps and strips common archive wrappers', async () => {
    const loaded = await loadPackageFiles({
      files: {
        'voltmart/project.json': '{"format_version":"2.0"}',
        'voltmart/agents/support.agent.abl': 'AGENT: Support\nGOAL: "Help"',
        'voltmart/node_modules/ignored/index.js': 'ignored',
      },
    });

    expect(loaded.source).toEqual({ kind: 'inline' });
    expect(loaded.warnings).toEqual(['Stripped common archive prefix "voltmart/".']);
    expect(Object.keys(loaded.files).sort()).toEqual(['agents/support.agent.abl', 'project.json']);
  });

  it('reads zip package paths without callers assembling file maps by hand', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'mcp-package-files-'));
    tempDirs.push(dir);
    const zipPath = path.join(dir, 'voltmart.zip');
    await writeFile(
      zipPath,
      makeStoredZip({
        'voltmart/project.json': '{"format_version":"2.0"}',
        'voltmart/agents/support.agent.abl': 'AGENT: Support\nGOAL: "Help"',
        '__MACOSX/._junk': 'ignored',
      }),
    );

    const loaded = await loadPackageFiles({ path: zipPath });

    expect(loaded.source).toEqual({
      kind: 'zip',
      path: zipPath,
      strippedPrefix: 'voltmart/',
    });
    expect(loaded.files).toEqual({
      'project.json': '{"format_version":"2.0"}',
      'agents/support.agent.abl': 'AGENT: Support\nGOAL: "Help"',
    });
  });

  it('rejects path traversal entries', async () => {
    await expect(
      loadPackageFiles({
        files: {
          '../project.json': '{}',
        },
      }),
    ).rejects.toThrow('Invalid file path');
  });

  it('extracts import-style data.files and rejects malformed values early', () => {
    expect(
      readPackageFilesFromData({
        files: {
          'project.json': '{"format_version":"2.0"}',
        },
      }),
    ).toEqual({ 'project.json': '{"format_version":"2.0"}' });

    expect(() => readPackageFilesFromData({ files: [] })).toThrow('data.files must be an object');
    expect(() => readPackageFilesFromData({ files: { 'project.json': 123 } })).toThrow(
      'data.files content must be a string: project.json',
    );
  });

  it('strips common wrappers for profile-only package content', async () => {
    const loaded = await loadPackageFiles({
      files: {
        'wrapped/behavior_profiles/voice.profile.abl':
          'BEHAVIOR_PROFILE: voice\nPRIORITY: 1\nWHEN: true',
      },
    });

    expect(loaded.warnings).toEqual(['Stripped common archive prefix "wrapped/".']);
    expect(loaded.files).toEqual({
      'behavior_profiles/voice.profile.abl': 'BEHAVIOR_PROFILE: voice\nPRIORITY: 1\nWHEN: true',
    });
  });

  it('strips nested common wrappers before package content directories', async () => {
    const loaded = await loadPackageFiles({
      files: {
        'repo-main/src/behavior_profiles/voice.profile.abl':
          'BEHAVIOR_PROFILE: voice\nPRIORITY: 1\nWHEN: true',
      },
    });

    expect(loaded.warnings).toEqual(['Stripped common archive prefix "repo-main/src/".']);
    expect(loaded.files).toEqual({
      'behavior_profiles/voice.profile.abl': 'BEHAVIOR_PROFILE: voice\nPRIORITY: 1\nWHEN: true',
    });
  });
});

function makeStoredZip(entries: Record<string, string>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const [entryName, content] of Object.entries(entries)) {
    const name = Buffer.from(entryName);
    const data = Buffer.from(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const centralDirectoryOffset = offset;
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(centralDirectoryOffset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}
