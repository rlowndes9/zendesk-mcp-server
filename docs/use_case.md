# Use cases

Worked examples of how this server supports real Zendesk admin consultancy work. Each one has the scenario, the prompt that kicks it off, the tools the agent reaches for, and the kind of answer that comes back. The agent picks its own tool path based on what you ask, so treat these as a feel for what questions are productive rather than a script.

All examples assume you've set the instance first, either with `set_instance({ name: "acme" })` or by telling the agent something like "I'm working on Acme today".

## 1. Should we move Acme to omnichannel routing?

Client meeting tomorrow. They want new tickets auto-assigned to agents and you're weighing up omnichannel routing. You need to know what's already in place to scope the change credibly.

> Client wants agents auto-assigned tickets. I'm thinking omnichannel routing. What's the lay of the land in Acme, what already does assignment, and what would conflict if we switch?

The agent runs `summarize_instance` for the headlines, `audit_trigger_health` for existing conflicts, `find_triggers_by_field` for `assignee_id` and `group_id` to find assignment logic, then `list_routing_attributes`, `list_skills` and `list_groups` for the current routing picture.

> Acme has 247 active triggers. 12 set `assignee_id` directly (5 by group via round-robin macros, 7 by user), 8 set `group_id`. Three pairs conflict: `Auto-assign VIP` at position 4 sets a specific user, `Round-robin Tier 1` at position 11 overwrites it, and VIP wins on position.
>
> Routing attributes exist (language, skill_level, channel) but only 2 of 47 agents have any values assigned, so the queues won't route meaningfully until skills are populated.
>
> If you switch to omnichannel queues, the 12 trigger-based assignment rules will fight them. You'd deactivate or rewrite them to fire only outside business hours. Here's the list with positions and titles...

Five minutes of agent time replaces an hour of clicking through trigger lists, because the analyzer and composite tools answer questions the UI has no screen for.

## 2. Why did the macro send the ticket to the wrong group?

Ops pings you: "I ran the 'Send to Tier 2' macro on ticket #58291 but it ended up in Spam. What happened?"

> Ops says they ran macro 360042 on ticket #58291 in Acme. It should have gone to Tier 2 but ended up in Spam. What happened?

The agent pulls `get_ticket({ id: 58291, include_audits: true })` for the full audit trail, reads the timeline, then fetches the macro and the offending trigger and checks `find_trigger_conflicts` to see if it's a systemic problem.

> Macro 'Send to Tier 2' (360042) ran at 14:22:01 and set the group correctly. 0.4 seconds later trigger 'Auto-route spam keywords' (360518, position 7) fired because the last public comment contained "unsubscribe", and overwrote `group_id` to Spam.
>
> Two fixes: add a `current_tags not includes tier-2-routed` condition to 360518 and have the macro set that tag (cleaner long-term), or reorder so 360518 fires before macros are applied (but that changes all spam routing, not just this case).
>
> 360518 conflicts with 4 other group-setting rules in similar ways. Want the list?

This works because ticket audits carry `via.source` with the originating rule and ID, so the causal chain is already in the data. Ask the agent to reconstruct the timeline chronologically and the answer reads well pasted straight back into Slack.

## 3. Is it safe to delete this custom field?

Six-year-old instance, custom field 360001 (`legacy_priority`) hasn't been touched in years, client wants to declutter. You need to know what depends on it first.

> Is it safe to delete custom field 360001 (legacy_priority) in Acme? What references it?

The agent confirms the field with `get_ticket_field`, then runs `find_field_usage({ field_id: 360001 })` to scan every trigger, automation, macro, view and form that references it.

> `legacy_priority` (dropdown) is referenced in 7 places: 3 triggers (2 active, including a sync trigger pulling it into standard `priority`), 1 deactivated macro, 2 views (one active, used in the last 30 days), and 1 active form.
>
> Verdict: not safe. Two active triggers and one active view depend on it, plus it's in an active form. Steps: check who uses the active view, reroute the sync trigger, remove the field from the form, then deletion is safe.

`find_field_usage` does what no Admin Center screen does: it scans across every config object and reports back with `why_matched` breadcrumbs like `condition #1 of all-block (custom_fields_360001 = 'urgent')`. Same pattern works for `find_form_usage` and `find_group_usage` before retiring a form or restructuring groups.

## 4. Picking up a brand new client

