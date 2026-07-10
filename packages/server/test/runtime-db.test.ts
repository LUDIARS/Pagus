import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createVillager,
  createWorld,
  DEFAULT_CONFIG,
  type ChatMessage,
  type ChronicleEntry,
  type PlayerActionEntry,
  type VillagerActionEntry,
  type WorldSnapshot,
} from '@pagus/sim';
import { ChatStore } from '../src/chat-store.js';
import { Chronicle } from '../src/chronicle.js';
import { InactiveResidentStore } from '../src/inactive-resident-store.js';
import { RuntimeDb } from '../src/runtime-db.js';
import { TermUserSet } from '../src/term-user-set.js';
import { WorldStore } from '../src/world-store.js';

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
    expect(db.recentChat(10)).toEqual([{ ...chat, userName: null }]);
  });

  it('stores activity and session logs without requiring an in-memory history', () => {
    const db = createDb();
    const playerAction: PlayerActionEntry = {
      date: '1月1日',
      userId: 'user-1',
      type: 'cheer',
      target: 'resident-a',
    };
    const villagerAction: VillagerActionEntry = {
      date: '1月1日',
      term: 3,
      villagerId: 'resident-a',
      villagerName: 'A',
      text: 'walked',
    };

    db.addPlayerAction(playerAction);
    db.addVillagerAction(villagerAction);
    db.addSessionLog({ t: 'log', ts: '2026-07-10T00:00:00.000Z', text: 'tick' });
    db.addSeasonRecord({ number: 1, winner: 'guide' });

    expect(db.recentPlayerActions(10)).toEqual([playerAction]);
    expect(db.recentVillagerActions(10)).toEqual([villagerAction]);
    expect(db.recentSessionLogs(10)).toEqual([
      { t: 'log', ts: '2026-07-10T00:00:00.000Z', text: 'tick' },
    ]);
    expect(db.seasonRecordCount()).toBe(1);
  });

  it('reads chronicle and chat updates directly from the database', () => {
    const db = createDb();
    const dir = dirs.at(-1);
    if (!dir) throw new Error('temporary directory was not created');
    const chronicle = new Chronicle(db, join(dir, 'missing-chronicle.json'));
    const chat = new ChatStore(db, join(dir, 'missing-chat.json'));

    chronicle.add('1月1日', 'first');
    db.addChronicle({ date: '1月2日', text: 'second', eventId: 'event-2' });
    expect(chronicle.recent()).toEqual([
      { date: '1月1日', text: 'first' },
      { date: '1月2日', text: 'second', eventId: 'event-2' },
    ]);
    expect(chronicle.hasEvent('event-2')).toBe(true);

    db.addChat({
      id: 'chat-direct',
      channel: 'human',
      speakerKind: 'human',
      userId: 'user-1',
      userName: 'before',
      text: 'hello',
      at: 10,
    });
    expect(chat.updateUserName('user-1', 'after')[0]?.userName).toBe('after');
  });

  it('archives inactive resident state and restores it on revival', () => {
    const db = createDb();
    const active = createVillager({ id: 'active', name: 'Active', position: { x: 0, y: 0 } });
    const inactive = createVillager({ id: 'inactive', name: 'Inactive', position: { x: 1, y: 0 } });
    inactive.alive = false;
    const world = createWorld([active, inactive], DEFAULT_CONFIG, { year: 2026, month: 7 });
    world.relationships = [
      { from: 'active', to: 'inactive', affinity: 20, hates: false },
      { from: 'inactive', to: 'active', affinity: 10, hates: false },
    ];
    world.userFaith = [
      { villagerId: 'inactive', userId: 'user-1', faith: 50, title: '信仰', note: 'test' },
    ];
    const store = new InactiveResidentStore(db);

    expect(store.archiveInactive(world)).toEqual({ relationships: 2, userFaith: 1 });
    expect(world.relationships).toEqual([]);
    expect(world.userFaith).toEqual([]);

    inactive.alive = true;
    expect(store.restoreForRevivedResident(world, inactive.id)).toEqual({ relationships: 2, userFaith: 1 });
    expect(world.relationships).toHaveLength(2);
    expect(world.userFaith).toHaveLength(1);
  });

  it('releases term-scoped user IDs when the game term changes', () => {
    const users = new TermUserSet();
    users.add(10, 'user-1');
    expect(users.has(10, 'user-1')).toBe(true);
    expect(users.has(11, 'user-1')).toBe(false);
  });

  it('keeps villager action history outside the world snapshot blob', () => {
    const db = createDb();
    const resident = createVillager({ id: 'resident-a', name: 'A', position: { x: 0, y: 0 } });
    const world = createWorld([resident], DEFAULT_CONFIG, { year: 2026, month: 7 });
    const action: VillagerActionEntry = {
      date: '1月1日',
      term: 1,
      villagerId: resident.id,
      villagerName: resident.name,
      text: 'worked',
    };
    world.villagerActionLog.push(action);
    db.addVillagerAction(action);
    const store = new WorldStore({ db, intervalMs: 0 });

    store.save(world, 0, 0, 0);

    expect(db.getState<WorldSnapshot>('world')?.world.villagerActionLog).toEqual([]);
    expect(store.load()?.world.villagerActionLog).toEqual([action]);
  });
});
