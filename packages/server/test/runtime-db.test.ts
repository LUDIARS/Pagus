import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatMessage, ChronicleEntry } from '@pagus/sim';
import { RuntimeDb } from '../src/runtime-db.js';

describe('RuntimeDb', () => {
  const dirs: string[] = [];
  const dbs: RuntimeDb[] = [];

  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function createDb(): RuntimeDb {
    const dir = mkdtempSync(join(tmpdir(), 'pagus-runtime-db-'));
    dirs.push(dir);
    const db = new RuntimeDb(join(dir, 'runtime.sqlite'));
    dbs.push(db);
    return db;
  }

  it('stores game state, event chronicle entries, and chat messages', () => {
    const db = createDb();
    db.setState('world', { term: 42, label: 'village' });
    expect(db.getState<{ term: number; label: string }>('world')).toEqual({ term: 42, label: 'village' });

    const event: ChronicleEntry = {
      date: '1月1日',
      text: 'イベントが始まった',
      kind: 'event',
      eventId: 'event-1',
      title: '公開裁判',
      replay: ['司会役: 猫守が現れた'],
      participants: ['人間:player', 'LLM BOT A'],
    };
    db.addChronicle(event);
    expect(db.recentChronicle(10)).toEqual([event]);

    const chat: ChatMessage = {
      id: 'chat-1',
      channel: 'god',
      speakerKind: 'human',
      userId: 'user-1',
      userName: 'player',
      text: '聞こえるか',
      at: 100,
      keywords: ['聞こえる'],
    };
    db.addChat(chat);
    expect(db.recentChat(10)).toEqual([chat]);
  });
});
