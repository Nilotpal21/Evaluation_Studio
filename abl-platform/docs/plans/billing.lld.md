# Billing & Usage — Low-Level Design

## Implementation Structure

Billing & Usage is a thin feature layer: one Runtime route file with 5 endpoints, one Studio proxy route, two SWR hook files, and one dashboard component. All data comes from shared MongoDB collections (Deal, CreditLedger, Subscription, Tenant) managed by Platform Admin.

## Key Files

### Runtime

| File                                           | Purpose                                                                                                                                                                                        |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/routes/workspace-billing.ts` | 5 endpoints: GET /deals, GET /credits, POST /upgrade, POST /credits/topup, GET /features. Uses authMiddleware + tenantRateLimit + requirePermission('credential:read'). Dynamic model imports. |

### Studio

| File                                               | Purpose                                                                                                                                         |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/studio/src/app/api/admin/billing/route.ts`   | GET/POST proxy to runtime. Uses requireTenantAuth + requireAdminRole. Routes via `endpoint` query param.                                        |
| `apps/studio/src/hooks/useBilling.ts`              | SWR hooks: useBillingDeals, useBillingCredits, useTenantFeatures. Mutation helpers: requestUpgrade, requestTopup. 60s polling.                  |
| `apps/studio/src/hooks/useAlerts.ts`               | SWR hooks for alert configuration (usage_threshold, credit_low, health_degraded, feature_limit).                                                |
| `apps/studio/src/components/admin/BillingPage.tsx` | Full billing dashboard: plan overview, deals with phases, credit progress bars, LLM usage analytics (AreaChart, PieChart), alert configuration. |

### Key Function Signatures

- `verifyTenantAccess(req, res): string | null` — returns tenantId or sends 403/404 and returns null
- `useBillingDeals(): { deals, isLoading, error, mutate }` — SWR hook for active deals
- `useBillingCredits(): { credits, isLoading, error, mutate }` — SWR hook for credit balance
- `useTenantFeatures(): { features, planTier, isLoading, error, mutate }` — SWR hook for resolved features
- `requestUpgrade(targetPlan: string): Promise<{ success, message, redirectUrl }>` — upgrade mutation
- `requestTopup(params?): Promise<{ success, message, checkoutSessionId }>` — topup mutation

## Known Gaps

| ID      | Gap                                                              | Severity | Notes                                                                    |
| ------- | ---------------------------------------------------------------- | -------- | ------------------------------------------------------------------------ |
| GAP-001 | Upgrade and topup are placeholders (no payment processing)       | High     | Returns 200 with no side effects                                         |
| GAP-002 | Zero test coverage                                               | High     | No test files for any billing component                                  |
| GAP-003 | Credit balance computation scales linearly with deal count       | Low      | No caching; computed on every request                                    |
| GAP-004 | Alert backend routes may not exist in runtime                    | Medium   | useAlerts references /api/admin/alerts which is not in workspace-billing |
| GAP-005 | LLM usage analytics in BillingPage may query ClickHouse directly | Medium   | Not routed through workspace-billing endpoints                           |
