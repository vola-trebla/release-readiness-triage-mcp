#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod/v4';
import {
  aggregateFailures,
  triageFailures,
  generateRecommendation,
  detectTemporalPatterns,
} from './analyzer.js';
import { analyzeRollbackReadiness } from './migrations.js';
import type { CIRunInput, FlakinessInput, CodeChangeInput } from './types.js';

const server = new McpServer({
  name: 'release-readiness-triage-mcp',
  version: '0.1.0',
});

const TestFailureSchema = z.object({
  testName: z.string(),
  suiteName: z.string(),
  errorMessage: z.string(),
  filePath: z.string().optional(),
  duration: z.number().optional(),
});

const FlakinessEntrySchema = z.object({
  testName: z.string(),
  suiteName: z.string(),
  flakyProbability: z.number().min(0).max(1),
  recentFailures: z.number().int(),
  totalRuns: z.number().int(),
});

server.tool(
  'aggregate_suite_failures',
  'Parse a CI test run and group failures by error signature. Deduplicates repeated errors and categorizes them as assertion, timeout, network, or crash. Use this as the first step before triage.',
  {
    failures: z.array(TestFailureSchema).describe('List of test failures from the CI run'),
    totalTests: z.number().int().describe('Total number of tests in the run'),
    passedTests: z.number().int().describe('Number of tests that passed'),
    branch: z.string().optional().describe('Branch name'),
    commitSha: z.string().optional().describe('Commit SHA'),
    runId: z.string().optional().describe('CI run identifier'),
    customInfraPatterns: z
      .array(z.string())
      .optional()
      .describe(
        "Extra regex patterns (as strings) to classify as infrastructure errors, e.g. cloud-provider-specific messages like 'No space left on device' or 'GCP quota exceeded'",
      ),
  },
  async (args) => {
    const extraPatterns = (args.customInfraPatterns ?? []).map((p) => new RegExp(p, 'i'));
    const input: CIRunInput = args;
    const result = aggregateFailures(input, extraPatterns);

    const lines = [
      `CI Run Summary`,
      `  Total tests:   ${args.totalTests}`,
      `  Passed:        ${args.passedTests}`,
      `  Failed:        ${result.totalFailures}`,
      `  Failure rate:  ${result.failureRate}%`,
      `  Error groups:  ${result.groups.length}`,
      ``,
      `Failure Groups (by frequency):`,
    ];

    for (const g of result.groups) {
      lines.push(`  [${g.category.toUpperCase()}] ${g.count}x — ${g.signature}`);
      for (const t of g.tests.slice(0, 3)) {
        lines.push(`    • ${t.suiteName} > ${t.testName}`);
      }
      if (g.tests.length > 3) lines.push(`    … and ${g.tests.length - 3} more`);
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  },
);

server.tool(
  'cross_reference_flakiness',
  'Given a list of test failures and a flakiness history, score each failure by how likely it is to be a known flaky test vs a real regression. Returns probability scores per test.',
  {
    failures: z.array(TestFailureSchema).describe('Failures to evaluate'),
    flakinessHistory: z
      .array(FlakinessEntrySchema)
      .describe(
        'Historical flakiness data — testName, suiteName, flakyProbability (0–1), recentFailures, totalRuns',
      ),
  },
  async (args) => {
    const flakiness: FlakinessInput = { entries: args.flakinessHistory };

    const lines = [`Flakiness Cross-Reference`, ``];

    const flakyMap = new Map<string, number>();
    for (const e of flakiness.entries) {
      flakyMap.set(`${e.suiteName}::${e.testName}`, e.flakyProbability);
    }

    for (const f of args.failures) {
      const key = `${f.suiteName}::${f.testName}`;
      const prob = flakyMap.get(key);
      if (prob !== undefined) {
        const label = prob >= 0.5 ? 'KNOWN FLAKY' : prob > 0.1 ? 'MILDLY FLAKY' : 'LIKELY STABLE';
        lines.push(`  [${label}] ${f.suiteName} > ${f.testName}`);
        lines.push(`    Flaky probability: ${Math.round(prob * 100)}%`);
      } else {
        lines.push(`  [NO HISTORY] ${f.suiteName} > ${f.testName}`);
        lines.push(`    Not found in flakiness database`);
      }
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  },
);

server.tool(
  'correlate_code_changes',
  'Match a list of changed files against failing tests to determine which failures are directly caused by the code changes in this commit. Returns a correlation mapping.',
  {
    changedFiles: z.array(z.string()).describe('List of file paths changed in this commit/PR'),
    affectedTests: z
      .array(z.string())
      .optional()
      .describe(
        'Optional: test names already known to be affected (e.g. from ast-impact-mapper-mcp)',
      ),
    failures: z.array(TestFailureSchema).describe('Failures to correlate against'),
  },
  async (args) => {
    const affectedSet = new Set(args.affectedTests ?? []);
    const lines = [
      `Code Change Correlation`,
      `  Changed files: ${args.changedFiles.length}`,
      `  Pre-identified affected tests: ${affectedSet.size}`,
      ``,
    ];

    for (const f of args.failures) {
      const key = `${f.suiteName}::${f.testName}`;
      const isAffected = affectedSet.has(f.testName) || affectedSet.has(key);

      const fileCorrelation = f.filePath
        ? args.changedFiles.some((cf) => f.filePath!.includes(cf) || cf.includes(f.filePath!))
        : false;

      const verdict = isAffected || fileCorrelation ? 'CORRELATED' : 'NOT CORRELATED';
      lines.push(`  [${verdict}] ${f.suiteName} > ${f.testName}`);
      if (isAffected) lines.push(`    → Matched via affected test list`);
      if (fileCorrelation) lines.push(`    → Matched via changed file: ${f.filePath}`);
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  },
);

server.tool(
  'generate_release_recommendation',
  'The final step: combines failures, flakiness history, and code change correlation to produce a GO / NO_GO / INVESTIGATE verdict with confidence score and a breakdown of blockers vs safe-to-ignore failures.',
  {
    failures: z.array(TestFailureSchema).describe('All failures from the CI run'),
    flakinessHistory: z
      .array(FlakinessEntrySchema)
      .describe('Flakiness history for cross-referencing'),
    changedFiles: z.array(z.string()).describe('Files changed in this commit/PR'),
    affectedTests: z
      .array(z.string())
      .optional()
      .describe('Tests known to be affected by code changes (from ast-impact-mapper-mcp)'),
    customInfraPatterns: z
      .array(z.string())
      .optional()
      .describe(
        "Extra regex patterns (as strings) to classify as infrastructure errors, e.g. 'GCP quota exceeded', 'No space left on device'",
      ),
    format: z
      .enum(['text', 'markdown'])
      .optional()
      .describe(
        "Output format. Use 'markdown' for GitHub PR comments or Slack. Defaults to 'text'.",
      ),
  },
  async (args) => {
    const extraPatterns = (args.customInfraPatterns ?? []).map((p) => new RegExp(p, 'i'));
    const flakiness: FlakinessInput = { entries: args.flakinessHistory };
    const codeChanges: CodeChangeInput = {
      changedFiles: args.changedFiles,
      affectedTests: args.affectedTests,
    };

    const triaged = triageFailures(args.failures, flakiness, codeChanges, extraPatterns);
    const rec = generateRecommendation(triaged);
    const confidence = Math.round(rec.confidence * 100);

    let text: string;

    if (args.format === 'markdown') {
      const verdictEmoji =
        rec.verdict === 'GO'
          ? '🟢'
          : rec.verdict === 'NO_GO'
            ? '🔴'
            : rec.verdict === 'CONDITIONAL_GO'
              ? '🟠'
              : '🟡';
      const lines = [
        `## ${verdictEmoji} Release Recommendation: ${rec.verdict} (${confidence}% confidence)`,
        ``,
        `> ${rec.summary}`,
        ``,
        `**Aggregate risk score:** ${rec.aggregate_risk_score}`,
        ``,
        `| Category | Count |`,
        `|---|---|`,
        `| Total failures | ${rec.stats.totalFailures} |`,
        `| 🔴 Real regressions | ${rec.stats.realRegressions} |`,
        `| 🟡 Known flaky | ${rec.stats.knownFlaky} |`,
        `| ⚪ Infra blips | ${rec.stats.infraBlips} |`,
        `| ❓ Unknown | ${rec.stats.unknown} |`,
      ];

      if (rec.failing_tests_analysis.length > 0) {
        lines.push(``, `### Risk Breakdown`, ``);
        lines.push(`| Test | Domain | Severity | Risk | Blast Radius |`);
        lines.push(`|---|---|---|---|---|`);
        for (const a of rec.failing_tests_analysis) {
          lines.push(
            `| ${a.test_id} | ${a.domain} | ${a.severity} | ${a.risk_contribution} | ${a.blast_radius} |`,
          );
        }
      }

      if (rec.blockers.length > 0) {
        lines.push(``, `### Blockers (must fix before release)`, ``);
        for (const b of rec.blockers) {
          lines.push(`**${b.suiteName} > ${b.testName}**`);
          lines.push(`- ${b.reason}`);
          lines.push(`- \`${b.errorMessage.slice(0, 120)}\``);
          lines.push(``);
        }
      }

      if (rec.warnings.length > 0) {
        lines.push(`### Investigate (unclear cause)`, ``);
        for (const w of rec.warnings) {
          lines.push(`- **${w.suiteName} > ${w.testName}** — ${w.reason}`);
        }
        lines.push(``);
      }

      if (rec.safeToIgnore.length > 0) {
        lines.push(`### Safe to ignore`, ``);
        for (const s of rec.safeToIgnore) {
          lines.push(`- ~~${s.suiteName} > ${s.testName}~~ — ${s.reason}`);
        }
      }

      text = lines.join('\n');
    } else {
      const lines = [
        `Release Recommendation: ${rec.verdict} (${confidence}% confidence)`,
        `Aggregate risk score:   ${rec.aggregate_risk_score}`,
        ``,
        rec.summary,
        ``,
        `Stats:`,
        `  Total failures:    ${rec.stats.totalFailures}`,
        `  Real regressions:  ${rec.stats.realRegressions}`,
        `  Known flaky:       ${rec.stats.knownFlaky}`,
        `  Infra blips:       ${rec.stats.infraBlips}`,
        `  Unknown:           ${rec.stats.unknown}`,
      ];

      if (rec.failing_tests_analysis.length > 0) {
        lines.push(``, `Risk Breakdown:`);
        for (const a of rec.failing_tests_analysis) {
          lines.push(
            `  ${a.test_id} — domain: ${a.domain}, severity: ${a.severity}, risk: ${a.risk_contribution}, blast_radius: ${a.blast_radius}`,
          );
        }
      }

      if (rec.blockers.length > 0) {
        lines.push(``, `BLOCKERS (must fix before release):`);
        for (const b of rec.blockers) {
          lines.push(`  ✗ ${b.suiteName} > ${b.testName}`);
          lines.push(`    ${b.reason}`);
          lines.push(`    Error: ${b.errorMessage.slice(0, 100)}`);
        }
      }

      if (rec.warnings.length > 0) {
        lines.push(``, `INVESTIGATE (unclear cause):`);
        for (const w of rec.warnings) {
          lines.push(`  ? ${w.suiteName} > ${w.testName}`);
          lines.push(`    ${w.reason}`);
        }
      }

      if (rec.safeToIgnore.length > 0) {
        lines.push(``, `SAFE TO IGNORE:`);
        for (const s of rec.safeToIgnore) {
          lines.push(`  ✓ ${s.suiteName} > ${s.testName} — ${s.reason}`);
        }
      }

      text = lines.join('\n');
    }

    return { content: [{ type: 'text', text }] };
  },
);

server.tool(
  'detect_temporal_failure_patterns',
  'Analyzes a history of test failures with timestamps to detect chronometric patterns: failures that cluster at the same UTC hour (hourly jobs), same day of month (billing runs), same weekday (scheduled jobs), or around DST transitions. When a pattern is found, the failure is a time artifact — not a code regression. The agent should schedule a re-run at a different time rather than investigating the source code.',
  {
    failures: z
      .array(
        z.object({
          testName: z.string(),
          suiteName: z.string(),
          timestamp: z.string().describe('ISO 8601 timestamp of the failure'),
        }),
      )
      .describe('Historical failure records with timestamps'),
  },
  async (args) => {
    const result = detectTemporalPatterns(args.failures);
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  },
);

server.tool(
  'analyze_rollback_readiness',
  'Scans a repository for versioned database migration files (Flyway V*.sql, Prisma migration.sql, Liquibase XML/YAML) and classifies each operation as additive (rollback safe) or destructive (forward-fix only). Returns rollback_eligible, a list of blocking_migrations with file and line, and deployment_strategy. Use before recommending deployment to determine whether a rollback is safe after go-live.',
  {
    repo_path: z
      .string()
      .describe('Absolute path to the repository root to scan for migration files'),
  },
  async (args) => {
    try {
      const result = analyzeRollbackReadiness(args.repo_path);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
