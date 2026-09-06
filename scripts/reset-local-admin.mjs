import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

// Local recovery only. There is deliberately no unauthenticated HTTP reset.
const [target, confirmation] = process.argv.slice(2);
if (!target || !path.isAbsolute(target) || confirmation !== '--confirm-owner-password-reset') {
  throw new Error('Supply the absolute canonical database path and --confirm-owner-password-reset. Quit Loom first.');
}
const databasePath = fs.realpathSync(target);
if (path.basename(databasePath) !== 'loomtv-canonical.sqlite' || !fs.statSync(databasePath).isFile()) {
  throw new Error('Only an existing loomtv-canonical.sqlite admin database can be reset.');
}
const users = spawnSync('lsof', ['-t', '--', databasePath], { encoding: 'utf8' });
if (users.error || users.status !== 1 || users.stdout.trim()) {
  throw new Error('Quit every Loom server using this database before resetting its admin password.');
}
process.umask(0o077);
const db = new DatabaseSync(databasePath);
db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
const digest = (value) => createHash('sha256').update(value).digest('hex');
const quote = (value) => `"${value.replaceAll('"', '""')}"`;
const snapshot = (table) => digest(JSON.stringify(db.prepare(`SELECT * FROM ${quote(table)}`).all()));
try {
  const owners = db.prepare("SELECT a.id,a.name FROM owner_account o JOIN accounts a ON a.id=o.account_id WHERE a.account_type='owner'").all();
  if (owners.length !== 1) throw new Error('Expected exactly one existing admin owner. Nothing was reset.');
  const owner = owners[0];
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
    .map((row) => row.name).filter((name) => !['account_credentials', 'account_sessions', 'login_attempts'].includes(name));
  const before = new Map(tables.map((table) => [table, snapshot(table)]));
  const backupDir = fs.mkdtempSync(path.join(path.dirname(databasePath), 'admin-password-backup-'));
  const backup = path.join(backupDir, 'loomtv-canonical.sqlite');
  db.prepare('VACUUM INTO ?').run(backup);
  const password = randomBytes(18).toString('base64url');
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('base64');
  db.exec('BEGIN IMMEDIATE');
  try {
    const changed = db.prepare("UPDATE account_credentials SET password_salt=?,password_hash=?,password_algorithm='scrypt',updated_at=? WHERE account_id=?")
      .run(salt, hash, Date.now(), owner.id);
    if (Number(changed.changes) !== 1) throw new Error('The owner credential was not found.');
    db.prepare("UPDATE account_sessions SET revoked_at=?,revoked_reason='local_password_recovery' WHERE account_id=? AND revoked_at IS NULL")
      .run(Date.now(), owner.id);
    for (const identity of [`account:${owner.id}`, 'owner', owner.name]) {
      db.prepare('DELETE FROM login_attempts WHERE key=?').run(digest(`identity:${identity.trim().toLocaleLowerCase()}`));
    }
    for (const table of tables) {
      if (snapshot(table) !== before.get(table)) throw new Error(`Unexpected change to ${table}; rolling back.`);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  console.log(JSON.stringify({ account: 'owner', temporaryPassword: password, backup, preservedTables: tables.length }));
} finally { db.close(); }
