# Env Demo

Demonstrates environment variable usage with stock price and market news APIs.

## Agents

| Agent              | Type       | Description                                                                |
| ------------------ | ---------- | -------------------------------------------------------------------------- |
| EnvDemo_Supervisor | supervisor | Routes requests to the Stock Lookup agent                                  |
| Stock_Lookup       | agent      | Looks up stock prices and market news using `{{env.*}}` HTTP tool bindings |

## Structure

```
env-demo/
  project.json
  agents/
    EnvDemo_Supervisor.agent.abl
    stock_lookup.agent.abl
  tools/
  config/
    project-settings.json
  environment/
    env-vars.json
  locales/
    en/
      EnvDemo_Supervisor.json
      Stock_Lookup.json
```

## Environment Variables

| Variable        | Secret | Description                                    |
| --------------- | ------ | ---------------------------------------------- |
| `STOCK_API_URL` | No     | Base URL for the stock price API               |
| `STOCK_API_KEY` | Yes    | API key for the stock price API                |
| `NEWS_API_URL`  | No     | Base URL for the news API                      |
| `NEWS_API_KEY`  | Yes    | API key for the news API                       |
| `CLIENT_NAME`   | No     | Non-secret identifier shown in request headers |

Configure these in Studio under Deployments > Environments for each target environment (dev/staging/prod).
