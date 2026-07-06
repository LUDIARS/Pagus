import { describe, it, expect } from 'vitest';
import {
  createWorld,
  createVillager,
  toWire,
  fromWire,
  DEFAULT_CONFIG,
  type World,
} from '../src/index.js';

function sampleWorld(): World {
  const a = createVillager({ id: 'a', name: 'ハナ', position: { x: 3, y: 4 }, activity: 'diurnal', traits: { kindness: 0.8 } });
  const b = createVillager({ id: 'b', name: 'ソラ', position: { x: 5, y: 6 }, activity: 'nocturnal', traits: { aggression: 0.7 } });
  const world = createWorld([a, b], DEFAULT_CONFIG, { year: 2026, month: 6 });
  world.term = 12;
  world.reputation.malice = 0.4;
  world.villagers.get('a')!.stress = 3;
  world.villagers.get('b')!.partnerId = 'a';
  return world;
}

describe('world snapshot (toWire ↔ fromWire)', () => {
  it('villagers Map を配列経由で往復しても元の状態に戻る', () => {
    const world = sampleWorld();
    const restored = fromWire(toWire(world));

    expect(restored.villagers).toBeInstanceOf(Map);
    expect(restored.villagers.size).toBe(2);
    expect(restored.villagers.get('a')?.name).toBe('ハナ');
    expect(restored.villagers.get('a')?.stress).toBe(3);
    expect(restored.villagers.get('b')?.partnerId).toBe('a');
    expect(restored.term).toBe(12);
    expect(restored.reputation.malice).toBe(0.4);
    expect(restored.calendar.month).toBe(6);
  });

  it('進行中の事件/裁判も JSON 往復で保たれる', () => {
    const world = sampleWorld();
    world.phase = 'sho';
    world.incident = {
      id: 'inc_1',
      perpetrator: 'a',
      involved: ['b'],
      description: '広場で騒ぎ',
      damage: 6,
      steps: [{ perspective: 'perpetrator', action: '挑発', damageDelta: 6 }],
      resolved: false,
    };

    // JSON.stringify を挟んでも (実ファイル経由を模す) 復元できる。
    const wire = JSON.parse(JSON.stringify(toWire(world)));
    const restored = fromWire(wire);

    expect(restored.phase).toBe('sho');
    expect(restored.incident?.id).toBe('inc_1');
    expect(restored.incident?.damage).toBe(6);
    expect(restored.incident?.steps[0]?.action).toBe('挑発');
  });

  it('scheduledParty and resident side data survive JSON restore', () => {
    const world = sampleWorld();
    world.scheduledParty = {
      dayOfMonth: 12,
      kind: 'harvest',
      title: '収穫祭',
      participantIds: ['a', 'b'],
      fired: false,
      incidentPlanted: false,
    };
    world.relationships.push({ from: 'a', to: 'b', affinity: -40, hates: true, note: 'test' });
    world.userFaith.push({ villagerId: 'a', userId: 'u1', faith: 72, title: '崇拝', note: 'test faith' });
    world.villagerActionLog.push({ date: '6月1日', term: 12, villagerId: 'a', villagerName: '繝上リ', text: 'test action' });

    const wire = JSON.parse(JSON.stringify(toWire(world)));
    const restored = fromWire(wire);

    expect(restored.scheduledParty?.title).toBe('収穫祭');
    expect(restored.scheduledParty?.participantIds).toEqual(['a', 'b']);
    expect(restored.relationships[0]?.hates).toBe(true);
    expect(restored.userFaith[0]?.faith).toBe(72);
    expect(restored.villagerActionLog[0]?.text).toBe('test action');
    expect(restored.residentHistory.length).toBeGreaterThan(0);
  });
});
