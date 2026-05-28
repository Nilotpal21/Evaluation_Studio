Help with capacity planning and saturation analysis using the `capacity-planner` skill.

Use this command when the user wants one of four things:

- Plan a saturation test before running it.
- Supervise a live k6 + cluster polling run.
- Analyse an existing run and identify the first real bottleneck.
- Recommend safe scaling changes for Deployment-based services.

Do not use this command for generic runtime bugs, auth failures, or session-level debugging unless the user explicitly asks for capacity or load analysis.

Operating rules:

- Start by classifying the request as `plan-only`, `live-run`, `post-run-analysis`, or `safe-scaling-follow-up`.
- If critical run inputs are missing, ask only for the missing facts that block correct analysis: environment, run ID, script name, step ladder, hold duration, and whether changes are analysis-only or change-applying.
- Use the `capacity-planner` skill as the primary procedure and the `load-test-analysis` skill for k6 query syntax and metric interpretation.
- Treat evidence in this order: hold-phase poll JSON for the current step, direct k6 time-series for the same hold window, Coroot metrics for service saturation, then logs/events for explanation.
- Never mix ramp data with hold-window conclusions. If hold boundaries are unclear, say that explicitly and lower confidence.
- Separate facts from interpretations from recommendations. Do not present guesses as findings.

Safety boundaries:

- Never modify StatefulSets, database Helm values, or database/gpu Terraform.
- Only recommend edits for Deployments, HPA, PDB, resource requests/limits, and safe user-node autoscaling settings.
- If the bottleneck is MongoDB, Redis, Kafka, ClickHouse, OpenSearch, Neo4j, Qdrant, or node-pool capacity outside the allowed scope, stop at a recommendation and tell the user exactly what to change manually.

Analysis rules:

- Identify the first bottleneck, not every noisy symptom.
- For each claimed bottleneck, name the exact service, the exact step/VU level, the limiting metric, the observed value, the effective limit or threshold, and why it is the gating factor.
- Distinguish between `saturated`, `degrading`, `healthy headroom`, and `insufficient evidence`.
- Call out when autoscaling lag, pending pods, CPU throttling, memory pressure, event-loop lag, connection pressure, or datastore contention is the real limiter.
- Prefer conservative recommendations when evidence conflicts.

Required response format:

1. `Mode` and exact scope.
2. `Executive Summary` with the highest safe throughput or current confidence level.
3. `Primary Bottleneck` with step, evidence, and impact.
4. `Supporting Signals` listing only evidence that materially supports the conclusion.
5. `Recommended Actions` split into:
   - `Agent-can-apply`
   - `User-must-apply`
6. `Risks / Uncertainty` with any missing data or ambiguous windows.
7. `Next Validation Step` with the smallest useful follow-up run or config check.

Writing rules:

- Use exact dates, run IDs, step values, and file paths when available.
- Keep the answer decisive and operational. Avoid long tutorials unless the user asked for one.
- If no trustworthy conclusion is possible, say `insufficient evidence` and state the minimum additional data needed.

$ARGUMENTS
