# Form Error Handling Lens

Review the file for form submission error handling quality.

## Check for each form or mutation in the file

1. **Async submit handlers**: Does every `async onSubmit` or `async () =>` that calls a mutation or API have a try/catch that catches the error and displays it in the UI?

2. **Mutation error path**: If `useMutation` is used, is there either:
   - An `onError` callback in the mutation options that calls `toast.error()` or sets form error state, OR
   - Every `mutateAsync()` call site wrapped in try/catch with error display?

3. **Field-level validation**: When the API returns a 422 with field-specific errors, are those errors mapped to form field error states using `form.setError()`?

4. **Loading state**: Is the submit button disabled while the mutation is pending (`disabled={isPending}` or `disabled={isLoading}`)?

5. **Error display**: After a failed submission, does the user see:
   - A toast notification with the error message, OR
   - An inline error message below the failed field(s), OR
   - Both?

## Emit a finding for each gap

For each gap found, emit a structured finding using the output schema. If no gaps are found, emit nothing.
