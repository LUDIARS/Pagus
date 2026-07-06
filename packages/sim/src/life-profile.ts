// 住民の生活プロファイル。永続フィールドを増やさず、values / hobby / traits / species から
// 職能・日課・事件の火種を決定的に推定する。

import type { EnvironmentView } from './brain.js';
import type { TimeOfDay, Villager } from './types/index.js';

export type LifeRelationshipKind = 'romance' | 'spouse';

export type LifeSpecialty =
  | 'musician'
  | 'artisan'
  | 'cook'
  | 'guard'
  | 'scholar'
  | 'collector'
  | 'gossip'
  | 'wanderer';

export interface LifeProfile {
  specialty: LifeSpecialty;
  label: string;
  routine: Record<TimeOfDay, string>;
  incident: {
    description: string;
    triggerWeight: number;
  };
}

const PROFILES: Record<LifeSpecialty, Omit<LifeProfile, 'specialty'>> = {
  musician: {
    label: '音楽家',
    routine: {
      morning: '発声練習をして旋律を整えた',
      noon: '広場で小さな演奏会の準備をした',
      evening: '夕暮れの路地で新曲を鳴らした',
      night: '夜更けまで楽器を鳴らしていた',
    },
    incident: { description: '夜更けの演奏が近所の騒音問題になった', triggerWeight: 4 },
  },
  artisan: {
    label: '職人',
    routine: {
      morning: '工房で道具の手入れをした',
      noon: '注文品の細工に集中した',
      evening: 'できあがった品を広場へ運んだ',
      night: '灯りの下で危なっかしい試作を続けた',
    },
    incident: { description: '工房の試作が失敗し、道具と責任をめぐる揉め事になった', triggerWeight: 2 },
  },
  cook: {
    label: '料理人',
    routine: {
      morning: '市場で食材を見立てた',
      noon: '大鍋の昼食を仕込んだ',
      evening: '夕餉の匂いで住民を集めた',
      night: '残り火の釜を見張った',
    },
    incident: { description: '焦げた匂いと食あたりの疑いで食卓が険悪になった', triggerWeight: 3 },
  },
  guard: {
    label: '見張り',
    routine: {
      morning: '村境を見回った',
      noon: '広場で不審者の聞き込みをした',
      evening: '家々の戸締まりを確かめた',
      night: '夜警として通りを巡回した',
    },
    incident: { description: '行き過ぎた見回りが疑心暗鬼を生み、誰かを犯人扱いした', triggerWeight: 3 },
  },
  scholar: {
    label: '学者',
    routine: {
      morning: '古い記録を読み返した',
      noon: '広場で観察記録を取った',
      evening: '研究の仮説を住民に話して回った',
      night: '禁じられた実験の続きをした',
    },
    incident: { description: '夜の実験が禁忌に触れたと噂され、研究室の周りが騒然となった', triggerWeight: 3 },
  },
  collector: {
    label: '収集家',
    routine: {
      morning: '道端の小物を拾い集めた',
      noon: '集めた品を並べて値踏みした',
      evening: '珍品を見せびらかした',
      night: '誰かの落とし物をこっそり探した',
    },
    incident: { description: '収集癖が盗難疑惑を呼び、持ち物の出所を問い詰められた', triggerWeight: 3 },
  },
  gossip: {
    label: '噂好き',
    routine: {
      morning: '井戸端で朝の噂を集めた',
      noon: '広場で聞いた話をつなぎ合わせた',
      evening: '誰かの秘密をほのめかした',
      night: '小声の密談を追いかけた',
    },
    incident: { description: '広めた噂が人狼めいた疑いを呼び、住民同士が互いを疑い始めた', triggerWeight: 3 },
  },
  wanderer: {
    label: '旅人',
    routine: {
      morning: '村の外れまで散歩した',
      noon: '知らない抜け道を探した',
      evening: '見つけた近道を自慢した',
      night: '足跡を残さず夜道を歩いた',
    },
    incident: { description: '夜道の足跡と不在時間が怪しまれ、密かな犯行を疑われた', triggerWeight: 0 },
  },
};

