/**
 * WritePipeline — Fire-and-forget event sink for trace data.
 */
export interface WritePipeline {
  /** Write an event to the pipeline. Fire-and-forget, never throws. */
  write(event: Record<string, unknown>): void;
}
