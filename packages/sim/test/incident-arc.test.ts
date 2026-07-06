import { describe, it, expect } from 'vitest';
import {
  createWorld,
  createVillager,
  StubBrain,
  StubWorldBrain,
  TermMachine,
  DEFAULT_CONFIG,
  addThread,
  decayThreads,
  heatThreadsInvolving,
  resolveThread,
  pickArcTheme,
  validateArcs,
  DEFAULT_ARCS,
  DEFAULT_PLOT,
  playMinorIncident,
  composeWitnesses,
  maybeReveal,
  type World,
  type TrialState,
  type Incident,
  type PlotThread,
} from '../src/index.js';

function seqRng(values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)] ?? 0;
}

function smallWorld(): World {
  const a = createVillager({ id: 'a', name: 'アオ', position: { x: 12, y: 12 }, activity: 'always', traits: { aggression: 0.6 } });
  const b = createVillager({ id: 'b', name: 'ベル', position: { x: 13, y: 12 }, activity: 'always' });
  const c = createVillager({ id: 'c', name: 'クロ', position: { x: 14, y: 12 }, activity: 'always', traits: { kindness: 0.8 } });
  return createWorld([a, b, c], { ...DEFAULT_CONFIG, damageThreshold: 8 }, { year: 2026, month: 6 });
}

function thread(id: string, kind: PlotThread['kind'], heat: number, actors: PlotThread['actors'] = []): PlotThread {
  return { id, kind, actors, heat, bornTerm: 0, note: `${kind} の火種` };
}

function incidentOf(perp: string, involved: string[], framed?: string): Incident {
  const inc: Incident = {
    id: 'inc_t',
    perpetrator: perp,
    involved,
    description: 'テスト事件',
    damage: 5,
    steps: [],
    resolved: true,
    origin: 'organic',
  };
  if (framed) inc.framedTargetId = framed;
  return inc;
}

function decidedTrial(defendant: string, verdict: 'death' | 'spared'): TrialState {
  return {
    incidentId: 'inc_t',
    judge: { kind: 'nekomori' },
    candidates: [defendant],
    stage: 'decided',
    pendingGroups: [],
    foolishVotes: {},
    defendant,
    fateVotes: { kill: verdict === 'death' ? 3 : 0, spare: verdict === 'spared' ? 3 : 0 },
    votes: [],
    verdict,
  };
}

describe('火種 (§v1.4-B PlotThread)', () => {
  it('addThread は上限超過時に heat 最小を捨てる', () => {
    const world = smallWorld();
    const cfg = { ...DEFAULT_PLOT, threadsMax: 2 };
    addThread(world, { kind: 'rumor', actors: [], heat: 0.9, note: '熱い' }, 't1', cfg);
    addThread(world, { kind: 'rumor', actors: [], heat: 0.1, note: 'ぬるい' }, 't2', cfg);
    addThread(world, { kind: 'rumor', actors: [], heat: 0.5, note: '中くらい' }, 't3', cfg);
    expect(world.plotThreads.map((t) => t.id).sort()).toEqual(['t1', 't3']);
  });

  it('decayThreads は heat を減らし、冷え切った火種を除去して返す', () => {
    const world = smallWorld();
    world.plotThreads = [thread('t1', 'rumor', 0.5), thread('t2', 'rumor', 0.04)];
    const burnt = decayThreads(world);
    expect(burnt.map((t) => t.id)).toEqual(['t2']);
    expect(world.plotThreads[0]?.heat).toBeCloseTo(0.45, 6);
  });

  it('heatThreadsInvolving は関係者が絡む火種だけ加熱する', () => {
    const world = smallWorld();
    world.plotThreads = [
      thread('t1', 'grudge', 0.3, [{ id: 'a', name: 'アオ' }]),
      thread('t2', 'grudge', 0.3, [{ id: 'c', name: 'クロ' }]),
    ];
    expect(heatThreadsInvolving(world, ['a', 'b'])).toBe(1);
    expect(world.plotThreads[0]?.heat).toBeCloseTo(0.5, 6);
    expect(world.plotThreads[1]?.heat).toBeCloseTo(0.3, 6);
  });

  it('resolveThread は id 指定で消す', () => {
    const world = smallWorld();
    world.plotThreads = [thread('t1', 'grudge', 0.5)];
    expect(resolveThread(world, 't1')).toBe(true);
    expect(resolveThread(world, 't1')).toBe(false);
    expect(world.plotThreads).toHaveLength(0);
  });
});

