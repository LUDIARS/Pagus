// テーマパック (§v1.4-D LexiconPack) のローダ。
// data/theme/<pack>/lexicon.json を読み、必須キーを検証して (欠落は即エラー =
// 無言フォールバック禁止 RULE_CODE §7.1)、moral=wholesome なら wholesome 上書きをマージする。
// sim は不変で、この語彙は server の feed 文言と client の表示にだけ効く。

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ThemeLexicon, MoralDial } from '@pagus/sim';
import { dataDir } from '../load-data.js';

/** ThemeLexicon の必須キー (string)。 */
const STRING_KEYS = [
  'packName',
  'trialOpen',
  'stageFoolish',
  'stageFate',
  'stageDecided',
  'verdictDeathJa',
  'verdictDeathEn',
  'verdictEducateJa',
  'verdictEducateEn',
  'verdictDeathResult',
  'verdictEducateResult',
  'verdictFeedPrefix',
  'sanctionFeed',
  'madmanLabel',
  'giftPoisonLabel',
  'denounceTone',
] as const;

/** ThemeLexicon の必須キー (string[])。 */
const ARRAY_KEYS = ['taunts', 'defenses', 'denounces', 'retorts', 'screams', 'reliefs', 'denounceSeeds'] as const;

const MORALS: readonly MoralDial[] = ['dark', 'balanced', 'wholesome'];

/** config theme.moral の検証 (不正値は即エラー)。 */
export function validateMoral(raw: string): MoralDial {
  if ((MORALS as readonly string[]).includes(raw)) return raw as MoralDial;
  throw new Error(`config theme.moral は dark|balanced|wholesome のいずれか: ${raw}`);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 1 パックぶんの生 JSON を検証して ThemeLexicon にする (部分オブジェクトの検証にも使う)。 */
function pickLexicon(raw: Record<string, unknown>, packLabel: string, partial: boolean): Partial<ThemeLexicon> {
  const out: Record<string, unknown> = {};
  for (const key of STRING_KEYS) {
    const v = raw[key];
    if (v === undefined) {
      if (partial) continue;
      throw new Error(`theme ${packLabel}: 必須キー ${key} がありません`);
    }
    // denounceTone だけは空文字列を許す (classic はトーン指定なし)。
    if (typeof v !== 'string' || (v.length === 0 && key !== 'denounceTone')) {
      throw new Error(`theme ${packLabel}: ${key} は空でない文字列である必要があります`);
    }
    out[key] = v;
  }
  for (const key of ARRAY_KEYS) {
    const v = raw[key];
    if (v === undefined) {
      if (partial) continue;
      throw new Error(`theme ${packLabel}: 必須キー ${key} がありません`);
    }
    if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== 'string' || x.length === 0)) {
      throw new Error(`theme ${packLabel}: ${key} は空でない文字列の配列である必要があります`);
    }
    out[key] = v;
  }
  return out as Partial<ThemeLexicon>;
}

/**
 * テーマパックをロードする (§v1.4-D)。dir 省略時はリポの data/。
 * moral=wholesome なら pack の wholesome 上書きをマージして返す。
 * ファイル欠落・キー欠落・型不正は throw (テーマは明示選択なので既定値に落とさない)。
 */
export function loadLexicon(pack: string, moral: MoralDial, dir: string = dataDir()): ThemeLexicon {
  if (!/^[a-z0-9-]+$/.test(pack)) throw new Error(`config theme.pack が不正 (英小文字/数字/ハイフン): ${pack}`);
  const path = resolve(dir, 'theme', pack, 'lexicon.json');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (cause) {
    throw new Error(`テーマパックが読めません: ${path}`, { cause });
  }
  if (!isPlainObject(raw)) throw new Error(`theme ${pack}: lexicon.json はオブジェクトである必要があります`);

  const base = pickLexicon(raw, pack, false) as ThemeLexicon;
  if (moral !== 'wholesome') return base;

  const overrides = raw['wholesome'];
  if (overrides === undefined) return base;
  if (!isPlainObject(overrides)) throw new Error(`theme ${pack}: wholesome はオブジェクトである必要があります`);
  return { ...base, ...pickLexicon(overrides, `${pack}.wholesome`, true) };
}

/** feed のテンプレ ({name} 差し込み)。 */
export function fillName(template: string, name: string): string {
  return template.replaceAll('{name}', name);
}
