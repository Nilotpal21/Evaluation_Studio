/**
 * Detect which generated agent should become the project's entry agent.
 *
 * Strategy:
 * 1. Prefer an explicit supervisor/router DSL.
 * 2. Otherwise choose the only agent that is not targeted by a handoff.
 * 3. Fall back to a router-like name, then the first agent.
 */
export function detectEntryAgent(
  agents: { name: string; type?: string; ablContent?: string }[],
): string {
  const supervisor = agents.find(
    (agent) =>
      agent.type === 'supervisor' ||
      (typeof agent.ablContent === 'string' && /^SUPERVISOR:\s/m.test(agent.ablContent)),
  );
  if (supervisor) {
    return supervisor.name;
  }

  const allTargets = new Set<string>();
  for (const agent of agents) {
    if (typeof agent.ablContent !== 'string') {
      continue;
    }
    const matches = agent.ablContent.matchAll(/TO:\s*(\w+)/g);
    for (const match of matches) {
      allTargets.add(match[1]);
    }
  }

  const roots = agents.filter((agent) => !allTargets.has(agent.name));
  if (roots.length === 1) {
    return roots[0].name;
  }

  const routerPattern = /triage|router|coordinator|orchestrator/i;
  const router = agents.find((agent) => routerPattern.test(agent.name));
  if (router) {
    return router.name;
  }

  return agents[0]?.name ?? 'coordinator';
}
