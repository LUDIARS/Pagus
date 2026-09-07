# 教育差分の適用と比較PNGの配送

- Date: 2026-09-07
- Status: fixed in working tree (delivery accepted; remote receipt not independently verified)
- Area: Pagus education / session artifact delivery

## Evidence and cause

教育のプロンプト・Reform型・StubBrainはいずれも traits を差分とするが、TermMachine.reform は上書きしていた。例: aggression 0.7 に -0.5 の教育をすると -0.5 になる。正しくは 0.2。既存の不整合であり、今回の変更で発生した回帰ではない。

ユーザーから「PNG送れてない」と報告。比較画像はローカルで表示できていたが、会話のローカルパス参照だけではDiscordの添付にならなかった。Lictorの既存 send-file-relay に記載されている配送上の落とし穴の再発。

## Fix and verification

- traits は有限の既知軸だけ加算し0..1に制限。教育前後の記録と外見・行動方向を同時保存する。
- PNGを自分のLictor `/v1/chat`、channel=system、attachment_paths で送信。受付メッセージ8660にPNG添付パスを確認した。Discord側での受信は未確認。
- テストはユーザー方針に従い未実行。確認すべき条件は差分加算・上下限・旧保存互換・添付の受信。ブラウザ接続も利用不可だったため、モデル比較は同じ頂点からオフライン出力した。

## Follow-up

リモートに画像を見せるときはPNG添付を利用し、ローカルリンクだけで送信完了と表現しない。配送受付と実際の受信を区別する。
