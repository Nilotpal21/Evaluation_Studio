# Workspace & Team Management

> **Estimated time**: 15 minutes | **Prerequisites**: None

## Learning Objectives

After completing this module, you will be able to:

- Describe the Agent Platform resource hierarchy and how workspaces, projects, and organizations relate to each other
- Explain the role-based access control (RBAC) model and assign appropriate roles to team members
- Manage team invitations, permissions, and workspace ownership
- Understand tenant isolation and its implications for data security
- Identify the right plan tier for your organization's needs

## How the Platform Is Organized

The Agent Platform organizes everything in a clear hierarchy that mirrors how most organizations work:

| Level                       | What It Contains                                                | Key Purpose                                                      |
| --------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------- |
| **Organization** (optional) | One or more workspaces                                          | Centralized billing and governance across teams                  |
| **Workspace**               | Projects, team members, AI model configurations, secrets        | Your team's dedicated environment -- the primary unit of tenancy |
| **Project**                 | Agents, knowledge bases, tools, environment variables, sessions | A specific use case or business initiative                       |

> **Key Concept**: A workspace is the fundamental boundary in the platform. Think of it as your team's private office -- everything inside it (data, credentials, configurations) is completely isolated from other workspaces. One workspace can host multiple projects, each serving a different department or business function.

For example, a mid-size company might set up a single workspace and create separate projects for **Customer Support** (with triage, billing, and technical agents), **Sales** (with product recommendation and checkout agents), and **Internal Operations** (with HR and IT helpdesk agents). This keeps each department's work organized while sharing a common pool of AI model configurations and team management.

### When to Use an Organization

Organizations are optional and add a layer above workspaces. Consider creating one when:

- Multiple teams need **separate workspaces** but share a billing account
- Centralized IT governance requires a **single control point** for plans, credit allocation, and security policies
- Budget allocation needs to flow from a **shared credit pool** to individual workspaces with per-workspace quotas

If you operate a single workspace, you do not need an organization.

## Roles and Permissions

The Agent Platform uses a hierarchical role-based access control system. Each role inherits all permissions from the roles below it.

### Workspace Roles

| Role         | What They Do                                                                        | Typical User                       |
| ------------ | ----------------------------------------------------------------------------------- | ---------------------------------- |
| **Owner**    | Full control -- billing, workspace deletion, ownership transfer. One per workspace. | Team lead or department head       |
| **Admin**    | Manages team members, AI models, secrets, and connectors. Views audit logs.         | Platform administrators            |
| **Operator** | Deploys agents, views analytics, manages environment variables and sessions.        | DevOps engineers, operations staff |
| **Member**   | Builds and tests agents within assigned projects.                                   | Agent designers, business analysts |
| **Viewer**   | Read-only access across the workspace.                                              | Stakeholders, reviewers            |

> **Key Concept**: The Operator role is designed for team members who manage production deployments and monitor performance without needing to change workspace-level configurations. Operators can deploy agents, view analytics dashboards, and manage environment variables -- all the day-to-day operational tasks without the ability to invite members or change model configurations.

### Project Roles

Within each project, additional roles provide fine-grained control:

| Role              | Capabilities                                           |
| ----------------- | ------------------------------------------------------ |
| **Project Admin** | Full control over the project's resources and settings |
| **Editor**        | Create and modify agents, tools, and knowledge bases   |
| **Viewer**        | Read-only access to the project                        |

A workspace Admin automatically has Project Admin access to all projects. Project-level roles are for Members and Viewers who need targeted access to specific projects.

### Custom Roles

For organizations needing fine-grained permissions, Owners and Admins can create custom roles that inherit from a built-in role and adjust specific permissions. Permission strings follow the format `resource:action` (for example, `agents:deploy`, `models:configure`, `secrets:read`).

## Managing Your Team

### Inviting Members

To add someone to your workspace:

1. Go to **Settings > Team > Members**
2. Click **Invite member**
3. Enter the invitee's email address
4. Select a role from the dropdown
5. Click **Send invitation**

The invitee receives an email with a unique invitation link. The invitation includes the workspace name, assigned role, and a link to accept.

> **Key Concept**: Invitations expire automatically after **7 days**. If an invitation expires before the recipient accepts it, the expired invitation is cleaned up automatically. You can resend a new invitation from the pending invitations list -- this generates a new token and resets the expiry.

For larger teams, the platform supports **bulk invite** by uploading a CSV file with `email` and `role` columns, and **export members** to download a CSV for auditing purposes.

### Changing Roles and Permissions

Role changes take effect immediately. The platform enforces strict hierarchy rules:

- You cannot assign a role higher than your own
- Only the Owner can promote a member to Admin
- You cannot demote yourself -- ask another Owner or Admin to change your role

### Transferring Ownership

Only the current Owner can transfer ownership. The previous Owner is automatically demoted to Admin, and the new Owner gains full control including the ability to delete the workspace.

## Data Security: Tenant Isolation

> **Key Concept**: Tenant isolation is enforced at the **data layer**, not the application layer. This means every database query automatically includes the tenant identifier as a filter condition. There is no API path, no query pattern, and no configuration error that can expose one workspace's data to another. Even a bug in business logic cannot bypass isolation boundaries.

What this means in practice:

- Your API keys, credentials, and tool bindings are scoped to your workspace and never touch another workspace's workloads
- Cross-tenant access attempts return a "not found" response (not "access denied") to prevent information leakage -- an attacker cannot even confirm whether a resource exists in another workspace
- Within a workspace, projects provide a **second level of isolation**. A session in one project cannot access data from another project, even within the same tenant

This layered approach gives you confidence that your data is secure whether you are on a shared cloud deployment or a dedicated instance.

## Choosing the Right Plan

| Feature                  | Starter | Professional  | Enterprise    |
| ------------------------ | ------- | ------------- | ------------- |
| Team members             | Up to 5 | Up to 25      | Unlimited     |
| Projects                 | Up to 3 | Up to 20      | Unlimited     |
| LLM providers            | 2       | All supported | All supported |
| Connectors               | --      | Yes           | Yes           |
| Advanced analytics       | --      | Yes           | Yes           |
| SSO (SAML/OIDC)          | --      | --            | Yes           |
| KMS (Bring Your Own Key) | --      | --            | Yes           |

> **Key Concept**: **SAML SSO** is available exclusively on the Enterprise plan. If your organization requires employees to authenticate through your corporate identity provider (Okta, Azure AD, OneLogin), you need an Enterprise subscription. All plans support Google authentication as a convenient alternative.

Features not available on your current plan appear greyed out in Studio with an "Upgrade to unlock" tooltip. Plan upgrades take effect immediately with prorated billing.

## Key Takeaways

- A workspace is the primary unit of tenancy -- one workspace with multiple projects is the recommended setup for organizing departments or business initiatives
- The five-role hierarchy (Owner, Admin, Operator, Member, Viewer) provides clear separation of responsibilities, with Operators handling day-to-day deployment and monitoring
- Invitations expire after 7 days and can be resent from the pending invitations list
- Tenant isolation is enforced at the data layer, making it structurally impossible for one workspace to access another's data
- SAML SSO requires the Enterprise plan; Google authentication is available on all plans

## What's Next

Continue to **Platform Configuration** to learn how AI models are configured, how the model resolution chain works, and how to manage costs with model tiers and token budgets.
