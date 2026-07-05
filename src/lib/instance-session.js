/**
 * Sticky-instance session state. Module-level singleton plus a class for tests.
 *
 * The active instance is sticky for the session: callers `set(name)` once and
 * subsequent tool calls implicitly target it. A per-call `instance` arg can
 * override without disturbing the sticky pointer.
 */
export class InstanceSession {
  constructor() {
    this._current = null;
  }

  set(name) {
    this._current = name || null;
  }

  get() {
    return this._current;
  }

  /**
   * Resolve which instance a tool call should target.
   *
   * - If `explicitArg` is given (truthy string), that wins for this call only.
   * - Else returns the sticky value if set.
   * - Else throws an Error with `code = "instance_unknown"`. The tool layer
   *   converts this into a structured envelope error.
   */
  resolve(explicitArg) {
    if (typeof explicitArg === 'string' && explicitArg.length > 0) {
      return explicitArg;
    }
    if (this._current) return this._current;
    const err = new Error(
      'No instance set. Call set_instance(name) or pass instance arg.',
    );
    err.code = 'instance_unknown';
    throw err;
  }
}

export const instanceSession = new InstanceSession();
