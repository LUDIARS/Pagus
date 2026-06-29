# ソーシャル機能パック (v1.3) — カード / 経済 / 政治 / 演出・協力

> 2026-06-28 起草。ユーザ採択 (4パック全採用) を正本化。既存資産 (カルマ/善性/stats/陣営=`server/player-state.ts`、村のルール/BehaviorRule/裁判=sim、BetPool=`server/bet-pool.ts`) の上に**毎 tick LLM を増やさず**乗せる。数値は env 可変・観戦調整前提。
>
> 共通: 状態は基本 server (per-userId)。接続↔userId は ws-server の `connUser`、per-connection 送信 (`sendToUser`)・broadcast あり。コマンドは全て **カルマ検証 → spend → 効果 → playerState/関連 push**、不正/不足は `commandRejected`。無言フォールバック禁止。

## 共通基盤 (先に入れる小物)

- **介入クールダウン**: per-userId のカード使用クールダウン (`PlayerState.cardReadyAt`)。`PAGUS_CARD_COOLDOWN_MS`(既定60000)。
- **BehaviorRule の TTL**: `BehaviorRule.expiresAtTerm?: number` を追加。`TermMachine` が日末 (advanceDay 後) に `expiresAtTerm <= term` のルールを除去。天災カード等の一時効果に使う。`source` に `'card'` を追加。
- **Villager の一時退避**: `Villager.hiddenUntilTerm?: number` を追加。`aliveVillagers`/`awakeVillagers`/裁判候補から hidden を除外し、日末に期限切れで復帰。神隠しに使う。
- snapshot 形式が変わるため `WORLD_SNAPSHOT_VERSION` を上げる。

---

## A. カードパック (v1.3-A) — カルマで切る一発介入

`ClientMessage` `{ t:'card'; card:<種別>; ...引数; userId? }` に集約 (or 個別 t)。各カードは cost + cooldown。

- **⑯天災 (disaster)** `{card:'disaster', kind:'drought'|'storm'|'plague'}`: 一時 BehaviorRule を `world.behaviorRules` に追加 (TTL=`PAGUS_DISASTER_DAYS`(3) 日)。drought→全体 anger+ / storm→ triggerWeight+ (事件多発) / plague→ joy−・stress 増。`source:'card'`、description「天災: …」。chronicle `🃏 天災: …`。cost `PAGUS_CARD_DISASTER_COST`(40)。
- **⑰神隠し (spiritAway)** `{card:'spiritAway', targetId}`: 対象に `hiddenUntilTerm = term + PAGUS_SPIRITAWAY_DAYS`(2)。裁判中の被告でも退避でき裁判逃れになる (進行中裁判の被告なら裁判を中断 → kisho へ)。cost `PAGUS_CARD_SPIRITAWAY_COST`(35)。
- **⑱入れ替え (swap)** `{card:'swap', aId, bId}`: 2 住民の `persona.traits` と `appearance` を交換 (sim helper `swapVillagers`)。cost `PAGUS_CARD_SWAP_COST`(30)。chronicle `🃏 入れ替え: A と B`。
- **⑲覚醒 (awaken)** `{card:'awaken', targetId}`: 対象の最小気質軸を高位へ引き上げ (隠し気質の解放、`min軸 → 0.9` 等) + flavor。cost `PAGUS_CARD_AWAKEN_COST`(25)。
- **⑳偽予言 (falseProphecy)** `{card:'falseProphecy', text?}`: 多数の住民に偽 InfoItem を撒き (既存 inciteTarget の噂注入を全体版に)、`eventParams` を底上げして翌日のアルゴリズムイベントを増やす。cost `PAGUS_CARD_PROPHECY_COST`(20)。chronicle `🃏 偽予言: …`。

sim 追加: `swapVillagers(world,a,b)` / `awakenVillager(world,id,rng)` / 偽予言の全体噂注入ヘルパ / BehaviorRule TTL prune / hidden 退避フィルタ。client: カード選択 UI (対象/種別選択 + コスト + クールダウン表示)。

## B. 経済パック (v1.3-B) — カルマ経済

主に `PlayerState` 拡張 + 新 `server/auction.ts`。

