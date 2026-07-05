# Design notes

Why this server is built the way it is, and the decisions worth knowing about if you're reading or extending the code.

## The problem

I work across a lot of client Zendesk instances as an admin consultant. The job is usually one of two things: standing up a new instance, or picking up a large messy one and untangling it. Both come down to the same core task. A client states a goal ("auto-assign tickets to agents"), I pick an approach ("omnichannel routing"), and then I have to work out how it fits their specific instance: what already exists, what conflicts, what's missing.

That last step eats the most time. There's no screen in Admin Center that answers "which triggers apply tag X", "which forms reference custom field Y", or "which triggers conflict with each other". You end up clicking through triggers, automations, macros, forms, fields, routing and SLAs by hand, holding the whole picture in your head. The Zendesk API doesn't expose these relational queries either, so a generic API wrapper doesn't help much.

What I actually want is a way to hand an AI agent live, accurate context about a client's instance, so I can describe a problem and have the agent make the instance legible while I do the design thinking.

## The approach

A read-only MCP server scoped to admin and configuration introspection, built around a few ideas:

- **Multi-instance.** One server process serves any number of configured instances. The active instance is sticky for the session, with a per-call override for cross-instance work. Credentials live in one `instances.json`, not scattered `.env` files.
- **Three layers.** A complete read-only API surface (`list_*` / `get_*` for every relevant resource), an analysis layer on top that filters inside conditions and actions server-side (`find_triggers_by_tag`, `find_field_usage`, `find_trigger_conflicts` and friends), and audit composites above that (`summarize_instance`, `audit_trigger_health`, and so on) for the first message of a new engagement.
- **Thin by default.** List responses return a projected subset of fields unless you ask for `verbose: true`. This keeps a single call from filling the agent's context on an instance with hundreds of triggers.
- **Out of the way.** In-memory TTL cache, concurrency cap, transparent 429 retry, plan-aware throttling, and a consistent response envelope. The agent handles the operational detail so the user never sees a cache miss, a cursor or a rate-limit error.

The server exposes state. The agent does the reasoning. The user stays the architect.

## Key decisions

**Read-only in v1.** Every write handler from the original code is gone. Pointing an agent at a client's production instance is far easier to justify when the worst case is a read. Writes, if they happen, are a later version behind an explicit prod-confirmation gate.

**Analysis is pure functions.** The analyzer modules (`TriggerAnalyzer`, `UsageAnalyzer`, `TagAnalyzer`, `UnusedDetector`) take a fetched corpus and return matches. No HTTP, no global state. The tool layer handles fetching, caching and error tolerance around them. This is why they're the priority for tests: wrong analysis produces wrong consultancy advice, and pure functions over JSON are cheap and stable to test.

**Every match carries a `why_matched` breadcrumb.** When the agent says a trigger matched, it says why ("sets tag 'vip' in action #2"). Zendesk's condition and action syntax is gnarly, so being able to spot-check the interpretation matters.

**Plan-aware, per-endpoint throttling.** Zendesk's rate limits differ by category: the overall budget, `search`, and `incremental` endpoints each have their own cap, and all of them scale with the client's Suite plan. The server looks up the right number per request and throttles to a fraction of it, so an analyzer fan-out doesn't 429 on a small plan and doesn't eat the client's own API budget.

**Conflict detection is deliberately conservative.** Two triggers conflict if their condition signatures overlap and they write different values to the same field. False positives are easy to dismiss; false negatives are the ones that bite.

## Response contract

Every tool returns one of:

```json
{ "ok": true,  "instance": "acme", "fetched_at": "...", "cached_at": null, "data": { ... } }
{ "ok": false, "instance": "acme", "error": { "code": "rate_limited", "message": "...", "http_status": 429, "retry_after": 30 } }
```

Error codes: `rate_limited`, `not_found`, `auth_failed`, `instance_unknown`, `bad_request`, `upstream_error`, `timeout`, `validation_error`, `scope_blocked`.

List responses carry `count`, a `truncated` flag and a cursor; analysis responses carry `matches`, `match_count` and `scanned_count`.

## Out of scope for v1

- Writes of any kind.
- Help Center / Guide coverage (better as its own server).
- Deep Chat coverage (Talk stats only).
- A persistent on-disk cache (sessions don't outlive the process often enough to justify it).
- Dedicated cross-instance comparison tools (the per-call `instance` override already covers this at the agent level).
