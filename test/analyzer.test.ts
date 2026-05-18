import { describe, it, expect } from 'vitest';
import { aggregateFailures, triageFailures, generateRecommendation } from '../src/analyzer.js';
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

  it('returns NO_GO when there are real regressions', () => {
    const triaged = [
      {
        testName: 't',
        suiteName: 's',
        errorMessage: 'e',
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
});
