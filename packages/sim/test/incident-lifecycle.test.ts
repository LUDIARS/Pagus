import { describe, it, expect } from 'vitest';
import {
  createWorld,
  createVillager,
  TermMachine,
  StubBrain,
  StubWorldBrain,
  DEFAULT_CONFIG,
  type World,
  type MonthlyScheduleContext,
  type MonthlySchedule,
} from '../src/index.js';

// 既存住民 2 体の村 (6月 = 30日)。事件用キャラはここに追加される。
function baseWorld(): World {
  const a = createVillager({ id: 'a', name: 'アオ', position: { x: 12, y: 12 }, species: '猫', activity: 'always', traits: { kindness: 0.8 } });
  const b = createVillager({ id: 'b', name: 'ベル', position: { x: 13, y: 12 }, species: '兎', activity: 'always', traits: { kindness: 0.6 } });
  return createWorld([a, b], { ...DEFAULT_CONFIG, damageThreshold: 8 }, { year: 2026, month: 6 });
}

function machine(world: World): TermMachine {
  return new TermMachine(world, new StubBrain({ damagePerStep: 4 }), { worldBrain: new StubWorldBrain() });
}

describe('事件ライフサイクル (§12.3)', () => {
  it('scheduleMonthlyIncident で scheduledIncident が設定され dayOfMonth がクランプされる', async () => {
    const world = baseWorld();
    const tm = machine(world);
    const m = await tm.scheduleMonthlyIncident();
    expect(m).not.toBeNull();
    // StubWorldBrain は min(15, daysInMonth) = 15 を返す。
    expect(world.scheduledIncident).not.toBeNull();
    expect(world.scheduledIncident?.dayOfMonth).toBe(15);
    expect(world.scheduledIncident?.themeSeed).toBe('人狼風の密告劇');
    expect(world.scheduledIncident?.designed).toBe(false);
    expect(world.scheduledIncident?.fired).toBe(false);
    expect(world.scheduledIncident?.design).toBeNull();
  });

  it('LLM が範囲外の日を返しても [1, daysInMonth] にクランプされる', async () => {
    // dayOfMonth=99 を返す世界脳でクランプを検証する。
    class BigDayBrain extends StubWorldBrain {
      override async scheduleMonthlyIncident(_ctx: MonthlyScheduleContext): Promise<MonthlySchedule> {
        return { dayOfMonth: 99, themeSeed: 'はみだし' };
      }
    }
    const world = baseWorld(); // 6月 = 30日
    const tm = new TermMachine(world, new StubBrain(), { worldBrain: new BigDayBrain() });
    await tm.scheduleMonthlyIncident();
    expect(world.scheduledIncident?.dayOfMonth).toBe(30);
  });

  it('worldBrain が無ければ null を返し scheduledIncident を設定しない', async () => {
    const world = baseWorld();
    const tm = new TermMachine(world, new StubBrain());
    expect(await tm.scheduleMonthlyIncident()).toBeNull();
    expect(world.scheduledIncident).toBeNull();
  });

  it('designScheduledIncident で事件用キャラ (origin=incident) が spawn され designed=true・加害者が解決される', async () => {
    const world = baseWorld();
    const tm = machine(world);
    await tm.scheduleMonthlyIncident();

    const result = await tm.designScheduledIncident();
    expect(result).not.toBeNull();
    const { design, spawned } = result!;

    // 事件用キャラが村に投入される。
    expect(spawned).toHaveLength(1);
    const culprit = spawned[0]!;
    expect(culprit.origin).toBe('incident');
    expect(culprit.id).toBe('incident_1');
    expect(world.villagers.get('incident_1')).toBe(culprit);
    expect(tm.getIncidentCount()).toBe(1);

    // 加害者が解決される (Stub は perpetratorId=null + 新規キャラ perpetrator:true)。
    expect(design.perpetratorId).toBe('incident_1');
    // 既存住民が巻き込まれ、加害者キャラは involved に含まれない。
    expect(design.involvedIds).toContain('a');
    expect(design.involvedIds).not.toContain('incident_1');

    // scheduledIncident に確定デザインが格納され designed=true。
    expect(world.scheduledIncident?.designed).toBe(true);
    expect(world.scheduledIncident?.design?.perpetratorId).toBe('incident_1');
  });

  it('designScheduledIncident は未スケジュール/デザイン済みなら null', async () => {
    const world = baseWorld();
    const tm = machine(world);
    expect(await tm.designScheduledIncident()).toBeNull(); // 未スケジュール
    await tm.scheduleMonthlyIncident();
    await tm.designScheduledIncident();
    expect(await tm.designScheduledIncident()).toBeNull(); // 既にデザイン済み
  });

  it('fireScheduledIncident が scheduled 日に発火し phase=sho・incident.origin=designed になる (違う日は発火しない)', async () => {
    const world = baseWorld();
    const tm = machine(world);
    await tm.scheduleMonthlyIncident();
    await tm.designScheduledIncident();
    const day = world.scheduledIncident!.dayOfMonth;

    world.phase = 'kisho';
    // 違う日は発火しない。
    world.calendar.dayOfMonth = day - 1;
    expect(tm.fireScheduledIncident()).toBe(false);
    expect(world.phase).toBe('kisho');
    expect(world.incident).toBeNull();

    // 当日に発火する。
    world.calendar.dayOfMonth = day;
    expect(tm.fireScheduledIncident()).toBe(true);
    expect(world.phase).toBe('sho');
    expect(world.incident?.origin).toBe('designed');
    expect(world.incident?.perpetrator).toBe('incident_1');
    expect(world.scheduledIncident?.fired).toBe(true);

    // 二重発火しない (進行中の事件がある + fired)。
    expect(tm.fireScheduledIncident()).toBe(false);
  });

  it('連続犯: scapegoat=true で framedTarget が被告に選ばれ、真犯人 (事件用キャラ) は alive のまま残る', async () => {
    // 無実の既存住民 inno と、攻撃的な事件用キャラ culprit を据える。
    const inno = createVillager({ id: 'inno', name: 'イノ', position: { x: 12, y: 12 }, activity: 'always', traits: { kindness: 0.9 } });
    const culprit = createVillager({ id: 'culprit1', name: '真犯人', position: { x: 13, y: 12 }, activity: 'always', traits: { aggression: 0.9 }, origin: 'incident' });
    const world = createWorld([inno, culprit], { ...DEFAULT_CONFIG, damageThreshold: 8 }, { year: 2026, month: 6 });
    const tm = new TermMachine(world, new StubBrain({ damagePerStep: 4 }), { worldBrain: new StubWorldBrain() });

    // scapegoat デザインを直接組む (真犯人が inno に罪を擦り付ける)。
    world.scheduledIncident = {
      dayOfMonth: 5,
      themeSeed: '盗み',
      designed: true,
      fired: false,
      design: {
        description: '何かが盗まれた',
        newCharacters: [],
        involvedIds: ['inno'],
        perpetratorId: 'culprit1',
        scapegoat: true,
        framedTargetId: 'inno',
      },
    };
    world.phase = 'kisho';
    world.calendar.dayOfMonth = 5;

    expect(tm.fireScheduledIncident()).toBe(true);
    expect(world.incident?.framedTargetId).toBe('inno');

    // 承を回して裁判 (転) へ。
    for (let i = 0; i < 10 && world.phase === 'sho'; i += 1) await tm.shoStep();
    expect(world.phase).toBe('ten');

    // 転 foolish を回し、擦り付け票で inno が被告に選ばれる。
    for (let i = 0; i < 10 && world.trial?.defendant === null; i += 1) await tm.tenStep();
    expect(world.trial?.defendant).toBe('inno');

    // 真犯人 (事件用キャラ) は被告にならず alive のまま居座る。
    expect(world.villagers.get('culprit1')?.alive).toBe(true);
    // 擦り付け票 (voter='culprit') が記録される。
    expect(world.trial?.votes.some((v) => v.voter === 'culprit')).toBe(true);
  });
});
