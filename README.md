# Zendesk MCP Server

A read-only Model Context Protocol server for Zendesk admin consultants. It feeds an AI agent live context about a customer's Zendesk instance so you can audit, untangle and solutionise faster.

## Why this exists

Zendesk admin consultancy is a solutionising job. A client states a goal ("auto-assign tickets to agents"), you pick an approach ("omnichannel routing"), and then you have to work out how it would actually fit in *their* specific instance: what already exists, what would conflict, what's missing. Doing that across many clients means digging through Admin Center, across triggers, automations, macros, ticket forms, custom fields, routing, SLAs, brands, schedules, custom roles and webhooks, for every single one.

The questions that come up daily ("which triggers apply tag X", "which forms reference custom field Y", "which triggers conflict with each other") have no native equivalent in the Zendesk UI or API. This server gives an AI agent the audit-grade reads, relational queries and pre-baked composites it needs to make a client's instance legible in seconds. The server exposes state, the agent does the reasoning, and you stay the architect.

## What it does (v1)

- **Read-only by design.** v1 is deliberately reads only, no writes anywhere in the surface. Pointing an agent at a client's production instance is a lot easier to sign off on when the worst it can do is read. Writes are a separate, later conversation, once the read patterns have settled.
- **Multi-instance by design.** One server process, any number of configured Zendesk instances, sticky-session switching with a per-call override. No more swapping `.env` files between clients.
- **Three layers of tools.**
  - **Primitives (~70):** `list_*` and `get_*` for triggers, automations, macros, views, ticket fields, ticket forms, custom statuses, brands, custom roles, schedules, SLA policies, webhooks, dynamic content, routing attributes, skills, audit logs and the rest of the admin surface.
  - **Analyzers:** `find_triggers_by_tag`, `find_triggers_by_field`, `find_trigger_conflicts`, `find_field_usage`, `find_form_usage`, `find_group_usage`, `list_tags_in_use`, `find_unused`. Each match carries a `why_matched` breadcrumb, so the agent's reasoning stays auditable.
  - **Audit composites:** `summarize_instance`, `audit_trigger_health`, `audit_tag_sprawl`, `audit_field_health`. One-call dashboards, built for the first message of a new client engagement.
- **Quiet in operation.** Responses are thin by default, pagination is automatic up to 25,000 items, there's an in-memory TTL cache (5 minutes), HTTP is concurrency-capped with transparent 429 retry, and rate limiting is plan-aware and per-endpoint (Team, Growth, Professional, Enterprise and Enterprise Plus, with separate budgets for `search` and `incremental` endpoints, since Zendesk caps those more tightly than the overall budget). Responses come back as structured envelopes with stable error codes. The user never sees a 429, a cache miss or a paginated cursor, and neither does your client's own staff.
- **PII-safe by default.** A per-instance `scope` controls which tools the agent can invoke. `config` (the production default) hides every tool that touches a ticket, user or organization, so customer content cannot reach the agent. `config_plus_audits` adds back the forensic-debugging tools (`get_ticket_audits`, `get_ticket_metrics`), with comment bodies redacted in audit responses. `full` exposes everything, and is the sandbox default.

## Quick start (macOS)

```bash
# 1. Clone and install
git clone https://github.com/rlowndes9/zendesk-mcp-server.git
cd zendesk-mcp-server
npm install

# 2. Create the config directory
mkdir -p ~/.config/zendesk-mcp

# 3. Write your instances.json (replace the placeholders).
#    `plan`  - the client's Zendesk Suite tier. Drives proactive throttling
#              to 25% of plan limits. team | growth | professional |
#              enterprise | enterprise_plus. Always set this on production.
#    `scope` - which tools are exposed for this instance. Recommended:
#              "config"             - config audit only, no PII (default for prod)
#              "config_plus_audits" - adds get_ticket_audits + get_ticket_metrics,
#                                     with comment bodies redacted (forensic debugging)
#              "full"               - everything (default for sandbox)
cat > ~/.config/zendesk-mcp/instances.json <<'EOF'
{
  "instances": {
    "acme": {
      "subdomain": "acme",
      "email": "you@example.com",
      "token": "your-zendesk-api-token",
      "env": "prod",
      "plan": "enterprise_plus",
      "scope": "config_plus_audits"
    }
  }
}
EOF

# 4. Lock the file down (it holds a live API token)
chmod 600 ~/.config/zendesk-mcp/instances.json

# 5. Smoke test
npm run inspect
```

Open the Inspector URL it prints, click **Tools**, then run `list_instances`, `set_instance({ name: "acme" })` and `list_triggers`. Full troubleshooting lives in [docs/RUNNING.md](./docs/RUNNING.md).

## Quick start (Windows, PowerShell)

