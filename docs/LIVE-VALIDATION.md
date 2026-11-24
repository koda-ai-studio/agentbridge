# Live provider validation — 2026-11-21

## Forward direction

PR #1 exercised actual Claude Code implementation, actual Codex static review and an AgentBridge-run test suite on revision `887a4ec0119a7f1c79972f4cd668daaed0a57dbd`: 30 passed, 0 failed. The task reached verified; a temporary source edit made it stale. Human acceptance was not recorded. That PR is now merged.

## Reverse direction and CI

For PR #2, Codex implemented the GitHub Actions workflow through the existing AgentBridge adapter. Initial implementation revision: `ac2775575ab3c6442366d848c12ae147640fd890`.

Claude's first actual review returned outcome `pass` alongside two low-severity observations: tests/CI had not yet been recorded, and cancelling superseded main runs leaves those older commits without completed CI. The runtime correctly rejected the contradictory response. The observations were preserved in the pilot task; main-run cancellation was retained as the specified behavior. The reviewer contract now explicitly requires pass with no findings, separates optional suggestions and pending execution caveats into summary, and retains fail-closed validation of contradictory output.

The initial CI run completed successfully on all six Ubuntu/macOS × Node 20/22/24 jobs:
https://github.com/koda-ai-studio/agentbridge/actions/runs/44969526607

That run applies to the initial implementation revision, not subsequent prompt/document changes. The PR description and check suite provide the final reviewed revision and latest CI outcome. Do not infer a current green result from this historical run link.

## Evidence boundaries

Human actor names are simulated, not two actual coworkers. Provider responses are real in these manual pilots; CI continues to use mocks and fake provider executables. Review opinions, local test receipts, GitHub CI results and human acceptance remain separate. No human acceptance is fabricated.

The local verification gate requires configured check coverage for every criterion. CI-specific criteria are evaluated using actual GitHub results and review; the local runner does not yet ingest authenticated external CI receipts. We do not map `npm test` to deployment/CI criteria merely to make the task appear verified.

Remaining: actual colleagues on separate machines, distributed conflict handling, progress streaming, external CI receipt ingestion, authenticated approval and provider interruption/rate-limit scenarios. Main/PR publication and Git checkpoints are still operator-driven.
