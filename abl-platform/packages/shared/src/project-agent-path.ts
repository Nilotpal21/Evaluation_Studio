// Local impl: webpack 5 cannot trace named re-exports across packages that also
// use "export *" barrel files. Duplicating the tiny fn here avoids the static-
// analysis warning that Next.js treats as a fatal build error.
export function buildProjectAgentPath(projectId: string, agentName: string): string {
  const p = projectId.trim();
  const a = agentName.trim();
  if (!p) throw new Error('projectId must be a non-empty string');
  if (!a) throw new Error('agentName must be a non-empty string');
  return `${p}/${a}`;
}
