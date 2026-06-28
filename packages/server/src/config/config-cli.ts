// 設定編集 CLI (`pnpm pagus:config <cmd>`).
//
//   init [--force]   DEFAULT_CONFIG を config ファイルへ書き出す (既存は --force 無しで拒否).
//   show             現在の (復号済) config を整形 JSON で stdout へ.
//   set <path> <val> 1 キーを設定 (型は DEFAULT_CONFIG に合わせて検証). secretKeys は暗号化保存.
//   import <file>    平文 (nested) JSON を読んで一括設定 (部分指定可・型検証).
//
// 実体は LUDIARS 正本 `@ludiars/encrypted-config` (Lapilli) の setConfig/readConfig/writeConfigFile.
// master secret: env PAGUS_MASTER_KEY → 無ければマシン束縛値 (pagus:hostname:user).
// 無言フォールバック禁止 (RULE_CODE §7.1): 不正な引数 / 型不一致は throw して非ゼロ終了.

import { existsSync, readFileSync } from 'node:fs';
import { setConfig, writeConfigFile, type ConfigFile } from '@ludiars/encrypted-config';
import {
  DEFAULT_CONFIG,
  STORE_OPTIONS,
  defaultConfigPath,
  flattenConfig,
  coerceLeaf,
  defaultAt,
  loadPagusConfig,
  mergePagusConfig,
  storeEnv,
} from './pagus-config.js';

function cmdInit(args: string[]): void {
  const force = args.includes('--force');
  const path = defaultConfigPath();
  if (existsSync(path) && !force) {
    throw new Error(`${path} は既に存在します (上書きは --force)`);
  }
  // 既定値を全 dot-key で書き出す (secretKeys は暗号化される).
  const env = storeEnv();
  // --force 時は空にしてから書き直す (古いキーを残さない).
  if (force) writeConfigFile({ plain: {}, secrets: {} } satisfies ConfigFile, STORE_OPTIONS, env);
  for (const [key, value] of Object.entries(flattenConfig(DEFAULT_CONFIG))) {
    setConfig(key, value, STORE_OPTIONS, env);
  }
  console.log(`[pagus] config を作成しました: ${path}`);
  console.log(`[pagus] master: ${process.env.PAGUS_MASTER_KEY ? 'PAGUS_MASTER_KEY (env)' : 'machine-bound (pagus:hostname:user)'}`);
}

function cmdShow(): void {
  console.log(JSON.stringify(loadPagusConfig(), null, 2));
}

function cmdSet(args: string[]): void {
  const [dotpath, raw] = args;
  if (!dotpath || raw === undefined) throw new Error('使い方: set <dotpath> <value>');
  if (defaultAt(dotpath) === undefined) throw new Error(`不明な設定キー: ${dotpath}`);
  if (typeof defaultAt(dotpath) === 'object') {
    throw new Error(`${dotpath} は leaf ではありません (配列/オブジェクトは import で)`);
  }
  // DEFAULT_CONFIG の型に合わせて検証 (不正は throw). 保存値は文字列 (配列は JSON 文字列).
  coerceLeaf(dotpath, raw);
  setConfig(dotpath, raw, STORE_OPTIONS, storeEnv());
  console.log(`[pagus] ${dotpath} = ${raw} を保存しました`);
}

function cmdImport(args: string[]): void {
  const [file] = args;
  if (!file) throw new Error('使い方: import <file.json>');
  if (!existsSync(file)) throw new Error(`JSON ファイルがありません: ${file}`);
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  // 部分指定可 + 型検証 (不正は throw). 検証済みの nested を flat 化して 1 キーずつ保存.
  const validated = mergePagusConfig(parsed);
  const env = storeEnv();
  for (const [key, value] of Object.entries(flattenConfig(validated))) {
    setConfig(key, value, STORE_OPTIONS, env);
  }
  console.log(`[pagus] ${file} を config へ取り込みました`);
}

function main(): void {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'init':
      cmdInit(rest);
      break;
    case 'show':
      cmdShow();
      break;
    case 'set':
      cmdSet(rest);
      break;
    case 'import':
      cmdImport(rest);
      break;
    default:
      console.error('使い方: pagus:config <init [--force] | show | set <dotpath> <value> | import <file.json>>');
      process.exit(1);
  }
}

main();