describe('派生表 (§v1.4-B pickArcTheme)', () => {
  it('heat が閾値を超えた火種のテーマを重み付きで選ぶ', () => {
    const world = smallWorld();
    world.plotThreads = [thread('t1', 'grudge', 0.5)];
    const pick = pickArcTheme(world, DEFAULT_ARCS, () => 0); // 先頭候補 = 最初の重みへ
    expect(pick?.thread.id).toBe('t1');
    expect(pick?.themeSeed).toBe('遺恨の復讐');
  });

  it('heat 不足・種別不一致では null', () => {
    const world = smallWorld();
    world.plotThreads = [thread('t1', 'grudge', 0.2)]; // 閾値 0.35 未満
    expect(pickArcTheme(world, DEFAULT_ARCS, () => 0)).toBeNull();
  });

  it('reputationAbove 条件を満たさない行は使わない', () => {
    const world = smallWorld();
    world.reputation.order = 0.1; // ruleViolation 行は order > 0.4 が必要
    world.plotThreads = [thread('t1', 'ruleViolation', 0.6)];
    expect(pickArcTheme(world, DEFAULT_ARCS, () => 0)).toBeNull();
  });

  it('validateArcs は不正な JSON を弾く', () => {
    expect(() => validateArcs('not-array')).toThrow();
    expect(() => validateArcs([{ when: { threadKind: 'nope', heatAbove: 0.1 }, themes: [] }])).toThrow();
    expect(validateArcs([{ when: { threadKind: 'grudge', heatAbove: 0.3 }, themes: [{ seed: 'x', weight: 1 }] }])).toHaveLength(1);
  });
});

describe('小騒動 (§v1.4-B minor incident)', () => {
  it('寸劇 3 行を返し、双方の怒りが少し上がる', () => {
    const world = smallWorld();
    const a = world.villagers.get('a');
    const b = world.villagers.get('b');
    if (!a || !b) throw new Error('missing');
    const r = playMinorIncident(a, b, seqRng([0.9, 0, 0, 0])); // residue 判定 0.9 → 遺恨残らず
    expect(r.residue).toBe(false);
    expect(r.lines).toHaveLength(3);
    expect(r.lines[0]).toContain('小騒動');
    expect(a.emotion.axes['anger']).toBeCloseTo(0.08, 6);
  });

  it('TermMachine: 小騒動に流れると事件化せず、遺恨が残れば rumor 火種が立つ', async () => {
    const world = smallWorld();
    // 自然発生トリガ (dailyTriggerAfter=1) を minorChance=1 で必ず小騒動へ流す。
    // residue 判定 0 (< 0.5) で必ず遺恨が残る。扇動由来は小騒動に流れない (別テスト)。
    const tm = new TermMachine(world, new StubBrain(), {
      dailyTriggerAfter: 1,
      minorConfig: { minorChance: 1, minorResidueChance: 0.5 },
      rng: () => 0,
    });
    tm.startDay();
    const r = await tm.kishoTick();
    expect(r.incidentStarted).toBe(false);
    expect(world.incident).toBeNull();
    expect(r.actions.some((x) => x.action.includes('小騒動'))).toBe(true);
    expect(world.plotThreads.some((t) => t.kind === 'rumor')).toBe(true);
  });
});

describe('裁判バリエーション (§v1.4-B witness / reveal)', () => {
  it('composeWitnesses は傍観者を立て、擦り付けがあれば framed へ票を乗せる', () => {
    const world = smallWorld();
    const incident = incidentOf('a', ['b'], 'c'); // 真犯人 a が c に擦り付け
    const trial: TrialState = {
      incidentId: incident.id,
      judge: { kind: 'nekomori' },
      candidates: ['a', 'b', 'c'],
      stage: 'foolish',
      pendingGroups: [],
      foolishVotes: {},
      defendant: null,
      fateVotes: { kill: 0, spare: 0 },
      votes: [],
      verdict: null,
    };
    const witnesses = composeWitnesses(world, incident, trial, () => 0, { witnessMax: 1, witnessWeight: 2, revealChance: 0 });
    expect(witnesses).toHaveLength(1);
    expect(witnesses[0]?.accusedId).toBe('c');
    expect(trial.foolishVotes['c']).toBe(2);
    expect(trial.votes[0]?.voter).toBe('witness');
  });

  it('maybeReveal は冤罪被告を真犯人へ差し替え、fate 票をリセットする', () => {
    const world = smallWorld();
    const incident = incidentOf('a', ['b'], 'c');
    const trial = decidedTrial('c', 'death');
    trial.stage = 'fate';
    trial.verdict = null;
    trial.fateVotes = { kill: 5, spare: 1 };
    const r = maybeReveal(world, incident, trial, () => 0, { witnessMax: 0, witnessWeight: 0, revealChance: 0.5 });
    expect(r?.toId).toBe('a');
    expect(trial.defendant).toBe('a');
    expect(trial.fateVotes).toEqual({ kill: 0, spare: 0 });
    expect(incident.framedTargetId).toBeNull();
    // 二重発覚しない。
    expect(maybeReveal(world, incident, trial, () => 0, { witnessMax: 0, witnessWeight: 0, revealChance: 1 })).toBeNull();
  });
});

