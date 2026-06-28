// 暗号化 config 編集 CLI (`pnpm pagus:config <cmd>`).
//
//   init [--force]   DEFAULT_CONFIG を暗号化して pagus.config.enc を作成 (既存は --force 無しで拒否).
//                    鍵が無ければ resolveSecretKey が data/runtime/pagus.config.key を生成する.
//   show             復号して整形 JSON を stdout へ.
//   set <path> <val> 復号 → 該当キーを設定 (数値/bool/文字列を推論) → 再暗号化保存.
//   import <file>    平文 JSON を読んで暗号化保存 (一括設定).
//
// 鍵は env passphrase (PAGUS_CONFIG_KEY) があればそれ、無ければ鍵ファイル.
// 無言フォールバック禁止 (RULE_CODE §7.1): 不正な引数 / 型不一致 / 復号失敗は throw して非ゼロ終了.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { SecretBox, resolveSecretKey } from './secret-box.js';
import {
  DEFAULT_CONFIG,
  defaultEncFile,
  defaultKeyFile,
  mergePagusConfig,
  type PagusConfig,
} from './pagus-config.js';

function box(): SecretBox {
  const envKey = process.env.PAGUS_CONFIG_KEY ?? null;
  const keyFile = defaultKeyFile();
  mkdirSync(dirname(keyFile), { recursive: true });
  return new SecretBox(resolveSecretKey({ envValue: envKey, keyFile }));
}

/** enc ファイルを復号して PagusConfig を得る (存在しなければ throw). */
function readConfig(): PagusConfig {
  const encFile = defaultEncFile();
  if (!existsSync(encFile)) {
    throw new Error(`暗号化 config がありません: ${encFile} (先に \`pnpm pagus:config init\`)`);
  }
  const plain = box().decrypt(readFileSync(encFile, 'utf8').trim());
  return mergePagusConfig(JSON.parse(plain));
}

/** PagusConfig を暗号化して enc ファイルへ書く. */
function writeConfig(config: PagusConfig): void {
  const encFile = defaultEncFile();
  mkdirSync(dirname(encFile), { recursive: true });
  const enc = box().encrypt(JSON.stringify(config, null, 2));
  writeFileSync(encFile, enc, 'utf8');
}

/** 文字列を bool/number/string に推論する. */
function inferValue(raw: string): boolean | number | string {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw.trim() !== '' && !Number.isNaN(Number(raw))) return Number(raw);
  return raw;
}

/** dotpath で config の leaf を設定する (中間/leaf 不在や非 leaf は throw). */
function setByPath(config: PagusConfig, dotpath: string, value: boolean | number | string): void {
  const keys = dotpath.split('.');
  if (keys.length < 2) throw new Error(`設定パスは <group>.<key> 形式で指定: ${dotpath}`);
  let cur: Record<string, unknown> = config as unknown as Record<string, unknown>;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const k = keys[i] as string;
    const next = cur[k];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      throw new Error(`設定パスが不正です: ${dotpath} (${k} はグループではありません)`);
    }
    cur = next as Record<string, unknown>;
  }
  const leaf = keys[keys.length - 1] as string;
  if (!(leaf in cur)) throw new Error(`不明な設定キー: ${dotpath}`);
  if (typeof cur[leaf] === 'object') throw new Error(`${dotpath} は leaf ではありません (配列/オブジェクトは import で)`);
  cur[leaf] = value;
}

function cmdInit(args: string[]): void {
  const force = args.includes('--force');
  const encFile = defaultEncFile();
  if (existsSync(encFile) && !force) {
    throw new Error(`${encFile} は既に存在します (上書きは --force)`);
  }
  writeConfig(structuredClone(DEFAULT_CONFIG));
  console.log(`[pagus] 暗号化 config を作成しました: ${encFile}`);
  console.log(`[pagus] 鍵: ${process.env.PAGUS_CONFIG_KEY ? 'PAGUS_CONFIG_KEY (env)' : defaultKeyFile()}`);
}

function cmdShow(): void {
  const config = readConfig();
  console.log(JSON.stringify(config, null, 2));
}

function cmdSet(args: string[]): void {
  const [dotpath, raw] = args;
  if (!dotpath || raw === undefined) throw new Error('使い方: set <dotpath> <value>');
  const config = readConfig();
  setByPath(config, dotpath, inferValue(raw));
  // 設定後に再検証 (型不一致は throw) してから保存する.
  writeConfig(mergePagusConfig(config));
  console.log(`[pagus] ${dotpath} = ${raw} を保存しました`);
}

function cmdImport(args: string[]): void {
  const [file] = args;
  if (!file) throw new Error('使い方: import <file.json>');
  if (!existsSync(file)) throw new Error(`JSON ファイルがありません: ${file}`);
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const config = mergePagusConfig(parsed); // 部分指定可 + 型検証
  writeConfig(config);
  console.log(`[pagus] ${file} を暗号化 config へ取り込みました`);
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
