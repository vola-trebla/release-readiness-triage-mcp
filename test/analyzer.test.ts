import { describe, it, expect } from 'vitest';
import {
  aggregateFailures,
  triageFailures,
  generateRecommendation,
  detectTemporalPatterns,
  classifyDomain,
} from '../src/analyzer.js';
import type { CIRunInput, FlakinessInput, CodeChangeInput, TestFailure } from '../src/types.js';

const makeFailure = (
  testName: string,
  suiteName: string,
  errorMessage: string,
  filePath?: string,
): TestFailure => ({ testName, suiteName, errorMessage, filePath });

const FLAKINESS_DATA: FlakinessInput = {
  entries: [
    {
      testName: 'login with expired token',
      suiteName: 'Auth Suite',
      flakyProbability: 0.73,
      recentFailures: 11,
      totalRuns: 15,
    },
    {
      testName: 'debounce timing',
      suiteName: 'Search Suite',
      flakyProbability: 0.22,
      recentFailures: 2,
      totalRuns: 9,
    },
  ],
};

describe('aggregateFailures', () => {
  it('groups identical error signatures', () => {
    const input: CIRunInput = {
      failures: [
        makeFailure('test A', 'Suite 1', 'Expected true to equal false'),
        makeFailure('test B', 'Suite 1', 'Expected true to equal false'),
        makeFailure('test C', 'Suite 2', 'ECONNREFUSED 127.0.0.1:5432'),
      ],
      totalTests: 100,
      passedTests: 97,
    };
    const result = aggregateFailures(input);
    expect(result.groups).toHaveLength(2);
    expect(result.groups[0].count).toBe(2);
    expect(result.totalFailures).toBe(3);
  });

  it('calculates failure rate', () => {
    const input: CIRunInput = {
      failures: [makeFailure('t', 's', 'err')],
      totalTests: 200,
      passedTests: 199,
    };
    const result = aggregateFailures(input);
    expect(result.failureRate).toBe(0.5);
  });

  it('categorizes network errors', () => {
    const input: CIRunInput = {
      failures: [makeFailure('t', 's', 'connect ECONNREFUSED 0.0.0.0:5432')],
      totalTests: 10,
      passedTests: 9,
    };
    const result = aggregateFailures(input);
    expect(result.groups[0].category).toBe('network');
  });

  it('categorizes timeout errors', () => {
    const input: CIRunInput = {
      failures: [makeFailure('t', 's', 'Timeout: waitFor exceeded 5000ms')],
      totalTests: 10,
      passedTests: 9,
    };
    const result = aggregateFailures(input);
    expect(result.groups[0].category).toBe('timeout');
  });

  it('categorizes assertion errors', () => {
    const input: CIRunInput = {
      failures: [makeFailure('t', 's', 'expect(received).toBe(expected)')],
      totalTests: 10,
      passedTests: 9,
    };
    const result = aggregateFailures(input);
    expect(result.groups[0].category).toBe('assertion');
  });

  it('returns zero failure rate when totalTests is 0', () => {
    const input: CIRunInput = { failures: [], totalTests: 0, passedTests: 0 };
    const result = aggregateFailures(input);
    expect(result.failureRate).toBe(0);
  });
});

describe('triageFailures', () => {
  const noChanges: CodeChangeInput = { changedFiles: [], affectedTests: [] };

  it('marks known flaky tests as known_flaky', () => {
    const failures = [
      makeFailure('login with expired token', 'Auth Suite', 'Expected 200 got 401'),
    ];
    const result = triageFailures(failures, FLAKINESS_DATA, noChanges);
    expect(result[0].verdict).toBe('known_flaky');
    expect(result[0].flakyProbability).toBeCloseTo(0.73);
  });

  it('marks mildly flaky tests as known_flaky too', () => {
    const failures = [makeFailure('debounce timing', 'Search Suite', 'Expected value to equal 42')];
    const result = triageFailures(failures, FLAKINESS_DATA, noChanges);
    expect(result[0].verdict).toBe('known_flaky');
  });

  it('marks network errors as infra_blip', () => {
    const failures = [makeFailure('health check', 'API Suite', 'ECONNREFUSED 127.0.0.1:3000')];
    const result = triageFailures(failures, FLAKINESS_DATA, noChanges);
    expect(result[0].verdict).toBe('infra_blip');
  });

  it('marks tests correlated with code changes as real_regression', () => {
    const failures = [makeFailure('renders correctly', 'Button Suite', 'Expected null got button')];
    const codeChanges: CodeChangeInput = {
      changedFiles: ['src/Button.tsx'],
      affectedTests: ['renders correctly'],
    };
    const result = triageFailures(failures, FLAKINESS_DATA, codeChanges);
    expect(result[0].verdict).toBe('real_regression');
    expect(result[0].relatedToChangedCode).toBe(true);
  });

  it('marks unknown failures with no history as unknown', () => {
    const failures = [makeFailure('brand new test', 'New Suite', 'Something unexpected')];
    const result = triageFailures(failures, FLAKINESS_DATA, noChanges);
    expect(result[0].verdict).toBe('unknown');
  });
});

