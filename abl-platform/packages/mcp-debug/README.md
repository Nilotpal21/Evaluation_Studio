# Arch MCP tools (`@koredotcom/agents-mcp-tools`)

Arch is the personified Agent Platform MCP operator for Build, Evaluate, Optimize, Debug, and Analyze workflows. The package name and tool names stay stable for existing automation, but clients now see the tool surface as Arch.

## Install

```json
{
  "mcpServers": {
    "arch-agent-platform": {
      "command": "npx",
      "args": ["@koredotcom/agents-mcp-tools"],
      "env": {
        "AGENTS_URL": "https://agents.kore.ai"
      }
    }
  }
}
```

Add this to your project's `.mcp.json` or `~/.claude/settings.json`.

Existing configs that use an MCP server key like `agent-platform-debug` can keep that key; the key is local client configuration.

### Environment URLs

| Environment | URL                              |
| ----------- | -------------------------------- |
| Production  | `https://agents.kore.ai`         |
| Dev         | `https://agents-dev.kore.ai`     |
| Staging     | `https://agents-staging.kore.ai` |
| QA          | `https://agents-qa.kore.ai`      |
| Local       | `http://localhost:3112`          |

Set `AGENTS_URL` in the `env` block, or pass `serverUrl` directly to `platform_connect`.

## Tools

### Arch Build

Arch creates and changes platform projects, agents, tools, configuration, versions, deployments, and imports.

| Tool                     | Description                                              |
| ------------------------ | -------------------------------------------------------- |
| `platform_projects`      | Manage projects (list, get, create, update, delete)      |
| `platform_agents`        | Manage agents (list, get, save_dsl)                      |
| `platform_versions`      | Manage agent versions (list, create, get, promote, diff) |
| `platform_deployments`   | Manage deployments (list, create, get, retire, rollback) |
| `platform_tools`         | Manage tools (list, get, create, update, delete, test)   |
| `platform_import_export` | Import/export projects                                   |
| `platform_config`        | Manage project and LLM configuration                     |
| `platform_workspaces`    | List, switch, and inspect active workspaces              |

### Arch Evaluate

Arch generates eval assets, runs eval workflows, and reads CI evidence.

| Tool                       | Description                                      |
| -------------------------- | ------------------------------------------------ |
| `platform_eval_personas`   | Manage and generate eval personas                |
| `platform_eval_scenarios`  | Manage and generate eval scenarios               |
| `platform_eval_evaluators` | Manage eval evaluators and templates             |
| `platform_eval_sets`       | Manage eval sets                                 |
| `platform_eval_runs`       | Manage eval runs, preflight, cases, and heatmaps |
| `debug_harness_logs`       | Get Harness CI execution logs                    |

### Arch Optimize

Arch validates packages, inspects compiler-visible models, and drives repair loops.

| Tool                          | Description                                                |
| ----------------------------- | ---------------------------------------------------------- |
| `platform_validate_package`   | Validate a local package and optional import preview       |
| `platform_package_model`      | Show compiler-visible agents, tools, refs, and diagnostics |
| `debug_lint_abl`              | Run ABL repair and design lint checks                      |
| `debug_why_transcript_failed` | Correlate transcript symptoms with ABL file/line causes    |
| `debug_diagnose_transcript`   | Alias for transcript failure diagnosis                     |

### Arch Debug

Arch connects to live sessions, traces failures, and inspects execution state.

| Tool                         | Description                                        |
| ---------------------------- | -------------------------------------------------- |
| `platform_connect`           | Connect and authenticate to the platform           |
| `debug_list_agents`          | List available agents by domain                    |
| `debug_load_agent`           | Load an agent and create a debug session           |
| `debug_send_message`         | Send a message to an agent                         |
| `debug_get_current_state`    | Inspect agent context, gather progress, flow state |
| `debug_traces`               | Search trace events (type, text, agent, error)     |
| `debug_get_span_tree`        | View hierarchical execution flow                   |
| `debug_explain_decision`     | Explain agent decisions with context               |
| `debug_get_flow_graph`       | View state machine graph (JSON or Mermaid)         |
| `debug_get_errors`           | Get errors, warnings, and escalations              |
| `debug_list_active_sessions` | List observable sessions                           |
| `debug_session`              | Subscribe/unsubscribe to session traces            |

### Arch Analyze

Arch explains documentation, diagnostics, and system health signals.

| Tool                    | Description                                |
| ----------------------- | ------------------------------------------ |
| `debug_docs`            | Get or search ABL documentation            |
| `debug_diagnose`        | Diagnose agent config and execution issues |
| `debug_analyze_session` | Automated session diagnostics              |

## Authentication

Authentication is automatic when you call `platform_connect`:

1. **Explicit token** — pass `authToken` parameter
2. **Stored credentials** — reads `~/.config/kore-platform/credentials.json`
3. **Device auth** — opens the browser and polls until approval completes in the same `platform_connect` call

## License

UNLICENSED
