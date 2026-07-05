import { z } from 'zod';
import {
  getConfigStore,
  instanceSession,
  getCache,
  reloadConfig,
} from '../lib/foundations.js';
import { success, error, fromError } from '../lib/response-envelope.js';

/**
 * MCP tool handlers must return `{ content: [{ type: "text", text }] }`.
 * We wrap every envelope in that shape.
 */
function asMcp(envelope) {
  return {
    content: [
      { type: 'text', text: JSON.stringify(envelope, null, 2) },
    ],
    isError: envelope.ok === false,
  };
}

export const metaTools = [
  {
    name: 'list_instances',
    description:
      'List every Zendesk instance configured for this server, with default and currently-sticky markers. **Call this once at session start to discover what instances are reachable;** then use `set_instance` to lock onto one. For cross-instance comparisons, leave the sticky instance alone and pass `instance:` per-call to whichever tool you invoke.',
    schema: {},
    handler: async () => {
      try {
        const store = await getConfigStore();
        const instances = store.listInstances();
        return asMcp(
          success(null, {
            instances,
            default: store.getDefaultInstance(),
            current: instanceSession.get(),
            source_path: store.sourcePath,
          }),
        );
      } catch (err) {
        return asMcp(fromError(err, null));
      }
    },
  },
  {
    name: 'set_instance',
    description:
      'Lock the session onto a single Zendesk instance, every subsequent call defaults to it unless you pass `instance:` per-call. **Call this once per session;** the sticky instance is how you avoid repeating yourself across dozens of tool calls. Use `list_instances` first if you don\'t know what\'s configured.',
    schema: {
      name: z
        .string()
        .min(1)
        .describe('Instance name as defined in instances.json'),
    },
    handler: async ({ name }) => {
      try {
        const store = await getConfigStore();
        const entry = store.getInstance(name);
        if (!entry) {
          const available = store.listInstances().map((i) => i.name);
          return asMcp(
            error(
              null,
              'instance_unknown',
              `Unknown instance "${name}". Available: ${available.join(', ') || '(none)'}`,
              { available },
            ),
          );
        }
        instanceSession.set(name);
        return asMcp(success(name, { instance: name, env: entry.env }));
      } catch (err) {
        return asMcp(fromError(err, null));
      }
    },
  },
  {
    name: 'current_instance',
    description: 'Returns the currently active sticky instance, or null if none has been set. Cheap sanity check, call this when you\'re unsure whether `set_instance` has been run yet.',
    schema: {},
    handler: async () => {
      const current = instanceSession.get();
      return asMcp(success(current, { instance: current }));
    },
  },
  {
    name: 'refresh_instance',
    description:
      'Invalidate the in-memory cache for an instance (or scope to specific `kinds:` like `["triggers"]`), forcing the next call to re-fetch from Zendesk. **Call this after the user makes a change in the Zendesk admin UI** so subsequent reads see the new state. When `kinds` is omitted, the per-instance HTTP client is also dropped, so edits to `instances.json` (rotated tokens, fixed creds) take effect on the next call without a server restart. Most other tools also accept `refresh: true` for one-off invalidation; reach for `refresh_instance` when you need to wipe several kinds at once.',
    schema: {
      instance: z
        .string()
        .optional()
        .describe('Instance name; defaults to the sticky instance'),
      kinds: z
        .array(z.string())
        .optional()
        .describe(
          'Optional resource kinds to invalidate (e.g. ["triggers"]); omit to wipe all kinds for the instance',
        ),
    },
    handler: async ({ instance, kinds }) => {
      try {
        const target = instanceSession.resolve(instance);
        getCache().invalidate(target, kinds);
        // When wiping all kinds, also re-read instances.json from disk so a
        // post-edit (rotated token / fixed creds) takes effect on the next call.
        if (!kinds || kinds.length === 0) {
          reloadConfig();
        }
        return asMcp(
          success(target, {
            invalidated: { instance: target, kinds: kinds || 'all' },
          }),
        );
      } catch (err) {
        return asMcp(fromError(err, instance ?? null));
      }
    },
  },
];

export { asMcp };
