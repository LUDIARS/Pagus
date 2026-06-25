# Pagus

> AI村 — LLM 駆動の創発的村シミュレーション。村人が自律行動し、事件 → 裁判 → 教育(改変) を繰り返して村が変容する。

LUDIARS プロジェクトコード **Pa** (Pagus = ラテン語「村」)。

## クイックスタート

```bash
pnpm install
pnpm build
# 開発実行 (dev server) はリポジトリの運用規約により手動起動のみ
```

## パッケージ

| パッケージ | 役割 |
|---|---|
| [`@pagus/sim`](packages/sim) | シミュレーション核 (純 TS, テスト可) |
| [`@pagus/server`](packages/server) | 権威サーバ + LLM オーケストレーション (`claude -p`) |
| [`@pagus/client`](packages/client) | 2D 描画 + UI (Vite + PixiJS) |

## 設計

[`spec/SPEC.md`](spec/SPEC.md) が設計正本。仕様変更は spec への PR を正本とする。
