# NEWS

## V1.0

V1.0 focuses on making MSGA's verified patch loop work reliably with local small language models, especially OpenAI-compatible Ollama models.

### Small-model reliability improvements

- Added a benchmark harness to compare MSGA against a direct baseline runner on reproducible fixtures.
- Added a default real benchmark path for local Ollama models, including `qwen3:8b` and weaker-model shortcuts.
- Increased benchmark request timeout support to handle slower local inference without changing normal CLI defaults.
- Added per-request output controls for patch-loop model calls, including JSON response mode and token caps, to prevent small models from over-generating.
- Tightened `ProposedPatch` prompts so models return compact JSON edits instead of prose, markdown, unified diffs, or hidden reasoning.
- Made `PatchIntent` parsing more tolerant of small-model output by accepting omitted or stringified edit-budget fields.
- Normalized model-provided patch budgets against runtime safety limits so model output cannot expand `maxChangedFiles` or `maxChangedLines`.
- Added a conservative fallback `PatchIntent` when deterministic analysis identifies exactly one safe editable source file and the model returns invalid intent JSON.
- Improved failure analysis for test failures by inferring editable source files from failing test imports, including TypeScript source files imported through `.js` specifiers.
- Added benchmark-only safe auto-confirmation for low-risk intents, preserving normal interactive CLI safety behavior.

### Safety and validation

- Rejects patch intents that target more files than the configured maximum instead of merely increasing risk.
- Keeps tests, config, dependency files, generated output, and vendor paths protected unless explicitly allowed.
- Requires proposed edits to target approved files and use exact unique `oldText` replacements.
- Excludes benchmark fixtures and generated benchmark workspaces from root test runs.
- Adds tests for benchmark metrics, workspace setup, patch schemas, model intent normalization, source inference, and proposal generation controls.

### Verification for this release

- `npm run lint`
- `npm run build`
- `npm test -- --run`
- `npm run bench`
