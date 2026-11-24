

function signed(e) {
  if (!e?.sig) return "";
  return ` (signed ${e.sig.key.slice(0, 15)}…)`;
}

export function summarize(v) {
  if (!v || typeof v !== "object" || typeof v.id !== "string" || !Array.isArray(v.history)) return null;
  const last = v.history.at(-1);
  if (v.scope === "project" && "summary" in v) {
    const lines = [`${v.id}  "${v.summary}"`];
    if (v.status === "proposed") lines.push(`  proposed by ${v.proposedBy}. A person accepts it with:`, `  agentbridge decision accept ${v.id} --actor YOUR-NAME`);
    else if (v.status === "accepted") lines.push(`  accepted by ${v.acceptedBy}${signed(v.history.findLast((e) => e.event === "decision_accepted"))}`);
    else lines.push(`  ${v.status}`);
    return lines.join("\n");
  }
  if ("title" in v && "criteria" in v) {
    const lines = [`${v.id}  "${v.title}"`, `  ${v.status}, owner ${v.owner || "nobody"}${v.scope?.length ? `, scope ${v.scope.join(", ")}` : ", no scope claimed"}`];
    if (v.pendingHandoff) lines.push(`  offered to ${v.pendingHandoff.to}: ${v.pendingHandoff.next}`, `  they accept with: agentbridge handoff receive ${v.id.slice(5, 13)} --actor ${v.pendingHandoff.to}`);
    if (v.note) lines.push(`  note: ${v.note.text}`);
    if (last?.event === "closed_merged") lines.push(`  closed: PR #${last.pr.number} merged ${last.pr.mergedAt.slice(0, 10)}; its paths are released`);
    if (last?.event === "cancelled") lines.push(`  cancelled: ${last.reason}`);
    if (last?.event === "human_accepted") lines.push(`  accepted by ${last.actor}${signed(last)}`);
    return lines.join("\n");
  }
  return null;
}
