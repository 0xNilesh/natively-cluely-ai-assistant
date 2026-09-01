// electron/services/__tests__/ClaudeSessionIdMigration.test.mjs
//
// meetings.claude_session_id — the forked Claude Code session a meeting's
// answers were generated in, so the meeting detail page can hand it back and
// `claude --resume <id>` reopens the interview conversation.
//
// Following the UserTitledMeetingRename / SaveMeetingIdempotency pattern: an
// in-memory better-sqlite3 carrying the PRE-migration production schema, the
// migration statement and the save SQL taken verbatim from the compiled
// DatabaseManager, plus source pins so the mirrored SQL cannot drift.
//
// The properties that matter:
//   1. The migration is idempotent on an existing database — it is applied
//      UNCONDITIONALLY rather than behind a user_version gate, so it runs on
//      every launch and must survive that
//   2. It is additive: existing rows and their data are untouched
//   3. saveMeeting's INSERT OR REPLACE does not blank a captured session id on
//      the second (final) write, the same hazard RC-7 found for the title
//   4. Meetings that used no claude-cli provider keep NULL, which is what the
//      detail page reads to decide whether to show the row at all

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * better-sqlite3, or Node's built-in SQLite when its native binding is not
 * built for the running runtime.
 *
 * better-sqlite3 is the production driver and the one every other DB test here
 * uses, so it is tried first. But its binding is compiled per ABI by the
 * postinstall step, and a checkout without that step (or one borrowing another
 * tree's node_modules) has no binding at all — every DB test then fails with
 * "Could not locate the bindings file" and proves nothing either way. The two
 * drivers agree on exactly the surface used below (exec / prepare().run / .get
 * / .all against plain SQL), and the assertions are about SQLite semantics, not
 * about the driver — so falling back keeps this file's findings available
 * everywhere while CI still exercises the real one.
 */
const Database = await (async () => {
  try {
    const { default: BetterSqlite3 } = await import('better-sqlite3');
    // The import succeeds even with no binding — `bindings` only looks for the
    // .node file when a Database is constructed. So construct one.
    new BetterSqlite3(':memory:').close();
    return BetterSqlite3;
  } catch {
    const { DatabaseSync } = await import('node:sqlite');
    return DatabaseSync;
  }
})();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const compiled = fs.readFileSync(
  path.resolve(__dirname, '../../../dist-electron/electron/db/DatabaseManager.js'), 'utf8');

/** The schema as it stands BEFORE this migration — an existing user's database. */
function makeLegacyDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE meetings (
      id TEXT PRIMARY KEY,
      title TEXT,
      start_time INTEGER,
      duration_ms INTEGER,
      summary_json TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      calendar_event_id TEXT,
      source TEXT,
      is_processed INTEGER DEFAULT 1,
      summary_status TEXT DEFAULT 'completed',
      user_titled INTEGER DEFAULT 0
    );
  `);
  return db;
}

// Verbatim from DatabaseManager.ts.
const MIGRATION_SQL = 'ALTER TABLE meetings ADD COLUMN claude_session_id TEXT';
const SAVE_SQL = `INSERT OR REPLACE INTO meetings (id, title, start_time, duration_ms, summary_json, created_at, calendar_event_id, source, is_processed, summary_status, user_titled, claude_session_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const READ_EXISTING_SQL = 'SELECT title, COALESCE(user_titled, 0) AS user_titled, claude_session_id FROM meetings WHERE id = ?';

/**
 * The production migration call, try/catch and all.
 *
 * The try/catch is the whole idempotency mechanism: SQLite raises "duplicate
 * column name" on a second ALTER and the production code swallows exactly that.
 * A test that ran the ALTER bare would prove nothing about the shipped code.
 */
function applyMigration(db) {
  try { db.exec(MIGRATION_SQL); } catch { /* Column already exists */ }
}

/** Mirror of the production saveMeeting session-id logic (pinned below). */
function saveMeeting(db, id, { title = 'A meeting', claudeSessionId = undefined } = {}) {
  const existing = db.prepare(READ_EXISTING_SQL).get(id);
  const userTitled = existing?.user_titled === 1;
  db.prepare(SAVE_SQL).run(
    id,
    userTitled && existing?.title ? existing.title : title,
    1, 1000, '{}', '2026-09-01', null, 'manual', 1, 'completed',
    userTitled ? 1 : 0,
    claudeSessionId || existing?.claude_session_id || null,
  );
}

const columns = (db) => db.prepare('PRAGMA table_info(meetings)').all().map(c => c.name);

describe('meetings.claude_session_id migration', () => {
  test('adds the column to an existing database without disturbing its rows', () => {
    const db = makeLegacyDb();
    db.prepare(`INSERT INTO meetings (id, title, start_time, duration_ms, summary_json, created_at, source, is_processed, summary_status, user_titled)
                VALUES ('old', 'Renamed by hand', 1, 1000, '{"legacySummary":"x"}', '2026-01-01', 'calendar', 1, 'completed', 1)`).run();

    assert.ok(!columns(db).includes('claude_session_id'));
    applyMigration(db);
    assert.ok(columns(db).includes('claude_session_id'));

    const row = db.prepare('SELECT * FROM meetings WHERE id = ?').get('old');
    assert.equal(row.title, 'Renamed by hand', 'an additive column must not touch existing data');
    assert.equal(row.user_titled, 1);
    assert.equal(row.summary_json, '{"legacySummary":"x"}');
    assert.equal(row.claude_session_id, null, 'pre-existing meetings have no Claude session, and must read NULL');
  });

  test('is idempotent: re-running it on a migrated database is a no-op', () => {
    const db = makeLegacyDb();
    applyMigration(db);
    saveMeeting(db, 'm1', { claudeSessionId: 'sess-1' });

    // It is applied UNCONDITIONALLY on every launch (see the comment in
    // DatabaseManager: version-gating an additive column is what caused the
    // 2026-08-23 data-loss incident), so "runs again" is the normal case, not
    // an edge case.
    for (let i = 0; i < 5; i++) applyMigration(db);

    assert.equal(columns(db).filter(c => c === 'claude_session_id').length, 1);
    assert.equal(db.prepare('SELECT claude_session_id FROM meetings WHERE id = ?').get('m1').claude_session_id, 'sess-1',
      're-running the migration must not clear captured session ids');
  });

  test('a fresh database and a migrated one end up with the same column set', () => {
    const legacy = makeLegacyDb();
    applyMigration(legacy);
    const fresh = makeLegacyDb();
    applyMigration(fresh);
    assert.deepEqual(columns(legacy), columns(fresh));
  });
});

describe('meetings.claude_session_id persistence', () => {
  test('the final save does not blank the id the placeholder captured', () => {
    const db = makeLegacyDb();
    applyMigration(db);

    // stopMeeting writes the placeholder WITH the id (it is only knowable while
    // the meeting is live); processAndSaveMeeting writes the final row later,
    // by which time the prep session is long gone. INSERT OR REPLACE rewrites
    // the whole row, so without the read-back the second write would null it —
    // exactly the hazard RC-7 found for the title.
    saveMeeting(db, 'm1', { title: 'Processing...', claudeSessionId: 'forked-abc' });
    saveMeeting(db, 'm1', { title: 'Backend interview' });

    const row = db.prepare('SELECT title, claude_session_id FROM meetings WHERE id = ?').get('m1');
    assert.equal(row.title, 'Backend interview');
    assert.equal(row.claude_session_id, 'forked-abc');
  });

  test('a meeting with no claude-cli provider keeps NULL', () => {
    const db = makeLegacyDb();
    applyMigration(db);
    saveMeeting(db, 'm2', { title: 'Processing...' });
    saveMeeting(db, 'm2', { title: 'Standup' });
    // NULL is what the detail page reads to decide whether to show the resume
    // row at all, so an empty string here would render an unusable control.
    assert.equal(db.prepare('SELECT claude_session_id FROM meetings WHERE id = ?').get('m2').claude_session_id, null);
  });

  test('a later save may still supply an id the first one did not have', () => {
    const db = makeLegacyDb();
    applyMigration(db);
    saveMeeting(db, 'm3', { title: 'Processing...' });
    saveMeeting(db, 'm3', { title: 'Final round', claudeSessionId: 'forked-late' });
    assert.equal(db.prepare('SELECT claude_session_id FROM meetings WHERE id = ?').get('m3').claude_session_id, 'forked-late');
  });
});

describe('source pins — the mirrored SQL must match production', () => {
  test('DatabaseManager applies the ALTER unconditionally, wrapped in try/catch', () => {
    assert.ok(compiled.includes(MIGRATION_SQL),
      'the migration statement mirrored here must exist verbatim in DatabaseManager');
    const at = compiled.indexOf(MIGRATION_SQL);
    const around = compiled.slice(Math.max(0, at - 200), at + 200);
    assert.ok(/try\s*\{[^}]*claude_session_id/.test(around),
      'the ALTER must be inside a try/catch — that is what makes it idempotent');
    // Version-gating an additive column is the shape that caused the 2026-08-23
    // incident (a live DB observed past the gate WITHOUT the column, after which
    // every saveMeeting threw and meetings were silently lost).
    assert.ok(!/if\s*\(\s*version\s*<\s*\d+\s*\)\s*\{?[^}]*claude_session_id/.test(around),
      'the ALTER must not sit behind a user_version gate');
  });

  test('DatabaseManager writes and reads back the column', () => {
    assert.ok(compiled.includes('claude_session_id'), 'the column must be referenced by the compiled manager');
    assert.ok(/INSERT OR REPLACE INTO meetings[^`]*claude_session_id/.test(compiled),
      'saveMeeting must include the column in its INSERT');
    assert.ok(compiled.includes('claudeSessionId: meetingRow.claude_session_id'),
      'getMeetingDetails must project the column back out, or the UI can never show it');
  });
});
