import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { deserialize, serialize } from 'node:v8';
import type { ChatMessage, ChronicleEntry } from '@pagus/sim';
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

export function runtimeDb(): RuntimeDb {
  if (!instance) instance = new RuntimeDb();
  return instance;
}

export class RuntimeDb {
  private readonly db: Database;

  constructor(path = resolve(dataDir(), 'runtime', 'pagus.sqlite')) {
    mkdirSync(dirname(path), { recursive: true });
    const sqlite = require('node:sqlite') as { DatabaseSync: DatabaseSyncCtor };
    this.db = new sqlite.DatabaseSync(path);
    this.init();
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
      .all(limit) as Array<{ payload?: Uint8Array }>;
    return rows
      .reverse()
      .map((row) => row.payload ? deserialize(Buffer.from(row.payload)) as ChronicleEntry : null)
      .filter((entry): entry is ChronicleEntry => entry !== null);
  }

  chatCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM chat_messages').get() as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  addChat(message: ChatMessage): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO chat_messages
         (message_id, channel, speaker_kind, user_id, user_name, villager_id, dm_with_villager_id, at, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
    this.pruneChat();
  }

  addChats(messages: ChatMessage[]): void {
    this.transaction(() => {
      const stmt = this.db.prepare(
        `INSERT OR REPLACE INTO chat_messages
         (message_id, channel, speaker_kind, user_id, user_name, villager_id, dm_with_villager_id, at, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const message of messages) {
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
      for (const message of messages) {
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
      .all(limit) as Array<{ payload?: Uint8Array }>;
    return rows
      .reverse()
      .map((row) => row.payload ? deserialize(Buffer.from(row.payload)) as ChatMessage : null)
      .filter((message): message is ChatMessage => message !== null);
  }

  private init(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
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
  }

  private pruneChronicle(cap = 500): void {
    this.db.prepare('DELETE FROM chronicle WHERE id NOT IN (SELECT id FROM chronicle ORDER BY id DESC LIMIT ?)').run(cap);
  }

  private pruneChat(cap = 500): void {
    this.db.prepare('DELETE FROM chat_messages WHERE id NOT IN (SELECT id FROM chat_messages ORDER BY id DESC LIMIT ?)').run(cap);
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
