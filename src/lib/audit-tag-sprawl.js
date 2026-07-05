/**
 * Audit composite, `audit_tag_sprawl`.
 *
 * Pure function over an instance corpus. Layered on top of `TagAnalyzer`.
 * Returns a structured tag-sprawl report in four sections:
 *
 *   {
 *     inventory:            [...],   // pass-through of TagAnalyzer.inventory
 *     suspected_duplicates: [...],   // clustered groups of dupe-suspect tags
 *     set_only_tags:        [...],   // tags only ever set, never conditioned on
 *     usage_distribution:   [...],   // top-N tags by used_in.length
 *   }
 *
 * The dupe-suspect graph TagAnalyzer emits per-tag is reshaped here into
 * connected components ("clusters") via union-find. This collapses, e.g.,
 * `vip` ↔ `VIP` ↔ `v_i_p` into a single cluster of size 3 rather than
 * three rows of "X is similar to Y, Z", which is closer to how a
 * consultant wants to read the report.
 *
 * No HTTP, no global state. The tool layer in
 * `src/tools-v1/audit-tag-sprawl.js` handles fetching, caching, and
 * envelope wrapping.
 */

import { TagAnalyzer } from './tag-analyzer.js';

const DEFAULT_TOP_N = 25;

function caseInsensitiveCompare(a, b) {
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  if (al !== bl) return al < bl ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Build connected components over the tag dupe graph using union-find.
 * Each tag's `dupe_suspects` is its adjacency list. Two tags in the same
 * component are mutually reachable through the dupe relation, so they
 * collapse into one cluster, including transitive cases (A↔B and B↔C
 * yields one cluster {A,B,C}).
 *
 * Returns an array of clusters, each shaped:
 *   { cluster: [tag, ...], cluster_size, total_usage }
 *
 * Cluster ordering: by `cluster_size` descending, ties broken by the
 * (case-insensitive) alphabetical first tag of each cluster. Tags within
 * a cluster are sorted alphabetically (case-insensitive) for determinism.
 */
function buildClusters(inventory) {
  const usageByTag = new Map();
  const adj = new Map();
  for (const row of inventory) {
    usageByTag.set(row.tag, row.used_in.length);
    adj.set(row.tag, row.dupe_suspects ?? []);
  }

  // Union-find keyed by tag string.
  const parent = new Map();
  const find = (x) => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root);
    // Path-compression.
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur);
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const tag of adj.keys()) parent.set(tag, tag);
  for (const [tag, neighbors] of adj.entries()) {
    for (const other of neighbors) {
      // Defensive: skip neighbors not in the inventory map (shouldn't
      // happen for TagAnalyzer output but belt-and-suspenders).
      if (!parent.has(other)) continue;
      union(tag, other);
    }
  }

  // Group by root.
  const groups = new Map();
  for (const tag of parent.keys()) {
    const root = find(tag);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(tag);
  }

  const clusters = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue; // singletons are not "duplicates"
    const sortedMembers = members.slice().sort(caseInsensitiveCompare);
    let total = 0;
    for (const t of sortedMembers) total += usageByTag.get(t) ?? 0;
    clusters.push({
      cluster: sortedMembers,
      cluster_size: sortedMembers.length,
      total_usage: total,
    });
  }

  clusters.sort((a, b) => {
    if (a.cluster_size !== b.cluster_size) return b.cluster_size - a.cluster_size;
    return caseInsensitiveCompare(a.cluster[0], b.cluster[0]);
  });

  return clusters;
}

function buildSetOnlyTags(inventory) {
  const out = [];
  for (const row of inventory) {
    if (row.set_only) {
      out.push({ tag: row.tag, used_in_count: row.used_in.length });
    }
  }
  out.sort((a, b) => caseInsensitiveCompare(a.tag, b.tag));
  return out;
}

function buildUsageDistribution(inventory, topN) {
  const rows = inventory.map((r) => ({ tag: r.tag, count: r.used_in.length }));
  rows.sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count;
    return caseInsensitiveCompare(a.tag, b.tag);
  });
  const cap = Number.isFinite(topN) && topN > 0 ? Math.floor(topN) : DEFAULT_TOP_N;
  return rows.slice(0, cap);
}

/**
 * @param {object} corpus
 *   Optional kinds: triggers, automations, macros. Each may be an array.
 *   Missing kinds are silently tolerated; the tool layer is responsible
 *   for surfacing per-kind upstream errors.
 * @param {object} [options]
 * @param {number} [options.topN=25] Max rows in `usage_distribution`.
 * @returns {{
 *   inventory: Array,
 *   suspected_duplicates: Array,
 *   set_only_tags: Array,
 *   usage_distribution: Array,
 * }}
 */
export function auditTagSprawl(corpus = {}, options = {}) {
  const inventory = TagAnalyzer.inventory({
    triggers: corpus.triggers ?? [],
    automations: corpus.automations ?? [],
    macros: corpus.macros ?? [],
  });

  const suspected_duplicates = buildClusters(inventory);
  const set_only_tags = buildSetOnlyTags(inventory);
  const usage_distribution = buildUsageDistribution(inventory, options.topN);

  return {
    inventory,
    suspected_duplicates,
    set_only_tags,
    usage_distribution,
  };
}

export const AuditComposites = { tagSprawl: auditTagSprawl };
