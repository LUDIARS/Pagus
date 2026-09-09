import { describe, expect, it } from 'vitest';
import { neighboringTownAreas, TOWN_AREAS, type TownArea } from '../src/index.js';

describe('neighboringTownAreas', () => {
  it('returns the bounded one-district halo in stable town order', () => {
    expect(neighboringTownAreas('north-west')).toEqual([
      'north-west',
      'north',
      'west',
      'plaza',
    ]);
    expect(neighboringTownAreas('east')).toEqual([
      'north',
      'north-east',
      'plaza',
      'east',
      'south',
      'south-east',
    ]);
  });

  it('returns the whole current 3x3 town for radius two', () => {
    expect(neighboringTownAreas('north-west', 2)).toEqual(TOWN_AREAS);
  });

  it('fails fast for an invalid runtime area', () => {
    expect(() => neighboringTownAreas('unknown' as TownArea)).toThrow('Unknown town area');
  });
});
