import { isDeepStrictEqual as same } from "node:util";

const keyed = (v) => Array.isArray(v) && v.length > 0 && v.every((x) => x && typeof x === "object" && typeof x.id === "string");
const later = (a, b) => ((a?.at || "") >= (b?.at || "") ? a : b);

function three(base, ours, theirs) {
  if (same(ours, theirs)) return { value: ours };
  if (same(base, ours)) return { value: theirs };
  if (same(base, theirs)) return { value: ours };
  return { conflict: true, value: ours };
}

function mergeKeyed(base = [], ours = [], theirs = [], field, conflicts) {
  const byId = (list) => new Map(list.map((x) => [x.id, x]));
  const b = byId(base), t = byId(theirs);
  const out = [];
  for (const item of ours) {
    if (!t.has(item.id)) {
      out.push(item);
      continue;
    }
    const r = three(b.get(item.id), item, t.get(item.id));
    if (r.conflict) conflicts.push({ field: `${field}[${item.id}]`, base: b.get(item.id) ?? null, ours: item, theirs: t.get(item.id) });
    out.push(r.value);
  }
  const have = new Set(out.map((x) => x.id));
  for (const item of theirs) if (!have.has(item.id)) out.push(item);
  if (field === "history") out.sort((x, y) => (x.at || "").localeCompare(y.at || ""));
  return out;
}

export function mergeRecords(base, ours, theirs, at = new Date().toISOString()) {
  base ??= {};
  const conflicts = [];
  const result = {};
  const keys = new Set([...Object.keys(ours), ...Object.keys(theirs)]);
  keys.delete("mergeConflicts");
  for (const k of keys) {
    const [b, o, t] = [base[k], ours[k], theirs[k]];
    if (k === "version") result[k] = Math.max(o ?? 0, t ?? 0) + 1;
    else if (k === "updatedAt") result[k] = [o, t].filter(Boolean).sort().at(-1);
    else if (k === "note") result[k] = o && t ? later(o, t) : (three(b, o, t).value ?? null);
    else if (keyed(o) || keyed(t) || keyed(b)) result[k] = mergeKeyed(b, o, t, k, conflicts);
    else {
      const r = three(b, o, t);
      if (r.conflict) conflicts.push({ field: k, base: b ?? null, ours: o ?? null, theirs: t ?? null });
      if (r.value !== undefined) result[k] = r.value;
    }
  }
  const carried = [...(ours.mergeConflicts || []), ...(theirs.mergeConflicts || [])].filter(
    (x, i, all) => all.findIndex((y) => y.field === x.field && same(y.theirs, x.theirs)) === i,
  );
  const all = [...carried, ...conflicts.map((x) => ({ ...x, at }))];
  if (all.length) result.mergeConflicts = all;
  return { record: result, conflicts: conflicts.length };
}
