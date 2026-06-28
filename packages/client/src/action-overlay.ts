// 統合アクションオーバーレイ (§v1.3-E)。増えたユーザ操作 (操作/カード/村/裁判/経済/情報) を
// 1 つのタブ式パネルへ集約し、上部に常時ヘッダ (カルマ残高 / 善性 / 課金 / 推し / クールダウン) を出す。
//
// 本クラスは「枠」の責務だけを持つ: タブ切替・ヘッダ描画・開閉 (ドロワー)。
// 各操作パネル (PlayerControls / CardPanel / EconomyPanel / GovernancePanel / TrialPanel /
// BetPanel / LeaderboardPanel / SpectaclePanel / StatusPanel / AccountPanel) は従来どおり
// それぞれのクラスが該当タブ内の DOM (#controls 等) へ mount する (送信/受信ロジックは無改変)。

/** ヘッダに出す自分の状態 (playerState 受信から組む)。 */
export interface OverlayPlayerState {
  karma: number;
  virtue: number;
  spent: number;
  championId: string | null;
  championName?: string;
  /** 応援クールダウンの残り (ms)。0 以下で「いま可能」。 */
  canCheerInMs: number;
}

export class ActionOverlay {
  private state: OverlayPlayerState | null = null;
  /** state を受信した時刻 (クールダウン残のローカル減算用)。 */
  private stateAt = 0;
  private openFlag = true;
  private readonly sections: HTMLElement[];
  private readonly tabButtons = new Map<string, HTMLButtonElement>();

  constructor(
    private readonly root: HTMLElement,
    private readonly headerBox: HTMLElement,
    private readonly tabBar: HTMLElement,
    toggleBtn: HTMLElement,
    private readonly backdrop: HTMLElement,
  ) {
    // data-tab セクションを集め、data-label でタブボタンを生成する。
    this.sections = Array.from(root.querySelectorAll<HTMLElement>('.ao-tab'));
    for (const sec of this.sections) {
      const id = sec.dataset.tab ?? '';
      const btn = document.createElement('button');
      btn.className = 'ao-tab-btn';
      btn.textContent = sec.dataset.label ?? id;
      btn.addEventListener('click', () => this.selectTab(id));
      this.tabBar.appendChild(btn);
      this.tabButtons.set(id, btn);
    }
    this.selectTab(this.sections[0]?.dataset.tab ?? '');

    toggleBtn.addEventListener('click', () => this.setOpen(!this.openFlag));
    this.backdrop.addEventListener('click', () => this.setOpen(false));

    // 起動時: 広い画面は開、狭い画面 (モバイル) はドロワーを閉じておく。
    this.setOpen(!this.isNarrow());

    this.renderHeader();
    // クールダウン残を毎秒詰める (playerState の再送を待たずに表示を進める)。
    setInterval(() => this.renderHeader(), 1000);
  }

  /** 自分の状態を反映する (playerState 受信時)。 */
  setPlayerState(s: OverlayPlayerState): void {
    this.state = s;
    this.stateAt = Date.now();
    this.renderHeader();
  }

  private selectTab(id: string): void {
    for (const sec of this.sections) {
      sec.style.display = sec.dataset.tab === id ? 'flex' : 'none';
    }
    for (const [tid, btn] of this.tabButtons) {
      btn.classList.toggle('active', tid === id);
    }
  }

  private setOpen(open: boolean): void {
    this.openFlag = open;
    this.root.classList.toggle('closed', !open);
    // backdrop は狭い画面でのみ (デスクトップは中央ステージを覆わない)。
    this.backdrop.classList.toggle('show', open && this.isNarrow());
  }

  private isNarrow(): boolean {
    return window.matchMedia('(max-width: 860px)').matches;
  }

  private renderHeader(): void {
    this.headerBox.replaceChildren();
    const s = this.state;
    if (!s) {
      this.headerBox.appendChild(chip('接続待ち…', ''));
      return;
    }
    const cd = Math.max(0, s.canCheerInMs - (Date.now() - this.stateAt));
    const champ = s.championId ? (s.championName ?? '指名中') : '未指名';
    this.headerBox.append(
      chip('💠 カルマ', s.karma.toFixed(1)),
      chip('😇 善性', s.virtue.toFixed(2)),
      chip('💴 課金', `¥${s.spent}`),
      chip('⭐ 推し', champ),
      chip('🌸 応援', cd <= 0 ? '可' : `${Math.ceil(cd / 1000)}s`),
    );
  }
}

/** ヘッダ用の小チップ (ラベル + 値)。値が空ならラベルのみ。 */
function chip(label: string, value: string): HTMLElement {
  const box = document.createElement('div');
  box.className = 'ao-chip';
  const l = document.createElement('span');
  l.className = 'ao-chip-label';
  l.textContent = label;
  box.appendChild(l);
  if (value) {
    const v = document.createElement('span');
    v.className = 'ao-chip-val';
    v.textContent = value;
    box.appendChild(v);
  }
  return box;
}
