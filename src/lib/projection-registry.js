/**
 * Single source of truth for "thin" field sets per resource kind.
 * `register(kind, fields)` stores the field list; `project(kind, obj)`
 * returns a new object with only those fields.
 */
export class ProjectionRegistry {
  constructor() {
    this._fields = new Map();
    this._skeletons = new Map();
  }

  register(kind, fields) {
    if (!Array.isArray(fields) || fields.length === 0) {
      throw new Error(
        `ProjectionRegistry: fields must be a non-empty array (kind=${kind})`,
      );
    }
    this._fields.set(kind, [...fields]);
  }

  /**
   * Slice A: register the smaller "skeleton" field set used as the new
   * default response projection. Typically ~4 fields (id, title, active,
   * updated_at). For kinds without a clean skeleton, register the same
   * field list as `register()` and document it inline.
   */
  registerSkeleton(kind, fields) {
    if (!Array.isArray(fields) || fields.length === 0) {
      throw new Error(
        `ProjectionRegistry: skeleton fields must be a non-empty array (kind=${kind})`,
      );
    }
    this._skeletons.set(kind, [...fields]);
  }

  fieldsFor(kind) {
    return this._fields.get(kind) || null;
  }

  skeletonFieldsFor(kind) {
    return this._skeletons.get(kind) || null;
  }

  /** Test helper. */
  registeredSkeletonKinds() {
    return [...this._skeletons.keys()];
  }

  project(kind, obj) {
    const fields = this._fields.get(kind);
    if (!fields) return obj;
    if (!obj || typeof obj !== 'object') return obj;
    const out = {};
    for (const f of fields) {
      if (Object.prototype.hasOwnProperty.call(obj, f)) {
        out[f] = obj[f];
      }
    }
    return out;
  }

  projectMany(kind, items) {
    if (!Array.isArray(items)) return [];
    return items.map((it) => this.project(kind, it));
  }

  /**
   * Project an item to the skeleton field set. Falls back to the thin
   * projection when no skeleton is registered for the kind.
   */
  skeletonOf(kind, obj) {
    const fields = this._skeletons.get(kind);
    if (!fields) return this.project(kind, obj);
    if (!obj || typeof obj !== 'object') return obj;
    const out = {};
    for (const f of fields) {
      if (Object.prototype.hasOwnProperty.call(obj, f)) {
        out[f] = obj[f];
      }
    }
    return out;
  }

  skeletonMany(kind, items) {
    if (!Array.isArray(items)) return [];
    return items.map((it) => this.skeletonOf(kind, it));
  }

  /**
   * Project an item against an arbitrary whitelist (the `fields:` arg on
   * list_* tools). Unknown fields are silently dropped.
   */
  projectFields(obj, fields) {
    if (!obj || typeof obj !== 'object') return obj;
    if (!Array.isArray(fields) || fields.length === 0) return {};
    const out = {};
    for (const f of fields) {
      if (Object.prototype.hasOwnProperty.call(obj, f)) {
        out[f] = obj[f];
      }
    }
    return out;
  }
}

export const projectionRegistry = new ProjectionRegistry();

// Triggers.
projectionRegistry.register('triggers', [
  'id', 'title', 'active', 'position', 'category_id', 'updated_at',
]);

// Core resources.
projectionRegistry.register('tickets', [
  'id', 'subject', 'status', 'priority', 'type',
  'requester_id', 'assignee_id', 'group_id', 'created_at', 'updated_at',
]);
projectionRegistry.register('users', [
  'id', 'name', 'email', 'role', 'organization_id', 'active', 'created_at', 'updated_at',
]);
projectionRegistry.register('organizations', [
  'id', 'name', 'domain_names', 'created_at', 'updated_at',
]);
projectionRegistry.register('groups', [
  'id', 'name', 'description', 'default', 'deleted', 'created_at', 'updated_at',
]);
projectionRegistry.register('macros', [
  'id', 'title', 'active', 'position', 'created_at', 'updated_at',
]);
projectionRegistry.register('views', [
  'id', 'title', 'active', 'position', 'created_at', 'updated_at',
]);
projectionRegistry.register('automations', [
  'id', 'title', 'active', 'position', 'created_at', 'updated_at',
]);

