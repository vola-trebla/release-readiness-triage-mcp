# release-readiness-triage-mcp

MCP server that aggregates CI test failures, cross-references flakiness history, and generates a **GO / NO_GO / INVESTIGATE** release recommendation — so your AI agent can triage a broken CI run in seconds instead of asking you to read logs manually.

## The problem

In any real codebase, CI always has _something_ failing. The hard question isn't "are there failures?" — it's "are these failures real regressions, or just the usual noise?"

That requires correlating three things at once:

- **Error signatures** — is this the same failure repeated 12 times, or 12 different problems?
- **Flakiness history** — is this test known to be unreliable?
- **Code changes** — is the failing test actually related to what changed?

An AI agent can't do this without structured tools. Raw CI logs are thousands of lines. Flakiness databases are external. Code→test mapping requires AST analysis.

## Tools

### `aggregate_suite_failures`

Groups test failures by normalized error signature, deduplicates repeated errors, and categorizes them as `assertion`, `timeout`, `network`, or `crash`. Use this first.

### `cross_reference_flakiness`

Takes failures + your flakiness history and scores each test: `KNOWN FLAKY`, `MILDLY FLAKY`, or `NO HISTORY`. Accepts any flakiness data format (probability 0–1 per test).

### `correlate_code_changes`

Matches changed files against failing tests. Works standalone or with pre-computed affected test lists from [ast-impact-mapper-mcp](https://www.npmjs.com/package/ast-impact-mapper-mcp).

### `generate_release_recommendation`

The final step. Combines all three signals and outputs:

```
Release Recommendation: GO (87% confidence)

All 4 failure(s) are either known flaky or infrastructure noise. Safe to release.

Stats:
  Total failures:    4
  Real regressions:  0
  Known flaky:       3
  Infra blips:       1
  Unknown:           0

SAFE TO IGNORE:
  ✓ Auth Suite > login with expired token — Historically flaky: 73% failure rate in history
  ✓ Auth Suite > refresh flow — Historically flaky: 61% failure rate in history
  ✓ Search Suite > debounce timing — Mildly flaky: 22% historical failure rate
  ✓ API Suite > health check — Error pattern matches infrastructure issues (network)
```

## Setup

Add to your Claude Desktop / Cursor config:

```json
{
  "mcpServers": {
    "release-readiness-triage": {
      "command": "npx",
      "args": ["-y", "release-readiness-triage-mcp"]
    }
  }
}
```

## Usage

Give the agent your CI failures (from any test runner), your flakiness history, and the list of changed files:

> "Here are 8 test failures from our CI run, our flakiness database, and the files changed in this PR. Generate a release recommendation."

The agent calls `generate_release_recommendation` and returns a verdict with full breakdown.

## Links

- **npm:** [npmjs.com/package/release-readiness-triage-mcp](https://www.npmjs.com/package/release-readiness-triage-mcp)
- **GitHub:** [github.com/vola-trebla/release-readiness-triage-mcp](https://github.com/vola-trebla/release-readiness-triage-mcp)

## License

MIT
