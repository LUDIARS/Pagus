import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { deserialize, serialize } from 'node:v8';
import { fileURLToPath } from 'node:url';
import type {
  ChatMessage,
  ChronicleEntry,
  PlayerActionEntry,
  UserFaithEntry,
  VillagerActionEntry,
  VillagerRelationship,
} from '@pagus/sim';
import { dataDir } from './load-data.js';

type Statement = {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
};

type Database = {
  close(): void;
  exec(sql: string): void;
  prepare(sql: string): Statement;
};

type DatabaseSyncCtor = new (filename: string) => Database;

const require = createRequire(import.meta.url);

let instance: RuntimeDb | null = null;
const CHRONICLE_RETENTION = 10_000;
const CHAT_RETENTION = 5_000;
const ACTION_RETENTION = 10_000;
const SESSION_LOG_RETENTION = 50_000;
const SEASON_RETENTION = 1_000;


export function runtimeDb(): RuntimeDb {
  if (!instance) instance = new RuntimeDb();
  return instance;
}

export function closeRuntimeDb(): void {
  instance?.close();
  instance = null;
}

export class RuntimeDb {
  private readonly db: Database;

  constructor(path = resolve(dataDir(), 'runtime', 'pagus.sqlite')) {
    mkdirSync(dirname(path), { recursive: true });
    const sqlite = require('node:sqlite') as { DatabaseSync: DatabaseSyncCtor };
    this.db = new sqlite.DatabaseSync(path);
    this.init();
    this.redactHumanChatNames();
  }

