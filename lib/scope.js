const glob = (entry) => (entry.endsWith("*") ? entry.slice(0, -1) : null);
export function pathInScope(entry, p) {
  const prefix = glob(entry);
  if (prefix !== null) return p.startsWith(prefix);
  return p === entry || p.startsWith(entry + "/");
}
export function scopesOverlap(a, b) {
  const pa = glob(a),
    pb = glob(b);
  if (pa === null && pb === null)
    return a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
  if (pa !== null && pb !== null) return pa.startsWith(pb) || pb.startsWith(pa);
  const [g, prefix, plain] = pa !== null ? [a, pa, b] : [b, pb, a];
  return pathInScope(g, plain) || prefix.startsWith(plain + "/");
}
