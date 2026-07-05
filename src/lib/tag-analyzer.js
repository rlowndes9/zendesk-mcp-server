/**
 * TagAnalyzer, pure functions producing a tag inventory across the
 * triggers / automations / macros corpus. No HTTP, no global state.
 *
 * Surface:
 *   inventory(corpus) -> [{ tag, used_in: [...], dupe_suspects: [...], set_only }]
 *
 * Each `used_in` entry: { kind, id, title, mode } where
 *   kind ∈ { trigger, automation, macro }
 *   mode ∈ { sets, removes, condition }   (same vocabulary as TriggerAnalyzer)
 *
 * Tag value parsing:
 *   - Action `{ field: "current_tags"|"set_tags"|"remove_tags", value: "vip pending" }`
 *     carries space-separated multi-tags. Split on whitespace; drop empty strings.
 *   - Defensively handle `value` arriving as an array.
 *   - Conditions: `{ field: "current_tags", value: "..." }`, same parsing.
 *   - Macros have actions only; no condition rows are scanned for them.
 *
 * Dupe-suspect heuristic (combined): two distinct tags A and B are "suspects"
 * if any one of these holds:
 *   1. case-insensitive equality:           lower(A) === lower(B)
 *   2. separator-stripped equality (lower): stripSep(A) === stripSep(B)
 *      where stripSep removes all `[-_.\s]` characters.
 *   3. Levenshtein distance ≤ 1, and both tags have length ≥ 5
 *      (avoids false positives on very short tags like cat/bat).
 *
 * `set_only` is true when a tag appears only via `sets`/`removes` modes
 * across the corpus and never via `condition`. Useful for the audit
 * composite (`audit_tag_sprawl`) to flag dead-end tags.
 *
 * Output is sorted by tag name ascending (case-insensitive). Within
 * `used_in`, entries are deduped on the `(kind, id, mode)` triple, e.g. a
 * trigger that sets `vip` in two different actions appears once with
 * mode=`sets`.
 */

const TAG_SET_FIELDS = new Set(['current_tags', 'set_tags']);
const TAG_REMOVE_FIELDS = new Set(['remove_tags']);
const TAG_CONDITION_FIELDS = new Set(['current_tags']);

/**
 * Split a tag value (string or array) into a list of trimmed tags.
 * Exported for reuse in the audit composite.
 */
export function parseTagValue(value) {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value.flatMap((v) => parseTagValue(v));
  }
  return String(value)
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function getTitle(resource) {
  return resource?.title ?? resource?.name ?? null;
}

function stripSeparators(s) {
  return s.toLowerCase().replace(/[-_.\s]/g, '');
}

/**
 * Levenshtein edit distance, small inline implementation.
 * Two-row dynamic programming. Returns an integer.
 */
function levenshtein(a, b) {
  if (a === b) return 0;
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  // Quick reject when length difference already exceeds the early threshold.
  let prev = new Array(bl + 1);
  let curr = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    curr[0] = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= bl; j++) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1, // insertion
        prev[j] + 1, // deletion
        prev[j - 1] + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[bl];
}

const LEV_LENGTH_THRESHOLD = 5;

/**
 * Are two distinct tags duplicate suspects under the combined heuristic?
 */
function areDupeSuspects(tagA, tagB) {
  if (tagA === tagB) return false;
  const lowerA = tagA.toLowerCase();
  const lowerB = tagB.toLowerCase();
  if (lowerA === lowerB) return true;
  if (stripSeparators(tagA) === stripSeparators(tagB)) return true;
  // Levenshtein-1 only when both tags meet the length threshold.
  if (tagA.length >= LEV_LENGTH_THRESHOLD && tagB.length >= LEV_LENGTH_THRESHOLD) {
    if (Math.abs(tagA.length - tagB.length) > 1) return false;
    if (levenshtein(lowerA, lowerB) <= 1) return true;
  }
  return false;
}

/**
 * Insert a (kind, id, title, mode) usage row into a tag's record. Dedupes
 * on the (kind, id, mode) triple, a single resource that sets the same
 * tag in multiple actions appears once.
 */