export function lifeProfileFor(villager: Villager): LifeProfile {
  const specialty = inferSpecialty(villager);
  return { specialty, ...PROFILES[specialty] };
}

export function routineActionFor(villager: Villager, env: EnvironmentView): string {
  const profile = lifeProfileFor(villager);
  return `${villager.name} は ${env.place} で${profile.label}として${profile.routine[env.timeOfDay]}`;
}

export function routineTextFor(villager: Villager, timeOfDay: TimeOfDay): string {
  return lifeProfileFor(villager).routine[timeOfDay];
}

export function sleepRoutineFor(villager: Villager, timeOfDay: TimeOfDay): string {
  return `${villager.name} は ${sleepRoutineTextFor(timeOfDay)}`;
}

export function sleepRoutineTextFor(timeOfDay: TimeOfDay): string {
  const place = timeOfDay === 'night' ? '寝床' : '静かな部屋';
  return `${place} で休んでいる`;
}

export function relationshipRoutineFor(
  villager: Villager,
  partner: Villager,
  env: EnvironmentView,
  kind: LifeRelationshipKind,
): string {
  if (env.timeOfDay === 'night') {
    return kind === 'spouse'
      ? `${villager.name} は ${partner.name} の家に行き、夜を共に静かに過ごした`
      : `${villager.name} は ${partner.name} の家に寄り、長く語らってから帰った`;
  }
  if (env.timeOfDay === 'evening') {
    return kind === 'spouse'
      ? `${villager.name} は ${partner.name} の家に行き、家族の時間を過ごした`
      : `${villager.name} は ${partner.name} を訪ね、夕暮れの時間を分け合った`;
  }
  if (env.timeOfDay === 'morning') {
    return kind === 'spouse'
      ? `${villager.name} は ${partner.name} の家に朝の用事を手伝いに行った`
      : `${villager.name} は ${partner.name} に朝の挨拶を届けに行った`;
  }
  return kind === 'spouse'
    ? `${villager.name} は ${partner.name} の家に寄り、昼の支度を手伝った`
    : `${villager.name} は ${partner.name} の様子を見に行った`;
}

export function specialtyIncidentSeed(villager: Villager, env: EnvironmentView): string {
  const profile = lifeProfileFor(villager);
  return `${villager.name} (${profile.label}) の日課から火種が生まれた: ${profile.incident.description}`;
}

export function specialtyTriggerWeight(villager: Villager, env: EnvironmentView): number {
  const profile = lifeProfileFor(villager);
  let weight = profile.incident.triggerWeight;
  if (env.timeOfDay === 'night') weight += 1;
  if (profile.specialty === 'musician' && (env.timeOfDay === 'night' || env.timeOfDay === 'evening')) weight += 1;
  if (profile.specialty === 'guard' && env.place === '住宅地') weight += 1;
  if (profile.specialty === 'collector' && env.place !== '広場') weight += 1;
  return weight;
}

function inferSpecialty(villager: Villager): LifeSpecialty {
  const text = `${villager.persona.values.join(' ')} ${villager.persona.speechStyle} ${villager.species}`.toLowerCase();
  if (matches(text, ['音楽', '歌', '楽器', '旋律', '踊'])) return 'musician';
  if (matches(text, ['手仕事', '道具', '工房', '作る', '細工'])) return 'artisan';
  if (matches(text, ['腹', '食', '料理', '美食']) || villager.hobby === 'gourmet') return 'cook';
  if (matches(text, ['縄張り', '守る', '警戒', '見張', '秩序']) || villager.persona.traits.discipline >= 0.75) return 'guard';
  if (matches(text, ['知識', '研究', '記録', '理屈', '本']) || villager.persona.traits.curiosity >= 0.82) return 'scholar';
  if (matches(text, ['集め', '蒐集', '珍品', '拾']) || villager.hobby === 'collector') return 'collector';
  if (villager.persona.traits.sociability >= 0.72 || matches(text, ['噂', '話', '社交'])) return 'gossip';
  return 'wanderer';
}

function matches(text: string, words: readonly string[]): boolean {
  return words.some((w) => text.includes(w));
}