describe('generateRecommendation', () => {
  it('returns GO when all failures are flaky or infra', () => {
    const triaged = [
      {
        testName: 't',
        suiteName: 's',
        errorMessage: 'e',
        verdict: 'known_flaky' as const,
        confidence: 0.8,
        reason: 'flaky',
      },
      {
        testName: 't2',
        suiteName: 's',
        errorMessage: 'e',
        verdict: 'infra_blip' as const,
        confidence: 0.75,
        reason: 'network',
      },
    ];
    const rec = generateRecommendation(triaged);
    expect(rec.verdict).toBe('GO');
    expect(rec.blockers).toHaveLength(0);
    expect(rec.safeToIgnore).toHaveLength(2);
  });

  it('returns NO_GO when there are real regressions in a HIGH severity domain', () => {
    const triaged = [
      {
        testName: 'charge fails',
        suiteName: 'Payment Suite',
        errorMessage: 'Expected 200 got 500',
        verdict: 'real_regression' as const,
        confidence: 0.85,
        reason: 'code changed',
        relatedToChangedCode: true,
      },
    ];
    const rec = generateRecommendation(triaged);
    expect(rec.verdict).toBe('NO_GO');
    expect(rec.blockers).toHaveLength(1);
    expect(rec.confidence).toBeGreaterThan(0.7);
    expect(rec.aggregate_risk_score).toBeGreaterThan(0);
    expect(rec.failing_tests_analysis[0].severity).toBe('HIGH');
  });

  it('returns CONDITIONAL_GO when regressions are in LOW/MEDIUM severity domain', () => {
    const triaged = [
      {
        testName: 'chart renders',
        suiteName: 'Analytics Dashboard',
        errorMessage: 'Expected bar to be blue',
        verdict: 'real_regression' as const,
        confidence: 0.85,
        reason: 'code changed',
        relatedToChangedCode: true,
      },
    ];
    const rec = generateRecommendation(triaged);
    expect(rec.verdict).toBe('CONDITIONAL_GO');
    expect(rec.failing_tests_analysis[0].severity).toBe('LOW');
    expect(rec.aggregate_risk_score).toBeGreaterThan(0);
    expect(rec.aggregate_risk_score).toBeLessThan(0.5);
  });

  it('returns INVESTIGATE when too many unknowns', () => {
    const unknowns = Array.from({ length: 4 }, (_, i) => ({
      testName: `t${i}`,
      suiteName: 's',
      errorMessage: 'e',
      verdict: 'unknown' as const,
      confidence: 0.4,
      reason: 'no data',
    }));
    const rec = generateRecommendation(unknowns);
    expect(rec.verdict).toBe('INVESTIGATE');
  });

  it('returns GO with 100% confidence when no failures', () => {
    const rec = generateRecommendation([]);
    expect(rec.verdict).toBe('GO');
    expect(rec.confidence).toBe(1.0);
  });

  it('stats are correct', () => {
    const triaged = [
      {
        testName: 'a',
        suiteName: 's',
        errorMessage: 'e',
        verdict: 'real_regression' as const,
        confidence: 0.85,
        reason: 'r',
      },
      {
        testName: 'b',
        suiteName: 's',
        errorMessage: 'e',
        verdict: 'known_flaky' as const,
        confidence: 0.7,
        reason: 'r',
      },
      {
        testName: 'c',
        suiteName: 's',
        errorMessage: 'e',
        verdict: 'infra_blip' as const,
        confidence: 0.75,
        reason: 'r',
      },
    ];
    const rec = generateRecommendation(triaged);
    expect(rec.stats.totalFailures).toBe(3);
    expect(rec.stats.realRegressions).toBe(1);
    expect(rec.stats.knownFlaky).toBe(1);
    expect(rec.stats.infraBlips).toBe(1);
  });

  it('always returns aggregate_risk_score and failing_tests_analysis fields', () => {
    const rec = generateRecommendation([]);
    expect(rec.aggregate_risk_score).toBeDefined();
    expect(rec.failing_tests_analysis).toBeDefined();
    expect(Array.isArray(rec.failing_tests_analysis)).toBe(true);
  });

  it('blast_radius equals number of regressions in the same suite', () => {
    const triaged = [
      {
        testName: 'test A',
        suiteName: 'Auth Suite',
        errorMessage: 'fail',
        verdict: 'real_regression' as const,
        confidence: 0.85,
        reason: 'r',
      },
      {
        testName: 'test B',
        suiteName: 'Auth Suite',
        errorMessage: 'fail',
        verdict: 'real_regression' as const,
        confidence: 0.85,
        reason: 'r',
      },
    ];
    const rec = generateRecommendation(triaged);
    expect(rec.failing_tests_analysis[0].blast_radius).toBe(2);
    expect(rec.failing_tests_analysis[1].blast_radius).toBe(2);
  });
});

