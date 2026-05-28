# AWS Bedrock Integration

This guide covers how to configure AWS Bedrock as an LLM provider in the ABL Platform,
including both explicit credentials and IAM Roles for Service Accounts (IRSA) authentication modes.

## Overview

The AWS Bedrock integration allows the platform to use Amazon Bedrock foundation models
(primarily Anthropic Claude) for agent execution. The integration supports two authentication modes:

- **Explicit credentials**: Provide an AWS Access Key ID and Secret Access Key directly
  through the Studio UI. Suitable for development, non-EKS deployments, or cross-account access.
- **IRSA (IAM Roles for Service Accounts)**: The runtime pod assumes an IAM role via a Kubernetes
  ServiceAccount annotation. No static credentials are stored. Recommended for production EKS deployments.

When a request arrives, the runtime's model resolution pipeline selects the Bedrock provider,
resolves credentials (explicit or IRSA), and forwards the request to the Bedrock API using
the AWS SDK's `invokeModel` / `invokeModelWithResponseStream` endpoints.

## Prerequisites

### Supported models

| Model ID                                  | Description                |
| ----------------------------------------- | -------------------------- |
| `anthropic.claude-opus-4-6-v1:0`          | Claude Opus 4.6            |
| `anthropic.claude-sonnet-4-6-v1:0`        | Claude Sonnet 4.6          |
| `anthropic.claude-sonnet-4-20250514-v1:0` | Claude Sonnet 4 (May 2025) |

Model access must be enabled in the AWS Bedrock console for each region you intend to use.
Navigate to **Amazon Bedrock > Model access** and request access for the desired models.

### AWS regions

Bedrock is available in a subset of AWS regions. Commonly used regions include:

- `us-east-1` (N. Virginia)
- `us-west-2` (Oregon)
- `eu-west-1` (Ireland)
- `ap-northeast-1` (Tokyo)

