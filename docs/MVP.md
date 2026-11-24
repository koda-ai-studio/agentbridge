# First workflow and acceptance criteria

## First acceptance scenario

The product targets teams with many developers and agents. This scenario deliberately starts with two people; it does not define a product limit.

Alice uses Claude Code to implement a task. Bob uses Codex to review and continue the same work. Their shared repository preserves accepted decisions, unresolved findings, test receipts and the next action across sessions and checkouts. Provider roles can be reversed. Actor names are local attribution.

## Implemented v0.2 workflow

1. Create a task with semicolon-separated acceptance criteria and an owner; optionally declare path scope.
2. Record a decision with rationale and accept it explicitly.
3. Configure executable/argv test commands and map them to criterion IDs.
4. Create a task worktree; run an implementation through a supported provider.
5. Inspect and commit implementation changes in the worktree. AgentBridge does not commit automatically.
6. Offer a handoff with a recipient and next action. Recipient acknowledges before becoming owner.
7. Run a different-provider review. Preserve structured findings and revision/patch identity.
8. Resolve findings with rationale, implement further fixes when needed, checkpoint and review again. Attempts are bounded.
9. Execute configured tests, capture real exit status and private output, and share receipts bound to the observed snapshot.
10. Verify eligibility, then explicitly accept as the human owner.
11. Share task records and code using Git; read context from a fresh clone without private logs.
12. Change code and observe stale evidence rather than a misleading current done claim.
13. Alternatively record work done in an interactive agent session or by hand (`implement record`), then review and test it the same way.
14. Record project-wide decisions once; every task context and agent prompt shows them, with explicit supersession when direction changes.

## Acceptance evidence

Automated workflow tests use two attributed people and mocked provider responses. They create actual Git repositories/worktrees, make actual commits, spawn real test processes, persist findings and decisions, clone shared records, attach the implementation revision, and detect later changed code. These are bounded synthetic tests, not a real team pilot or a live Claude/Codex execution.

Negative checks cover stale writes, missing private files, invalid ownership transfer, manual evidence rejection, invalid transitions, open findings, failing latest tests, code mutation during execution, malformed reviews, same-provider review, timeout, excessive output, command argument safety, spawn failure, interrupted runs, bounded attempts and oversize diffs.

## Remaining qualification

- Run a consented live task through both provider CLIs and inspect actual outputs, denied permissions, cost and completion behavior.
- Run a real two-person pilot on separate machines, including conflicting edits and interrupted handoffs.
- Expand to a proposed 3–5-person pilot with multiple concurrent tasks, ownership transfer, multiple reviewers, conflicting decisions and recovery across machines. Measure before claiming larger-team readiness.
- Validate test environments and dependencies beyond source-tree identity.
- Enforce identity and provenance outside writable project records before making enterprise assurance claims.
- Add automatic capture only after confirming which explicit CLI steps create friction.

The implemented workflow is stepwise and resumable. An unattended implement/review/fix loop, merge automation, hosted service and dashboard are not in this milestone.