// Schema primitives.
projectionRegistry.register('ticket_fields', [
  'id', 'type', 'key', 'title', 'raw_title', 'description', 'position',
  'active', 'required', 'system_field_options', 'custom_field_options',
  'created_at', 'updated_at',
]);
projectionRegistry.register('ticket_forms', [
  'id', 'name', 'raw_name', 'display_name', 'active', 'default',
  'position', 'ticket_field_ids', 'created_at', 'updated_at',
]);
projectionRegistry.register('custom_statuses', [
  'id', 'status_category', 'agent_label', 'end_user_label',
  'active', 'default', 'created_at', 'updated_at',
]);
projectionRegistry.register('trigger_categories', [
  'id', 'name', 'position', 'created_at', 'updated_at',
]);
projectionRegistry.register('organization_fields', [
  'id', 'type', 'key', 'title', 'position', 'active', 'system', 'created_at', 'updated_at',
]);
projectionRegistry.register('user_fields', [
  'id', 'type', 'key', 'title', 'position', 'active', 'system', 'created_at', 'updated_at',
]);

// Structure primitives.
projectionRegistry.register('brands', [
  'id', 'name', 'brand_url', 'subdomain', 'active', 'default', 'created_at', 'updated_at',
]);
projectionRegistry.register('locales', [
  'id', 'locale', 'name', 'default', 'presentation_name',
]);
projectionRegistry.register('custom_roles', [
  'id', 'name', 'description', 'role_type', 'team_member_count', 'created_at', 'updated_at',
]);
projectionRegistry.register('schedules', [
  'id', 'name', 'time_zone', 'created_at', 'updated_at',
]);
projectionRegistry.register('sla_policies', [
  'id', 'title', 'description', 'position', 'filter', 'policy_metrics', 'created_at', 'updated_at',
]);

// Channel primitives.
projectionRegistry.register('webhooks', [
  'id',
  'name',
  'status',
  'endpoint',
  'http_method',
  'request_format',
  'subscriptions',
  'created_by',
  'updated_by',
  'created_at',
  'updated_at',
]);

projectionRegistry.register('webhook_invocations', [
  'id',
  'webhook_id',
  'status',
  'http_status',
  'request_started_at',
  'request_finished_at',
]);

projectionRegistry.register('targets', [
  'id',
  'type',
  'title',
  'active',
  'created_at',
]);

projectionRegistry.register('dynamic_content', [
  'id',
  'name',
  'default_locale_id',
  'created_at',
  'updated_at',
]);

projectionRegistry.register('audit_logs', [
  'id',
  'source_type',
  'source_id',
  'source_label',
  'actor_id',
  'actor_name',
  'action',
  'change_description',
  'created_at',
]);

// Routing primitives.
projectionRegistry.register('routing_attributes', [
  'id',
  'name',
  'created_at',
]);
projectionRegistry.register('routing_attribute_values', [
  'id',
  'attribute_id',
  'name',
  'created_at',
]);

// Ticket sideloads.
projectionRegistry.register('ticket_comments', [
  'id',
  'type',
  'author_id',
  'body',
  'html_body',
  'public',
  'created_at',
]);
projectionRegistry.register('ticket_audits', [
  'id',
  'ticket_id',
  'created_at',
  'author_id',
  'events',
]);
projectionRegistry.register('side_conversations', [
  'id',
  'ticket_id',
  'subject',
  'state',
  'preview_text',
  'created_at',
  'updated_at',
]);
projectionRegistry.register('ticket_metrics', [
  'id',
  'ticket_id',
  'created_at',
  'updated_at',
  'replies',
  'reply_time_in_minutes',
  'first_resolution_time_in_minutes',
  'full_resolution_time_in_minutes',
  'reopens',
  'group_stations',
  'assignee_stations',
  'on_hold_time_in_minutes',
]);

