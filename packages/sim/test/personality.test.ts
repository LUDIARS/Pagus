import { describe, it, expect } from 'vitest';
import {
  makePersonality,
  dominantAxis,
  groupByDominant,
  virtueFromPersonality,
  makeVirtueVector,
  VIRTUE_OF_AXIS,
  createVillager,
} from '../src/index.js';

describe('性格 (気質6軸) と徳目 (徳目6軸)', () => {
  it('makePersonality は欠けた軸を 0 で埋める', () => {
    const p = makePersonality({ aggression: 0.8 });
    expect(p.aggression).toBe(0.8);
    expect(p.kindness).toBe(0);
    expect(Object.keys(p)).toHaveLength(6);
  });

  it('dominantAxis は最大値の軸を返す', () => {
    expect(dominantAxis(makePersonality({ kindness: 0.2, ambition: 0.9 }))).toBe('ambition');
  });

  it('groupByDominant は dominant 軸でグループ化する', () => {
    const a = createVillager({ id: 'a', name: 'A', position: { x: 0, y: 0 }, traits: { aggression: 0.9 } });
    const b = createVillager({ id: 'b', name: 'B', position: { x: 1, y: 0 }, traits: { aggression: 0.7 } });
    const c = createVillager({ id: 'c', name: 'C', position: { x: 2, y: 0 }, traits: { kindness: 0.8 } });
    const groups = groupByDominant([a, b, c], (v) => v.persona.traits);
    expect(groups.get('aggression')).toHaveLength(2);
    expect(groups.get('kindness')).toHaveLength(1);
  });

  it('virtueFromPersonality は 1:1 対応で徳目へ写す', () => {
    const v = virtueFromPersonality(makePersonality({ aggression: 0.5, kindness: 0.3 }));
    expect(v[VIRTUE_OF_AXIS.aggression]).toBe(0.5); // malice
    expect(v.malice).toBe(0.5);
    expect(v.benevolence).toBe(0.3);
  });

  it('makeVirtueVector は徳目6軸を 0 で埋める', () => {
    expect(Object.keys(makeVirtueVector())).toHaveLength(6);
  });
});
