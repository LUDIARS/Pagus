// WS 配線契約。World は Map を持ち JSON 化できないので、villagers を配列にした
// WireWorld を介して server→client へ送る。client もこの型だけ見れば描画できる。

import type { World, WorldConfig, Villager, Calendar, Phase, Incident, TrialState } from './types/index.js';
import type { VirtueVector } from './virtue.js';

export interface WireWorld {
  config: WorldConfig;
  term: number;
  calendar: Calendar;
  phase: Phase;
  reputation: VirtueVector;
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
    reputation: world.reputation,
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
  | { t: 'calm' } // 進行中の事件の被害を和らげる
  | { t: 'vote'; pick: string }; // 裁判への 1 票 (foolish 段階=候補id / fate 段階='kill'|'spare')
