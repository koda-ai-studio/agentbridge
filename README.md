# AgentBridge

**Switch between Claude, Codex and teammates without re-explaining the work or editing each other's files.**

When you run Claude Code and Codex on one repository, or hand work to a teammate, you end up pasting context into a fresh chat and hoping two agents don't edit the same file. AgentBridge keeps one shared record per repository. It holds who is working on which files, what was decided, what was found and checked, and the exact next step. The agents read and update that record themselves.

- **Pick up where the last one stopped.** An agent that takes over a task gets one packet: goal, done bar, next step, branch, changed files, PR, decisions and open findings (`agentbridge resume`).
- **No stepping on each other.** Before Claude Code or Codex edits a file someone else is working on, it is told who, for which task and since when. Teams that want hard locks can switch them on. Claims let go on their own once the PR merges or the work goes idle.
- **You only answer questions.** Run `agentbridge` and it asks about each thing that needs you, one key per answer. Agents never hand work off or accept work on their own.

It's a local CLI with zero dependencies (Node 20+, Apache-2.0). It's early: its authors use it daily, and two-person teams are the tested case. See [Limits](#limits).

## Try it in one minute

```sh
npm install -g github:koda-ai-studio/agentbridge
agentbridge demo
```

The demo runs in a throwaway repository and changes nothing of yours. Claude claims a file, Codex is refused when it tries to edit it, Claude hands the task over, and Codex gets the packet it needs to continue.

## Set it up

```sh
cd your-repo && agentbridge onboard --solo   # you and your agents; records stay out of Git
cd your-repo && agentbridge onboard          # a team; one shared board on its own branch
```

Team mode needs the [GitHub CLI](https://cli.github.com) logged in (`gh auth login`) and push access. Each teammate runs the same command in their own clone.

`onboard` installs the agent skill, the edit and prompt hooks, the Codex MCP entry and the git pre-commit check, then reports each step. It backs up any config it changes. `--dry-run` shows the plan first. Re-run it after updating.

## Daily use

Agents need nothing from you: they follow the skill, see new handoffs and merged PRs in their next prompt, and are told before they edit a file someone else is working on. (Codex asks you to approve the new hooks once, in `/hooks`.)

You, in a normal terminal (not Claude Code's `!`, which runs inside the agent's session):

| Command | What it does |
|---|---|
| `agentbridge` | Asks about each thing that needs you: offers, decisions, finished work, merged tasks to close, duplicates, stalled tasks |
| `agentbridge digest` | What happened since you last looked: merges, handoffs, decisions, findings, open PRs (`--since 7d`). Or ask your agent "what's new?" |
| `agentbridge board` | Who is doing what |
| `agentbridge assign "New work" --to codex` | Gives work to one of your agents, or offers it to a teammate (`--to their-github-login`) |
| `agentbridge resume TASK` | Where a task stands and its next step |
| `agentbridge done` | Closes your tasks whose PR merged |
| `agentbridge release TASK --reason "…"` | Frees the files of someone's stale claim |

You don't need `--actor`: outside an agent session you act as your GitHub login, and inside one the command acts as that agent. Task ids can be shortened to 8 characters.

## How it works

Each task has an owner and a scope: the paths it is changing. Before an agent edits a file, a hook checks the scope of every open task.

- **Someone else's open task covers the file:** the agent is told, before the edit, who holds it, for which task, when it was last active, and the command that releases it. It tells you and goes ahead. A team that wants hard locks runs `agentbridge policy ownership block`, and then the edit and the commit are refused.
- **Its pull request merged, or it has had no activity for a day:** the file is free, and the agent is told why.
- **The owner is you or one of your agents:** silent. `alice/claude` may edit `alice`'s files, but two agents of the same person still warn each other.
- **Nobody holds it:** silent.

Ownership moves only by handoff, which the recipient has to accept, or by a person moving work between themselves and their own agents. Any person can free a stale claim with `agentbridge release TASK --reason "..."`; the owner sees who did it and why.

| AgentBridge does | It leaves to existing tools |
|---|---|
| Who owns which paths, checked before each edit | Work items: **Jira, Linear, GitHub issues** (link with `--ref`) |
| Handoffs with the next step | Agent instructions: **AGENTS.md, Agent Skills** |
| Project decisions, shown in every agent's prompt | Isolation: **Git worktrees** |
| Findings that stay open until resolved | Code history and gates: **Git, PRs, CI** |

| | Claude Code | Codex | Any MCP client |
|---|---|---|---|
| Teaches the loop | Skill | Skill | — |
| Sees new handoffs unprompted | Prompt hook | Prompt hook | — |
| Flags edits to others' files | Pre-edit hook | Pre-edit hook | — |
| Flags commits of others' files | Git pre-commit | Git pre-commit | Git pre-commit |
| Native tools | — | MCP server | MCP server |

In team mode, records live on their own `agentbridge-records` branch. It's checked out inside `.git/`, synced in the background, and merged record by record, so it never touches your code history. [docs/REFERENCE.md](docs/REFERENCE.md) covers:

- sync and tamper protection
- GitHub identity and record merging
- signed approvals
- manual setup
- the agent command loop
- decisions
- the review → test → verify → accept workflow

## Limits

- **Not a security boundary.** Actor names come from your GitHub login, which stops casual impersonation, but anyone can edit records on their own machine. Worktrees are not sandboxes.
- **Only Claude Code and Codex are checked at edit time.** Other tools are caught at commit, and `git commit --no-verify` skips that check. Claude Code receives the warning before the edit; whether Codex shows it to the model is not yet verified (hard blocks work in both).
- **Merged-PR release needs GitHub.** It needs a GitHub `origin` and `gh`; without them, the owner closes the task by hand.
- **Larger teams are not qualified yet.** It's tested with two people across real clones. Edit checks take about 0.17 s at 1,000 tasks.
- **Passing checks don't prove bug-free code.**

Full details are in [Limits in full](docs/REFERENCE.md#limits-in-full). Read [docs/SECURITY.md](docs/SECURITY.md) before running project commands, and report vulnerabilities as described in [SECURITY.md](SECURITY.md).

Found a rough edge? [Open an issue](https://github.com/koda-ai-studio/agentbridge/issues/new/choose); pasting `agentbridge stats` helps.

## Docs

| | |
|---|---|
| [Reference](docs/REFERENCE.md) | Setup details, team sync, identity, signing, all workflows |
| [Product](docs/PRODUCT.md) | Personas, value, rules |
| [Architecture](docs/ARCHITECTURE.md) | Layers, contracts, verification rules |
| [Validation](docs/VALIDATION.md) | What CI runs, and the live runs ([live](docs/LIVE-VALIDATION.md)) |
| [Roadmap](docs/ROADMAP.md) | Next gates |

[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Apache License 2.0](LICENSE)
