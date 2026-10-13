# 住民表示変更 (77bda0b) の Anatomia 所見の調査

- 日付: 2026-10-13
- 対象: マージコミット `77bda0be0313` (Revisor #1585「住民の見た目と初期画角を精緻化し、裁判会話演出と隔離判定を作り直す」)
- 元タスク: `spec/tasks/2026-09-09-presence-anatomia-followup.md` (Actio 8a0c6567)
- 根拠: Revisor の保存済み審査結果 (`revisor pr show 1585 --json` の `anatomia` / `advisories` / `mergeRisk`) と、Pagus のコード

## 結論

| 所見 | 判定 | 必要な対応 |
|---|---|---|
| program 層の未分類 41 アンカー | **program 層の宣言不足**。Pagus に `.anatomia/layers.json` が無いため、変更したアンカーが全件「未分類」になる | Pagus に program 層を宣言する (別タスク) |
| 孤立関数 1 件 | **解析上の未検出**。実際には呼ばれている | Anatomia 側の検出漏れとして登録 (別タスク) |
| 複雑度比較が legacy aggregate | 比較不能。改善・悪化どちらの証拠にもしない | 対応なし (記録のみ) |

意味ドメイン (ビジネス層) の所属は欠けていない。審査結果の `unassignedAnchors` は 0 件、
`businessUnownedAnchors` も 0 件で、変更アンカーはすべて Pagus の意味ドメイン
(Client UI (PixiJS) / Behavior Engine (Black-box / BT) / Test Suites ほか) に属している。
未分類は program 層だけの話で、意味ドメインの未登録と混同しない。

## 1. program 層の未分類 41 アンカー

- 内訳 (意味ドメインの所属から): クライアント (`packages/client`) 21 / シミュレーション (`packages/sim/src`) 4 / テスト (`packages/sim/test`) 16。
- 原因: Pagus には `.anatomia/layers.json` (program 層の宣言) が無い (`.anatomia/` にあるのは `domains/`・`link-stability.json`・`plan/` のみ)。
  program 層が空なので、Anatomia の二層ドメイン検査はすべての変更アンカーを unclassified と数える。
  特定の関数の分類漏れではない。
- 対応: `packages/sim` (純 TS の核)・`packages/server` (権威サーバ)・`packages/client` (描画と操作)・テストの層を
  `.anatomia/layers.json` に宣言する。CLAUDE.md の構成表がそのまま層の候補になる。
  所見は advisory (ブロックしない) なので急ぎではない。

## 2. 孤立関数 1 件

- 対象: `TrialDialogue` の `constructor` (`packages/client/src/trial-dialogue.ts:20`、anchor `cef7ad51c27f4a3a`)。
- 実際の呼び出し: `packages/client/src/stage-view.ts:31` (77bda0b 時点) のクラスフィールド初期化子
  `private readonly dialogue = new TrialDialogue();` で生成されている。現在の main でも同じ (`stage-view.ts:35`)。
- 判定: 呼び出し漏れではなく、Anatomia が「クラスフィールドの初期化子に書かれた `new`」をコンストラクタ呼び出しとして
  結んでいない検出漏れ。Pagus のコードを直す必要は無い。
- 既存の追跡との重複: Pf の概要 TODO は 2026-10-09 にコア↔ビジネスドメインのつながりだけを見る形へ切り替わり、
  関数単位の孤立は扱っていない。重複する追跡項目は無い。

## 3. 複雑度比較 (legacy aggregate)

- 審査結果の `complexityComparison` は `mode: legacy-aggregate`、理由は `Function snapshots unavailable or invalid`、`delta: 0`。
- 変更前 (base) の関数ごとのスナップショット (`baselineFunctionComplexity`) はあったが、変更後と比べられる関数スナップショットが無かった。
- したがって `delta: 0` は「変化なし」ではなく「比べられなかった」を意味する。改善済みの証拠として使わない。

## 分解したタスク

- Pagus: `.anatomia/layers.json` で program 層 (sim / server / client / test) を宣言する。
- Anatomia: クラスフィールド初期化子の `new X()` をコンストラクタ呼び出しとして結ぶ (孤立関数の誤検知)。
