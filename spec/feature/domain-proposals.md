# PA-DOMAINS コアとビジネスドメインの提案

2026-09-08 neco 指示。Pf登録前の調査で Pagus プロジェクトは未登録だった。
したがって、Pf上では以下のコア4件とビジネス候補9件が未登録だった。
本書のビジネス候補は採否未確定。フラグメントに登録し、確定したドメインと混同しない。

## コア4件

| コア候補 | 独自のゲーム価値 | 既存の解析ドメインとの対応 |
|---|---|---|
| AIによる意思決定・創発 | 文脈を読み、個体の意思・発言・事件が生まれる | Behavior Engine、Incident Lifecycle。Brain/LLM Backendsは接続基盤部分を分離 |
| 住民の生活・関係 | 個体の人格と記憶が継続し、交友・対立が育つ | Villager Persona Engine、Emergent Social Mechanics |
| 裁判と教育 | 証言・対立を裁き、教育が人格・外見・行動に残る | Trial & Judgment、Evaluation, Voting & Groupsの教育部分 |
| 人間の間接介入 | 直接操縦せず、声・応援・扇動・投票で世界に関わる | Player Operations & Karma、投票・チャットのゲームルール |

## ビジネス候補9件（未確定）

| 候補 | ルール・責務 | 支えるコア | 既存の出典・対応 |
|---|---|---|---|
| 村の空間・住居・建設 | 道路、建物、入居、職場、損壊、建て直し | 住民、AI | town-life.md、evolving-town-buildings.md、town-map/residency/construction |
| 暦・季節・生活時間 | 朝夜、睡眠、季節、祭日、進行のペース | 住民、AI | SPEC.md、Game Loop & Time Model |
| 住民経済・消費 | 所得、貧富、趣味消費、経済的な関係 | 住民、AI | economy.ts、Resident Economy |
| 介入資源・取引 | カルマ、カード、オークション、保険など介入の制約 | 人間の間接介入 | social-packs-v1.3.md、Player Operations & Karma、auction/player-store |
| フィールドアイテム | 生成・配置・取得・贈り物・薬物の効果 | 住民、人間の間接介入 | field-items.md、Field Items |
| 村の政治・しきたり | 村長、法案、税、戒厳令、蜂起 | 住民、人間の間接介入、裁判 | Politics & Governance、village-rules、governance |
| 評判・人口循環 | 村の評価、住民の流入・退場・休眠と復帰 | 住民、AI | Evaluation, Voting & Groups、town-life.md、inactive-resident-store |
| 歴史・観戦の振り返り | 事件・判決・個体の歩み、日次ハイライト | 住民、裁判と教育 | chronicle、spectacle、emergent-and-life.md |
| 観戦者コミュニティ・通知 | 人間同士のチャット、購読、参加機会の通知 | 人間の間接介入 | multiplayer-social.md、notification-voting.md、chat-store/push-service |

## 境界で注意する点

住民の感情・関係を作る処理、事件の意味付け、教育効果、介入の効き方はコアに残す。
例えば通知配送は支援だが「誰の投票をどう裁判に効かせるか」は間接介入と裁判の境界である。
同様に、保存された歴史の閲覧は支援だが、記憶を意思決定へ使う部分はAI/住民のコアである。
描画・3Dモデル・テーマは体験を支える表示層であり、現段階では独立したビジネスドメインに数えない。

## 技術基盤として分けるもの

LLM接続・モデル割当・コスト、WS通信・配信、認証・永続化、ビルド、テスト、監視。
これらはゲームのビジネスドメインではない。現在の解析台帳は技術とゲームの分類が混在している。

## Anatomiaで確認した未登録の意味

- spec/domains に16件の宣言がある（where/findでも既存ドメインに着地）。既存の宣言ゼロではない。
- 本体 project analyze pagus は192ファイル・1,901関数・93エントリーポイントを解析。
- program domains のレイヤー設定は未定義で、作業途中の診断は11モジュール・1,907シンボルが未分類。
- この「未分類」はプログラム層の対応表がない意味であり、全コードが業務上未定義という意味ではない。
- 技術寄りの16件を、上記4コア＋9支援候補へ対応付けてPfで検討する。今回全コードの再配置は行わない。

## 現在の16解析ドメイン

Behavior Engine (Black-box / BT)、Brain/LLM Backends、Build & Delivery、Client UI (PixiJS)、
Emergent Social Mechanics、Evaluation, Voting & Groups、Field Items、Game Loop & Time Model、
Incident Lifecycle、Player Operations & Karma、Politics & Governance、Resident Economy、
Server Protocol & Transport、Test Suites、Trial & Judgment、Villager Persona Engine。
