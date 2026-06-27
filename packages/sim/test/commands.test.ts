import { describe, it, expect } from 'vitest';
import {
  createWorld,
  createVillager,
  StubBrain,
  TermMachine,
  DEFAULT_CONFIG,
  dominantAxis,
  type World,
} from '../src/index.js';

// 隣り合う 2 体 (常時活動) の村。扇動/制裁/応援の対象操作を試す。
function twoAnimalWorld(): World {
  const a = createVillager({ id: 'a', name: 'アオ', position: { x: 12, y: 12 }, activity: 'always', traits: { aggression: 0.6 } });
  const b = createVillager({ id: 'b', name: 'ベル', position: { x: 13, y: 12 }, activity: 'always' });
  return createWorld([a, b], { ...DEFAULT_CONFIG, damageThreshold: 8 }, { year: 2026, month: 6 });
}

describe('プレイヤー操作 (扇動/応援/制裁)', () => {
  it('inciteTarget は対象に偽情報を足し、次の自由行動で対象が事件化する', async () => {
    const w = twoAnimalWorld();
    // triggerAfter を高くして「対象指定の扇動」だけが事件化要因になるようにする。
    const tm = new TermMachine(w, new StubBrain(), { dailyTriggerAfter: 99 });

    const ok = tm.inciteTarget('a', 'b');
    expect(ok).toBe(true);
    const a = w.villagers.get('a');
    expect(a?.information).toHaveLength(1);
    expect(a?.information[0]?.source).toBe('player');
    expect(a?.information[0]?.text).toContain('ベル');

    tm.startDay();
    const r = await tm.kishoTick();
    expect(r.incidentStarted).toBe(true);
    expect(w.phase).toBe('sho');
    expect(w.incident?.perpetrator).toBe('a');
  });

  it('inciteTarget は生存しない対象に false を返す', () => {
    const w = twoAnimalWorld();
    const tm = new TermMachine(w, new StubBrain());
    expect(tm.inciteTarget('missing')).toBe(false);
  });

  it('cheer は対象の dominant 軸を上げる', () => {
    const w = twoAnimalWorld();
    const tm = new TermMachine(w, new StubBrain());
    const a = w.villagers.get('a')!;
    const axis = dominantAxis(a.persona.traits); // aggression
    const before = a.persona.traits[axis];
    const res = tm.cheer('a');
    expect(res).not.toBeNull();
    expect(res?.axis).toBe(axis);
    expect(res?.villagerName).toBe('アオ');
    expect(a.persona.traits[axis]).toBeCloseTo(before + 0.1, 6);
  });

  it('cheer は 0..1 にクランプする', () => {
    const w = twoAnimalWorld();
    const tm = new TermMachine(w, new StubBrain());
    const a = w.villagers.get('a')!;
    a.persona.traits.aggression = 0.95;
    tm.cheer('a');
    expect(a.persona.traits.aggression).toBeLessThanOrEqual(1);
  });

  it('sanction は固定被告の fate 裁判を開き、tenStep→ketsuStep で判決まで進む', async () => {
    const w = twoAnimalWorld();
    const tm = new TermMachine(w, new StubBrain());

    const ok = tm.sanction('a');
    expect(ok).toBe(true);
    expect(w.phase).toBe('ten');
    expect(w.trial?.stage).toBe('fate');
    expect(w.trial?.defendant).toBe('a');
    expect(w.trial?.candidates).toEqual(['a']);
    expect(w.incident?.origin).toBe('sanction');

    for (let i = 0; i < 12 && w.phase === 'ten'; i += 1) await tm.tenStep();
    expect(w.phase).toBe('ketsu');
    expect(w.trial?.verdict).not.toBeNull();

    await tm.ketsuStep();
    expect(w.phase).toBe('reform');
  });

  it('sanction は進行中の事件があると false', () => {
    const w = twoAnimalWorld();
    const tm = new TermMachine(w, new StubBrain());
    expect(tm.sanction('a')).toBe(true); // 1 回目: 裁判が開く
    expect(tm.sanction('b')).toBe(false); // 裁判中なので拒否
  });
});