```powershell
# 1. Clone and install
git clone https://github.com/rlowndes9/zendesk-mcp-server.git
cd zendesk-mcp-server
npm install

# 2. Create the config directory
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.config\zendesk-mcp"

# 3. Write your instances.json (replace the placeholders, then paste the whole block).
#    `plan`  - the client's Zendesk Suite tier. Drives proactive throttling
#              to 25% of plan limits. team | growth | professional |
#              enterprise | enterprise_plus. Always set this on production.
#    `scope` - which tools are exposed for this instance. Recommended:
#              "config"             - config audit only, no PII (default for prod)
#              "config_plus_audits" - adds get_ticket_audits + get_ticket_metrics,
#                                     with comment bodies redacted (forensic debugging)
#              "full"               - everything (default for sandbox)
@'
{
  "instances": {
    "acme": {
      "subdomain": "acme",
      "email": "you@example.com",
      "token": "your-zendesk-api-token",
      "env": "prod",
      "plan": "enterprise_plus",
      "scope": "config_plus_audits"
    }
  }
}
'@ | Set-Content -Path "$env:USERPROFILE\.config\zendesk-mcp\instances.json" -Encoding utf8NoBOM

# 4. Lock the file down (it holds a live API token)
icacls "$env:USERPROFILE\.config\zendesk-mcp\instances.json" /inheritance:r /grant:r "$($env:USERNAME):(R,W)"

# 5. Smoke test
npm run inspect
```

Open the Inspector URL it prints, click **Tools**, then run `list_instances`, `set_instance({ name: "acme" })` and `list_triggers`. Full troubleshooting lives in [docs/RUNNING.md](./docs/RUNNING.md).

> **Note.** `Set-Content -Encoding utf8NoBOM` needs PowerShell 6 or later. On Windows PowerShell 5.1 (the default on older Windows installs), use `[System.IO.File]::WriteAllText("$env:USERPROFILE\.config\zendesk-mcp\instances.json", $jsonContent, [System.Text.UTF8Encoding]::new($false))` instead, because Node's `JSON.parse` rejects files that carry a UTF-8 BOM.

## Adding more clients later

Add another key under `instances` in the same file. Restart the server, or call `refresh_instance` if you've only rotated an existing token, since the file is loaded once at startup.

## Worked example: omnichannel routing

This is the canonical workflow. A consultant picks up Acme and needs to work out whether a routing change is safe:

> **You:** Client wants agents auto-assigned tickets. I'm thinking omnichannel routing. What's the lay of the land in Acme?
>
> **Agent:** *calls `set_instance({ name: "acme" })`, then `summarize_instance`, `audit_trigger_health`, `find_triggers_by_field({ field: "assignee_id" })`, `find_triggers_by_field({ field: "group_id" })`, `list_routing_attributes` and `list_skills`*
>
> **Agent:** Acme has 247 triggers, 12 of which currently assign agents directly (5 by group, 7 by user). Three pairs conflict on overwrite order. Routing attributes are configured but no skills are assigned to agents yet. If we switch to omnichannel queues, the 12 trigger-based assignments will need deactivating or rewriting. Here's the list, with positions and why each one matched...

From there it's a normal design conversation. The agent has the facts, you have the judgement.

More worked examples (first-touch on a new client, "is it safe to delete this custom field?", post-incident "why did the macro send the ticket to the wrong group?", tag-sprawl audits, cross-instance pattern reuse) live in [docs/use_case.md](./docs/use_case.md).

## Available tools

Grouped by layer. See [docs/RUNNING.md](./docs/RUNNING.md) section 8 for the full surface, and `npm run inspect` for live introspection.

| Layer | Tools |
|---|---|
| **Meta** | `list_instances`, `set_instance`, `current_instance`, `refresh_instance` |
| **Core resources** | tickets (with comments, audits, metrics sideloads), users, organizations, groups, macros, views, automations, search, talk stats, chats |
| **Schema** | ticket fields, ticket forms, custom statuses, trigger categories, organization fields, user fields |
| **Structure** | brands, locales, custom roles, schedules, SLA policies |
| **Channels** | webhooks (plus invocations), targets, dynamic content, audit logs |
| **Routing** | routing attributes (plus values), skills, agent skill assignments |
| **Analyzers** | `find_triggers_by_tag`, `find_triggers_by_field`, `find_trigger_conflicts`, `find_field_usage`, `find_form_usage`, `find_group_usage`, `list_tags_in_use`, `find_unused` |
| **Audit composites** | `summarize_instance`, `audit_trigger_health`, `audit_tag_sprawl`, `audit_field_health` |

Every list response is thin by default (`id`, `title`, `active` and so on). Pass `verbose: true` for the full Zendesk payload. Every analysis result includes `why_matched` breadcrumbs.

## Configuration