Verify model availability in your target region at
[AWS Bedrock pricing](https://aws.amazon.com/bedrock/pricing/) before configuring.

### IAM permissions

The IAM principal (user or role) must have the following minimum policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      "Resource": "arn:aws:bedrock:*::foundation-model/anthropic.claude-*"
    }
  ]
}
```

To restrict to a specific region, replace the first `*` in the Resource ARN:

```
arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-*
```

To restrict to a specific model:

```
arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-6-v1:0
```

## Explicit Credentials Setup

Use this mode when you have static AWS credentials (Access Key ID + Secret Access Key).

### Step-by-step (Studio UI)

1. Open the Studio and navigate to **Settings > LLM Providers**.
2. Click **Add Provider** and select **AWS Bedrock** from the provider list.
3. Fill in the required fields:
   - **AWS Access Key ID**: Your IAM user's access key.
   - **AWS Secret Access Key**: Your IAM user's secret key.
   - **AWS Region**: The region where Bedrock is enabled (e.g., `us-east-1`).
4. Click **Test Connection** to verify the credentials have the required permissions.
5. Click **Save**.
6. Navigate to your agent configuration and select the Bedrock provider with the desired model.

### Security considerations

- Credentials are encrypted at rest using the platform's KMS integration.
- Rotate access keys periodically. AWS recommends rotation every 90 days.
- Use an IAM user with only the minimum Bedrock permissions listed above.
- Prefer IRSA for production deployments to avoid storing static credentials entirely.

## IRSA Setup (IAM Roles for Service Accounts)

IRSA eliminates the need for static credentials by allowing Kubernetes pods to assume
an IAM role through a ServiceAccount annotation. The AWS SDK automatically discovers
the role credentials via the pod's projected service account token.

### EKS cluster requirements

1. **OIDC provider**: Your EKS cluster must have an IAM OIDC identity provider configured.
   Verify with:

   ```bash
   aws eks describe-cluster --name <cluster-name> \
     --query "cluster.identity.oidc.issuer" --output text
   ```

   If no OIDC issuer is returned, enable it:

   ```bash
   eksctl utils associate-iam-oidc-provider \
     --cluster <cluster-name> --approve
   ```

2. **EKS version**: 1.24 or later recommended.

### IAM role creation

1. Create the IAM role with a trust policy scoped to your cluster and namespace:

   ```bash
   ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
   OIDC_ID=$(aws eks describe-cluster --name <cluster-name> \
     --query "cluster.identity.oidc.issuer" --output text | sed 's|https://||')

   cat > trust-policy.json <<EOF
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Principal": {
           "Federated": "arn:aws:iam::${ACCOUNT_ID}:oidc-provider/${OIDC_ID}"
         },
         "Action": "sts:AssumeRoleWithWebIdentity",
         "Condition": {
           "StringEquals": {
             "${OIDC_ID}:sub": "system:serviceaccount:<namespace>:abl-runtime-sa",
             "${OIDC_ID}:aud": "sts.amazonaws.com"
           }
         }
       }
     ]
   }
   EOF

   aws iam create-role \
     --role-name AblBedrockRole \
     --assume-role-policy-document file://trust-policy.json
   ```

2. Attach the Bedrock permissions policy:

   ```bash
   cat > bedrock-policy.json <<EOF
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": [
           "bedrock:InvokeModel",
           "bedrock:InvokeModelWithResponseStream"
         ],
         "Resource": "arn:aws:bedrock:*::foundation-model/anthropic.claude-*"
       }
     ]
   }
   EOF

   aws iam put-role-policy \
     --role-name AblBedrockRole \
     --policy-name BedrockInvokePolicy \
     --policy-document file://bedrock-policy.json
   ```

3. Annotate the Kubernetes ServiceAccount:

   ```bash
   kubectl annotate serviceaccount abl-runtime-sa \
     -n <namespace> \
     eks.amazonaws.com/role-arn=arn:aws:iam::${ACCOUNT_ID}:role/AblBedrockRole
   ```

4. Restart the runtime pods to pick up the new annotation:

   ```bash
   kubectl rollout restart deployment/abl-runtime -n <namespace>
   ```

### Verification

Exec into a runtime pod and verify the environment variables are injected:

```bash
kubectl exec -it deploy/abl-runtime -n <namespace> -- env | grep AWS_
```

You should see `AWS_ROLE_ARN` and `AWS_WEB_IDENTITY_TOKEN_FILE` set automatically by EKS.

### Studio configuration for IRSA

When adding the Bedrock provider in Studio with IRSA:

1. Open **Settings > LLM Providers**.
2. Click **Add Provider** and select **AWS Bedrock**.
3. Leave the **AWS Access Key ID** and **AWS Secret Access Key** fields empty.
4. Set the **AWS Region** to your target region.
5. Save. The runtime will automatically use IRSA credentials from the pod's environment.

## Multi-Region Configuration

To use Bedrock across multiple AWS regions (for latency optimization or model availability),
create a separate provider entry for each region:

1. In **Settings > LLM Providers**, add a Bedrock provider for each region
   (e.g., `us-east-1`, `eu-west-1`).
2. Name each provider descriptively (e.g., "Bedrock US East", "Bedrock EU West").
3. In agent configuration, select the provider corresponding to the region closest
   to your users or where the desired model is available.

When using IRSA, the same IAM role works across regions as long as the Bedrock
permissions policy uses a wildcard region (`arn:aws:bedrock:*::foundation-model/...`).
For explicit credentials, the same access key works across regions since IAM is global.

## Provider Cache Configuration

The runtime caches resolved provider configurations to avoid repeated database lookups
and credential resolution on every request.

| Environment Variable             | Default | Description                                             |
| -------------------------------- | ------- | ------------------------------------------------------- |
| `LLM_PROVIDER_CACHE_TTL_SECONDS` | `1800`  | TTL in seconds for cached provider entries (30 minutes) |

To adjust the cache TTL:

```bash
# In your deployment environment variables
LLM_PROVIDER_CACHE_TTL_SECONDS=900  # 15 minutes
```

**When to adjust:**

- **Lower the TTL** (e.g., 300s) during credential rotation or provider configuration changes
  so the runtime picks up new settings faster.
- **Raise the TTL** (e.g., 3600s) for stable production environments to reduce database load.

After changing provider configuration, the cache will clear naturally after the TTL expires.
A pod restart also clears the cache immediately.

## Troubleshooting

### AccessDeniedException

**Symptom**: Requests fail with `AccessDeniedException` from the Bedrock API.

**Causes and fixes**:

- The IAM principal lacks the `bedrock:InvokeModel` permission. Attach the minimum
  policy documented above.
- The policy Resource ARN does not match the model being invoked. Ensure the ARN
  covers the model ID (e.g., `anthropic.claude-*` for all Claude models).
- Model access has not been granted in the Bedrock console. Navigate to
  **Amazon Bedrock > Model access** and request access for the specific model.

### ResourceNotFoundException

**Symptom**: Requests fail with `ResourceNotFoundException`.

**Causes and fixes**:

- The model is not available in the configured region. Check the
  [Bedrock model availability matrix](https://docs.aws.amazon.com/bedrock/latest/userguide/models-regions.html)
  and switch to a supported region.
- The model ID contains a typo. Verify the exact model ID from the supported models table above.

### ValidationException

**Symptom**: Requests fail with `ValidationException` referencing the model identifier.

**Causes and fixes**:

- The model ID format is incorrect. Bedrock model IDs follow the pattern
  `<provider>.<model-name>-<version>`. Ensure the full ID is used
  (e.g., `anthropic.claude-sonnet-4-6-v1:0`, not `claude-sonnet-4.6`).
- Request parameters exceed model limits (e.g., `max_tokens` too large for the model).
  Consult the model's documentation for parameter constraints.

### ThrottlingException

**Symptom**: Requests fail with a "rate limit exceeded" error message.

**Causes and fixes**:

- Bedrock throttles requests based on per-model, per-region quotas. During burst
  traffic, requests may be throttled even if average throughput is within quota.
- Request a quota increase via **AWS Service Quotas > Amazon Bedrock** for the
  specific model and region.
- Implement retry logic in your agent configuration with exponential backoff.
- Consider distributing load across multiple AWS regions by creating separate
  Bedrock connections per region.

### ServiceUnavailableException

**Symptom**: Requests fail with a "service temporarily unavailable" error message.

**Causes and fixes**:

- This is typically a transient AWS infrastructure issue. Retry the request after
  a short delay.
- Check the [AWS Health Dashboard](https://health.aws.amazon.com/) for active
  Bedrock service events in your region.
- Configure runtime retry settings or implement client-side retry with backoff.

### IRSA credential resolution failures

**Symptom**: The runtime logs indicate credential resolution failed, or requests
return authentication errors despite no explicit credentials being configured.

**Causes and fixes**:

- **Not running on EKS**: IRSA only works on Amazon EKS. If the runtime is running
  outside EKS (local development, non-AWS Kubernetes, Docker Compose), IRSA credentials
  will not be available. Use explicit credentials instead.
- **Missing ServiceAccount annotation**: Verify the annotation exists:

  ```bash
  kubectl get serviceaccount abl-runtime-sa -n <namespace> -o yaml
  ```

  Look for `eks.amazonaws.com/role-arn`.

- **OIDC provider not configured**: The EKS cluster must have an OIDC identity provider.
  See the IRSA setup section above.
- **Pod not restarted**: After adding the ServiceAccount annotation, existing pods must
  be restarted to mount the projected token. Run `kubectl rollout restart`.
- **Trust policy mismatch**: The IAM role's trust policy must reference the correct
  namespace and ServiceAccount name. Verify the `Condition` block matches your deployment.

### "OpenAI API error" fallback symptom

**Symptom**: Agent execution logs show an "OpenAI API error" even though the agent is
configured to use Bedrock.

**Causes and fixes**:

- **No provider configured**: If no Bedrock provider is set up for the tenant or project,
  the model resolution pipeline may fall back to a default OpenAI provider (if one exists)
  or fail with a misleading error. Verify the Bedrock provider is configured in
  **Settings > LLM Providers**.
- **Provider not assigned to agent**: The agent must be explicitly configured to use the
  Bedrock provider. Check the agent's model configuration in Studio.
- **Stale provider cache**: If you recently added the Bedrock provider, the runtime may
  still be serving a cached configuration. Wait for the cache TTL to expire
  (`LLM_PROVIDER_CACHE_TTL_SECONDS`, default 30 minutes) or restart the runtime pods.
