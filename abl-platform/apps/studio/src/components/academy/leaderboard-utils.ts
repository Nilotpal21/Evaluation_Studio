/**
 * Deterministic avatar background color from a userId hash.
 * Returns a semantic token class name.
 */
export function avatarColor(userId: string): string {
  const colors = ['bg-accent', 'bg-success', 'bg-warning', 'bg-error', 'bg-info', 'bg-purple'];
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = ((hash << 5) - hash + userId.charCodeAt(i)) | 0;
  }
  return colors[Math.abs(hash) % colors.length];
}
