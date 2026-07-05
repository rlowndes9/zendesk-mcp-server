/**
 * Process-wide singletons that wire the foundations together.
 * Tools import from here; tests construct their own instances.
 */
import { InstanceConfigStore } from './instance-config-store.js';
import { instanceSession } from './instance-session.js';
import { ZendeskClientFactory } from './zendesk-client-factory.js';
import { ResourceCache } from './resource-cache.js';
import { projectionRegistry } from './projection-registry.js';
import {
  defaultScopeForEnv,
  getRequiredScope,
  scopeAllowsTool,
} from './scope.js';
import { error as envelopeError } from './response-envelope.js';

let _configStore = null;
let _clientFactory = null;
let _cache = null;

/**
 * Lazily load the config store on first access. We don't fail-fast at
 * server startup, instead, missing config produces a clean
 * `instance_unknown` error on the first tool call that needs an instance.
 */
export async function getConfigStore() {
  if (!_configStore) {
    _configStore = await InstanceConfigStore.load();
    warnUnthrottledProdInstances(_configStore);
  }
  return _configStore;
}

/**
 * Print a stderr warning for any env=prod instance missing rate_limit_per_min.
 * Without it, the MCP can briefly consume most of a small client's API budget
 * on a fan-out. We never fail-fast on this (sandboxes legitimately omit it),
 * but a visible startup nudge surfaces the risk to the operator.
 */
function warnUnthrottledProdInstances(store) {
  const offenders = store
    .listInstances()
    .filter((i) => i.env === 'prod')
    .map((i) => store.getInstance(i.name))
    .filter(
      (entry) =>
        entry &&
        entry.plan === undefined &&
        entry.rate_limit_per_min === undefined,
    )
    .map((entry) => entry.subdomain);
  if (offenders.length === 0) return;
  console.error(
    `[zendesk-mcp] Warning: ${offenders.length} prod instance(s) have no plan or rate_limit_per_min set: ${offenders.join(', ')}.`,
  );
  console.error(
    '[zendesk-mcp]   Without it, the MCP may briefly consume most of the client\'s API budget on fan-outs',
  );
  console.error(
    '[zendesk-mcp]   and may trip 429s on stricter endpoints (search, incremental) on small plans.',
  );
  console.error(
    '[zendesk-mcp]   Recommended: set "plan" in instances.json to one of:',
  );
  console.error(
    '[zendesk-mcp]     team | growth | professional | enterprise | enterprise_plus',
  );
}

export async function getClientFactory() {
  if (!_clientFactory) {
    const configStore = await getConfigStore();
    _clientFactory = new ZendeskClientFactory({ configStore });
  }
  return _clientFactory;
}

export function getCache() {
  if (!_cache) _cache = new ResourceCache();
  return _cache;
}

export { instanceSession, projectionRegistry };

/**
 * Resolve the scope of an instance entry, defaulting based on env when
 * the field isn't set in instances.json.
 */
export function getEffectiveScope(entry) {
  if (!entry) return 'config';
  return entry.scope || defaultScopeForEnv(entry.env);
}

/**
 * Look up an instance by name and return its effective scope, or null
 * if the instance is unknown.
 */
export async function getInstanceScope(instanceName) {
  if (!instanceName) return null;
  const store = await getConfigStore();
  const entry = store.getInstance(instanceName);
  return entry ? getEffectiveScope(entry) : null;
}

/**
 * Wrap a tool's handler with a scope gate. If the tool requires a higher
 * scope than the resolved instance is configured at, returns a structured
 * `scope_blocked` error envelope (in MCP tool-result shape) instead of
 * invoking the handler. Tools that require only `config` (the default)
 * are returned unchanged.
 */
export function gateToolByScope(tool) {
  const required = getRequiredScope(tool.name);
  if (required === 'config') return tool;
  const wrapped = { ...tool };
  const original = tool.handler;
  wrapped.handler = async (args = {}) => {
    let resolvedInstance;
    try {
      resolvedInstance = instanceSession.resolve(args.instance);
    } catch (err) {
      // Let the original handler produce its own instance_unknown error.
      return original(args);
    }
    const scope = await getInstanceScope(resolvedInstance);
    if (!scope || !scopeAllowsTool(scope, required)) {
      const msg =
        `Tool "${tool.name}" requires scope "${required}" but instance "${resolvedInstance}" is configured at scope "${scope || 'config'}". ` +
        `To enable, set "scope": "${required}" (or "full") in instances.json and restart the server.`;
      const envelope = envelopeError(resolvedInstance, 'scope_blocked', msg);
      return {
        content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
        isError: true,
      };
    }
    return original(args);
  };
  return wrapped;
}

/**
 * Drop the cached configStore + clientFactory so the next access re-reads
 * instances.json from disk. Used by refresh_instance to pick up rotated
 * tokens or fixed creds without a server restart.
 */
export function reloadConfig() {
  _configStore = null;
  _clientFactory = null;
}

/** Test-only reset hook. */
export function _resetForTests() {
  _configStore = null;
  _clientFactory = null;
  _cache = null;
}
