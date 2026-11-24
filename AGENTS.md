# Working on AgentBridge

Build for teams of multiple developers and agents. Preserve the local CLI and two-person workflow as the first acceptance scenario, not a product-size limit. Do not hardcode a pair of participants or imply that larger-team concurrency is already qualified. Read docs/PRODUCT.md, docs/ARCHITECTURE.md and docs/MVP.md before changing behavior. Keep the core collaboration model independent of provider SDKs.

Run `npm test` after changes. Use mock providers in automated tests; exercise real Git and test subprocesses for workflow contracts. Do not claim live-provider success from mocks, CLI availability, or help output. Do not invoke authenticated provider runs unless the user requests that execution. Never inspect credential contents.

Preserve findings, decisions and history. Reject stale updates and ambiguous state. Keep manual attestations separate from executed test receipts; preserve exact revision and code-digest provenance. Human acceptance is separate from machine verification. Do not claim actor attribution is authentication or local JSON is tamper-proof.

Use incremental changes and meaningful positive/negative tests. Do not add a dashboard, cloud service, automatic merge, permission bypass, external publication or a database without a demonstrated need and task authorization. Keep raw output private and shared summaries inspectable. Worktrees are not sandboxes.
