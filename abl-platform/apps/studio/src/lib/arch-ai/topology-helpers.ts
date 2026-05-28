/**
 * Extract agent metadata from ABL DSL content for topology visualization.
 * These are lightweight regex-based extractors — NOT full parsers.
 * They read the most common ABL patterns to provide graph node metadata.
 */

export function extractMode(dsl: string | null): 'reasoning' | 'scripted' | 'hybrid' | 'unknown' {
  if (!dsl) return 'unknown';
  const modeMatch = dsl.match(/MODE:\s*(reasoning|scripted|hybrid)/i);
  if (modeMatch) return modeMatch[1].toLowerCase() as 'reasoning' | 'scripted' | 'hybrid';
  // Heuristic: if FLOW section exists, likely scripted or hybrid
  if (/\bFLOW:/i.test(dsl)) {
    return /\bRESPOND:/i.test(dsl) ? 'hybrid' : 'scripted';
  }
  return 'reasoning'; // default for agents without explicit MODE
}

export function extractIsEntryPoint(dsl: string | null): boolean {
  if (!dsl) return false;
  return /ENTRY_POINT:\s*true/i.test(dsl);
}

export function extractToolNames(dsl: string | null): string[] {
  if (!dsl) return [];
  const lines = dsl.split('\n');
  const names = new Set<string>();
  let inTools = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^TOOLS\s*:/i.test(trimmed)) {
      inTools = true;
      continue;
    }

    if (
      inTools &&
      line === line.trimStart() &&
      /^[A-Z_][A-Z0-9_ ]*\s*:/.test(trimmed) &&
      !trimmed.startsWith('-')
    ) {
      break;
    }

    if (!inTools || !trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const signature = trimmed.replace(/^-\s*/, '').split('#')[0]?.trim() ?? '';
    const signatureMatch = signature.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (signatureMatch?.[1]) {
      names.add(signatureMatch[1]);
    }
  }

  return [...names];
}
