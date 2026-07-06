import { describe, it, expect } from 'vitest';
import { createVillager, pickTrialAttendees } from '../src/index.js';

describe('trial attendance', () => {
  it('生存者から被告を除き、最大10人を裁判IDで決定的に抽選する', () => {
    const villagers = Array.from({ length: 24 }, (_, i) =>
      createVillager({ id: `v${i}`, name: `住民${i}`, position: { x: i, y: 0 } }),
    );
    villagers[3]!.alive = false;

    const first = pickTrialAttendees(villagers, 'v0', 'trial-a');
    const again = pickTrialAttendees(villagers, 'v0', 'trial-a');
    const otherTrial = pickTrialAttendees(villagers, 'v0', 'trial-b');

    expect(first).toHaveLength(10);
    expect(first.map((v) => v.id)).toEqual(again.map((v) => v.id));
    expect(first.some((v) => v.id === 'v0' || v.id === 'v3')).toBe(false);
    expect(first.map((v) => v.id)).not.toEqual(otherTrial.map((v) => v.id));
  });
});
