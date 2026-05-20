import type {
  CIRunInput,
  FailureGroup,
  FlakinessInput,
  CodeChangeInput,
  TriagedFailure,
  ReleaseRecommendation,
  TestFailure,
  FailureTimestamp,
  TemporalCluster,
  TemporalPatternsResult,
  DomainSeverity,
  FailingTestAnalysis,
} from './types.js';

const DEFAULT_INFRA_PATTERNS = [
  /ECONNREFUSED/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /socket hang up/i,
  /connect ENOENT/i,
  /ENOMEM/i,
  /killed/i,
  /out of memory/i,
  /docker/i,
  /container/i,
];

const TIMEOUT_PATTERNS = [/timeout/i, /timed out/i, /exceeded.*ms/i, /waitFor/i];

function errorSignature(msg: string): string {
  return msg
    .replace(/\d+ms/g, 'Xms')
    .replace(/\d+\.\d+s/g, 'Xs')
    .replace(/:[0-9]+\)/g, ':L)')
    .replace(/0x[0-9a-f]+/gi, '0xADDR')
    .replace(/\/.+?\.ts:\d+/g, '<file>')
    .slice(0, 120);
}

function categorizeError(
  msg: string,
  extraInfraPatterns: RegExp[] = [],
): 'assertion' | 'timeout' | 'network' | 'crash' | 'unknown' {
  const infraPatterns = [...DEFAULT_INFRA_PATTERNS, ...extraInfraPatterns];
  if (infraPatterns.some((r) => r.test(msg))) return 'network';
  if (TIMEOUT_PATTERNS.some((r) => r.test(msg))) return 'timeout';
  if (/expect|assert|toBe|toEqual|toHave/i.test(msg)) return 'assertion';
  if (/segfault|core dump|SIGSEGV|abort/i.test(msg)) return 'crash';
  return 'unknown';
}

export function aggregateFailures(
  input: CIRunInput,
  customInfraPatterns: RegExp[] = [],
): {
  groups: FailureGroup[];
  totalFailures: number;
  failureRate: number;
} {
  const map = new Map<string, TestFailure[]>();

  for (const f of input.failures) {
    const sig = errorSignature(f.errorMessage);
    const existing = map.get(sig) ?? [];
    existing.push(f);
    map.set(sig, existing);
  }

  const groups: FailureGroup[] = Array.from(map.entries())
    .map(([sig, tests]) => ({
      signature: sig,
      count: tests.length,
      tests,
      category: categorizeError(tests[0].errorMessage, customInfraPatterns),
    }))
    .sort((a, b) => b.count - a.count);

  return {
    groups,
    totalFailures: input.failures.length,
    failureRate:
      input.totalTests > 0
        ? Math.round((input.failures.length / input.totalTests) * 10000) / 100
        : 0,
  };
}

export function triageFailures(
  failures: TestFailure[],
  flakiness: FlakinessInput,
  codeChanges: CodeChangeInput,
  customInfraPatterns: RegExp[] = [],
): TriagedFailure[] {
  const flakyMap = new Map<string, number>();
  for (const e of flakiness.entries) {
    flakyMap.set(`${e.suiteName}::${e.testName}`, e.flakyProbability);
  }

  const affectedSet = new Set(codeChanges.affectedTests ?? []);

  return failures.map((f): TriagedFailure => {
    const key = `${f.suiteName}::${f.testName}`;
    const flakyProb = flakyMap.get(key) ?? 0;
    const isAffected = affectedSet.has(f.testName) || affectedSet.has(key);
    const category = categorizeError(f.errorMessage, customInfraPatterns);

    if (category === 'network' || category === 'timeout') {
      return {
        testName: f.testName,
        suiteName: f.suiteName,
        errorMessage: f.errorMessage,
        filePath: f.filePath,
        verdict: 'infra_blip',
        confidence: 0.75,
        reason: `Error pattern matches infrastructure issues (${category})`,
        flakyProbability: flakyProb,
        relatedToChangedCode: isAffected,
      };
    }

    if (flakyProb >= 0.5) {
      return {
        testName: f.testName,
        suiteName: f.suiteName,
        errorMessage: f.errorMessage,
        filePath: f.filePath,
        verdict: 'known_flaky',
        confidence: flakyProb,
        reason: `Historically flaky: ${Math.round(flakyProb * 100)}% failure rate in history`,
        flakyProbability: flakyProb,
        relatedToChangedCode: isAffected,
      };
    }

    if (isAffected) {
      return {
        testName: f.testName,
        suiteName: f.suiteName,
        errorMessage: f.errorMessage,
        filePath: f.filePath,
        verdict: 'real_regression',
        confidence: 0.85,
        reason: 'Test is directly affected by code changes in this commit',
        flakyProbability: flakyProb,
        relatedToChangedCode: true,
      };
    }

    if (flakyProb > 0.1) {
      return {
        testName: f.testName,
        suiteName: f.suiteName,
        errorMessage: f.errorMessage,
        filePath: f.filePath,
        verdict: 'known_flaky',
        confidence: flakyProb,
        reason: `Mildly flaky: ${Math.round(flakyProb * 100)}% historical failure rate`,
        flakyProbability: flakyProb,
        relatedToChangedCode: false,
      };
    }

    return {
      testName: f.testName,
      suiteName: f.suiteName,
      errorMessage: f.errorMessage,
      filePath: f.filePath,
      verdict: 'unknown',
      confidence: 0.4,
      reason: 'No flakiness history and no direct code correlation found',
      flakyProbability: flakyProb,
      relatedToChangedCode: false,
    };
  });
}