describe('判決由来の火種 (§v1.4-B spawnVerdictThreads)', () => {
  async function runKetsu(world: World, incident: Incident, trial: TrialState): Promise<void> {
    world.incident = incident;
    world.trial = trial;
    world.phase = 'ketsu';
    const tm = new TermMachine(world, new StubBrain());
    await tm.ketsuStep();
  }

  it('冤罪死 (framed のまま処刑 + 真犯人生存) → 遺恨 + 未解決', async () => {
    const world = smallWorld();
    await runKetsu(world, incidentOf('a', ['b'], 'c'), decidedTrial('c', 'death'));
    expect(world.plotThreads.some((t) => t.kind === 'grudge' && t.note.includes('冤罪'))).toBe(true);
    expect(world.plotThreads.some((t) => t.kind === 'unresolved')).toBe(true);
  });

  it('教育 (spared) → 更生の火種、有罪証言つきなら偽証の遺恨も', async () => {
    const world = smallWorld();
    const trial = decidedTrial('a', 'spared');
    trial.testimonies = [{ userId: 'u1', stance: 'accuse', weight: 2 }];
    await runKetsu(world, incidentOf('a', ['b']), trial);
    expect(world.plotThreads.some((t) => t.kind === 'redemption')).toBe(true);
    expect(world.plotThreads.some((t) => t.kind === 'grudge' && t.note.includes('偽証'))).toBe(true);
  });

  it('アーク由来の事件は決着で火種を回収する', async () => {
    const world = smallWorld();
    world.plotThreads = [thread('thread_9', 'grudge', 0.6)];
    world.scheduledIncident = { dayOfMonth: 5, themeSeed: '遺恨の復讐', designed: true, fired: true, design: null, arcThreadId: 'thread_9' };
    const inc = incidentOf('a', ['b']);
    inc.origin = 'designed';
    await runKetsu(world, inc, decidedTrial('a', 'spared'));
    expect(world.plotThreads.some((t) => t.id === 'thread_9')).toBe(false);
    expect(world.scheduledIncident?.arcThreadId).toBeUndefined();
  });
});

describe('月初スケジューラのアーク統合 (§v1.4-B)', () => {
  it('火種があれば派生表のテーマが採用され、arcThreadId が残る', async () => {
    const world = smallWorld();
    world.plotThreads = [thread('thread_1', 'grudge', 0.6, [{ id: 'a', name: 'アオ' }])];
    const tm = new TermMachine(world, new StubBrain(), { worldBrain: new StubWorldBrain(), rng: () => 0 });
    const m = await tm.scheduleMonthlyIncident();
    expect(m?.themeSeed).toBe('遺恨の復讐'); // stub は arcHint を採用する
    expect(m?.arcNote).toContain('火種');
    expect(world.scheduledIncident?.arcThreadId).toBe('thread_1');
  });

  it('火種が無ければ従来どおり自由テーマ', async () => {
    const world = smallWorld();
    const tm = new TermMachine(world, new StubBrain(), { worldBrain: new StubWorldBrain() });
    const m = await tm.scheduleMonthlyIncident();
    expect(m?.themeSeed).toBe('いさかい');
    expect(world.scheduledIncident?.arcThreadId).toBeUndefined();
  });
});

describe('日末の減衰 (§v1.4-B advanceDay)', () => {
  it('advanceDay は火種を減衰させ、消えた火種を返す', () => {
    const world = smallWorld();
    world.plotThreads = [thread('t1', 'rumor', 0.04)];
    world.phase = 'advance';
    const tm = new TermMachine(world, new StubBrain());
    const r = tm.advanceDay();
    expect(r.burntThreads.map((t) => t.id)).toEqual(['t1']);
    expect(world.plotThreads).toHaveLength(0);
  });
});
