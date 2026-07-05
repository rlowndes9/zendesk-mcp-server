import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { normalisePlanName, PLAN_NAMES } from './zendesk-plan-limits.js';
import { normaliseScope, SCOPES } from './scope.js';

/**
 * Loads and validates ~/.config/zendesk-mcp/instances.json
 * (with ~/.zendesk-mcp/instances.json as fallback).
 *
 * Validation is intentionally throw-on-malformed at load time
 * but tolerant of unknown instance names at lookup time.
 */
export class InstanceConfigStore {
  constructor({ instances, defaultInstance = null, sourcePath } = {}) {
    this._instances = instances || {};
    this._default = defaultInstance;
    this._sourcePath = sourcePath || null;
  }

  static defaultPaths() {
    const home = homedir();
    return [
      path.join(home, '.config', 'zendesk-mcp', 'instances.json'),
      path.join(home, '.zendesk-mcp', 'instances.json'),
    ];
  }

  /**
   * Load from disk. Tries XDG path first, falls back to ~/.zendesk-mcp/.
   * If neither exists, returns an empty store (no instances configured).
   * Throws on malformed JSON or schema violations.
   */
  static async load({ paths } = {}) {
    const candidates = paths || InstanceConfigStore.defaultPaths();
    let raw = null;
    let source = null;
    for (const p of candidates) {
      try {
        raw = await readFile(p, 'utf8');
        source = p;
        break;
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
    if (raw === null) {
      // No file found, empty store. Tools that require an instance will
      // produce a clear `instance_unknown` error.
      return new InstanceConfigStore({ instances: {}, sourcePath: null });
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `InstanceConfigStore: failed to parse ${source}: ${err.message}`,
      );
    }
    return InstanceConfigStore.fromObject(parsed, source);
  }

  /**
   * Build a store from an in-memory object. Useful for tests.
   * Validates schema and normalizes env flag.
   */
  static fromObject(obj, sourcePath = null) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new Error(
        'InstanceConfigStore: config root must be an object',
      );
    }
    const { instances, default: defaultInstance } = obj;
    if (
      !instances ||
      typeof instances !== 'object' ||
      Array.isArray(instances)
    ) {
      throw new Error(
        'InstanceConfigStore: "instances" must be an object map',
      );
    }
    const normalized = {};
    for (const [name, entry] of Object.entries(instances)) {
      normalized[name] = validateAndNormalizeInstance(name, entry);
    }
    if (
      defaultInstance !== undefined &&
      defaultInstance !== null &&
      !Object.prototype.hasOwnProperty.call(normalized, defaultInstance)
    ) {
      throw new Error(
        `InstanceConfigStore: default "${defaultInstance}" is not in instances`,
      );
    }
    return new InstanceConfigStore({
      instances: normalized,
      defaultInstance: defaultInstance ?? null,
      sourcePath,
    });
  }

  /** Returns the instance entry, or null if not configured. */
  getInstance(name) {
    if (!name) return null;
    return this._instances[name] || null;
  }

  /**
   * Returns an array of summaries (no secrets, never includes email or
   * token). Includes `plan`, `effective_scope`, and `rate_limit_per_min`
   * so the agent / operator can sanity-check the configuration.
   *
   * `effective_scope` is the *resolved* scope: the explicit scope field
   * if set, otherwise the env-based default ("config" for prod,
   * "full" for sandbox).
   */
  listInstances() {
    return Object.entries(this._instances).map(([name, entry]) => {
      const scope =
        entry.scope ?? (entry.env === 'sandbox' ? 'full' : 'config');
      return {
        name,
        subdomain: entry.subdomain,
        env: entry.env,
        plan: entry.plan ?? null,
        scope: entry.scope ?? null,
        effective_scope: scope,
        rate_limit_per_min: entry.rate_limit_per_min ?? null,
      };
    });
  }

  /** Returns the configured default name, or null. */
  getDefaultInstance() {
    return this._default;
  }

  get sourcePath() {
    return this._sourcePath;
  }
}

function validateAndNormalizeInstance(name, entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(
      `InstanceConfigStore: instance "${name}" must be an object`,
    );
  }
  const required = ['subdomain', 'email', 'token'];
  for (const k of required) {
    if (typeof entry[k] !== 'string' || entry[k].length === 0) {
      throw new Error(
        `InstanceConfigStore: instance "${name}" missing required field "${k}"`,
      );
    }
  }
  let env = entry.env ?? 'prod';
  if (typeof env !== 'string') {
    throw new Error(
      `InstanceConfigStore: instance "${name}" env must be a string`,
    );
  }
  env = env.toLowerCase();
  if (env !== 'prod' && env !== 'sandbox') {
    throw new Error(
      `InstanceConfigStore: instance "${name}" env must be "prod" or "sandbox" (got "${entry.env}")`,
    );
  }
  let rateLimitPerMin;
  if (entry.rate_limit_per_min !== undefined && entry.rate_limit_per_min !== null) {
    if (
      typeof entry.rate_limit_per_min !== 'number' ||
      !Number.isFinite(entry.rate_limit_per_min) ||
      entry.rate_limit_per_min <= 0
    ) {
      throw new Error(
        `InstanceConfigStore: instance "${name}" rate_limit_per_min must be a positive number`,
      );
    }
    rateLimitPerMin = entry.rate_limit_per_min;
  }
  let plan;
  if (entry.plan !== undefined && entry.plan !== null) {
    const normalised = normalisePlanName(entry.plan);
    if (!normalised) {
      throw new Error(
        `InstanceConfigStore: instance "${name}" plan must be one of ${PLAN_NAMES.join(', ')} (got "${entry.plan}")`,
      );
    }
    plan = normalised;
  }
  let scope;
  if (entry.scope !== undefined && entry.scope !== null) {
    const normalised = normaliseScope(entry.scope);
    if (!normalised) {
      throw new Error(
        `InstanceConfigStore: instance "${name}" scope must be one of ${SCOPES.join(', ')} (got "${entry.scope}")`,
      );
    }
    scope = normalised;
  }
  return {
    subdomain: entry.subdomain,
    email: entry.email,
    token: entry.token,
    env,
    ...(plan !== undefined ? { plan } : {}),
    ...(scope !== undefined ? { scope } : {}),
    ...(rateLimitPerMin !== undefined ? { rate_limit_per_min: rateLimitPerMin } : {}),
  };
}
