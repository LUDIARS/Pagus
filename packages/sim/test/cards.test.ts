import { describe, it, expect } from 'vitest';
import {
  createWorld,
  createVillager,
  StubBrain,
  TermMachine,
  DEFAULT_CONFIG,
  makeDisasterRule,
  aliveVillagers,
  awakeVillagers,
  REACTION_EXPOSURE,
  type World,
} from '../src/index.js';

function world(): World {
  const a = createVillager({ id: 'a', name: 'アオ', position: { x: 12, y: 12 }, activity: 'always', traits: { aggression: 0.6, kindness: 0.1 } });
  const b = createVillager({ id: 'b', name: 'ベル', position: { x: 13, y: 12 }, activity: 'always', traits: { curiosity: 0.5 } });
  return createWorld([a, b], { ...DEFAULT_CONFIG, damageThreshold: 8 }, { year: 2026, month: 6 });
}

describe('天災ルール (§v1.3-A ⑯ makeDisasterRule)', () => {
  it('drought→anger+0.15 / storm→triggerWeight+2 / plague→joy-0.15、source=card で TTL を持つ', () => {
    const drought = makeDisasterRule('drought', 5, 'd1');
    expect(drought.source).toBe('card');
    expect(drought.expiresAtTerm).toBe(5);
    expect(drought.when).toEqual([]); // actionCategory 不問 (常時 match)
    expect(drought.then).toContainEqual({ kind: 'emotionDelta', emotionAxis: 'anger', delta: 0.15 });

    expect(makeDisasterRule('storm', 5, 'd2').then).toContainEqual({ kind: 'triggerWeight', delta: 2 });
    expect(makeDisasterRule('plague', 5, 'd3').then).toContainEqual({ kind: 'emotionDelta', emotionAxis: 'joy', delta: -0.15 });
  });
});

describe('BehaviorRule TTL (§v1.3 pruneExpiredRules)', () => {
  it('expiresAtTerm <= world.term の一時ルールだけ除去し base は残す', () => {
    const w = world();
    const baseCount = w.behaviorRules.length; // 4 (base, expires なし)
    w.term = 10;
    const tm = new TermMachine(w, new StubBrain());
    tm.addCardRule(makeDisasterRule('drought', 10, 'expired')); // <= term → 除去対象
    tm.addCardRule(makeDisasterRule('storm', 13, 'alive')); // > term → 残る
    expect(w.behaviorRules.length).toBe(baseCount + 2);

    const removed = tm.pruneExpiredRules();
    expect(removed.map((r) => r.id)).toEqual(['expired']);
    expect(w.behaviorRules.length).toBe(baseCount + 1);
    expect(w.behaviorRules.filter((r) => r.source === 'base').length).toBe(baseCount);
    expect(w.behaviorRules.some((r) => r.id === 'alive')).toBe(true);
  });
});

describe('一時退避 (§v1.3-A ⑰ spiritAway / hidden フィルタ)', () => {
  it('spiritAway は hiddenUntilTerm を設定し alive/awake から除外する', () => {
    const w = world();
    w.term = 4;
    const tm = new TermMachine(w, new StubBrain());
    expect(tm.spiritAway('a', 2)).toBe(true);
    expect(w.villagers.get('a')?.hiddenUntilTerm).toBe(6); // term(4)+days(2)
    expect(aliveVillagers(w).map((v) => v.id)).toEqual(['b']);
    expect(awakeVillagers(w).map((v) => v.id)).toEqual(['b']);
  });

  it('spiritAway は生存しない対象に false', () => {
    const w = world();
    const tm = new TermMachine(w, new StubBrain());
    expect(tm.spiritAway('missing', 2)).toBe(false);
  });

  it('進行中裁判の被告を神隠しすると裁判が中断され起へ戻る (裁判逃れ)', () => {
    const w = world();
    const tm = new TermMachine(w, new StubBrain());
    expect(tm.sanction('a')).toBe(true);
    expect(w.trial?.defendant).toBe('a');
    expect(tm.spiritAway('a', 2)).toBe(true);
    expect(w.incident).toBeNull();
    expect(w.trial).toBeNull();
    expect(w.phase).toBe('kisho');
  });

  it('advanceDay で期限切れ (hiddenUntilTerm <= 新ターム) を復帰させる', () => {
    const w = world();
    w.term = 4;
    const tm = new TermMachine(w, new StubBrain());
    tm.spiritAway('a', 1); // hiddenUntilTerm = 5
    w.phase = 'advance';
    tm.advanceDay(); // term → 5, 5 <= 5 で復帰
    expect(w.villagers.get('a')?.hiddenUntilTerm).toBeUndefined();
    expect(aliveVillagers(w).map((v) => v.id).sort()).toEqual(['a', 'b']);
  });
});

