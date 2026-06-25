// WS 配線契約。World は Map を持ち JSON 化できないので、villagers を配列にした
// WireWorld を介して server→client へ送る。client もこの型だけ見れば描画できる。

import type { World, WorldConfig, Villager, Calendar, Phase, Incident, TrialState } from './types/index.js';

export interface WireWorld {
  config: WorldConfig;
  term: number;
  calendar: Calendar;
  phase: Phase;
  villagers: Villager[];
  incident: Incident | null;
  trial: TrialState | null;
}

export function toWire(world: World): WireWorld {
  return {
    config: world.config,
    term: world.term,
    calendar: world.calendar,
    phase: world.phase,
    villagers: [...world.villagers.values()],
    incident: world.incident,
    trial: world.trial,
  };
}

/** server → client。 */
export type ServerMessage =
  | { t: 'snapshot'; world: WireWorld }
  | { t: 'log'; phase: Phase; text: string };

/** client → server。 */
export type ClientMessage =
  | { t: 'incite' } // 次の tick で強制的に事件を起こす
  | { t: 'calm' }; // 進行中の事件の被害を和らげる
