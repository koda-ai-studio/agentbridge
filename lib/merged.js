import path from "node:path";
import { gh } from "./github.js";
import { git } from "./git.js";
import * as st from "./store.js";

const mergedCacheMs = 10 * 60 * 1000;
export const prMentions = (text = "") => [...String(text).matchAll(/\b(?:PR|pull request)\s*#?(\d+)\b|\/pull\/(\d+)\b/gi)].map((m) => Number(m[1] || m[2]));

export function mergedPullRequests(cwd, { now = Date.now() } = {}) {
  let url;
  try {
    url = git(cwd, ["remote", "get-url", "origin"]);
  } catch {
    return null;
  }
  if (!/github\.com[:/]/.test(url)) return null;
  const file = path.join(st.root(cwd), "local", "merged-prs.json");
  try {
    const cached = st.read(file);
    if (cached.origin === url && now - Date.parse(cached.at) < mergedCacheMs) return cached.prs;
  } catch {}
  let prs;
  try {
    prs = JSON.parse(gh(cwd, ["pr", "list", "--state", "merged", "--limit", "100", "--json", "number,headRefName,mergedAt"]));
  } catch {
    prs = null;
  }
  try {
    st.atomic(file, { origin: url, at: new Date(now).toISOString(), prs });
  } catch {}
  return prs;
}

export function mergedWork(t, prs) {
  if (!prs?.length) return null;
  const history = t.history || [];
  const branch = history.map((e) => e.by?.branch).filter(Boolean).at(-1);
  const byBranch = branch && prs.filter((p) => p.headRefName === branch).sort((a, b) => b.mergedAt.localeCompare(a.mergedAt))[0];
  if (byBranch) return { pr: byBranch.number, mergedAt: byBranch.mergedAt, how: `branch ${branch}` };
  const text = t.note?.text || "";
  const numbers = new Set(/\bmerged\b/i.test(text) ? prMentions(text) : []);
  const words = new Set(text.split(/[\s,;:()]+/));
  const hit = prs.filter((p) => numbers.has(p.number) || words.has(p.headRefName)).sort((a, b) => b.mergedAt.localeCompare(a.mergedAt))[0];
  return hit ? { pr: hit.number, mergedAt: hit.mergedAt, how: "latest note" } : null;
}


export function releasedByMerge(cwd, list, { merged = mergedPullRequests } = {}) {
  const out = new Map();
  if (!list.length || !merged) return out;
  const prs = merged(cwd);
  for (const t of list) {
    const m = mergedWork(t, prs);
    if (m) out.set(t.id, m);
  }
  return out;
}
