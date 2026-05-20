import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { analyzeRollbackReadiness } from '../src/migrations.js';

let testDir: string;

beforeAll(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollback-test-'));
});

afterAll(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

function makeDir(...parts: string[]): string {
  const dir = path.join(testDir, ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFile(dir: string, name: string, content: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

describe('analyzeRollbackReadiness', () => {
  it('throws when repo_path does not exist', () => {
    expect(() => analyzeRollbackReadiness('/nonexistent/path/abc')).toThrow(
      'Repository path not found',
    );
  });

  it('returns standard strategy when no migration files found', () => {
    const emptyDir = makeDir('empty');
    const result = analyzeRollbackReadiness(emptyDir);
    expect(result.rollback_eligible).toBe(true);
    expect(result.migrations_scanned).toBe(0);
    expect(result.deployment_strategy).toBe('standard');
    expect(result.blocking_migrations).toHaveLength(0);
  });

  it('detects Flyway additive migration as rollback_eligible', () => {
    const dir = makeDir('flyway-additive');
    writeFile(
      dir,
      'V1__create_users.sql',
      'CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT);\nADD COLUMN email TEXT;\n',
    );
    const result = analyzeRollbackReadiness(dir);
    expect(result.rollback_eligible).toBe(true);
    expect(result.migrations_scanned).toBe(1);
    expect(result.deployment_strategy).toBe('standard');
  });

  it('detects DROP TABLE as forward_fix_only', () => {
    const dir = makeDir('flyway-drop-table');
    writeFile(dir, 'V2__cleanup.sql', 'DROP TABLE legacy_logs;\n');
    const result = analyzeRollbackReadiness(dir);
    expect(result.rollback_eligible).toBe(false);
    expect(result.deployment_strategy).toBe('forward_fix_only');
    expect(result.blocking_migrations).toHaveLength(1);
    expect(result.blocking_migrations[0].operation).toBe('DROP TABLE');
    expect(result.blocking_migrations[0].line).toBe(1);
  });

  it('detects DROP COLUMN as forward_fix_only', () => {
    const dir = makeDir('flyway-drop-column');
    writeFile(dir, 'V3__remove_field.sql', 'ALTER TABLE users DROP COLUMN legacy_token;\n');
    const result = analyzeRollbackReadiness(dir);
    expect(result.blocking_migrations[0].operation).toBe('DROP COLUMN');
  });

  it('detects TRUNCATE as forward_fix_only', () => {
    const dir = makeDir('flyway-truncate');
    writeFile(dir, 'V4__reset.sql', 'TRUNCATE TABLE audit_log;\n');
    const result = analyzeRollbackReadiness(dir);
    expect(result.blocking_migrations[0].operation).toBe('TRUNCATE');
  });

  it('detects ALTER COLUMN TYPE as forward_fix_only', () => {
    const dir = makeDir('flyway-alter-type');
    writeFile(dir, 'V5__change_type.sql', 'ALTER TABLE orders ALTER COLUMN amount TYPE BIGINT;\n');
    const result = analyzeRollbackReadiness(dir);
    expect(result.blocking_migrations[0].operation).toBe('ALTER COLUMN TYPE');
  });

  it('ignores SQL comments', () => {
    const dir = makeDir('sql-comments');
    writeFile(
      dir,
      'V6__safe.sql',
      '-- DROP TABLE would go here if we needed it\nCREATE TABLE new_thing (id INT);\n',
    );
    const result = analyzeRollbackReadiness(dir);
    expect(result.rollback_eligible).toBe(true);
  });

  it('scans Prisma migration.sql inside migrations/ folder', () => {
    const migDir = makeDir('prisma-repo', 'prisma', 'migrations', '20240101_init');
    writeFile(migDir, 'migration.sql', 'CREATE TABLE posts (id INT);\n');
    const result = analyzeRollbackReadiness(path.join(testDir, 'prisma-repo'));
    expect(result.migrations_scanned).toBe(1);
    expect(result.rollback_eligible).toBe(true);
  });

  it('detects destructive op in Prisma migration.sql', () => {
    const migDir = makeDir('prisma-drop', 'prisma', 'migrations', '20240201_cleanup');
    writeFile(migDir, 'migration.sql', 'DROP TABLE old_sessions;\n');
    const result = analyzeRollbackReadiness(path.join(testDir, 'prisma-drop'));
    expect(result.rollback_eligible).toBe(false);
    expect(result.blocking_migrations[0].operation).toBe('DROP TABLE');
  });

  it('scans Liquibase XML changelog for destructive ops', () => {
    const dir = makeDir('liquibase-repo', 'liquibase');
    writeFile(
      dir,
      'changelog.xml',
      '<databaseChangeLog>\n  <changeSet id="1">\n    <dropTable tableName="temp"/>\n  </changeSet>\n</databaseChangeLog>\n',
    );
    const result = analyzeRollbackReadiness(path.join(testDir, 'liquibase-repo'));
    expect(result.rollback_eligible).toBe(false);
    expect(result.blocking_migrations[0].operation).toBe('dropTable');
  });

  it('reports relative file paths in blocking_migrations', () => {
    const dir = makeDir('relative-paths');
    writeFile(dir, 'V7__drop.sql', 'DROP TABLE foo;\n');
    const result = analyzeRollbackReadiness(dir);
    expect(result.blocking_migrations[0].file).not.toContain(testDir);
    expect(result.blocking_migrations[0].file).toBe('V7__drop.sql');
  });

  it('counts multiple blocking operations across files', () => {
    const dir = makeDir('multi-block');
    writeFile(dir, 'V8__a.sql', 'DROP TABLE a;\n');
    writeFile(dir, 'V9__b.sql', 'TRUNCATE TABLE b;\n');
    const result = analyzeRollbackReadiness(dir);
    expect(result.blocking_migrations).toHaveLength(2);
    expect(result.rollback_eligible).toBe(false);
  });
});