  getState<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value?: Uint8Array } | undefined;
    if (!row?.value) return null;
    return deserialize(Buffer.from(row.value)) as T;
  }

  setState(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO kv (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, serialize(value), Date.now());
  }

  close(): void {
    this.db.close();
  }

  chronicleCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM chronicle').get() as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  addChronicle(entry: ChronicleEntry): void {
    this.db
      .prepare('INSERT INTO chronicle (date, text, kind, event_id, title, payload) VALUES (?, ?, ?, ?, ?, ?)')
      .run(entry.date, entry.text, entry.kind ?? null, entry.eventId ?? null, entry.title ?? null, serialize(entry));
    this.pruneChronicle();
  }

  hasChronicleEvent(eventId: string): boolean {
    const row = this.db.prepare('SELECT 1 AS found FROM chronicle WHERE event_id = ? LIMIT 1').get(eventId) as
      | { found?: number }
      | undefined;
    return row?.found === 1;
  }

  replaceChronicle(entries: ChronicleEntry[]): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM chronicle').run();
      const stmt = this.db.prepare('INSERT INTO chronicle (date, text, kind, event_id, title, payload) VALUES (?, ?, ?, ?, ?, ?)');
      for (const entry of entries) {
        stmt.run(entry.date, entry.text, entry.kind ?? null, entry.eventId ?? null, entry.title ?? null, serialize(entry));
      }
    });
    this.pruneChronicle();
  }

  recentChronicle(limit: number): ChronicleEntry[] {
    const rows = this.db
      .prepare('SELECT payload FROM chronicle ORDER BY id DESC LIMIT ?')
      .all(clampLimit(limit, CHRONICLE_RETENTION)) as Array<{ payload?: Uint8Array }>;
    return deserializeRows<ChronicleEntry>(rows);
  }

  chatCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM chat_messages').get() as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  addChat(message: ChatMessage): void {
    const stored = chatForStorage(message);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO chat_messages
         (message_id, channel, speaker_kind, user_id, user_name, villager_id, dm_with_villager_id, at, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        stored.id,
        stored.channel,
        stored.speakerKind,
        stored.userId,
        stored.userName ?? null,
        stored.villagerId ?? null,
        stored.dmWithVillagerId ?? null,
        stored.at,
        serialize(stored),
      );
    this.pruneChat();
  }

  addChats(messages: ChatMessage[]): void {
    this.transaction(() => {
      const stmt = this.db.prepare(
        `INSERT OR REPLACE INTO chat_messages
         (message_id, channel, speaker_kind, user_id, user_name, villager_id, dm_with_villager_id, at, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const message of messages.map(chatForStorage)) {
        stmt.run(
          message.id,
          message.channel,
          message.speakerKind,
          message.userId,
          message.userName ?? null,
          message.villagerId ?? null,
          message.dmWithVillagerId ?? null,
          message.at,
          serialize(message),
        );
      }
    });
    this.pruneChat();
  }

  replaceChat(messages: ChatMessage[]): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM chat_messages').run();
      const stmt = this.db.prepare(
        `INSERT INTO chat_messages
         (message_id, channel, speaker_kind, user_id, user_name, villager_id, dm_with_villager_id, at, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const message of messages.map(chatForStorage)) {
        stmt.run(
          message.id,
          message.channel,
          message.speakerKind,
          message.userId,
          message.userName ?? null,
          message.villagerId ?? null,
          message.dmWithVillagerId ?? null,
          message.at,
          serialize(message),
        );
      }
    });
    this.pruneChat();
  }

  recentChat(limit: number): ChatMessage[] {
    const rows = this.db
      .prepare('SELECT payload FROM chat_messages ORDER BY at DESC, id DESC LIMIT ?')
      .all(clampLimit(limit, CHAT_RETENTION)) as Array<{ payload?: Uint8Array }>;
    return deserializeRows<ChatMessage>(rows);
  }

  private redactHumanChatNames(): void {
    const rows = this.db
      .prepare('SELECT id, payload FROM chat_messages WHERE speaker_kind = ? AND user_name IS NOT NULL')
      .all('human') as Array<{ id?: number; payload?: Uint8Array }>;
    if (rows.length === 0) return;
    this.transaction(() => {
      const update = this.db.prepare('UPDATE chat_messages SET user_name = ?, payload = ? WHERE id = ?');
      for (const row of rows) {
        if (row.id === undefined || !row.payload) continue;
        const message = deserialize(Buffer.from(row.payload)) as ChatMessage;
        const stored = chatForStorage(message);
        update.run(null, serialize(stored), row.id);
      }
    });
  }

  addPlayerAction(entry: PlayerActionEntry): void {
    this.addAction('player', entry.date, null, entry.userId, entry);
  }

  recentPlayerActions(limit: number): PlayerActionEntry[] {
    return this.recentActions<PlayerActionEntry>('player', limit);
  }

  addVillagerAction(entry: VillagerActionEntry): void {
    this.addAction('villager', entry.date, entry.term, entry.villagerId, entry);
  }

  addVillagerActions(entries: readonly VillagerActionEntry[]): void {
    if (entries.length === 0) return;
    this.transaction(() => {
      const insert = this.db.prepare(
        'INSERT INTO action_log (kind, game_date, term, actor_id, payload) VALUES (?, ?, ?, ?, ?)',
      );
      for (const entry of entries) {
        insert.run('villager', entry.date, entry.term, entry.villagerId, serialize(entry));
      }
    });
    this.pruneActions('villager');
  }

  villagerActionCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM action_log WHERE kind = ?').get('villager') as
      | { count?: number }
      | undefined;
    return Number(row?.count ?? 0);
  }

  recentVillagerActions(limit: number): VillagerActionEntry[] {
    return this.recentActions<VillagerActionEntry>('villager', limit);
  }

  addSessionLog(record: Readonly<Record<string, unknown>>): void {
    const timestamp = typeof record.ts === 'string' ? record.ts : new Date().toISOString();
    const recordType = typeof record.t === 'string' ? record.t : 'log';
    this.db
      .prepare('INSERT INTO session_log (record_type, recorded_at, payload) VALUES (?, ?, ?)')
      .run(recordType, timestamp, serialize(record));
    this.pruneTable('session_log', SESSION_LOG_RETENTION);
  }

  recentSessionLogs(limit: number): Array<Record<string, unknown>> {
    const rows = this.db
      .prepare('SELECT payload FROM session_log ORDER BY id DESC LIMIT ?')
      .all(clampLimit(limit, SESSION_LOG_RETENTION)) as Array<{ payload?: Uint8Array }>;
    return deserializeRows<Record<string, unknown>>(rows);
  }

  addSeasonRecord(record: unknown): void {
    this.db.prepare('INSERT INTO season_history (payload) VALUES (?)').run(serialize(record));
    this.pruneTable('season_history', SEASON_RETENTION);
  }

  replaceSeasonRecords(records: readonly unknown[]): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM season_history').run();
      const insert = this.db.prepare('INSERT INTO season_history (payload) VALUES (?)');
      for (const record of records.slice(-SEASON_RETENTION)) insert.run(serialize(record));
    });
  }

  seasonRecordCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM season_history').get() as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  archiveRelationships(entries: readonly VillagerRelationship[]): void {
    if (entries.length === 0) return;
    this.transaction(() => {
      const insert = this.db.prepare(
        `INSERT INTO archived_relationships (from_id, to_id, payload, archived_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(from_id, to_id) DO UPDATE SET payload = excluded.payload, archived_at = excluded.archived_at`,
      );
      const archivedAt = Date.now();
      for (const entry of entries) insert.run(entry.from, entry.to, serialize(entry), archivedAt);
    });
  }

  archivedRelationshipsFor(villagerId: string): VillagerRelationship[] {
    const rows = this.db
      .prepare('SELECT payload FROM archived_relationships WHERE from_id = ? OR to_id = ?')
      .all(villagerId, villagerId) as Array<{ payload?: Uint8Array }>;
    return deserializeRows<VillagerRelationship>(rows, false);
  }

  archiveUserFaith(entries: readonly UserFaithEntry[]): void {
    if (entries.length === 0) return;
    this.transaction(() => {
      const insert = this.db.prepare(
        `INSERT INTO archived_user_faith (villager_id, user_id, payload, archived_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(villager_id, user_id) DO UPDATE SET payload = excluded.payload, archived_at = excluded.archived_at`,
      );
      const archivedAt = Date.now();
      for (const entry of entries) insert.run(entry.villagerId, entry.userId, serialize(entry), archivedAt);
    });
  }

  archivedUserFaithFor(villagerId: string): UserFaithEntry[] {
    const rows = this.db.prepare('SELECT payload FROM archived_user_faith WHERE villager_id = ?').all(villagerId) as Array<{
      payload?: Uint8Array;
    }>;
    return deserializeRows<UserFaithEntry>(rows, false);
  }

  private init(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA cache_size = -4096;
      PRAGMA temp_store = FILE;
      PRAGMA mmap_size = 0;
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value BLOB NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chronicle (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        text TEXT NOT NULL,
        kind TEXT,
        event_id TEXT,
        title TEXT,
        payload BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chronicle_kind ON chronicle(kind);
      CREATE INDEX IF NOT EXISTS idx_chronicle_event_id ON chronicle(event_id);
      CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL UNIQUE,
        channel TEXT NOT NULL,
        speaker_kind TEXT NOT NULL,
        user_id TEXT NOT NULL,
        user_name TEXT,
        villager_id TEXT,
        dm_with_villager_id TEXT,
        at INTEGER NOT NULL,
        payload BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chat_channel_at ON chat_messages(channel, at);
      CREATE INDEX IF NOT EXISTS idx_chat_user_id ON chat_messages(user_id);
    `);
    this.applyMemoryHistoryMigration();
  }

  private applyMemoryHistoryMigration(): void {
    const path = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations/001_memory_history.sql');
    const sql = readFileSync(path, 'utf8');
    for (const statement of sql.split(';').map((part) => part.trim()).filter(Boolean)) {
      this.db.exec(`${statement};`);
    }
  }

  private addAction(kind: 'player' | 'villager', date: string, term: number | null, actorId: string, entry: unknown): void {
    this.db
      .prepare('INSERT INTO action_log (kind, game_date, term, actor_id, payload) VALUES (?, ?, ?, ?, ?)')
      .run(kind, date, term, actorId, serialize(entry));
    this.pruneActions(kind);
  }

  private recentActions<T>(kind: 'player' | 'villager', limit: number): T[] {
    const rows = this.db
      .prepare('SELECT payload FROM action_log WHERE kind = ? ORDER BY id DESC LIMIT ?')
      .all(kind, clampLimit(limit, ACTION_RETENTION)) as Array<{ payload?: Uint8Array }>;
    return deserializeRows<T>(rows);
  }

  private pruneActions(kind: 'player' | 'villager'): void {
    this.db
      .prepare(
        'DELETE FROM action_log WHERE kind = ? AND id NOT IN (SELECT id FROM action_log WHERE kind = ? ORDER BY id DESC LIMIT ?)',
      )
      .run(kind, kind, ACTION_RETENTION);
  }

  private pruneChronicle(cap = CHRONICLE_RETENTION): void {
    this.db.prepare('DELETE FROM chronicle WHERE id NOT IN (SELECT id FROM chronicle ORDER BY id DESC LIMIT ?)').run(cap);
  }

  private pruneChat(cap = CHAT_RETENTION): void {
    this.db.prepare('DELETE FROM chat_messages WHERE id NOT IN (SELECT id FROM chat_messages ORDER BY id DESC LIMIT ?)').run(cap);
  }

  private pruneTable(table: 'session_log' | 'season_history', cap: number): void {
    this.db.prepare(`DELETE FROM ${table} WHERE id NOT IN (SELECT id FROM ${table} ORDER BY id DESC LIMIT ?)`).run(cap);
  }

  private transaction(fn: () => void): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      fn();
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
}

function clampLimit(limit: number, max: number): number {
  if (!Number.isFinite(limit)) return max;
  return Math.max(0, Math.min(max, Math.trunc(limit)));
}

function deserializeRows<T>(rows: Array<{ payload?: Uint8Array }>, reverse = true): T[] {
  const ordered = reverse ? rows.reverse() : rows;
  return ordered
    .map((row) => row.payload ? deserialize(Buffer.from(row.payload)) as T : null)
    .filter((entry): entry is T => entry !== null);
}

function chatForStorage(message: ChatMessage): ChatMessage {
  if (message.speakerKind !== 'human' || message.userName == null) return message;
  return { ...message, userName: null };
}
