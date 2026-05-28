# Limitations & ABL Gaps

**Overall ABL Coverage**: 63%

5 limitation(s) identified:

## Significant Limitations

### JavaScript processors/pre-processing hooks

**Limitation**: ABL has no JavaScript execution or pre/post-processing hook system

**Alternatives**:

- **Wrap processor logic in TOOLS**
  - Tradeoffs: Logic must be reimplemented as tool functions
  - Example:
  ```
  TOOLS:
    preprocess_input(text: string) -> {processed: string, metadata: object}
  ```

## Moderate Limitations

### PII masking / data privacy configuration

**Limitation**: ABL has no built-in PII detection or masking

**Alternatives**:

- **Use GUARDRAILS with input checks + TOOLS for redaction**
  - Tradeoffs: Less integrated than platform-native PII handling
  - Example:
  ```
  GUARDRAILS:
    pii_check:
      kind: input
      check: "contains_pii(user_input)"
      action: redact
      message: "PII detected and redacted"
  ```

### Per-agent LLM model configuration (model, temperature)

**Limitation**: ABL has no per-agent model configuration syntax

**Alternatives**:

- **Note in documentation - model config is set at deployment level**
  - Tradeoffs: All agents use the same model unless platform supports overrides
  - Example:
  ```
  # Model configuration is set at deployment/runtime level
  ```

## Minor Limitations

### Thought streaming to UI

**Limitation**: ABL has no thought/reasoning stream output

**Alternatives**:

- **Platform-level feature, not needed in agent definition**
  - Tradeoffs: Streaming behavior is a runtime concern
  - Example:
  ```
  # Thought streaming is a platform runtime feature
  ```

### Content variables / template system

**Limitation**: ABL has context references ({{context.field}}) but no global content variable system

**Alternatives**:

- **Use MEMORY persistent paths for shared variables**
  - Tradeoffs: Not the same as compile-time content variables
  - Example:
  ```
  MEMORY:
    persistent:
      - config.welcome_message
      - config.company_name
  ```
