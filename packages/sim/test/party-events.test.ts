import { describe, expect, it } from 'vitest';
import { createVillager, createWorld, DEFAULT_CONFIG, StubBrain, TermMachine, type World } from '../src/index.js';

function world(): World {
  const a = createVillager({ id: 'a', name: 'A', position: { x: 1, y: 1 }, activity: 'always', traits: { aggression: 0.9, kindness: 0.4 } });
  const b = createVillager({ id: 'b', name: 'B', position: { x: 2, y: 1 }, activity: 'always', traits: { aggression: 0.8, kindness: 0.5 } });
  const w = createWorld([a, b], DEFAULT_CONFIG, { year: 2026, month: 6, dayOfMonth: 1 });
  w.reputation.malice = 1;
  return w;
}

describe('scheduled party events', () => {
  it('monthly party timing is decided ahead of time', () => {
    const w = world();
    const tm = new TermMachine(w, new StubBrain(), { rng: () => 0.5 });

    const party = tm.scheduleMonthlyParty();

    expect(party).not.toBeNull();
    expect(w.scheduledParty).toEqual(party);
    expect(party?.dayOfMonth).toBeGreaterThan(1);
    expect(party?.fired).toBe(false);
  });

  it('party outcome can plant a near-future incident trigger', () => {
    const w = world();
    w.phase = 'kisho';
    w.calendar.dayOfMonth = 8;
    w.scheduledParty = {
      dayOfMonth: 8,
      kind: 'welcome',
      title: '歓迎会',
      participantIds: ['a', 'b'],
      fired: false,
      incidentPlanted: false,
    };
    const tm = new TermMachine(w, new StubBrain(), { rng: () => 0 });

    const result = tm.fireScheduledParty();

    expect(result?.incidentDay).toBe(9);
    expect(w.scheduledParty?.fired).toBe(true);
    expect(w.scheduledParty?.incidentPlanted).toBe(true);
    expect(w.scheduledIncident?.dayOfMonth).toBe(9);
    expect(w.scheduledIncident?.themeSeed).toContain('歓迎会');
    expect(w.relationships.some((r) => r.from === 'a' && r.to === 'b' && r.affinity > 0)).toBe(true);
  });
});