// DST transitions: second Sunday of March (US spring forward) and first Sunday of November (US fall back).
// We flag a ±2h window around 02:00 local on those Sundays as potential timezone shift artifacts.
function isDstTransitionSunday(date: Date): boolean {
  const month = date.getUTCMonth(); // 0-based
  const dayOfWeek = date.getUTCDay(); // 0 = Sunday
  if (dayOfWeek !== 0) return false;
  if (month === 2) {
    // March: 2nd Sunday = day 8–14
    const dayOfMonth = date.getUTCDate();
    return dayOfMonth >= 8 && dayOfMonth <= 14;
  }
  if (month === 10) {
    // November: 1st Sunday = day 1–7
    const dayOfMonth = date.getUTCDate();
    return dayOfMonth >= 1 && dayOfMonth <= 7;
  }
  return false;
}

export function detectTemporalPatterns(failures: FailureTimestamp[]): TemporalPatternsResult {
  // Group by test_id
  const byTest = new Map<string, Date[]>();
  for (const f of failures) {
    const key = `${f.suiteName}::${f.testName}`;
    const dates = byTest.get(key) ?? [];
    dates.push(new Date(f.timestamp));
    byTest.set(key, dates);
  }

  const clusters: TemporalCluster[] = [];

  for (const [testId, dates] of byTest) {
    if (dates.length < 2) continue;

    // Check timezone_shift: all failures near 02:00 UTC on DST Sundays
    const dstDates = dates.filter((d) => {
      const hour = d.getUTCHours();
      return isDstTransitionSunday(d) && hour >= 0 && hour <= 4;
    });
    if (dstDates.length === dates.length && dstDates.length >= 2) {
      clusters.push({
        test_id: testId,
        pattern_type: 'timezone_shift',
        cluster_times: dstDates.map((d) => d.toISOString()),
        confidence_score: Math.min(0.95, 0.7 + dstDates.length * 0.05),
      });
      continue;
    }

    // Check hourly: all failures within ±30min of the same UTC hour
    const hours = dates.map((d) => d.getUTCHours() + d.getUTCMinutes() / 60);
    const referenceHour = hours[0];
    const allNearSameHour = hours.every((h) => {
      const diff = Math.abs(h - referenceHour);
      return Math.min(diff, 24 - diff) <= 0.5;
    });
    if (allNearSameHour) {
      clusters.push({
        test_id: testId,
        pattern_type: 'hourly',
        cluster_times: dates.map((d) => d.toISOString()),
        confidence_score: Math.min(0.95, 0.6 + dates.length * 0.07),
      });
      continue;
    }

    // Check monthly: all failures on the same day of month (±1)
    const daysOfMonth = dates.map((d) => d.getUTCDate());
    const refDay = daysOfMonth[0];
    const allSameDay = daysOfMonth.every((day) => Math.abs(day - refDay) <= 1);
    if (allSameDay) {
      clusters.push({
        test_id: testId,
        pattern_type: 'monthly',
        cluster_times: dates.map((d) => d.toISOString()),
        confidence_score: Math.min(0.9, 0.55 + dates.length * 0.07),
      });
      continue;
    }

    // Check daily: all failures on the same UTC weekday
    const weekdays = dates.map((d) => d.getUTCDay());
    const refWeekday = weekdays[0];
    const allSameWeekday = weekdays.every((wd) => wd === refWeekday);
    if (allSameWeekday) {
      clusters.push({
        test_id: testId,
        pattern_type: 'daily',
        cluster_times: dates.map((d) => d.toISOString()),
        confidence_score: Math.min(0.9, 0.5 + dates.length * 0.08),
      });
    }
  }

  const detected = clusters.length > 0;
  const patternTypes = [...new Set(clusters.map((c) => c.pattern_type))];
  const summary = detected
    ? `${clusters.length} temporal cluster(s) detected (${patternTypes.join(', ')}). These failures are likely chronometric artifacts, not code regressions.`
    : 'No temporal patterns detected. Failures appear to be randomly distributed in time.';

  return { temporal_pattern_detected: detected, clusters, summary };
}

const HIGH_SEVERITY_DOMAINS = [
  'payment',
  'auth',
  'billing',
  'checkout',
  'security',
  'transaction',
  'stripe',
  'paypal',
];
const LOW_SEVERITY_DOMAINS = ['docs', 'analytics', 'admin', 'reporting', 'dashboard', 'metrics'];