- **①送金 (transfer)** — **廃止** (2026-06)。人から人へのカルマ送金は村の設計から外した (`transfer` メッセージ / `PlayerState.transfer` / `PAGUS_TRANSFER_FEE_PCT` ともに削除)。カルマの授受は銀行・オークション・闇市・税/基金を通じてのみ行う。
- **②市場/オークション (auction)** `server/auction.ts`: 定期ロット (例: 「次の制裁無料券」「永続善性+0.1」「カード1枚」)。`{t:'bid', lotId, amount}` でオープン入札 (増額のみ)。`PAGUS_AUCTION_PERIOD_MS`(120000) ごとに最高入札者が落札しカルマ徴収・効果付与、他は返金。`ServerMessage {t:'auction', lots:[{id,title,highBid,highUserId,endsInMs}]}` broadcast。
- **③推し保険 (insure)** `{t:'insure', targetId, premium}`: premium 払い、対象が `PAGUS_INSURE_DAYS`(5) 日以内に死んだら払戻 `premium × PAGUS_INSURE_MULT`(3)。死亡検知 (v1.2-A の機構) で清算。
- **④銀行 (bank)** — **廃止** (2026-06)。預金/利子は村の設計から外した (`deposit`/`withdraw` メッセージ / `PlayerState.savings` / `applyInterest` / `PAGUS_BANK_INTEREST` ともに削除)。
- **⑤闇市 (blackmarket)** `{t:'buyMarket', item}`: プレミアム価格でカード (パックA) / `revive`(死んだ住民を1体復活) 等を購入。`revive` は最近死んだ villager を alive へ戻す (sim helper、cost `PAGUS_REVIVE_COST`(80))。

client: 保険/闇市/オークション UI (送金・銀行 UI は廃止)。

## C. 政治パック (v1.3-C) — 統治

`server/governance.ts` に集約。

- **⑥村長 (mayor)** — **2026-06 刷新 → §17**。旧「プレイヤーが `voteMayor` で投票、最多得票プレイヤーが村長」は廃止。村長は**村人 (NPC)** が**選挙イベント**で村人世論により就任する方式へ (匿名世論調査 + リコール)。実装は `packages/sim/src/mayor.ts`、詳細 `spec/feature/villager-mayor.md`。村長の無料しきたり特典も撤去。
- **⑦法案投票 (law)** `{t:'proposeLaw', text}` (供託カルマ) + `{t:'voteLaw', lawId, approve:bool}`: 賛成多数で `addVillageRule` 実行 + 提案者へ供託返金、否決で没収。投票中の法案を broadcast `{t:'laws', items:[...]}`。
- **⑧革命 (revolt)** — アルゴリズム: 村の `malice > PAGUS_REVOLT_THRESHOLD`(0.7) で日末に蜂起イベント発火。プレイヤーは `{t:'revolt', side:'incite'|'suppress'}` で分岐 (集約カルマ多い側が勝ち)。incite 勝利→大量事件/評判悪化、suppress 勝利→鎮静 (malice 減)。chronicle `🔥 革命: …`。
- **⑨戒厳令 (martialLaw)** `{t:'martial', mode:'freeze'|'surge'}`: 複数プレイヤーの集約カルマ `PAGUS_MARTIAL_COST`(100) を満たすと発動。freeze=スケジュール事件を一時凍結 / surge=日常事件の閾値を下げ多発。TTL 付き。
- **⑩税 (tax)** — 定期: `PAGUS_TAX_PERIOD_MS`(180000) ごとに全プレイヤーから `PAGUS_TAX_AMOUNT`(5) を徴収し**村基金 (village fund)** へ。基金が `PAGUS_FUND_THRESHOLD`(100) に達したら村イベント (祝祭=評判活気+ / 救済=stress 減) を発火し基金リセット。

sim 追加: 革命イベント / martialLaw が `fireScheduledIncident`・DailyEngine 閾値へ作用するフック。client: 村長/法案/革命/戒厳令/基金の政治パネル。

## D. 演出・協力パック (v1.3-D)

- **㉑ハイライトカード (highlights)**: server が節目 (処刑/和解/革命/レイド勝利) を**ハイライト**として buffer (上限30)。`{t:'highlights'}` 要求 or 接続時 push `{t:'highlights', cards:[{date,title,kind,summary}]}`。client がカード表示 (共有用に整形)。
- **㉓予測アワード (predict)** `{t:'predictDay', dayOfMonth}`: その月の事件発生日 (`scheduledIncident.dayOfMonth`) を当てる。月初スケジュール後〜発生前に受付、的中で `PAGUS_PREDICT_REWARD`(30)。発生日に判定。
- **㉔月間MVP (mvp)** `{t:'voteMvp', villagerId}`: 月末に住民へ投票、最多得票が「今月の主役」称号 + legacy (村ルール/石碑)。`ServerMessage {t:'mvp', villagerId, name}`。
- **㉕観客の祈り (pray)** `{t:'pray'}`: `PAGUS_PRAY_WINDOW_MS`(30000) 内に `PAGUS_PRAY_NEEDED`(3) 人が祈ると村全体に微バフ (reputation benevolence+vitality+ / 全体 stress−)。協力要素。chronicle `🙏 祈り: …`。
- **㉙共闘レイド (raid)**: 特別な凶悪事件用キャラ (連続殺人犯=高 `raidHp`) が出現。プレイヤーは `{t:'raidStrike', amount}` でカルマを投じてダメージ、総量が hp を超えたら討伐 (villain 退場 + 全員へ報酬カルマ + ハイライト)。失敗 (期限切れ) で村に大被害。`ServerMessage {t:'raid', villainName, hp, hpMax, endsInMs}`。
- **㉚シーズン制 (season)**: `PAGUS_SEASON_DAYS` ごと (既定=ゲーム年? or 月) に陣営勝敗を確定 (guide vs incite スコア比較) → 勝利陣営に報酬カルマ、`stats`/称号は保持しつつ**シーズンスコアをリセット**、ランキングを `data/runtime/seasons.json` に追記保存。`ServerMessage {t:'season', number, winner, leaderboard}`。

