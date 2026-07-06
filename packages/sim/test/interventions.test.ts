import { describe, it, expect } from 'vitest';
import {
  createWorld,
  createVillager,
  StubBrain,
  TermMachine,
  DEFAULT_CONFIG,
  DEFAULT_INTERVENTION,
  DEFAULT_ITEMS,
  HECKLED_TAG,
  TESTIFIED_TAG,
  DRUG_TAG,
  heckleIncident,
  testifyInTrial,
  giveGift,
  testimonyWeight,
  stepItemPickups,
  setPlaceState,
  pruneExpiredPlaceStates,
  placeStateOf,
  environmentView,
  evaluateRules,
  defaultBehaviorRules,
  type World,
  type TrialState,
} from '../src/index.js';

// 隣り合う 2 体 (常時活動) の村。野次/証言/贈り物の即効介入 (§v1.4-A) を試す。
function twoAnimalWorld(): World {
  const a = createVillager({ id: 'a', name: 'アオ', position: { x: 12, y: 12 }, activity: 'always', traits: { aggression: 0.6 } });
  const b = createVillager({ id: 'b', name: 'ベル', position: { x: 13, y: 12 }, activity: 'always' });
  return createWorld([a, b], { ...DEFAULT_CONFIG, damageThreshold: 8 }, { year: 2026, month: 6 });
}

/** 進行中の事件 (承) を対象指定扇動で立てる。 */
async function worldWithIncident(): Promise<{ world: World; tm: TermMachine }> {
  const world = twoAnimalWorld();
  const tm = new TermMachine(world, new StubBrain(), { dailyTriggerAfter: 99 });
  tm.inciteTarget('a');
  tm.startDay();
  const r = await tm.kishoTick();
  expect(r.incidentStarted).toBe(true);
  return { world, tm };
}

/** fate 段階の裁判状態を直接組む (証言の純関数テスト用)。 */
function fateTrial(defendant: string): TrialState {
  return {
    incidentId: 'inc_t',
    judge: { kind: 'nekomori' },
    candidates: [defendant],
    stage: 'fate',
    pendingGroups: [],
    foolishVotes: {},
    defendant,
    fateVotes: { kill: 0, spare: 0 },
    votes: [],
    verdict: null,
  };
}

describe('野次 (§v1.4-A heckle)', () => {
  it('agitate は被害を即加算し、当事者に HECKLED_TAG を残す', async () => {
    const { world, tm } = await worldWithIncident();
    const before = world.incident?.damage ?? 0;
    const r = tm.heckle('agitate');
    expect(r).not.toBeNull();
    expect(world.incident?.damage).toBe(before + DEFAULT_INTERVENTION.heckleDamage);
    expect(r?.biasDelta).toBeCloseTo(-DEFAULT_INTERVENTION.heckleBias, 6);
    const perp = world.villagers.get(world.incident?.perpetrator ?? '');
    expect(perp?.eventParams[HECKLED_TAG]).toBe(1);
  });

  it('soothe は被害を増やさず和解バイアスを上げる (biasDelta 正)', async () => {
    const { world, tm } = await worldWithIncident();
    const before = world.incident?.damage ?? 0;
    const r = tm.heckle('soothe');
    expect(r).not.toBeNull();
    expect(world.incident?.damage).toBe(before);
    expect(r?.biasDelta).toBeCloseTo(DEFAULT_INTERVENTION.heckleBias, 6);
  });

  it('事件が進行していなければ null', () => {
    const world = twoAnimalWorld();
    const tm = new TermMachine(world, new StubBrain());
    expect(tm.heckle('agitate')).toBeNull();
  });

  it('heckleIncident は巻き込まれた者にもタグを残す', async () => {
    const { world } = await worldWithIncident();
    const incident = world.incident;
    if (!incident) throw new Error('incident が立っていない');
    heckleIncident(world, incident, 'agitate');
    for (const id of [incident.perpetrator, ...incident.involved]) {
      expect(world.villagers.get(id)?.eventParams[HECKLED_TAG]).toBe(1);
    }
  });
});