describe('入れ替え (§v1.3-A ⑱ swapVillagers)', () => {
  it('2 体の traits と appearance を交換する', () => {
    const w = world();
    const tm = new TermMachine(w, new StubBrain());
    const a = w.villagers.get('a')!;
    const b = w.villagers.get('b')!;
    a.appearance = { body: 'cat', descriptors: ['青'] };
    b.appearance = { body: 'owl', descriptors: ['白'] };
    const aAgg = a.persona.traits.aggression;
    const bCur = b.persona.traits.curiosity;

    expect(tm.swapVillagers('a', 'b')).toBe(true);
    expect(w.villagers.get('a')?.persona.traits.curiosity).toBe(bCur);
    expect(w.villagers.get('b')?.persona.traits.aggression).toBe(aAgg);
    expect(w.villagers.get('a')?.appearance.body).toBe('owl');
    expect(w.villagers.get('b')?.appearance.body).toBe('cat');
  });

  it('同一/不在の対象は false', () => {
    const w = world();
    const tm = new TermMachine(w, new StubBrain());
    expect(tm.swapVillagers('a', 'a')).toBe(false);
    expect(tm.swapVillagers('a', 'missing')).toBe(false);
  });
});

describe('覚醒 (§v1.3-A ⑲ awaken)', () => {
  it('最小気質軸を 0.9 へ引き上げ、引き上げた軸を返す', () => {
    const w = world();
    const tm = new TermMachine(w, new StubBrain());
    const a = w.villagers.get('a')!;
    // kindness=0.1 が最小 (他は 0 や 0.6)。実際は 0 の軸が最小なので最小軸を計算で確認。
    a.persona.traits = { kindness: 0.1, aggression: 0.6, sociability: 0.2, curiosity: 0.3, discipline: 0.4, ambition: 0.5 };
    const res = tm.awaken('a');
    expect(res?.axis).toBe('kindness'); // 0.1 が最小
    expect(a.persona.traits.kindness).toBe(0.9);
  });

  it('生存しない対象は null', () => {
    const w = world();
    const tm = new TermMachine(w, new StubBrain());
    expect(tm.awaken('missing')).toBeNull();
  });
});

describe('復活 (§v1.3-B ⑤ revive 闇市)', () => {
  it('退場済み (alive=false) のどうぶつを 1 体 alive へ戻す', () => {
    const w = world();
    const tm = new TermMachine(w, new StubBrain());
    const a = w.villagers.get('a')!;
    a.alive = false;
    expect(aliveVillagers(w).map((v) => v.id)).toEqual(['b']);
    expect(tm.revive('a')).toBe(true);
    expect(a.alive).toBe(true);
    expect(aliveVillagers(w).map((v) => v.id).sort()).toEqual(['a', 'b']);
  });

  it('生存中 / 不在の対象は false', () => {
    const w = world();
    const tm = new TermMachine(w, new StubBrain());
    expect(tm.revive('a')).toBe(false); // 既に生存
    expect(tm.revive('missing')).toBe(false); // 不在
  });
});

describe('偽予言 (§v1.3-A ⑳ falseProphecy)', () => {
  it('生存住民全員に偽 InfoItem を撒き REACTION_EXPOSURE を底上げし、注入数を返す', () => {
    const w = world();
    const tm = new TermMachine(w, new StubBrain());
    const n = tm.falseProphecy('村が滅ぶ');
    expect(n).toBe(2);
    for (const id of ['a', 'b']) {
      const v = w.villagers.get(id)!;
      expect(v.information.some((i) => i.text === '村が滅ぶ' && i.source === 'player')).toBe(true);
      expect(v.eventParams[REACTION_EXPOSURE]).toBe(1);
    }
  });

  it('退避中 (hidden) の住民には撒かない', () => {
    const w = world();
    const tm = new TermMachine(w, new StubBrain());
    tm.spiritAway('a', 2);
    const n = tm.falseProphecy();
    expect(n).toBe(1); // b のみ
    expect(w.villagers.get('a')?.information.length).toBe(0);
  });
});
