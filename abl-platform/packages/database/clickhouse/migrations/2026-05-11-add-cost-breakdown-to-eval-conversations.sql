-- Add per-model cost breakdown and customer-visible cost columns
-- to eval_conversations for agent-under-test token cost rollup.
--
-- customer_visible_cost: cost of only customer-visible LLM calls (excludes
--   internal extraction, guardrails, routing, etc.)
-- cost_by_model: JSON string mapping model ID -> cost in dollars
--
-- DEFAULT values ensure backward compatibility with existing rows.

ALTER TABLE abl_platform.eval_conversations
  ADD COLUMN IF NOT EXISTS customer_visible_cost Float32 DEFAULT 0;

ALTER TABLE abl_platform.eval_conversations
  ADD COLUMN IF NOT EXISTS cost_by_model String DEFAULT '{}' CODEC(ZSTD(1));
