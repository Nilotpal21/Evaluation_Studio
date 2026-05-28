/**
 * extractComplianceRegulations() — Extracts regulation identifiers from conversation notes.
 *
 * Bridges the gap between INTERVIEW phase (compliance stored as conversationNotes)
 * and BUILD phase (B23 constraint coaching expects regulation identifiers like 'PCI-DSS').
 *
 * Canonical regulation keys match REGULATION_TEMPLATES in generate-constraints.ts.
 */

interface ConversationNote {
  icon: string;
  label: string;
  detail: string;
  category: string;
}

/** Canonical regulation keys — must match REGULATION_TEMPLATES keys in generate-constraints.ts */
const REGULATION_PATTERNS: Array<{ canonical: string; patterns: RegExp[] }> = [
  { canonical: 'PCI-DSS', patterns: [/\bpci[\s-]?dss\b/i, /\bpci\b/i] },
  { canonical: 'HIPAA', patterns: [/\bhipaa\b/i] },
  { canonical: 'GDPR', patterns: [/\bgdpr\b/i] },
  { canonical: 'SOC2', patterns: [/\bsoc[\s-]?2\b/i] },
];

/**
 * Extract regulation identifiers from conversation notes with category 'compliance'.
 * Returns deduplicated array of canonical regulation keys.
 */
export function extractComplianceRegulations(notes: ConversationNote[]): string[] {
  const complianceNotes = notes.filter((n) => n.category === 'compliance');
  if (complianceNotes.length === 0) return [];

  const matched = new Set<string>();

  for (const note of complianceNotes) {
    const text = `${note.label} ${note.detail}`;
    for (const { canonical, patterns } of REGULATION_PATTERNS) {
      if (patterns.some((p) => p.test(text))) {
        matched.add(canonical);
      }
    }
  }

  return [...matched];
}