New engagement Monday. You've never seen this instance. They've described their pain points but you haven't logged in.

> Just got handed Globex. Give me the lay of the land, what's there, what looks healthy, what looks messy.

The agent sets the instance, then runs the three audit composites: `summarize_instance` for the dashboard, `audit_trigger_health`, `audit_field_health` and `audit_tag_sprawl`.

> Globex at a glance: 89 triggers (72 active), 41 macros, 15 views, 47 ticket fields (32 custom), 8 forms, 3 brands, 4 SLA policies, 12 groups. Oldest active trigger updated 2018-02, worth a manual look.
>
> Trigger health: 4 conflicts (all in Auto-routing), 6 orphaned references pointing at deleted groups or fields, 2 deactivated triggers still positioned under 10, 1 trigger with no actions.
>
> Field health: 8 unused custom fields, 3 used only by inactive rules, 1 dropdown with an empty option list, 4 not in any active form.
>
> Tag sprawl: 247 distinct tags, 6 suspected duplicate clusters (biggest is `{vip, VIP, v_i_p}` across 14 places), 31 set-only tags that are never read.
>
> Want me to drill into any of these?

The composites produce a stable, reproducible format you can paste into a project doc. Save this first-touch output as your baseline, then re-run it in a couple of months and diff to see what changed.

## 5. Tag sprawl deep dive

Client says "we have a tag problem" but can't say what. You suspect duplicate spellings, dead-end tags and tag explosion, and you need numbers.

> Tag sprawl audit on Acme. Show me the dupe clusters and which tags are set but never read.

The agent runs `audit_tag_sprawl({ top_n: 50 })` for the full inventory, then drills into interesting clusters with `find_triggers_by_tag`.

> 387 distinct tags. Top duplicate clusters: `{vip, VIP, v_i_p, vip_customer, vipcustomer}` (31 refs), `{urgent, URGENT, urgent-ticket}` (19), `{escalated, escalation, esc}` (14). The vip family is set by 12 triggers and read by 19, but the reads don't all match the same member, so VIP customers route inconsistently. Worth canonicalising on `vip`.
>
> Set-only tags (set in actions, never read in any condition): 47. Top suspects are `imported_2022_q3`, `ai_categorised` (set by a webhook target) and `legacy_priority_high`. These are dead ends, either feeding an external system or cruft from a past migration.

The duplicate heuristic combines case-insensitive, separator-stripped and edit-distance matching, so it catches the realistic ways tags drift over years. The set-only detection is the hidden gem, surfacing "we set this but never act on it" patterns nobody notices because each rule looks fine on its own.

## 6. Cross-instance pattern reuse

Globex has a clean SLA setup you want to borrow for an Acme engagement. You're not migrating anything, just using it as a reference.

> Show me how Globex's SLA policies are structured, how many, how they're filtered, and the priority and business-hours story.

The agent uses per-call `instance: "globex"` overrides on `list_sla_policies`, `list_schedules` and `list_groups`, so your sticky session stays on Acme.

> Globex has 4 SLA policies: VIP (filter `tags includes vip`, 1h first reply, 24/7 schedule), Standard (`priority is normal`, 4h, business hours), Low (`priority is low`, 24h), and a retired Spam catch-all.
>
> Worth noting: their VIP SLA keys off `tags includes vip` rather than `priority is urgent`, so it runs off tag detection regardless of how priority gets set elsewhere. More robust if your priority field is touched by other rules.
>
> Your next call goes back to Acme unless you keep the override.

Every read tool accepts an optional `instance` arg that overrides the sticky session for one call only, so cross-instance comparison never costs you your working context.

## Patterns worth keeping in mind

- **Lead with `summarize_instance` on a fresh engagement.** It primes the cache for everything that follows, so later analyzer calls are essentially free.
- **Ask for the timeline explicitly when debugging.** The audit data already has timestamps and rule attribution, so "reconstruct chronologically what happened to ticket X" is a strong prompt shape.
- **Trust, but spot-check, `why_matched`.** When an answer surprises you, ask to see the breadcrumbs. That's how you catch a misread of Zendesk's condition syntax.
- **The per-call `instance:` override is your friend** for cross-client comparisons and sandbox-versus-prod sanity checks.
- **Cache rewards a loader-first flow on small-plan clients.** Once a corpus is loaded, anything touching the same data within 5 minutes is free.