function recordUsage(record, kind, id, title, mode) {
  const exists = record.used_in.some(
    (u) => u.kind === kind && u.id === id && u.mode === mode,
  );
  if (!exists) {
    record.used_in.push({ kind, id, title, mode });
  }
  if (mode === 'condition') {
    record.has_condition = true;
  } else {
    record.has_action = true;
  }
}

function ensureRecord(byTag, tag) {
  let rec = byTag.get(tag);
  if (!rec) {
    rec = { tag, used_in: [], has_condition: false, has_action: false };
    byTag.set(tag, rec);
  }
  return rec;
}

function scanRule(kind, resource, byTag, { scanConditions }) {
  if (!resource || typeof resource !== 'object') return;
  const id = resource.id;
  const title = getTitle(resource);

  // Actions: sets / removes.
  const actions = Array.isArray(resource.actions) ? resource.actions : [];
  for (const action of actions) {
    if (!action || typeof action !== 'object') continue;
    const isSet = TAG_SET_FIELDS.has(action.field);
    const isRemove = TAG_REMOVE_FIELDS.has(action.field);
    if (!isSet && !isRemove) continue;
    const tags = parseTagValue(action.value);
    const mode = isRemove ? 'removes' : 'sets';
    for (const tag of tags) {
      const rec = ensureRecord(byTag, tag);
      recordUsage(rec, kind, id, title, mode);
    }
  }

  // Conditions: current_tags includes / not_includes.
  if (!scanConditions) return;
  const conds = resource.conditions;
  if (!conds || typeof conds !== 'object') return;
  for (const block of ['all', 'any']) {
    const rows = Array.isArray(conds[block]) ? conds[block] : [];
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      if (!TAG_CONDITION_FIELDS.has(row.field)) continue;
      const tags = parseTagValue(row.value);
      for (const tag of tags) {
        const rec = ensureRecord(byTag, tag);
        recordUsage(rec, kind, id, title, 'condition');
      }
    }
  }
}

/**
 * Build the tag inventory.
 *
 * @param {{ triggers?: Array, automations?: Array, macros?: Array }} corpus
 * @returns {Array<{ tag: string, used_in: Array<{kind, id, title, mode}>,
 *                   dupe_suspects: string[], set_only: boolean }>}
 */
export function inventory(corpus = {}) {
  const byTag = new Map();

  for (const t of corpus.triggers ?? []) {
    scanRule('trigger', t, byTag, { scanConditions: true });
  }
  for (const a of corpus.automations ?? []) {
    scanRule('automation', a, byTag, { scanConditions: true });
  }
  for (const m of corpus.macros ?? []) {
    // Macros don't have conditions, only actions contribute.
    scanRule('macro', m, byTag, { scanConditions: false });
  }

  const tags = Array.from(byTag.keys());

  // Compute dupe suspects pairwise. Tag corpus is small (typically a few
  // hundred at most), O(n^2) is fine.
  const suspectsByTag = new Map();
  for (const a of tags) suspectsByTag.set(a, []);
  for (let i = 0; i < tags.length; i++) {
    for (let j = i + 1; j < tags.length; j++) {
      const a = tags[i];
      const b = tags[j];
      if (areDupeSuspects(a, b)) {
        suspectsByTag.get(a).push(b);
        suspectsByTag.get(b).push(a);
      }
    }
  }

  const result = tags.map((tag) => {
    const rec = byTag.get(tag);
    const dupes = suspectsByTag.get(tag).slice().sort((x, y) => {
      const xl = x.toLowerCase();
      const yl = y.toLowerCase();
      if (xl !== yl) return xl < yl ? -1 : 1;
      return x < y ? -1 : x > y ? 1 : 0;
    });
    return {
      tag,
      used_in: rec.used_in,
      dupe_suspects: dupes,
      set_only: rec.has_action && !rec.has_condition,
    };
  });

  result.sort((a, b) => {
    const al = a.tag.toLowerCase();
    const bl = b.tag.toLowerCase();
    if (al !== bl) return al < bl ? -1 : 1;
    return a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0;
  });

  return result;
}

export const TagAnalyzer = { inventory, parseTagValue };
