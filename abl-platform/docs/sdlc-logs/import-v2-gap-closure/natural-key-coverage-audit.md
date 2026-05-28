# Natural-Key Coverage Audit: Import v2 Merge

**Date**: 2026-05-06
**Ticket**: ABLP-869
**Status**: Initial coverage lock

## Merge Contract

`conflictStrategy: "merge"` must supersede only active target records that match imported records by stable natural key. It must preserve unrelated active records in the same layer.

## Coverage Matrix

| Layer       | Collection                 | Merge Key                                     | Coverage                                            |
| ----------- | -------------------------- | --------------------------------------------- | --------------------------------------------------- |
| core        | `project_agents`           | `name`                                        | Existing core merge test                            |
| core        | `project_tools`            | `slug`                                        | Existing core merge test                            |
| core        | `project_runtime_configs`  | imported singleton present                    | Existing core merge test                            |
| core        | `project_llm_configs`      | imported singleton present                    | Needs explicit singleton test                       |
| core        | `agent_model_configs`      | `agentName`                                   | Needs explicit model-config test                    |
| core        | `environment_variables`    | `key`, `environment`                          | Needs explicit compound-key test                    |
| core        | `project_config_variables` | `key`                                         | Needs explicit config-variable test                 |
| core        | `mcp_server_configs`       | `name`                                        | Needs explicit MCP config test                      |
| connections | `connector_connections`    | `displayName` or `connectorName` fallback     | Existing disassembler behavior, needs explicit test |
| connections | `connector_configs`        | `connectorType`                               | Existing disassembler behavior, needs explicit test |
| prompts     | `prompt_library_items`     | `name`                                        | Added natural-key test                              |
| prompts     | `prompt_library_versions`  | `promptId` for matched prompt item ids        | Added natural-key test                              |
| workflows   | `workflows`                | `name`                                        | Existing disassembler behavior, needs explicit test |
| workflows   | `workflow_versions`        | `workflowId` for matched workflow ids         | Existing disassembler behavior, needs explicit test |
| guardrails  | `guardrail_policies`       | `name`                                        | Existing guardrail merge test                       |
| search      | `search_indexes`           | `slug` or `name`                              | Existing disassembler behavior, needs explicit test |
| search      | `search_sources`           | `name`, `indexId`                             | Existing disassembler behavior, needs explicit test |
| search      | `knowledge_bases`          | `name`                                        | Existing disassembler behavior, needs explicit test |
| search      | `crawl_patterns`           | `name`                                        | Existing disassembler behavior, needs explicit test |
| evals       | `eval_sets`                | `name`                                        | Existing disassembler behavior, needs explicit test |
| evals       | `eval_scenarios`           | `name`                                        | Existing disassembler behavior, needs explicit test |
| evals       | `eval_personas`            | `name`                                        | Existing disassembler behavior, needs explicit test |
| evals       | `eval_evaluators`          | `name`                                        | Existing disassembler behavior, needs explicit test |
| channels    | `channel_connections`      | `displayName`                                 | Added natural-key test                              |
| channels    | `webhook_subscriptions`    | `channelConnectionId` for matched channel ids | Added natural-key test                              |
| channels    | `widget_configs`           | imported singleton present                    | Added natural-key test                              |
| vocabulary  | `domain_vocabularies`      | `projectKnowledgeBaseId`                      | Added natural-key test                              |
| vocabulary  | `lookup_entries`           | `tableName`, `key`                            | Added natural-key test                              |
| vocabulary  | `canonical_schemas`        | `knowledgeBaseId`                             | Added natural-key test                              |
| vocabulary  | `facts`                    | `scope`, `key`                                | Added natural-key test                              |

## Index Follow-Ups

The merge keys above should be backed by tenant/project-scoped indexes or explicit uniqueness where the domain requires uniqueness. The current slice locks behavioral preservation in the disassembler layer; schema/index hardening should be a separate migration-reviewed slice because several target collections are owned by different packages and services.

## Verdict

The highest-risk child and compound-key cases are now covered for prompts, channels, and vocabulary. Remaining coverage should focus on connections, workflows, search, evals, and the untested core singleton/config collections.
