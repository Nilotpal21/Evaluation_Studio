'use client';

/**
 * Reusable skill-chip rendering for external agents.
 *
 * Used by `ExternalAgentEditPanel` (full edit screen) and `ExternalAgentCard`
 * (chat-surface widget). Extracts the chip JSX previously inlined in
 * EditPanel:161-175 to keep visual treatment consistent across surfaces.
 *
 * Per LLD §3.6: deliberately framework-agnostic — no i18n keys (chat surface
 * uses hardcoded English; EditPanel passes its own `t()`-resolved strings via
 * `skill.name`).
 */
interface Skill {
  id?: string | number;
  name?: string;
  // Tolerate unknown future fields without breaking the chip.
  [key: string]: unknown;
}

interface SkillChipsProps {
  skills: Skill[];
  /** Optional cap. When set, chips beyond `max` collapse into a "+N more" pill. */
  max?: number;
  /** When false, hides the overflow counter entirely. Default: true. */
  showOverflow?: boolean;
}

export function SkillChips({ skills, max, showOverflow = true }: SkillChipsProps) {
  const visible = typeof max === 'number' && max >= 0 ? skills.slice(0, max) : skills;
  const overflow = skills.length - visible.length;

  return (
    <div className="flex flex-wrap gap-1">
      {visible.map((skill, i) => {
        const label =
          typeof skill.name === 'string' && skill.name.trim()
            ? skill.name
            : typeof skill.id === 'string' || typeof skill.id === 'number'
              ? String(skill.id)
              : `Skill ${i + 1}`;
        return (
          <span
            key={typeof skill.id === 'string' || typeof skill.id === 'number' ? skill.id : i}
            className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-background-muted text-muted"
          >
            {label}
          </span>
        );
      })}
      {showOverflow && overflow > 0 && (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-background-muted text-muted">
          +{overflow} more
        </span>
      )}
    </div>
  );
}
