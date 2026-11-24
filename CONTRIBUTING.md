# Contributing

Thanks for trying AgentBridge. The most useful contribution right now is feedback from real use: where setup got stuck, where a handoff lost context, where an edit was blocked wrongly. Open an issue with the "Pilot feedback" or "Bug" template.

Code changes:

- Node 20+, no runtime dependencies. Run `npm test` before opening a pull request; CI runs the same suite on Linux and macOS.
- Read [AGENTS.md](AGENTS.md), [docs/PRODUCT.md](docs/PRODUCT.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before changing behavior.
- Add a test that fails without your change. Tests use mock providers and a fake `gh`; they never reach GitHub or a model provider.
- Keep changes small and say why in the pull request.

By contributing you agree your contribution is licensed under the [Apache License 2.0](LICENSE).