describe('証言 (§v1.4-A testify)', () => {
  it('accuse は 1 グループ分の重みで死刑側へ票を上乗せし、被告にタグを残す', () => {
    const world = twoAnimalWorld();
    const trial = fateTrial('a');
    const w = testimonyWeight(world);
    const r = testifyInTrial(world, trial, 'u1', 'accuse', 'あいつが犯人だ');
    expect(r.ok).toBe(true);
    expect(trial.fateVotes.kill).toBe(w);
    expect(trial.testimonies).toHaveLength(1);
    expect(trial.testimonies?.[0]?.text).toBe('あいつが犯人だ');
    expect(trial.votes[0]?.voter).toBe('testimony');
    expect(world.villagers.get('a')?.eventParams[TESTIFIED_TAG]).toBe(1);
  });

  it('defend は教育側へ票を上乗せし、被告にタグを残さない', () => {
    const world = twoAnimalWorld();
    const trial = fateTrial('a');
    const r = testifyInTrial(world, trial, 'u1', 'defend');
    expect(r.ok).toBe(true);
    expect(trial.fateVotes.spare).toBe(testimonyWeight(world));
    expect(world.villagers.get('a')?.eventParams[TESTIFIED_TAG]).toBeUndefined();
  });

  it('同じユーザは 1 裁判 1 回まで', () => {
    const world = twoAnimalWorld();
    const trial = fateTrial('a');
    expect(testifyInTrial(world, trial, 'u1', 'accuse').ok).toBe(true);
    expect(testifyInTrial(world, trial, 'u1', 'defend').ok).toBe(false);
    expect(testifyInTrial(world, trial, 'u2', 'defend').ok).toBe(true);
  });

  it('fate 段階以外では不成立', () => {
    const world = twoAnimalWorld();
    const trial = fateTrial('a');
    trial.stage = 'foolish';
    expect(testifyInTrial(world, trial, 'u1', 'accuse').ok).toBe(false);
  });

  it('TermMachine.testify は裁判が開いていなければ不成立', () => {
    const world = twoAnimalWorld();
    const tm = new TermMachine(world, new StubBrain());
    expect(tm.testify('u1', 'accuse').ok).toBe(false);
  });
});

describe('贈り物 (§v1.4-A gift)', () => {
  it('treat は喜びと所持金を上げる', () => {
    const world = twoAnimalWorld();
    const a = world.villagers.get('a');
    if (!a) throw new Error('a がいない');
    const wealthBefore = a.wealth;
    const joyBefore = a.emotion.axes['joy'] ?? 0;
    const r = giveGift(world, 'a', 'treat');
    expect(r?.villagerName).toBe('アオ');
    expect(a.wealth).toBe(wealthBefore + DEFAULT_INTERVENTION.giftTreatWealth);
    expect(a.emotion.axes['joy']).toBeCloseTo(Math.min(1, joyBefore + DEFAULT_INTERVENTION.giftTreatJoy), 6);
  });

  it('poison は薬物と同じ荒れ方 (怒り+・所持金−・drug タグ)', () => {
    const world = twoAnimalWorld();
    const a = world.villagers.get('a');
    if (!a) throw new Error('a がいない');
    const wealthBefore = a.wealth;
    const r = giveGift(world, 'a', 'poison');
    expect(r?.kind).toBe('poison');
    expect(a.wealth).toBe(Math.max(0, wealthBefore - DEFAULT_ITEMS.drugWealthLoss));
    expect(a.emotion.axes['anger']).toBeCloseTo(DEFAULT_ITEMS.drugAnger, 6);
    expect(a.eventParams[DRUG_TAG]).toBe(1);
  });

  it('不在/退場の対象は null', () => {
    const world = twoAnimalWorld();
    expect(giveGift(world, 'ghost', 'treat')).toBeNull();
    const a = world.villagers.get('a');
    if (a) a.alive = false;
    expect(giveGift(world, 'a', 'treat')).toBeNull();
  });
});

describe('アイテムのセグメント回収 (§v1.4-A stepItemPickups)', () => {
  it('最寄りが 1 歩ずつ取りに歩き、手が届いたら拾う', () => {
    const a = createVillager({ id: 'a', name: 'アオ', position: { x: 0, y: 0 }, activity: 'always' });
    const world = createWorld([a]);
    world.items = [{ id: 'item_1', kind: 'precious', position: { x: 5, y: 5 } }];
    const wealthBefore = a.wealth;

    // 4 歩で (4,4) = 距離 1 → 5 回目で拾う。
    for (let i = 0; i < 4; i += 1) {
      expect(stepItemPickups(world)).toHaveLength(0);
    }
    expect(a.position).toEqual({ x: 4, y: 4 });
    const pickups = stepItemPickups(world);
    expect(pickups).toHaveLength(1);
    expect(pickups[0]?.villagerId).toBe('a');
    expect(world.items).toHaveLength(0);
    expect(a.wealth).toBe(wealthBefore + DEFAULT_ITEMS.preciousWealth);
  });

  it('起きている住民がいなければ動かない (アイテムは残る)', () => {
    // diurnal は segment 0 (夜明け前) は睡眠中 → 誰も取りに行かない。
    const a = createVillager({ id: 'a', name: 'アオ', position: { x: 0, y: 0 }, activity: 'diurnal' });
    const world = createWorld([a], undefined, { year: 2026, month: 6, segment: 0 });
    world.items = [{ id: 'item_1', kind: 'precious', position: { x: 5, y: 5 } }];
    expect(stepItemPickups(world)).toHaveLength(0);
    expect(world.items).toHaveLength(1);
    expect(a.position).toEqual({ x: 0, y: 0 });
  });
});

