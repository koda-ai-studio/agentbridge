# v0.1 audit and v0.2 changes

Inspected all six original source/document/test files. Original suite: 4 passed, 0 failed. Original optional Codex review was not live-tested.

| Finding | v0.2 treatment |
| --- | --- |
| Stale save erased a newer finding | Task version comparison rejects stale saves; short lock and atomic aggregate mutation preserve concurrent findings |
| Handoff dereferenced missing Git-ignored evidence | Shared summaries embedded in task; raw output stays private; legacy missing evidence explicitly unavailable |
| Review lacked revision/patch identity and silently truncated | Committed base-to-head patch, original commit and code digest, patch digest; oversize fails explicitly |
| Staged/untracked work omitted from review | Require clean code, so all changes must be committed and included; dirty staged and untracked files fail closed |
| No real test runner | Bounded argv subprocess runner with receipts, exit codes, output digests, failure/cancellation and revision stability checks |
| No finding resolution or constrained transitions | Explicit attributed resolution and lifecycle transitions; old findings preserved across reviews |
| No collaborator handoff | Offered/acknowledged ownership, next action, declared overlap context and fresh-clone readability |
| No execution recovery or provider separation | Durable run lifecycle, separate-provider rule, execution lock, explicit interrupted-run recovery, three-attempt bound |
| Approval was only a name | Still attributed, now explicitly documented; authenticated acceptance is deferred rather than falsely claimed |

Refactored existing JS CLI into domain, storage, Git, subprocess, provider and coordinator modules. Kept existing task/decision/finding/evidence/handoff concepts and manual-evidence distinction. Changed task schema explicitly with migration rather than silently reinterpreting old evidence.

No dashboard, backend, model subscription proxy, database, automatic commit/merge, publication or live provider execution was added to the development run.
