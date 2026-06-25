import type { VillagerId } from './villager.js';

/** 承: 村人が起こした事件。 */
export interface Incident {
  id: string;
  /** 当事者 (加害者)。 */
  perpetrator: VillagerId;
  /** 巻き込まれた周囲の村人。 */
  involved: VillagerId[];
  /** 事件内容 (自然言語)。 */
  description: string;
  /** 蓄積した被害量。damageThreshold 超過で収束。 */
  damage: number;
  /** GANs 進行の視点ログ (加害者/被害者を別コンテキストで)。 */
  steps: IncidentStepRecord[];
  resolved: boolean;
}

export type IncidentPerspective = 'perpetrator' | 'victim';

export interface IncidentStepRecord {
  perspective: IncidentPerspective;
  /** その視点でとられた行動 (自然言語)。 */
  action: string;
  /** この一手で増えた被害量。 */
  damageDelta: number;
}