export function classifyDomain(
  suiteName: string,
  filePath?: string,
): { domain: string; severity: DomainSeverity } {
  const haystack = `${suiteName} ${filePath ?? ''}`.toLowerCase();
  for (const d of HIGH_SEVERITY_DOMAINS) {
    if (haystack.includes(d)) return { domain: d, severity: 'HIGH' };
  }
  for (const d of LOW_SEVERITY_DOMAINS) {
    if (haystack.includes(d)) return { domain: d, severity: 'LOW' };
  }
  return { domain: 'core', severity: 'MEDIUM' };
}

function severityWeight(severity: DomainSeverity): number {
  if (severity === 'HIGH') return 1.0;
  if (severity === 'MEDIUM') return 0.5;
  return 0.2;
}

export function generateRecommendation(triaged: TriagedFailure[]): ReleaseRecommendation {
  const blockers = triaged.filter((t) => t.verdict === 'real_regression');
  const warnings = triaged.filter((t) => t.verdict === 'unknown');
  const safeToIgnore = triaged.filter(
    (t) => t.verdict === 'known_flaky' || t.verdict === 'infra_blip',
  );

  const stats = {
    totalFailures: triaged.length,
    realRegressions: blockers.length,
    knownFlaky: triaged.filter((t) => t.verdict === 'known_flaky').length,
    infraBlips: triaged.filter((t) => t.verdict === 'infra_blip').length,
    unknown: warnings.length,
  };

  // Build per-test analysis for regressions
  const suiteFailureCounts = new Map<string, number>();
  for (const t of blockers) {
    suiteFailureCounts.set(t.suiteName, (suiteFailureCounts.get(t.suiteName) ?? 0) + 1);
  }

  const failingTestsAnalysis: FailingTestAnalysis[] = blockers.map((t) => {
    const { domain, severity } = classifyDomain(t.suiteName, t.filePath);
    const weight = severityWeight(severity);
    const flakyProb = t.flakyProbability ?? 0;
    const riskContribution = Math.round(weight * (1 - flakyProb) * 100) / 100;
    const blastRadius = suiteFailureCounts.get(t.suiteName) ?? 1;
    return {
      test_id: `${t.suiteName}::${t.testName}`,
      domain,
      severity,
      risk_contribution: riskContribution,
      blast_radius: blastRadius,
    };
  });

  // aggregate_risk_score = probability union across regression risk contributions
  let aggregateRiskScore = 0;
  if (failingTestsAnalysis.length > 0) {
    const unionComplement = failingTestsAnalysis.reduce(
      (acc, a) => acc * (1 - a.risk_contribution),
      1,
    );
    aggregateRiskScore = Math.round(Math.min(0.99, 1 - unionComplement) * 100) / 100;
  } else if (warnings.length > 0) {
    aggregateRiskScore = Math.round(Math.min(0.5, warnings.length * 0.1) * 100) / 100;
  }

  const hasHighSeverityBlocker = failingTestsAnalysis.some((a) => a.severity === 'HIGH');

  let verdict: 'GO' | 'CONDITIONAL_GO' | 'NO_GO' | 'INVESTIGATE';
  let confidence: number;
  let summary: string;

  if (blockers.length > 0 && hasHighSeverityBlocker) {
    verdict = 'NO_GO';
    confidence = Math.min(0.95, 0.7 + blockers.length * 0.05);
    const highDomains = [
      ...new Set(failingTestsAnalysis.filter((a) => a.severity === 'HIGH').map((a) => a.domain)),
    ].join(', ');
    summary = `${blockers.length} confirmed regression(s) in critical domain(s) [${highDomains}]. Do not release.`;
  } else if (blockers.length > 0) {
    verdict = 'CONDITIONAL_GO';
    confidence = Math.min(0.85, 0.6 + blockers.length * 0.05);
    const domains = [...new Set(failingTestsAnalysis.map((a) => a.domain))].join(', ');
    summary =
      `${blockers.length} regression(s) in low/medium-risk domain(s) [${domains}] ` +
      `(aggregate risk: ${aggregateRiskScore}). Review before releasing.`;
  } else if (warnings.length > 2) {
    verdict = 'INVESTIGATE';
    confidence = 0.6;
    summary = `${warnings.length} failures with no clear cause. Investigate before releasing.`;
  } else if (triaged.length === 0) {
    verdict = 'GO';
    confidence = 1.0;
    summary = 'No failures. Safe to release.';
  } else {
    verdict = 'GO';
    confidence = Math.max(0.7, 1.0 - warnings.length * 0.1);
    summary = `All ${triaged.length} failure(s) are either known flaky or infrastructure noise. Safe to release.`;
  }

  return {
    verdict,
    confidence,
    aggregate_risk_score: aggregateRiskScore,
    summary,
    blockers,
    warnings,
    safeToIgnore,
    failing_tests_analysis: failingTestsAnalysis,
    stats,
  };
}
