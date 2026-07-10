import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  addResidentHistory,
  createVillager,
  createWorld,
  nameExistingGenericIncidentVillagers,
} from '../src/index.js';

function fixedRng(): number {
  return 0;
}

describe('incident visitor naming', () => {
  it('names restored generic incident visitors once and records the namer', () => {
    const resident = createVillager({
      id: 'a',
      name: 'Aoi',
      position: { x: 12, y: 12 },
      species: 'human',
      activity: 'always',
    });
    const masked = createVillager({
      id: 'incident_9',
      name: '仮面の訪問者',
      position: { x: 13, y: 12 },
      species: 'human',
      origin: 'incident',
      activity: 'always',
    });
    const world = createWorld([resident, masked], { ...DEFAULT_CONFIG, damageThreshold: 8 }, { year: 2026, month: 6 });
    addResidentHistory(world, resident, { joinedTerm: 0 });
    addResidentHistory(world, masked, { origin: 'incident', archetype: '訪問者', joinedTerm: 3 });

    const records = nameExistingGenericIncidentVillagers(world, {
      rng: fixedRng,
      resolveBrain: (id) => (id === masked.id ? 'gpt' : null),
    });

    expect(records).toHaveLength(1);
    expect(masked.name).not.toBe('仮面の訪問者');
    expect(records[0]).toMatchObject({
      villagerId: masked.id,
      originalName: '仮面の訪問者',
      assignedName: masked.name,
      namedById: resident.id,
      namedByName: resident.name,
    });
    expect(world.residentHistory.find((h) => h.id === masked.id)).toMatchObject({
      name: masked.name,
      originalName: '仮面の訪問者',
      namedById: resident.id,
      namedByName: resident.name,
      llmBrain: 'gpt',
    });

    expect(nameExistingGenericIncidentVillagers(world, { rng: fixedRng })).toHaveLength(0);
  });
});
