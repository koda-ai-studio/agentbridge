---
name: agentbridge
description: Coordinate with other agents and people on a shared repository through AgentBridge - see what you own, what others own, pending handoffs and project decisions; check paths before editing; claim work; leave status notes; hand work off; catch the user up. Use at the start of work in any Git repository where `agentbridge where` reports initialized true, before editing files there, when the user says "check the board" or "check the inbox", asks "what's new", "catch me up" or "what did I miss", and before stopping.
---

# AgentBridge

AgentBridge holds who owns which paths, handoffs, project decisions, findings and verification. It is not the issue tracker: descriptions and discussion stay in Jira, Linear or GitHub; link them with `--ref`. Write each fact once: the what and why live in the PR or issue, AgentBridge holds state plus a link, and you answer the user from both.

Your actor name is your tool's name in lowercase (`claude`, `codex`, `cursor`) unless the user gave you another. Run commands from inside the checkout. If the `agentbridge` MCP tools are available, use them (same names, pass your checkout's absolute path as `cwd`) instead of the shell.

## Loop

1. **Start:** `agentbridge inbox --actor ME --since last --format text`. Receive handoffs addressed to you: `agentbridge handoff receive TASK --actor ME`. Follow accepted project decisions.
   To continue a task (one you just received, or after a session ended): `agentbridge resume TASK` (or `agentbridge resume` for your latest open task) gives the goal, done bar, next step, branch and changed files, PR, accepted decisions, open findings and checks. Start from its `Next:` line rather than asking the user to re-explain.
2. **Before editing:** `agentbridge check PATH... --actor ME`. Exit 1 (`conflicts` in the JSON) means someone else's active task covers a path: tell the user which task and owner holds it before you change it. If the user wants you to go ahead, keep the change small and note it on your task. In repositories with `mode: "block"` the edit hook refuses instead; never work around it with shell writes. `released` lists files an open task still names but no longer holds (its PR merged, or it has been idle for a day); those are free.
3. **Claim the paths you will edit.** For a task you received without a scope: `agentbridge task scope TASK dir/a,dir/b-* --actor ME`. For new work: `agentbridge task add "Title" --criteria "Check one; Check two" --actor ME --scope dir/a,dir/b-* [--ref PROJ-142]`, then `agentbridge task status TASK in_progress --actor ME`. A trailing `*` matches by prefix. With exactly one task in progress, the edit hook adds each file you edit to it, so naming the scope up front is optional; with several in progress, claim explicitly.
4. **Before stopping:** `agentbridge task note TASK "PR #55 · CI green · waiting on review" --actor ME`. State plus a link, one line, at most 200 characters; never repeat the PR description. When implementation is done: `agentbridge task status TASK implemented --actor ME`.
5. **Passing work on, only when the user asks** ("hand this to Codex", "assign it to alice"): `agentbridge task add "Title" --criteria "..." --to OTHER --scope ... --actor ME` for new work, or `agentbridge handoff offer TASK --actor ME --to OTHER --next "Exact next step, branch and PR"` for yours. Never create or offer tasks to others on your own initiative; suggest it to the user instead. Likewise only when the user asks: `agentbridge handoff decline TASK --actor ME --reason "..."` (an offer to you), `agentbridge handoff withdraw TASK --actor ME` (your offer), `agentbridge task cancel TASK --actor ME --reason "..."` (your task).

## Catching the user up

When the user asks what is new or what they missed, run `agentbridge digest --format text` (MCP: `digest`; add `--since 7d` or a date if they name one) and answer from it in a few plain sentences, leading with what waits on them. Do not write catch-up issues, notes or documents by hand, and do not create tasks that duplicate an issue or PR; link instead.

## Rules

- `--actor` is optional inside your session (it defaults to you), and task ids can be shortened to 8 characters.
- Act only as yourself. AgentBridge detects your session and refuses other names, and records your session id on every action.
- Propose project-wide decisions with `agentbridge decision propose "..." --why "..." --actor ME`. Only people accept decisions and work; never run `decision accept`, `accept` or `policy`. `agentbridge approvals --verify` shows who approved what and whether the signatures check out.
- Report problems in others' work with `agentbridge finding add TASK "..." --by ME` (MCP: `report_finding`) instead of fixing their paths. Resolve findings on your own tasks with `agentbridge finding resolve TASK FINDING --why "how" --actor ME` (MCP: `resolve_finding`).
- Claims sync first: claiming files pulls others' claims before checking. If it warns that it could not sync, tell the user someone elsewhere may hold the files.
- When your pull request merges and no work remains, close your task (`agentbridge task close TASK`, or `--pr N`); that releases its files. The board and your prompt flag open tasks whose PR is already merged.
- Files in your person's own tasks are yours to edit when they ask you to work on them; other agents' and people's files are not.
- If another agent holds files you need (for example it stopped mid-task), never suggest running a command as that agent (`--actor codex`). Ask the user to move it from their own terminal, not with Claude Code's `!` prefix: `agentbridge assign TASK --to ME`. For someone else's stale claim, the user can free its files: `agentbridge release TASK --reason "..."`; never run `release` yourself.
- When something needs the user (an offer, a decision, finished work, a merged or stalled task), tell them to run `agentbridge` in their own terminal; it asks them about each item. For a specific action: `agentbridge assign TASK --to AGENT-OR-TEAMMATE` or `agentbridge done TASK` (no `--actor`).
- Records sync to the team on their own. If `agentbridge board` says changes are not shared yet, run `agentbridge sync`.
- Do not edit files under the AgentBridge records directory (`agentbridge where`); use the commands.
