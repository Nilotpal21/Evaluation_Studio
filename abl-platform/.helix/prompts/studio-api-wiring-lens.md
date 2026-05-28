# Studio API Wiring Lens

Review the feature for Studio API → service → runtime wiring completeness.

## Check for each new API route file in apps/studio/src/app/api/

1. **UI caller exists**: Search for the route path string in `apps/studio/src/` TSX/TS files.
   - Is there a `fetch('/api/...')`, `useQuery({ queryFn: ... fetch ... })`, or `useMutation` call that references this route?
   - If not, the route is dead — no UI component calls it.

2. **Route actually proxies or calls a service**: Does the route handler call `proxyToRuntime()` or invoke a real service method? Or does it return stub data?

3. **No orphan components**: For each component that renders data from this route, verify the component is imported and rendered somewhere in the page/layout tree.

## Check for each new runtime route

1. **Router registration**: Is `router.use(...)` or `router.get/post/put/delete(...)` called for this route in the appropriate router file (e.g., `apps/runtime/src/routes/index.ts`)?

2. **Middleware chain**: Is the route behind the correct auth middleware?

## Emit a finding for each gap

For each wiring gap found, emit a structured finding. If no gaps, emit nothing.
