# Runtime Route Wiring Lens

Review new runtime route handler files for registration completeness.

## What to check

1. **Router file**: Find the router file that should import this handler. Common locations:
   - `apps/runtime/src/routes/index.ts`
   - `apps/runtime/src/routes/<domain>.ts`
   - `apps/runtime/src/server.ts`

2. **Verify the import**: Is the new route handler actually imported in the router file?

3. **Verify the mount**: Is `router.use('/path', handler)` or `app.use('/path', handler)` called for this route?

4. **Auth middleware**: Is `requireAuth` or `createUnifiedAuthMiddleware` applied before this route?

## Emit a finding for each gap

For each missing registration or auth gap, emit a structured finding. If no gaps, emit nothing.