// ─────────────────────────────────────────────────────────────────────────
// Slice A, skeleton projections.
//
// The default list_* response projection. Aim is ~4 fields:
//   id, title, active, updated_at
// For kinds without a clean (id, title, active, updated_at) shape we map
// the closest analog (e.g. tickets use "subject" as the title-like field;
// users use "name"; metrics have no title).
// ─────────────────────────────────────────────────────────────────────────
projectionRegistry.registerSkeleton('triggers', ['id', 'title', 'active', 'updated_at']);
projectionRegistry.registerSkeleton('automations', ['id', 'title', 'active', 'updated_at']);
projectionRegistry.registerSkeleton('macros', ['id', 'title', 'active', 'updated_at']);
projectionRegistry.registerSkeleton('views', ['id', 'title', 'active', 'updated_at']);
projectionRegistry.registerSkeleton('sla_policies', ['id', 'title', 'position', 'updated_at']);
// tickets, `subject` is the title-like field; ticket's "active" is
// effectively `status` (open/solved/etc), so we surface that instead.
projectionRegistry.registerSkeleton('tickets', ['id', 'subject', 'status', 'updated_at']);
projectionRegistry.registerSkeleton('users', ['id', 'name', 'active', 'updated_at']);
projectionRegistry.registerSkeleton('organizations', ['id', 'name', 'updated_at']);
projectionRegistry.registerSkeleton('groups', ['id', 'name', 'default', 'updated_at']);
projectionRegistry.registerSkeleton('ticket_fields', ['id', 'title', 'active', 'updated_at']);
projectionRegistry.registerSkeleton('ticket_forms', ['id', 'name', 'active', 'updated_at']);
projectionRegistry.registerSkeleton('custom_statuses', ['id', 'agent_label', 'active', 'updated_at']);
projectionRegistry.registerSkeleton('trigger_categories', ['id', 'name', 'position', 'updated_at']);
projectionRegistry.registerSkeleton('organization_fields', ['id', 'title', 'active', 'updated_at']);
projectionRegistry.registerSkeleton('user_fields', ['id', 'title', 'active', 'updated_at']);
projectionRegistry.registerSkeleton('brands', ['id', 'name', 'active', 'updated_at']);
projectionRegistry.registerSkeleton('custom_roles', ['id', 'name', 'role_type', 'updated_at']);
projectionRegistry.registerSkeleton('schedules', ['id', 'name', 'time_zone', 'updated_at']);
projectionRegistry.registerSkeleton('webhooks', ['id', 'name', 'status', 'updated_at']);
projectionRegistry.registerSkeleton('targets', ['id', 'title', 'active', 'created_at']);
projectionRegistry.registerSkeleton('dynamic_content', ['id', 'name', 'default_locale_id', 'updated_at']);
projectionRegistry.registerSkeleton('audit_logs', ['id', 'action', 'source_type', 'created_at']);
projectionRegistry.registerSkeleton('routing_attributes', ['id', 'name', 'created_at']); // same as thin, no active/updated_at on this resource
projectionRegistry.registerSkeleton('routing_attribute_values', ['id', 'attribute_id', 'name', 'created_at']); // same as thin
// Agent skill assignments are simply attribute-value rows on a user.
projectionRegistry.register('routing_agent_assignments', ['id', 'attribute_id', 'name', 'created_at']);
projectionRegistry.registerSkeleton('routing_agent_assignments', ['id', 'attribute_id', 'name', 'created_at']);
// Webhook invocations have no title/active, keep the timing-relevant fields.
projectionRegistry.registerSkeleton('webhook_invocations', ['id', 'webhook_id', 'status', 'request_started_at']);
// Locales: no skeleton-friendly shape, fall back to the thin projection.
projectionRegistry.registerSkeleton('locales', ['id', 'locale', 'name', 'default']);
// Ticket sideloads.
projectionRegistry.registerSkeleton('ticket_comments', ['id', 'author_id', 'public', 'created_at']);
projectionRegistry.registerSkeleton('ticket_audits', ['id', 'ticket_id', 'author_id', 'created_at']);
projectionRegistry.registerSkeleton('side_conversations', ['id', 'subject', 'state', 'updated_at']);
// Ticket metrics: no title/active analog, keep id+ticket_id+timing summary.
projectionRegistry.registerSkeleton('ticket_metrics', ['id', 'ticket_id', 'replies', 'updated_at']);
