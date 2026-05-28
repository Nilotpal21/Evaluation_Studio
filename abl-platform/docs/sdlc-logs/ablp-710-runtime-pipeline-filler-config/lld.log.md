# LLD Log: ABLP-710 Runtime Pipeline Filler Config

**Date**: 2026-04-29
**Feature**: runtime-pipeline-filler-config
**Ticket**: ABLP-710

---

## Oracle Decisions (Pre-LLD)

| #   | Question                                              | Classification      | Decision                                                                                                 |
| --- | ----------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------- |
| Q1  | DSL compiler in scope?                                | ANSWERED            | Out of scope — follow-up ticket                                                                          |
| Q2  | fillerMode:none → skip service or disable?            | DECIDED             | Skip creation entirely (avoids StatusTagParser + pipeline LLM wiring)                                    |
| Q3  | Voice pipeline delay defaults?                        | ANSWERED            | delayMs:1200, cooldownMs:5000, maxPerTurn:3 (aligned with chat delay)                                    |
| Q4  | FillerConfigIR in compiler vs defer?                  | AMBIGUOUS → DECIDED | Defer to follow-up compiler ticket. ABLP-710 scope is runtime-only; resolver uses channel-based defaults |
| Q5  | Rename chatDelayMs?                                   | DECIDED             | Keep chatDelayMs, add voiceDelayMs. Export removal guard + additive commit policy blocks renaming        |
| Q6  | resolveFillerConfig location?                         | ANSWERED            | apps/runtime/src/services/filler/config-resolver.ts                                                      |
| Q7  | ChannelManifestEntry constructed outside manifest.ts? | ANSWERED            | No — safe to add required field                                                                          |

---

## Audit Rounds

(To be populated during review)
