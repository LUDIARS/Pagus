import { describe, expect, it } from 'vitest';
import {
  createVillager,
  createWorld,
  DEFAULT_CONFIG,
  MAX_VISIBLE_RESIDENTS,
  toWire,
  townAreaAt,
  type GridPos,
  type TownArea,
  type WireWorld,
} from '@pagus/sim';
import { areaFrame } from '../src/area-stream.js';

function residentsAt(prefix: string, count: number, position: GridPos): ReturnType<typeof createVillager>[] {
  return Array.from({ length: count }, (_, index) => createVillager({
    id: `${prefix}-${String(index).padStart(2, '0')}`,
    name: `${prefix}${index}`,
    position,
  }));
}

function streamedWorld(): WireWorld {
  const world = createWorld([
    ...residentsAt('nw', MAX_VISIBLE_RESIDENTS + 1, { x: 0, y: 0 }),
    ...residentsAt('n', MAX_VISIBLE_RESIDENTS + 1, { x: 8, y: 0 }),
    ...residentsAt('se', 1, { x: 23, y: 23 }),
  ], DEFAULT_CONFIG);
  world.incident = {
    id: 'incident',
    perpetrator: `nw-${MAX_VISIBLE_RESIDENTS}`,
    involved: [],
    description: 'streaming test',
    damage: 1,
    steps: [],
    resolved: false,
  };
  return toWire(world);
}

function villagerCountsByArea(world: WireWorld): Map<TownArea, number> {
  const counts = new Map<TownArea, number>();
  for (const villager of world.villagers) {
    const area = townAreaAt(world.config, villager.position);
    counts.set(area, (counts.get(area) ?? 0) + 1);
  }
  return counts;
}

describe('areaFrame radius streaming', () => {
  it('caps each included district independently and retains featured residents', () => {
    const message = areaFrame(streamedWorld(), 'north-west', 7);
    expect(message.t).toBe('areaFrame');
    if (message.t !== 'areaFrame') throw new Error('Expected an area frame');

    expect(message.radius).toBe(1);
    expect(message.sequence).toBe(7);
    expect(message.world.villagers.some((villager) => villager.id === `nw-${MAX_VISIBLE_RESIDENTS}`)).toBe(true);
    const counts = villagerCountsByArea(message.world);
    expect(counts.size).toBe(2);
    expect(counts.get('north-west')).toBe(MAX_VISIBLE_RESIDENTS);
    expect(counts.get('north')).toBe(MAX_VISIBLE_RESIDENTS);
    expect(message.world.residentHistory).toEqual([]);
    expect(message.world.relationships).toEqual([]);
    expect(message.world.userFaith).toEqual([]);
    expect(message.world.villagerActionLog).toEqual([]);
  });

  it('includes distant districts only at radius two', () => {
    const radiusOne = areaFrame(streamedWorld(), 'north-west', 8, 1);
    const radiusTwo = areaFrame(streamedWorld(), 'north-west', 8, 2);
    if (radiusOne.t !== 'areaFrame' || radiusTwo.t !== 'areaFrame') throw new Error('Expected area frames');

    expect(radiusOne.world.villagers.some((villager) => villager.id === 'se-00')).toBe(false);
    expect(radiusTwo.world.villagers.some((villager) => villager.id === 'se-00')).toBe(true);
    expect(radiusTwo.radius).toBe(2);
  });
});
