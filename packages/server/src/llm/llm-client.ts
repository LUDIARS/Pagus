// LLM 呼び出しの唯一の境界 (server 内)。
// sim の Brain とは別レイヤ — Brain 実装 (LlmBrain) がこの client を使って実 LLM を叩く。
// transport (CLI / SDK / mock) はこの interface の裏に隠れる。

/** LLM へ 1 回問い合わせる引数。 */
export interface LlmInvokeArgs {
  /** ユーザメッセージ本文。 */
  prompt: string;
  /** 固定の指示 (人格・出力規約)。prefix-cache の錨になるよう不変断片を載せる。 */
  system?: string;
  /** モデル ID。未指定なら client 既定 (= backend.model)。 */
  model?: string;
  /** 出力トークン上限 (CLI 経路では参考値)。 */
  maxTokens?: number;
  /** タイムアウト ms。 */
  timeoutMs?: number;
}

/**
 * LLM クライアント。
 *
 * 失敗 (spawn 失敗 / 非ゼロ終了 / タイムアウト / 空出力) は **throw** する。
 * 無言フォールバック禁止 (RULE_CODE §7.1) — 呼び出し側は成功テキストのみ受け取る。
 */
export interface LlmClient {
  invoke(args: LlmInvokeArgs): Promise<{ text: string }>;
}
