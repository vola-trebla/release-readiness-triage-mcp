import * as fs from 'fs';
import * as path from 'path';

export interface BlockingMigration {
  file: string;
  line: number;
  operation: string;
  reason: string;
}

export interface RollbackReadinessResult {
  rollback_eligible: boolean;
  migrations_scanned: number;
  blocking_migrations: BlockingMigration[];
  deployment_strategy: 'standard' | 'forward_fix_only';
  summary: string;
}

const DESTRUCTIVE_SQL: Array<{ pattern: RegExp; operation: string; reason: string }> = [
  {
    pattern: /\bDROP\s+TABLE\b/i,
    operation: 'DROP TABLE',
    reason: 'Table and all its data are permanently deleted — code rollback will not restore it.',
  },
  {
    pattern: /\bDROP\s+COLUMN\b/i,
    operation: 'DROP COLUMN',
    reason:
      'Column data is permanently deleted — code rollback will fail if the column is referenced.',
  },
  {
    // ALTER TABLE foo ALTER COLUMN bar TYPE ... (PostgreSQL)
    pattern: /\bALTER\s+(?:TABLE\s+\S+\s+)?(?:ALTER|CHANGE)\s+COLUMN\b.*\bTYPE\b/i,
    operation: 'ALTER COLUMN TYPE',
    reason:
      'Type change can truncate or corrupt existing values — a reverse migration is required to roll back.',
  },
  {
    // MySQL: ALTER TABLE foo MODIFY COLUMN bar INT NOT NULL
    pattern: /\bMODIFY\s+COLUMN\b/i,
    operation: 'MODIFY COLUMN',
    reason: 'Column modification may change data type or drop NOT NULL constraint destructively.',
  },
  {
    pattern: /\bTRUNCATE\b/i,
    operation: 'TRUNCATE',
    reason: 'All rows permanently deleted — data cannot be recovered by code rollback.',
  },
];

const DESTRUCTIVE_LIQUIBASE: Array<{ pattern: RegExp; operation: string; reason: string }> = [
  {
    pattern: /dropTable|drop-table/i,
    operation: 'dropTable',
    reason: 'Table and all its data are permanently deleted.',
  },
  {
    pattern: /dropColumn|drop-column/i,
    operation: 'dropColumn',
    reason: 'Column and its data are permanently deleted.',
  },
  {
    pattern: /modifyDataType|modify-data-type/i,
    operation: 'modifyDataType',
    reason: 'Type change can corrupt or truncate existing data.',
  },
  {
    pattern: /truncateTable|truncate-table/i,
    operation: 'truncateTable',
    reason: 'All rows permanently deleted.',
  },
];

function isFlywaySql(file: string): boolean {
  return /V\d+[^/\\]*\.sql$/i.test(path.basename(file));
}

function isPrismaMigrationSql(file: string): boolean {
  return path.basename(file) === 'migration.sql' && file.includes('migrations');
}

function isLiquibaseFile(file: string): boolean {
  const base = path.basename(file);
  const inMigrationDir =
    file.includes('liquibase') || file.includes('changelog') || file.includes('migration');
  return inMigrationDir && /\.(xml|ya?ml)$/.test(base);
}

function isMigrationFile(file: string): boolean {
  return isFlywaySql(file) || isPrismaMigrationSql(file) || isLiquibaseFile(file);
}

function collectMigrationFiles(dir: string, files: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectMigrationFiles(full, files);
    } else if (entry.isFile() && isMigrationFile(full)) {
      files.push(full);
    }
  }
  return files;
}

function scanSqlFile(filePath: string, repoRoot: string): BlockingMigration[] {
  const found: BlockingMigration[] = [];
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return found;
  }
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip SQL comments
    if (/^\s*--/.test(line)) continue;
    for (const { pattern, operation, reason } of DESTRUCTIVE_SQL) {
      if (pattern.test(line)) {
        found.push({
          file: path.relative(repoRoot, filePath),
          line: i + 1,
          operation,
          reason,
        });
        break;
      }
    }
  }
  return found;
}

function scanLiquibaseFile(filePath: string, repoRoot: string): BlockingMigration[] {
  const found: BlockingMigration[] = [];
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return found;
  }
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const { pattern, operation, reason } of DESTRUCTIVE_LIQUIBASE) {
      if (pattern.test(lines[i])) {
        found.push({
          file: path.relative(repoRoot, filePath),
          line: i + 1,
          operation,
          reason,
        });
        break;
      }
    }
  }
  return found;
}

export function analyzeRollbackReadiness(repoPath: string): RollbackReadinessResult {
  if (!fs.existsSync(repoPath)) {
    throw new Error(`Repository path not found: ${repoPath}`);
  }

  const migrationFiles = collectMigrationFiles(repoPath);
  const blocking: BlockingMigration[] = [];

  for (const file of migrationFiles) {
    if (isLiquibaseFile(file)) {
      blocking.push(...scanLiquibaseFile(file, repoPath));
    } else {
      blocking.push(...scanSqlFile(file, repoPath));
    }
  }

  const rollbackEligible = blocking.length === 0;
  const strategy = rollbackEligible ? 'standard' : 'forward_fix_only';

  let summary: string;
  if (migrationFiles.length === 0) {
    summary = 'No migration files found. Deployment strategy: standard rollback.';
  } else if (rollbackEligible) {
    summary = `${migrationFiles.length} migration file(s) scanned — all operations are additive. Standard rollback is safe.`;
  } else {
    summary =
      `${migrationFiles.length} migration file(s) scanned — ${blocking.length} destructive operation(s) found. ` +
      `Rolling back code after deployment will corrupt the database. Forward-fix only.`;
  }

  return {
    rollback_eligible: rollbackEligible,
    migrations_scanned: migrationFiles.length,
    blocking_migrations: blocking,
    deployment_strategy: strategy,
    summary,
  };
}
