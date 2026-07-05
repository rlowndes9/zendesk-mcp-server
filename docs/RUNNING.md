# Running & connecting the Zendesk MCP

How to install the server, test it locally with the MCP Inspector, and wire it up to Claude Desktop or Claude Code.

This is a v1 read-only audit MCP. Multi-instance native: one server process serves any number of configured Zendesk instances. See [PRD.md](./PRD.md) for the design.

---

## 1. Prerequisites

- **Node.js 18 or higher** (top-level `await` + MCP SDK requirements). Verify: `node --version`.
- **A Zendesk account with API access** for each instance you want to query. You'll need:
  - The instance subdomain (e.g. `acme` for `acme.zendesk.com`).
  - The email of an agent with API permission.
  - An API token. Generate one at *Admin Center → Apps and integrations → Zendesk API → Settings → Add API token*.
- **An MCP client**, either Claude Desktop or Claude Code (CLI).

---

## 2. Install

```bash
git clone https://github.com/rlowndes9/zendesk-mcp-server.git
cd zendesk-mcp-server
npm install
```

That's it, no build step.

---

## 3. Configure your Zendesk instances

The server reads instance credentials from a per-user config file. The path resolves via Node's `os.homedir()`, so it works on every OS, only the literal path differs.

| OS | Primary path | Fallback |
|---|---|---|
| macOS / Linux | `~/.config/zendesk-mcp/instances.json` | `~/.zendesk-mcp/instances.json` |
| Windows | `C:\Users\<you>\.config\zendesk-mcp\instances.json` | `C:\Users\<you>\.zendesk-mcp\instances.json` |

Create the directory:

```bash
# macOS / Linux
mkdir -p ~/.config/zendesk-mcp
```

```powershell
# Windows (PowerShell)
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.config\zendesk-mcp"
```

Then create `instances.json` inside it with this shape:

```json
{
  "instances": {
    "acme": {
      "subdomain": "acme",
      "email": "you@example.com",
      "token": "your-api-token-here",
      "env": "prod",
      "plan": "enterprise_plus",
      "scope": "config_plus_audits"
    },
    "acme-sbx": {
      "subdomain": "acmesandbox",
      "email": "you@example.com",
      "token": "your-sandbox-token-here",
      "env": "sandbox"
    },
    "globex": {
      "subdomain": "globex",
      "email": "you@globex.com",
      "token": "globex-token",
      "env": "prod",
      "plan": "professional",
      "scope": "config"
    }
  }
}
```

Notes:

