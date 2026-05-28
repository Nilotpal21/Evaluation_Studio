import * as fs from 'fs';
import * as path from 'path';
import type { CompletionContext } from '@abl/language-service';

const MAX_FILES = 100;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.worktrees', 'coverage']);

export interface WorkspaceScanner {
  scan(workspaceFolders: string[]): CompletionContext;
  invalidate(): void;
}

export function createWorkspaceScanner(): WorkspaceScanner {
  let cached: CompletionContext | null = null;

  function findABLFiles(dir: string, files: string[], depth: number): void {
    if (depth > 5 || files.length >= MAX_FILES) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          findABLFiles(path.join(dir, entry.name), files, depth + 1);
        }
      } else if (
        entry.isFile() &&
        (entry.name.endsWith('.agent.yaml') || entry.name.endsWith('.agent.abl'))
      ) {
        files.push(path.join(dir, entry.name));
      }
    }
  }

  function extractNamesFromFile(filePath: string): { agentName?: string; toolNames: string[] } {
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      return { toolNames: [] };
    }

    // Extract agent name
    const agentMatch = content.match(/^agent\s*:\s*(.+)$/m) || content.match(/^AGENT\s*:\s*(.+)$/m);
    const agentName = agentMatch ? agentMatch[1].trim().replace(/^["']|["']$/g, '') : undefined;

    // Extract tool names
    const toolNames: string[] = [];
    let inTools = false;
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (/^tools\s*:/i.test(trimmed)) {
        inTools = true;
        continue;
      }
      if (
        inTools &&
        /^[a-z][a-z_]*\s*:/i.test(trimmed) &&
        !line.startsWith(' ') &&
        !line.startsWith('\t')
      ) {
        inTools = false;
        continue;
      }
      if (inTools) {
        const match = trimmed.match(/^-\s+(?:name\s*:\s*)?(\S+)/);
        if (match) {
          toolNames.push(match[1].replace(/^["']|["']$/g, ''));
        }
      }
    }

    return { agentName, toolNames };
  }

  return {
    scan(workspaceFolders: string[]): CompletionContext {
      if (cached) return cached;

      const files: string[] = [];
      for (const folder of workspaceFolders) {
        findABLFiles(folder, files, 0);
      }

      const agents: Array<{ name: string }> = [];
      const tools: Array<{ name: string; type?: string; description?: string }> = [];
      const seenAgents = new Set<string>();
      const seenTools = new Set<string>();

      for (const file of files) {
        const { agentName, toolNames } = extractNamesFromFile(file);
        if (agentName && !seenAgents.has(agentName)) {
          seenAgents.add(agentName);
          agents.push({ name: agentName });
        }
        for (const name of toolNames) {
          if (!seenTools.has(name)) {
            seenTools.add(name);
            tools.push({ name });
          }
        }
      }

      cached = { availableAgents: agents, availableTools: tools };
      return cached;
    },

    invalidate(): void {
      cached = null;
    },
  };
}
