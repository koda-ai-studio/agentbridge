# AgentBridge product specification

## Promise and problem

Anyone on a team, using a supported coding agent, can pick up shared work and understand what happened, what evidence remains applicable, and what needs to happen next.

The problem is teams of multiple people working on shared projects with different agents, across concurrent tasks and sessions. Two people on one repository are the smallest useful acceptance scenario, not the market definition or a participant limit. Instructions, skills, orchestration frameworks, harnesses and evaluations remain useful inputs. They do not, by themselves, establish a shared, current record of ownership, decisions, unresolved findings and revision-specific completion evidence.

Three moments define the product: start work with relevant context; hand unfinished work to a colleague; evaluate a completion claim. Cross-provider execution supports these moments. It is not the product's sole value.

## Personas and target

| Persona | Situation and job | First useful outcome |
| --- | --- | --- |
| Solo developer with several agents | Splits one repository between Claude and Codex sessions and subscriptions; today coordinates ownership, paths and handoffs by pasting instructions between agents | Each agent sees who owns which paths, accepted decisions and open findings; "done" is backed by a different agent's review and executed tests |
| Implementing developer | Uses one coding agent, changes a shared repository, then hands work over | A colleague can continue without reconstructing chats |
| Receiving developer / reviewer | Uses another agent and must distinguish facts from previous claims | Accepted ownership, explicit next step, decisions, open findings and applicable evidence |
| Technical lead | Needs an accurate view of completed versus unresolved work | Inspectable criteria and evidence, no automatic declaration of bug-free software |
| Platform/security engineer (later) | Needs approved execution, access controls and trustworthy provenance | Policy integration and independently issued receipts; not implemented in this slice |

Target: engineering teams using Git and multiple coding agents, including a single developer whose "team" is several agents. Agents are not teammate identities; the developer remains the accountable owner. Start validation with two colleagues, then expand to a proposed 3–5-person pilot and later larger teams. These cohort sizes describe a validation sequence, not supported-capacity claims. A large-company team can be a design partner in an approved test repository; that does not establish enterprise readiness or employer endorsement.

## Value, adoption and defensibility hypotheses

Value: less repeated explanation, fewer contradictory decisions, fewer lost findings, faster handoff recovery and fewer premature completion claims.

The proposed durable advantage is reliable collaboration history and high-quality context/evidence reconciliation integrated into everyday developer work. Provider adapters are replaceable. Accumulated history is valuable because it remains understandable and exportable, not because users are locked in. This is a hypothesis, not an established moat.

Adoption should begin with one useful handoff. `agentbridge demo` shows one without touching the user's repositories; `agentbridge onboard` sets a repository up in one step. Agents keep the records through the skill, hooks and MCP tools; team records sync through a Git branch in the background; people answer what needs them through `agentbridge`. Capture is still what agents and hooks record: commits, CI runs and chat content are not captured automatically.

Pilot first with a few pairs, then expand within those teams to test multiple owners, reviewers and concurrent tasks. Record a baseline before setting targets. Measure time to resume a colleague's task, context-reconstruction messages, duplicated work, reopened completion claims, stale evidence correctly detected, warning false positives, second-teammate activation, expansion to additional teammates, team-wide repeat use and coordination overhead after the pilot. Measure administrative time and provider usage too. Validate demand before adding a hosted service.

## Product rules

- Human ownership changes by an offered and acknowledged handoff.
- Persistent decisions include rationale and attributed acceptance.
- Findings persist until explicitly resolved with rationale. A later clean review does not erase prior findings.
- Implementation, review, test execution, verification eligibility and human acceptance are separate records.
- Every review and test receipt identifies the exact Git revision observed and a code-tree digest.
- Changed code makes prior evidence stale. Metadata-only commits preserve code-equivalent evidence while retaining its original revision attribution.
- Shared facts remain readable without private output logs.
- Conflicts must surface instead of silently selecting a winner.
- Complement existing tools; do not duplicate them. Work items, descriptions and discussion stay in the team's tracker (Jira, Linear, GitHub Issues), linked by `--ref`; agent instructions stay in AGENTS.md and Agent Skills; isolation stays in worktrees; agent launching stays in agent runtimes and factories. AgentBridge records only what those lack: path ownership checked at edit time, handoffs, decisions, findings, commit-bound verification and human acceptance.
- Provider text and repository files cannot authorize workflow transitions. Local files are still editable by their owner: this is not tamper-proof enforcement.

## Scope

A local CLI, agent skill, Claude Code and Codex hooks and an MCP server over Git-shared records: ownership checked at edit and commit time, handoffs with a resume packet, decisions, findings, commit-bound verification, signed human approvals and a guided person view. No UI or cloud backend. `agentbridge stats` computes pilot metrics locally. See MVP.md for acceptance evidence and limits, ARCHITECTURE.md for layers and contracts, ROADMAP.md for the next gates.