Instance credentials live in `~/.config/zendesk-mcp/instances.json` on macOS and Linux, or `C:\Users\<you>\.config\zendesk-mcp\instances.json` on Windows (with `~/.zendesk-mcp/instances.json` and `C:\Users\<you>\.zendesk-mcp\instances.json` as fallbacks). The key under `instances` is the short name you'll pass to `set_instance`.

```json
{
  "instances": {
    "acme":     { "subdomain": "acme",        "email": "...", "token": "...", "env": "prod",    "plan": "enterprise_plus", "scope": "config_plus_audits" },
    "acme-sbx": { "subdomain": "acmesandbox", "email": "...", "token": "...", "env": "sandbox" },
    "globex":   { "subdomain": "globex",      "email": "...", "token": "...", "env": "prod",    "plan": "professional",    "scope": "config" },
    "smallcli": { "subdomain": "smallcli",    "email": "...", "token": "...", "env": "prod",    "plan": "team",            "scope": "config" }
  }
}
```

Per-instance fields:

| Field | Required | What it does |
|---|---|---|
| `subdomain`, `email`, `token` | yes | Zendesk credentials. |
| `env` | no (defaults to `"prod"`) | Echoed in every response, so prod/sandbox mistakes reveal themselves. It will gate destructive operations once writes land in v2, and it also drives the default `scope`. |
| `plan` | **yes on prod, no on sandbox** | The client's Zendesk Suite plan. Accepted values: `team`, `growth`, `professional`, `enterprise`, `enterprise_plus` (case-insensitive; spaces and hyphens are fine). It drives the server's per-endpoint throttling. Zendesk's real rate limits differ by category (overall budget vs. `search` vs. `incremental`), so the server looks up the right number for each request and throttles itself to **25%** of it. This matters because `search` on a Team plan is only 10 calls a minute, far below the 200-a-minute overall budget, and a naive analyzer fan-out would 429 instantly without that per-endpoint awareness. |
| `scope` | no (defaults to `"config"` on prod, `"full"` on sandbox) | Controls which tools are exposed for this instance, as a PII-safety gate. Three levels:<br>&bull; **`"config"`** - config audit only. Hides every tool that touches a ticket, user, organization, search, chat or side conversation. Customer content cannot reach the agent at all. This is the recommended default for prod.<br>&bull; **`"config_plus_audits"`** - adds `get_ticket_audits` and `get_ticket_metrics`, so you can do forensic debugging ("why didn't this macro fire on this ticket?"). Comment bodies in audit responses are redacted, so you see rule attribution and field changes, not customer message text.<br>&bull; **`"full"`** - everything is exposed (list/get tickets, comments, users, organizations, search, chats). Use it on sandboxes or your own test instances; it's risky on real client prod.<br>Tools blocked by scope return a structured `scope_blocked` error envelope. |
| `rate_limit_per_min` | no (legacy) | An older one-bucket override. If you set both, `plan` wins. Use `plan` unless you have a specific reason not to. |

Lock the file down, since it holds live API tokens (`chmod 600` on Unix; on Windows, `icacls ... /inheritance:r /grant:r "%USERNAME%:(R,W)"`). The full configuration guide and troubleshooting live in [docs/RUNNING.md](./docs/RUNNING.md).

## Connecting to Claude Desktop

Add this to `~/Library/Application Support/Claude/claude_desktop_config.json` (the macOS path; see RUNNING.md for Windows and Linux):

```json
{
  "mcpServers": {
    "zendesk": {
      "command": "node",
      "args": ["/absolute/path/to/zendesk-mcp-server/src/index.js"]
    }
  }
}
```

Fully quit and relaunch Claude Desktop. Details are in [docs/RUNNING.md](./docs/RUNNING.md) section 5.

## Connecting to Claude Code

```bash
claude mcp add zendesk node /absolute/path/to/zendesk-mcp-server/src/index.js
```

Details are in [docs/RUNNING.md](./docs/RUNNING.md) section 6.

## Project status

v1 is read-only, and that's a deliberate scope decision rather than an unfinished one. The whole surface reads Zendesk config and never writes it, which keeps it safe to run against a live client instance. It's usable today for auditing and solutionising. Writes may follow in a later version once the read patterns have proven out. Bug reports and suggestions are welcome.

## Architecture

- **[docs/PRD.md](./docs/PRD.md)** covers the design rationale and decisions.
- **[docs/RUNNING.md](./docs/RUNNING.md)** covers full setup, troubleshooting, Claude Desktop and Code wiring, and the per-plan rate-limit table.
- **[docs/use_case.md](./docs/use_case.md)** covers six worked workflow examples (solutionising, forensic debugging, cleanup safety checks, first-touch audits, tag-sprawl, and cross-instance comparison).

Analyzer modules under `src/lib/` are pure functions over fetched corpora, so they're independently testable with no HTTP, and the test suite under `test/` exercises them with hand-built fixtures.

## License

Released under the [MIT License](./LICENSE).