client: ハイライト/予測/MVP/祈り/レイド/シーズンの演出 UI。

## E. 操作オーバーレイ整備 (v1.3-E、最後に実施)

> 全パック実装でユーザ操作が激増するため、**専用オーバーレイ操作パネル**に集約して整理する。実装後に一度起動して動作確認する。

- **プレイヤー行動パネル (操作) は独立** (2026-06 改定): 扇動(噂)/制裁/応援/推し指名 は画面下の常設ドック `#action-dock` に分離し、PC・モバイル共通で画面下に出す (レスポンシブで折り返す)。`player-controls.ts` は横並びバー (状態チップ + コマンド + 対象/悪口の主セレクタ + 実行)。
- **2段コマンド UI** (2026-06 改定): ①コマンドを選ぶ (扇動/制裁/応援/推し指名、各ボタンに**消費カルマを併記**。応援はクールダウン残/無料、推し指名は無料) → ②対象を選ぶ → 実行。`playerState` に `inciteCost` を追加し client がコスト表示に使う (制裁は動的 `sanctionCost`)。
- **推し保護**: 扇動コマンドのときは対象セレクタから自分の推し (champion) を除外する (推しに誤って扇動しない、§4.2)。
- **行動リアクション**: 実行すると対象どうぶつが村ステージで即リアクション吹き出しを出す (`StageView.reactToAction`、扇動=「なんだと…！？」等)。扇動の手応えが無い問題への対応。裁判中は出さない。
- 残りの操作は**統合アクションオーバーレイ** (右ドロワー、トグル `🎛 メニュー`) にタブで整理:
  - **カード**: 天災/偽予言 等の対象不問カード。
  - **村**: しきたり改定/法案/村長/革命/戒厳令/基金。
  - **裁判**: 死刑/教育投票 + ベット。
  - **経済**: 保険/オークション/闇市 (カルマ経済。送金・銀行は廃止)。
  - **課金 (別枠)**: 課金モック / ユーザーコード / 別端末ログイン (§F)。実マネーの課金は村内カルマ経済とは別タブに分離。
  - **情報**: 状態(コスト/年)/スコアボード(称号・陣営)/履歴/ハイライト/予測/MVP/シーズン。
- カルマ残高・クールダウン・コストを常時表示し、不可操作は無効化＋理由表示 (commandRejected と整合)。
- 既存の散在 UI (bet-panel/leaderboard/status/chronicle 等) をこのオーバーレイ配下へ再編。行動ドック以外はモバイルでドロワー。
- 実装後 `PAGUS_FRESH=1` stub 起動 + client で一通りの操作系統が出ること・型/受信ハンドラが揃っていることを確認 (一度レビュー)。

## env 既定一覧 (抜粋)

カード: CARD_COOLDOWN_MS=60000 / DISASTER_COST=40・DISASTER_DAYS=3 / SPIRITAWAY_COST=35・_DAYS=2 / SWAP_COST=30 / AWAKEN_COST=25 / PROPHECY_COST=20。
経済: AUCTION_PERIOD_MS=120000 / INSURE_DAYS=5・INSURE_MULT=3 / REVIVE_COST=80。(TRANSFER_FEE_PCT/BANK_INTEREST は送金・銀行廃止に伴い削除)
政治: REVOLT_THRESHOLD=0.7 / MARTIAL_COST=100 / TAX_PERIOD_MS=180000・TAX_AMOUNT=5・FUND_THRESHOLD=100。
演出: PREDICT_REWARD=30 / PRAY_WINDOW_MS=30000・PRAY_NEEDED=3 / (RAID/SEASON 各種)。

## 開いた判断

- カード/カルマのインフレ防止 (上限/減衰) は観戦して調整。
- 革命/レイドの数値 (閾値/HP/報酬) は当て推量。
- シーズン境界の定義 (ゲーム年 or 実時間)。暫定 = ゲーム月 N 個。
- オークションのロット内容と頻度。暫定 = 固定ロット3種ローテ。
</content>
