# フィールドアイテム (§16) — 人手のランダム配布物

> 2026-06-29 起草・実装。プレイヤーがフィールドに「アイテム」を配置し、住民が拾って影響を受ける。
> §15 住民経済の上に乗る介入手段。**カルマ消費なし・ランダム配布** (購入ではない)。LLM 非依存。

## モデル

- `FieldItemKind = 'precious'(貴金属) | 'drug'(薬物)`。プレイヤー選択 `ItemKindChoice = 'random' | precious | drug`。
- `World.items: FieldItem[]` (`{ id, kind, position }`)。WireWorld に乗って client へ配信、world.json に永続化。snapshot **v8**。
- `TermMachine.itemCount` は復元した `world.items` の最大番号から続ける (id 衝突回避、永続化シグネチャは変えない)。

## フロー

1. **配置** (`{t:'placeItem', kind, toChampion?}`、カルマ消費なし):
   - `toChampion=false` → `TermMachine.placeItem(kind)` がランダムマスへ置く (`world.items` に追加)。
   - `toChampion=true` → `giveChampionItem(kind, championId)` で**推しへフィールドを介さず即適用**。推し未指名/不在は reject。
2. **拾得 (日末)**: `collectItems(world)` が各アイテムを**最寄りの生存住民**に拾わせ、効果適用後 `world.items` を空にする。
3. **効果** (`applyItemEffect`):
   - 貴金属 → `wealth += preciousWealth`(150)。→ §15 のクズ化の誘因。
   - 薬物 → `anger += drugAnger`(0.3, クランプ) / `wealth -= drugWealthLoss`(20) / `eventParams.drug += 1`。

## 非行連動 (behavior-rules)

薬物の波及は決定的ルールで表す: `base_drugged` (`wander` かつ `eventParamAbove 'drug' 0` → `triggerWeight`+2・怒り+0.1)。
薬物を拾った個体は事件 (非行) を起こしやすくなる。タグ名は items.ts の `DRUG_TAG` と一致 (base ルールはリテラル)。

## client

- `item-panel.ts` (オーバーレイ「🎁 アイテム」タブ): 種別 (ランダム/貴金属/薬物) + 「フィールドに置く」「推しに送る」。
- `VillageScene` がフィールドに 💎/💊 を描画 (拾われると消える)。`village-status` に落とし物数。

## 開いた判断 / 今後

- 薬物の `drug` eventParam は現状減衰しない (依存が残る表現)。観戦して必要なら定期減衰を入れる。
- 効果値は sim 内定数 (`DEFAULT_ITEMS`)。バランス次第で暗号化 config 化。
- 拾得は日末の最寄り 1 体。セグメント単位の空間的拾得 (歩いて踏む) にするかは観戦して判断。