describe('classifyDomain', () => {
  it('classifies payment suite as HIGH severity', () => {
    const { domain, severity } = classifyDomain('Payment Suite');
    expect(severity).toBe('HIGH');
    expect(domain).toBe('payment');
  });

  it('classifies auth suite as HIGH severity', () => {
    const { severity } = classifyDomain('Auth Integration Tests');
    expect(severity).toBe('HIGH');
  });

  it('classifies analytics suite as LOW severity', () => {
    const { severity } = classifyDomain('Analytics Dashboard Tests');
    expect(severity).toBe('LOW');
  });

  it('classifies unknown suite as MEDIUM severity', () => {
    const { domain, severity } = classifyDomain('Button Component Tests');
    expect(severity).toBe('MEDIUM');
    expect(domain).toBe('core');
  });

  it('uses filePath as fallback when suiteName has no match', () => {
    const { severity } = classifyDomain('Generic Suite', 'src/billing/invoice.test.ts');
    expect(severity).toBe('HIGH');
  });
});

describe('detectTemporalPatterns', () => {
  it('returns no pattern when fewer than 2 failures per test', () => {
    const result = detectTemporalPatterns([
      { testName: 'only once', suiteName: 'S', timestamp: '2026-03-01T02:00:00Z' },
    ]);
    expect(result.temporal_pattern_detected).toBe(false);
    expect(result.clusters).toHaveLength(0);
  });

  it('detects hourly pattern when failures cluster at the same UTC hour', () => {
    const result = detectTemporalPatterns([
      { testName: 'cron job', suiteName: 'S', timestamp: '2026-03-01T03:05:00Z' },
      { testName: 'cron job', suiteName: 'S', timestamp: '2026-04-01T03:15:00Z' },
      { testName: 'cron job', suiteName: 'S', timestamp: '2026-05-01T03:20:00Z' },
    ]);
    expect(result.temporal_pattern_detected).toBe(true);
    expect(result.clusters[0].pattern_type).toBe('hourly');
    expect(result.clusters[0].confidence_score).toBeGreaterThan(0.6);
  });

  it('detects monthly pattern when failures cluster on the same day of month', () => {
    const result = detectTemporalPatterns([
      { testName: 'billing', suiteName: 'S', timestamp: '2026-01-01T10:00:00Z' },
      { testName: 'billing', suiteName: 'S', timestamp: '2026-02-01T14:00:00Z' },
      { testName: 'billing', suiteName: 'S', timestamp: '2026-03-02T09:00:00Z' },
    ]);
    expect(result.temporal_pattern_detected).toBe(true);
    expect(result.clusters[0].pattern_type).toBe('monthly');
  });

  it('detects daily (weekday) pattern when failures always occur on the same weekday', () => {
    // 2026-01-05, 2026-01-12, 2026-01-19 are all Mondays (UTC day 1)
    const result = detectTemporalPatterns([
      { testName: 'weekly', suiteName: 'S', timestamp: '2026-01-05T18:30:00Z' },
      { testName: 'weekly', suiteName: 'S', timestamp: '2026-01-12T09:00:00Z' },
      { testName: 'weekly', suiteName: 'S', timestamp: '2026-01-19T14:00:00Z' },
    ]);
    expect(result.temporal_pattern_detected).toBe(true);
    expect(result.clusters[0].pattern_type).toBe('daily');
  });

  it('detects timezone_shift when failures happen near 02:00 UTC on DST transition Sundays', () => {
    // 2026-03-08 is the 2nd Sunday of March (US spring forward)
    // 2027-03-14 is the 2nd Sunday of March next year
    const result = detectTemporalPatterns([
      { testName: 'dst test', suiteName: 'S', timestamp: '2026-03-08T02:30:00Z' },
      { testName: 'dst test', suiteName: 'S', timestamp: '2027-03-14T01:45:00Z' },
    ]);
    expect(result.temporal_pattern_detected).toBe(true);
    expect(result.clusters[0].pattern_type).toBe('timezone_shift');
  });

  it('returns no pattern when failures are randomly distributed', () => {
    const result = detectTemporalPatterns([
      { testName: 'random', suiteName: 'S', timestamp: '2026-01-01T02:00:00Z' },
      { testName: 'random', suiteName: 'S', timestamp: '2026-01-15T14:30:00Z' },
      { testName: 'random', suiteName: 'S', timestamp: '2026-02-20T09:15:00Z' },
    ]);
    expect(result.temporal_pattern_detected).toBe(false);
  });

  it('includes summary explaining the patterns found', () => {
    const result = detectTemporalPatterns([
      { testName: 'nightly', suiteName: 'S', timestamp: '2026-03-01T00:05:00Z' },
      { testName: 'nightly', suiteName: 'S', timestamp: '2026-04-01T00:10:00Z' },
    ]);
    expect(result.summary).toContain('temporal cluster');
  });

  it('summary states no pattern when none detected', () => {
    const result = detectTemporalPatterns([
      { testName: 'rand', suiteName: 'S', timestamp: '2026-01-03T08:00:00Z' },
      { testName: 'rand', suiteName: 'S', timestamp: '2026-02-17T20:00:00Z' },
    ]);
    expect(result.summary).toContain('No temporal patterns');
  });
});
