import type { Action, Priority } from './classify';
import type { Case, HistoryEntry, Status } from './cases';
import type { Category } from './config';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS cases (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    posted_at TEXT NOT NULL,
    username TEXT NOT NULL,
    followers INTEGER NOT NULL,
    likes INTEGER NOT NULL,
    reposts INTEGER NOT NULL,
    text TEXT NOT NULL,
    category TEXT NOT NULL,
    priority TEXT NOT NULL,
    suggested TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'New',
    action TEXT NOT NULL DEFAULT '',
    history TEXT NOT NULL DEFAULT '[]'
  )`,
  `CREATE INDEX IF NOT EXISTS cases_created ON cases (created_at)`,
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];

export async function ensureSchema(db: D1Database): Promise<void> {
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
}

export async function getMeta(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM meta WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setMeta(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .bind(key, value)
    .run();
}

export async function deleteMeta(db: D1Database, key: string): Promise<void> {
  await db.prepare('DELETE FROM meta WHERE key = ?').bind(key).run();
}

export async function getMetaJson<T>(db: D1Database, key: string): Promise<T | null> {
  const raw = await getMeta(db, key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export const setMetaJson = (db: D1Database, key: string, value: unknown): Promise<void> =>
  setMeta(db, key, JSON.stringify(value));

interface CaseRow {
  id: string;
  created_at: number;
  posted_at: string;
  username: string;
  followers: number;
  likes: number;
  reposts: number;
  text: string;
  category: string;
  priority: string;
  suggested: string;
  status: string;
  action: string;
  history: string;
}

function toCase(r: CaseRow): Case {
  let history: HistoryEntry[] = [];
  try {
    history = JSON.parse(r.history) as HistoryEntry[];
  } catch {
    // corrupt history is not worth failing a button click over
  }
  return {
    id: r.id,
    createdAt: r.created_at,
    postedAt: r.posted_at,
    username: r.username,
    followers: r.followers,
    likes: r.likes,
    reposts: r.reposts,
    text: r.text,
    category: r.category as Category,
    priority: r.priority as Priority,
    suggested: r.suggested as Action,
    status: r.status as Status,
    action: r.action as Action | '',
    history,
  };
}

export async function getCase(db: D1Database, id: string): Promise<Case | null> {
  const row = await db.prepare('SELECT * FROM cases WHERE id = ?').bind(id).first<CaseRow>();
  return row ? toCase(row) : null;
}

export async function caseExists(db: D1Database, id: string): Promise<boolean> {
  const row = await db.prepare('SELECT 1 AS one FROM cases WHERE id = ?').bind(id).first<{ one: number }>();
  return row !== null;
}

export async function insertCase(db: D1Database, c: Case): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO cases
       (id, created_at, posted_at, username, followers, likes, reposts, text, category, priority, suggested, status, action, history)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      c.id, c.createdAt, c.postedAt, c.username, c.followers, c.likes, c.reposts, c.text,
      c.category, c.priority, c.suggested, c.status, c.action, JSON.stringify(c.history),
    )
    .run();
}

export async function saveCaseState(db: D1Database, c: Case): Promise<void> {
  await db
    .prepare('UPDATE cases SET status = ?, action = ?, history = ? WHERE id = ?')
    .bind(c.status, c.action, JSON.stringify(c.history), c.id)
    .run();
}

export async function countCasesSince(db: D1Database, sinceMs: number): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM cases WHERE created_at >= ?')
    .bind(sinceMs)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function countOpenCases(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM cases WHERE status IN ('New', 'Waiting')")
    .first<{ n: number }>();
  return row?.n ?? 0;
}
