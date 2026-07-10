# Pagus データスキーマ

Pagus の runtime データはローカル SQLite (data/runtime/pagus.sqlite) を権威ソースとする。
個人プロフィールは保持せず、ユーザーは Cernere の userId だけをアンカーとして扱う。

| データ名 | 種類 | 権威ソース | 保存先 | 保護 | 保持・メモリ方針 |
|---|---|---|---|---|---|
| 現在の world | user | Pagus | SQLite kv | 不要 | 単一スナップショット。進行に必要な現在状態だけメモリに置く |
| 村の年代記・イベント再生 | user | Pagus | chronicle | 不要 | DB 10,000件、配信は直近200件 |
| チャット | user | Pagus | chat_messages | 要 | DB 5,000件。ユーザーIDと発言を保持し、秘密・プロフィール属性は記録しない |
| プレイヤー・住民行動 | user | Pagus | action_log | 要 | 種別ごとDB 10,000件。world BLOBには含めず、住民行動は直近100件だけメモリへ復元 |
| セッション進行ログ | user | Pagus | session_log | 不要 | DB 50,000件。秘密・個人データを本文へ出さない |
| シーズン履歴 | user | Pagus | season_history | 不要 | DB 1,000件。追記時に全履歴をロードしない |
| 住民間関係 | user | Pagus | world / archived_relationships | 不要 | 生存住民間だけメモリ。退場住民分はDBへ退避し、復活時に必要分を戻す |
| ユーザー信仰 | user | Pagus | world / archived_user_faith | 要 | userId のみ保持。退場住民分はDBへ退避 |

既存 world.json / chronicle.json / chat.json / seasons.json は初回移行元であり、DB移行後は権威ではない。
DDL は CREATE TABLE/INDEX IF NOT EXISTS と追加のみで冪等に適用し、既存カラム・テーブルを削除しない。