- The **key** (`acme`, `globex`, …) is what you'll pass to `set_instance(name)`, pick short, memorable names.
- `env` is metadata only in v1 (it's echoed back in responses so you can tell prod vs sandbox at a glance). It will gate destructive ops once writes land in v2.
- **`plan`** (strongly recommended on every prod instance). Accepted values: `team`, `growth`, `professional`, `enterprise`, `enterprise_plus` (case-insensitive; spaces / hyphens normalised). When set, the MCP looks up Zendesk's published per-endpoint rate limits for that plan and throttles itself to **25 %** of each:

  | Plan | overall / min | search / min | incremental / min |
  |---|---|---|---|
  | team | 200 | 10 | 10 |
  | growth | 400 | 100 | 10 |
  | professional | 700 | 100 | 10 |
  | enterprise | 700 | 100 | 10 |
  | enterprise_plus | 2500 | 100 | 10 |

  The per-category throttling matters because Zendesk's `search` and `incremental` endpoints have *much* stricter limits than the overall budget, a naive analyzer fan-out using `search` on a Team plan would 429 instantly without this. Source: <https://developer.zendesk.com/api-reference/introduction/rate-limits/>.

- **Why throttle at all?** Without proactive throttling, the MCP can briefly consume most of a small client's API budget on a fan-out. Even though the concurrency cap (5 in-flight) + 429 retry will keep *you* from breaking, the *client's* staff hitting the API at the same moment may see 429s. Sandboxes and your own test instances can omit `plan`, they fall back to the reactive-only behaviour. The server prints a stderr warning at startup for any `env: "prod"` instance missing both `plan` and `rate_limit_per_min`.

- **`rate_limit_per_min` (legacy):** an older one-bucket override that throttles all categories uniformly. If both `plan` and `rate_limit_per_min` are set, `plan` wins. Prefer `plan`; the per-endpoint awareness is the whole point.

- **`scope`** (the PII-safety gate). Controls which tools the agent can invoke against this instance. Three levels:

  | Scope | Tools exposed | When to use |
  |---|---|---|
  | `config` | All config primitives (triggers, macros, fields, forms, etc.) + analyzers + audit composites. **Hidden:** every tool that touches a ticket, user, organization, search, chat, or side conversation. | **Recommended default for client prod instances.** Customer content (PII) can't reach the agent at all. |
  | `config_plus_audits` | Above + `get_ticket_audits` (with comment bodies redacted) + `get_ticket_metrics`. | When you need forensic debugging, *"why didn't this macro fire on ticket X?"* The audit trail gives you rule attribution and field changes; comment bodies are stripped from the response so PII still doesn't cross the wire. |
  | `full` | Everything: `list_tickets`, `get_ticket`, `get_ticket_comments`, `search`, `list_users`, `get_user`, `list_organizations`, `get_organization`, `list_chats`, `list_side_conversations`. | Sandboxes, your own test instances, or client engagements where the client has explicitly approved full ticket-content access. |

  **Defaults:** if `scope` is omitted, the MCP picks based on `env`: `prod` defaults to `config` (safest), `sandbox` defaults to `full` (convenience). Always explicit-set on prod when you want forensic capabilities, don't rely on defaults to stay safe.

  **What "redacted" means in `config_plus_audits`:** when an audit event has `type: "Comment"`, the `body`, `html_body`, and `plain_body` fields are stripped before the response leaves the MCP. The event is replaced with a `redacted: true` marker. Everything else, `author_id`, `public`, `via.source`, `created_at`, the surrounding `Change` events with rule attribution, is preserved. The agent can still tell *that* a comment was added, *who* added it, and *which rules fired in response*. It just can't see *what the comment said*.

  **Tools blocked by scope** return a structured `scope_blocked` error envelope explaining what scope would unlock them. The agent sees a clear "this requires scope X on this instance" rather than a generic failure.

- **Sanity-check your config:** call `list_instances` in MCP Inspector. The response now includes `plan`, `scope`, `effective_scope` (the resolved value after env defaults), and `rate_limit_per_min` for each instance, so you can confirm what the server actually sees.
- The file is loaded once at server startup. If you edit it, restart the MCP server (or use `refresh_instance` for cache-only refreshes).
- **Permissions:** lock the file down, it holds live API tokens.
  - macOS / Linux: `chmod 600 ~/.config/zendesk-mcp/instances.json`
  - Windows: right-click the file → **Properties → Security → Advanced**, disable inheritance, and remove all groups except your own user. Or via PowerShell: `icacls "$env:USERPROFILE\.config\zendesk-mcp\instances.json" /inheritance:r /grant:r "$env:USERNAME:(R,W)"`.

---

## 4. Test the server with MCP Inspector

The fastest way to verify everything works without involving Claude. From the repo root:

```bash
npm run inspect
```

This launches the MCP Inspector, a web UI for poking at the server directly. Open the URL it prints (usually `http://localhost:6274`).

### Smoke-test sequence

In the Inspector's **Tools** tab, run these in order:

1. `list_instances`, should return the instances from your config file. Verifies the config is loadable.
2. `set_instance` with `{ "name": "acme" }` (substitute your instance key), sets the sticky instance.
3. `current_instance`, should echo back what you just set.
4. `list_triggers`, should return a thin list of triggers from Acme. First call: `cached_at: null`, `fetched_at` populated.
5. `list_triggers` *again* (same args), second call: `cached_at` is now populated. Cache hit.
6. `refresh_instance` with `{ "instance": "acme" }`, wipes the cache for that instance.
7. `list_triggers` once more, `cached_at: null` again. Confirms refresh works.
8. `get_trigger` with `{ "id": <pick an id from step 4> }`, full single-object fetch.

You should see response envelopes shaped like:

```json
{
  "ok": true,
  "instance": "acme",
  "fetched_at": "2026-04-29T...",
  "cached_at": null,
  "data": {
    "count": 247,
    "truncated": false,
    "cursor": null,
    "items": [
      { "id": 360001, "title": "Auto-assign VIP", "active": true, "position": 12, "category_id": 5, "updated_at": "..." }
    ]
  }
}
```

If a tool call returns an `{ ok: false, error: { code: "...", ... } }` envelope, the `code` field tells you what went wrong: `instance_unknown`, `auth_failed`, `not_found`, `rate_limited`, `timeout`, `upstream_error`.

### Try the rest of the surface

Browse the full tool list in the Inspector (under **Tools**). Useful read-only audit tools to try:

- `list_macros`, `list_views`, `list_automations`, `list_ticket_fields`, `list_ticket_forms`
- `list_brands`, `list_custom_roles`, `list_sla_policies`, `list_schedules`
- `list_webhooks`, `list_dynamic_content`
- `list_routing_attributes`, `list_skills` (these will return a graceful `upstream_error` if the instance doesn't have omnichannel routing on its plan)
- `search` with `{ "query": "type:ticket status:open" }` for Zendesk-search-syntax queries

---

## 5. Connect to Claude Desktop

Claude Desktop reads MCP server configuration from a JSON file:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

If the file doesn't exist, create it. Add the Zendesk MCP under `mcpServers`:

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

Replace the path with the actual absolute path to your clone (e.g. `/Users/yourname/Zendesk/zendesk-mcp-server/src/index.js`).

**Important:** the path must be absolute, `~` and relative paths don't work in MCP client configs.

If you already have other MCP servers configured, add `"zendesk"` as a sibling key under `mcpServers`:

```json
{
  "mcpServers": {
    "filesystem": { "command": "...", "args": ["..."] },
    "zendesk": {
      "command": "node",
      "args": ["/Users/yourname/Zendesk/zendesk-mcp-server/src/index.js"]
    }
  }
}
```

Save the file and **fully quit + restart Claude Desktop** (Cmd-Q on macOS, closing the window isn't enough). On the next launch, the Zendesk MCP tools will appear in the tool list.

### First conversation

Start a new chat and tell Claude something like:

> *"I'm working on the Acme Zendesk instance today. Give me a summary of what's there."*

Claude should call `set_instance({ name: "acme" })`, then begin querying. From here on the workflow is natural language, *"what triggers apply the `vip` tag?"*, *"which forms reference custom field 360001?"*, *"compare Acme's trigger setup with Globex's"*.

---

## 6. Connect to Claude Code (CLI)

If you use Claude Code (the CLI tool), register the server with `claude mcp add`:

```bash
claude mcp add zendesk node /absolute/path/to/zendesk-mcp-server/src/index.js
```

Verify:

```bash
claude mcp list
```

You should see `zendesk` listed. From any Claude Code session it'll be available as a tool group named `zendesk`.

To remove later:

```bash
claude mcp remove zendesk
```

---

## 7. Common issues

### "No instance set" error

You called a tool without first calling `set_instance` or passing an explicit `instance` arg. Either:
- Tell Claude which instance to work with at the start of the session, OR
- Pass `instance: "acme"` directly on the tool call.

### `instance_unknown` error

The instance name you used isn't in your config file. Run `list_instances` to see what's available. Check `~/.config/zendesk-mcp/instances.json` and restart the server if you've just added a new instance.

### `auth_failed` error

Token is wrong, expired, or the email doesn't match. Regenerate the API token in Zendesk Admin Center and update the config file.

### `upstream_error` on routing tools

The instance's Zendesk plan doesn't include omnichannel/skill-based routing (Suite Team / Growth plans). This is expected, the tool degrades gracefully. The `error.message` will say `routing config unavailable on this plan`.

### Claude Desktop doesn't see the tools after editing the config

Fully quit (Cmd-Q on macOS) and relaunch, closing the window keeps the process alive. Also double-check the JSON is valid (no trailing commas, properly quoted strings).

### "Server crashed" or no response in Inspector

Check stderr output. The server prints startup messages to stderr (stdout is reserved for MCP JSON-RPC). If the config file is malformed, the server fails fast and prints the parse error.

### Wrong instance answers in the conversation

Every tool response includes `"instance": "acme"` in the JSON. If the agent's answer surprises you, ask Claude to show the raw tool response, the `instance` field will tell you which client it queried. To fix, call `set_instance` with the right name (or pass `instance:` explicitly on individual calls).

---

## 8. What's available right now

For the full and up-to-date tool surface, browse the **Tools** tab in MCP Inspector. The surface:

- **Meta:** `list_instances`, `set_instance`, `current_instance`, `refresh_instance`
- **Core resources:** triggers, tickets (with `include_comments`/`include_audits` sideloads), ticket comments/audits/metrics, side conversations, users, organizations, groups, macros, views, automations, search, talk stats, chats
- **Schema:** ticket fields, ticket forms, custom statuses, trigger categories, organization fields, user fields
- **Structure:** brands, locales, custom roles, schedules, business hours, SLA policies
- **Channels:** webhooks (+ invocations), targets, dynamic content, audit logs
- **Routing:** routing attributes (+ values), skills, agent skill assignments
- **Analyzers:** `find_triggers_by_tag`, `find_triggers_by_field`, `find_trigger_conflicts`, `find_field_usage`, `find_form_usage`, `find_group_usage`, `list_tags_in_use`, `find_unused`
- **Audit composites:** `summarize_instance`, `audit_trigger_health`, `audit_tag_sprawl`, `audit_field_health`

74 tools total. v2 territory: writes, Help Center coverage, Chat deep coverage. See [PRD.md](./PRD.md) "Out of Scope" for the full list.
