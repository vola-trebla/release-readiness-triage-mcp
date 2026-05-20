export interface TestFailure {
  testName: string;
  suiteName: string;
  errorMessage: string;
  filePath?: string;
  duration?: number;
}

export interface CIRunInput {
  failures: TestFailure[];
  totalTests: number;
  passedTests: number;
  branch?: string;
  commitSha?: string;
  runId?: string;
}

export interface FailureGroup {
  signature: string;
  count: number;
  tests: TestFailure[];
  category: 'assertion' | 'timeout' | 'network' | 'crash' | 'unknown';
}

export interface FlakinessEntry {
  testName: string;
  suiteName: string;
  flakyProbability: number;
  recentFailures: number;
  totalRuns: number;
}

export interface FlakinessInput {
  entries: FlakinessEntry[];
}

export interface CodeChangeInput {
  changedFiles: string[];
  affectedTests?: string[];
}

export interface TriagedFailure {
  testName: string;
  suiteName: string;
  errorMessage: string;
  filePath?: string;
  verdict: 'real_regression' | 'known_flaky' | 'infra_blip' | 'unknown';
  confidence: number;
  reason: string;
  flakyProbability?: number;
  relatedToChangedCode?: boolean;
}

export type DomainSeverity = 'HIGH' | 'MEDIUM' | 'LOW';

export interface FailingTestAnalysis {
  test_id: string;
  domain: string;
  severity: DomainSeverity;
  risk_contribution: number;
  blast_radius: number;
}

export interface ReleaseRecommendation {
  verdict: 'GO' | 'CONDITIONAL_GO' | 'NO_GO' | 'INVESTIGATE';
  confidence: number;
  aggregate_risk_score: number;
  summary: string;
  blockers: TriagedFailure[];
  warnings: TriagedFailure[];
  safeToIgnore: TriagedFailure[];
  failing_tests_analysis: FailingTestAnalysis[];
  stats: {
    totalFailures: number;
    realRegressions: number;
    knownFlaky: number;
    infraBlips: number;
    unknown: number;
  };
}

export interface FailureTimestamp {
  testName: string;
  suiteName: string;
  timestamp: string; // ISO 8601
}

export type TemporalPatternType = 'hourly' | 'daily' | 'monthly' | 'timezone_shift';

export interface TemporalCluster {
  test_id: string;
  pattern_type: TemporalPatternType;
  cluster_times: string[];
  confidence_score: number;
}

export interface TemporalPatternsResult {
  temporal_pattern_detected: boolean;
  clusters: TemporalCluster[];
  summary: string;
}
