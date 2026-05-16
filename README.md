# 🚦 release-readiness-triage-mcp

[![npm](https://img.shields.io/npm/v/release-readiness-triage-mcp)](https://www.npmjs.com/package/release-readiness-triage-mcp)
[![CI](https://github.com/vola-trebla/release-readiness-triage-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/vola-trebla/release-readiness-triage-mcp/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Stop reading CI logs. Start getting verdicts.**

MCP server that aggregates test failures, cross-references flakiness history, and outputs a **GO / NO_GO / INVESTIGATE** release decision — so your AI agent can triage a broken CI run in seconds instead of asking you to read 3000 lines of logs.

---

## 🤔 The problem

In any real codebase, CI always has _something_ failing. The hard question isn't "are there failures?" — it's **"are these failures real regressions, or just the usual noise?"**

Answering that requires correlating three signals at once:

- 🔍 **Error signatures** — is this the same failure repeated 12 times, or 12 different problems?
- 📊 **Flakiness history** — is this test known to be unreliable?
- 🔗 **Code changes** — is the failing test actually related to what changed?

An AI agent can't do this without structured tools. Raw CI logs are thousands of lines. Flakiness databases are external. Code→test mapping requires AST analysis. Without this MCP, the agent just guesses.

---

## 🛠️ Tools

### `aggregate_suite_failures`

Groups failures by normalized error signature, deduplicates repeated errors, categorizes as `assertion / timeout / network / crash`. Pass `customInfraPatterns` for cloud-specific errors.

### `cross_reference_flakiness`

Scores each failure against your flakiness history: `KNOWN FLAKY`, `MILDLY FLAKY`, or `NO HISTORY`.

### `correlate_code_changes`

Matches changed files against failing tests. Works standalone or with pre-computed affected test lists from [ast-impact-mapper-mcp](https://www.npmjs.com/package/ast-impact-mapper-mcp).

### `generate_release_recommendation`

The final step. Outputs `GO / NO_GO / INVESTIGATE` with confidence score and full breakdown. Supports `format: "markdown"` for GitHub PR comments and Slack.

---

## 🧪 What it looks like in practice

5 failures in CI. What's real, what's noise?

```
failures:
  - Auth Suite > login with expired token   → "Expected status 200, got 401"
  - API Suite > health check                → "connect ECONNREFUSED 127.0.0.1:3000"
  - Button Suite > renders button correctly → "Expected null, got <button>Submit</button>"
  - Search Suite > debounce timing          → "Expected 42, received 43"
  - Storage Suite > upload avatar           → "GCP quota exceeded for this project"

changedFiles: ["src/components/Button.tsx"]
affectedTests: ["renders button correctly"]
customInfraPatterns: ["GCP quota exceeded"]
format: "markdown"
```

Output:

```markdown
## 🔴 Release Recommendation: NO_GO (75% confidence)

> 1 confirmed regression(s) directly correlated with code changes. Do not release.

| Category            | Count |
| ------------------- | ----- |
| Total failures      | 5     |
| 🔴 Real regressions | 1     |
| 🟡 Known flaky      | 2     |
| ⚪ Infra blips      | 2     |
| ❓ Unknown          | 0     |

### 🔴 Blockers (must fix before release)

**Button Suite > renders button correctly**

- Test is directly affected by code changes in this commit
- `Expected null, got <button>Submit</button>`

### ✅ Safe to ignore

- ~~Auth Suite > login with expired token~~ — Historically flaky: 73% failure rate in history
- ~~API Suite > health check~~ — Error pattern matches infrastructure issues (network)
- ~~Search Suite > debounce timing~~ — Mildly flaky: 22% historical failure rate
- ~~Storage Suite > upload avatar~~ — Error pattern matches infrastructure issues (network)
```

One tool call. One verdict. Go fix `Button.tsx`.

---

## ⚡ Setup

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

---

## 🚀 Usage

> "Here are the failures from our CI run, our flakiness database, and the files changed in this PR. Is it safe to release?"

The agent calls `generate_release_recommendation` and returns a verdict with a full breakdown — ready to paste into a PR comment or Slack.

Works standalone, or as a meta-orchestrator on top of:

- [flakiness-knowledge-graph-mcp](https://www.npmjs.com/package/flakiness-knowledge-graph-mcp) — for flakiness history
- [ast-impact-mapper-mcp](https://www.npmjs.com/package/ast-impact-mapper-mcp) — for code→test correlation
- [playwright-trace-decoder-mcp](https://www.npmjs.com/package/playwright-trace-decoder-mcp) — for trace-level failure analysis

---

## 📦 Links

- **npm:** [npmjs.com/package/release-readiness-triage-mcp](https://www.npmjs.com/package/release-readiness-triage-mcp)
- **GitHub:** [github.com/vola-trebla/release-readiness-triage-mcp](https://github.com/vola-trebla/release-readiness-triage-mcp)

## License

MIT
