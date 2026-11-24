# Roadmap: team collaboration, validated incrementally

## Gate 1 — reliable local vertical slice (implemented; see validation report)

- Preserve existing CLI and records, migrate old projects explicitly.
- Reject stale saves; atomically persist complete task records.
- Share evidence summaries independently of private logs.
- Add acknowledged ownership handoff and declared path overlap context.
- Add worktree creation/attachment, provider adapters, structured separate review, real test runner, stale-evidence checks, explicit acceptance, failure history and bounded attempts.
- Demonstrate two attributed people and two mocked providers with real Git/test subprocesses and a fresh clone.

Exit: meaningful positive/negative tests pass. This gate does not imply live-provider or team adoption validation.

## Gate 2 — live pair qualification (next)

Priority P0: inspect real CLI behavior for both provider role assignments, errors, cancellations and permission denials in an approved disposable repository. Run the two-person workflow with a colleague on another machine. Preserve a concrete receipt of what was actually tested.

Priority P0: test concurrent changes in separate clones; define a merge-safe event format and explicit resolution policy before advertising simultaneous shared state. Current local CAS/locks do not solve distributed conflicts.

Implemented for the pilot: recording work done outside AgentBridge, configurable provider timeouts, bundled Codex CLI detection, decision proposer attribution, project-wide decisions with explicit supersession, and `done-unchecked` status in checkouts without the task workspace.

Implemented: one record set shared by every worktree on a machine (`init --records-dir`, `where`).

Implemented: typed `inbox` and `check` agent contracts with a published JSON Schema, and trailing-`*` scope prefixes.

Implemented: `onboard`, one idempotent command per person and repository that performs every setup step.

Implemented: GitHub-login identity per clone (`setup`), agents named `login/agent`, agents refused for acceptance, and a record merge driver that combines concurrent changes and freezes same-field disagreements until a person resolves them.

Implemented: signed approvals (SSH signatures checked against GitHub-published keys). Next: concurrency qualification beyond two people.

Implemented: closing tasks whose PR merged, person-only reassignment of stalled work, a resume packet for continuing work (`resume`, MCP `resume_task`, returned on handoff receipt), findings over MCP, claims that sync first, double-claim detection, a guided person view (bare `agentbridge`), a throwaway-repository `demo`, and local pilot metrics (`stats`, including blocked edits).

Implemented: Git pre-commit ownership check for every committer, and a Claude Code prompt hook that surfaces new handoffs without being asked.

Implemented: team board, team audit log, one-step assignment, scope claims on existing tasks, and PR comment plus `agentbridge` commit status.

Implemented: an installable Agent Skill carrying the coordination loop, and `--ref` links from tasks to the team's issue tracker.

Implemented: owner status notes, a Claude Code pre-edit hook that blocks edits to other owners' paths, and a stdio MCP server with inbox, check, start_task, note and handoff tools.

Priority P0 (pulled forward from Gate 4): focused agent tools so Claude and Codex sessions read path ownership, project decisions and open findings, and submit implementation claims, without the developer relaying instructions by hand. Agents submit claims; trusted runners supply execution evidence.

Priority P1: tighten schema validation, migration recovery, interrupted-child cleanup, durable writes and platform coverage. Add environment/dependency fingerprints and external CI receipts where appropriate. Threat-model local execution and record tampering.

Exit: a real pair can recover and complete work correctly, and conflicting records surface without losing findings.

## Now — open pilot

Four weeks, about 10 developers already using Claude and Codex on the same repository, 3–5 repositories. Record a baseline handoff before installing. Fix installation and recovery friction in week one. Use `agentbridge stats` and the pilot feedback issue template for measurements. Investment gates, not results: most participants complete a first useful handoff within ten minutes; median time to resume falls materially (target 50%); at least half stay active in week four without prompting; several invite another developer; maintenance stays below the time saved. Defer new surfaces until these are measured.

## Gate 3 — expand from pairs to a team

Use a proposed 3–5-person cohort on the same project, with multiple tasks and agent sessions. This is a test target, not a supported user cap or existing capacity claim.

Priority P0: explicit participant and role modeling, accountable ownership with collaborators, reviewer assignments, task dependencies, and conflict-aware cross-clone synchronization. Remove project-wide execution serialization only with task/workspace isolation and shared-resource conflict rules. Preserve findings and decisions across concurrent writers.

Acceptance: several teammates can implement separate tasks, request multiple reviews, transfer ownership and recover interrupted sessions without lost findings, contradictory ownership or stale completion claims. Measure contention, relevant-context quality, coordination overhead and recovery time. Larger-team qualification follows measured results; do not extrapolate from a two-person test.

## Gate 4 — reduce collaboration effort

Add supported agent-tool/MCP surfaces, automatic capture of observable events, per-session relevant context, optional PR summaries, decision supersession, richer dependencies and evidence-linked finding resolution. Retain human confirmation for judgment and acceptance. Improve status wording and show evidence origin and freshness together.

Pilot measurements: handoff recovery time, context-reconstruction messages, duplicate work, premature completion reopenings, stale-evidence warnings and false positives, record-maintenance effort, provider usage, second-teammate activation, expansion to additional teammates and team retention. Establish baselines first. Do not substitute installation counts or agent-call volume for retained use.

Exit: teams voluntarily keep using the tool and expand participation and measured benefits outweigh added administration.

## Gate 5 — organization controls, only when demanded

Authenticated identity, access control, independently issued verification receipts, organization policy integration, distributed coordination and optional hosted synchronization. Keep exportable project records and local operation. The project is licensed under Apache-2.0 and installed from GitHub; npm publication waits for pilot results.

The defensibility hypothesis is trustworthy, portable history and accurate reconciliation across the tools teams already use. Validate it through repeat adoption. A long feature list, proprietary lock-in, or a claim to be the only bridge does not establish a moat.

## Deferred

Dashboard/IDE extension, autonomous endless agent loops, universal semantic conflict detection, cloud orchestration, billing and auto-merge. Build these only for demonstrated needs after the pair workflow succeeds.