describe("場所介入 (§v1.4-A' spot)", () => {
  it('defile はその場の住民の怒りを即時に上げ、placeStates に残る', () => {
    const world = twoAnimalWorld(); // (12,12)/(13,12) = 広場
    const r = setPlaceState(world, '広場', 'defile', 2);
    expect(r?.state).toBe('defiled');
    expect(r?.affected).toBe(2);
    expect(world.villagers.get('a')?.emotion.axes['anger']).toBeCloseTo(DEFAULT_INTERVENTION.spotAnger, 6);
    expect(placeStateOf(world, '広場')).toBe('defiled');
    expect(placeStateOf(world, '村はずれ')).toBeNull();
  });

  it('bless は喜びを上げ、同じ場所の既存状態を塗り替える', () => {
    const world = twoAnimalWorld();
    setPlaceState(world, '広場', 'defile', 2);
    const r = setPlaceState(world, '広場', 'bless', 2);
    expect(r?.state).toBe('blessed');
    expect(world.placeStates).toHaveLength(1);
    expect(placeStateOf(world, '広場')).toBe('blessed');
  });

  it('不正な場所は null', () => {
    const world = twoAnimalWorld();
    expect(setPlaceState(world, '温泉', 'defile', 2)).toBeNull();
  });

  it('期限が切れると placeStateOf は null になり、prune で除去される', () => {
    const world = twoAnimalWorld();
    setPlaceState(world, '広場', 'defile', 1); // untilTerm = term+1
    world.term += 1;
    expect(placeStateOf(world, '広場')).toBeNull();
    const removed = pruneExpiredPlaceStates(world);
    expect(removed).toHaveLength(1);
    expect(world.placeStates).toHaveLength(0);
  });

  it('荒らされた場所では behavior-rule (base_defiled_place) で事件化しやすくなる', () => {
    const world = twoAnimalWorld();
    const a = world.villagers.get('a');
    if (!a) throw new Error('a がいない');
    const rules = defaultBehaviorRules();
    const before = evaluateRules(rules, { villager: a, env: environmentView(world, a), category: 'wander' }).triggerWeight;
    setPlaceState(world, '広場', 'defile', 2);
    const after = evaluateRules(rules, { villager: a, env: environmentView(world, a), category: 'wander' }).triggerWeight;
    expect(after).toBeGreaterThan(before);
  });

  it('復元 world に新しい base ルールが無ければ TermMachine が補完する', () => {
    const world = twoAnimalWorld();
    world.behaviorRules = world.behaviorRules.filter((r) => r.id !== 'base_defiled_place');
    new TermMachine(world, new StubBrain());
    expect(world.behaviorRules.some((r) => r.id === 'base_defiled_place')).toBe(true);
    // 冪等: 二重生成しない。
    new TermMachine(world, new StubBrain());
    expect(world.behaviorRules.filter((r) => r.id === 'base_defiled_place')).toHaveLength(1);
  });
});

describe("噂の増幅 (§v1.4-A' fanFlames)", () => {
  it('プレイヤー由来の噂を近傍住民へ複製し REACTION_EXPOSURE を積む', () => {
    const world = twoAnimalWorld();
    const tm = new TermMachine(world, new StubBrain(), { dailyTriggerAfter: 99 });
    tm.inciteTarget('a', 'b'); // a に噂を注入
    const r = tm.fanFlames('a');
    expect(r).not.toBeNull();
    expect(r?.spreadCount).toBe(1); // 近傍は b のみ
    const b = world.villagers.get('b');
    expect(b?.information.some((i) => i.text.includes('噂で聞いた'))).toBe(true);
    expect(b?.eventParams['incidentExposure']).toBe(1);
  });

  it('同じ噂の重複配布はしない', () => {
    const world = twoAnimalWorld();
    const tm = new TermMachine(world, new StubBrain(), { dailyTriggerAfter: 99 });
    tm.inciteTarget('a', 'b');
    expect(tm.fanFlames('a')?.spreadCount).toBe(1);
    expect(tm.fanFlames('a')?.spreadCount).toBe(0); // 2 回目は届かない
  });

  it('噂を持たない対象・不在の対象は null', () => {
    const world = twoAnimalWorld();
    const tm = new TermMachine(world, new StubBrain());
    expect(tm.fanFlames('a')).toBeNull(); // 噂なし
    expect(tm.fanFlames('ghost')).toBeNull();
  });
});
