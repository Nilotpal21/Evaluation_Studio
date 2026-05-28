/**
 * Color themes for project cards.
 * Deterministic color based on project ID hash.
 */
export const projectColors = [
  { bg: 'bg-accent-subtle', text: 'text-accent', border: 'border-accent' },
  { bg: 'bg-purple-subtle', text: 'text-purple', border: 'border-purple' },
  { bg: 'bg-success-subtle', text: 'text-success', border: 'border-success' },
  { bg: 'bg-warning-subtle', text: 'text-warning', border: 'border-warning' },
  { bg: 'bg-error-subtle', text: 'text-error', border: 'border-error' },
  { bg: 'bg-info-subtle', text: 'text-info', border: 'border-info' },
];

export function getProjectColor(id: string) {
  const hash = id.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return projectColors[hash % projectColors.length];
}
