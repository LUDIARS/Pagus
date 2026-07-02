// アカウント関連 UI (§v1.3-F)。
// 課金は課金タブ、ユーザーコード/別端末ログイン/ユーザー名は設定メニューへ分ける。

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** ユーザーコード (=userId) が UUID 形式か (空/不正は false)。 */
export function isValidUserCode(code: string): boolean {
  return code.length > 0 && UUID_RE.test(code);
}

export interface AccountHandlers {
  /** 課金 (モック): 固定パック額でカルマ + 課金額を増やす。 */
  onTopup(amount: number): void;
}

export interface AccountSettingsHandlers {
  /** 別端末ログイン: ユーザーコードで現セッションを束ね直す。 */
  onLogin(code: string): void;
  /** ユーザー名を保存する。空文字は未設定。 */
  onUserName(name: string): void;
}

/** 課金パック (モック)。固定 3 種。 */
const TOPUP_PACKS = [100, 500, 1000];

export class AccountPanel {
  private readonly spentEl = document.createElement('span');

  constructor(
    private readonly root: HTMLElement,
    private readonly h: AccountHandlers,
  ) {
    this.root.replaceChildren();
    const head = document.createElement('h3');
    head.textContent = '💴 課金';
    this.root.appendChild(head);

    // 課金 (モック) ボタン。
    this.root.appendChild(subLabel('課金 (モック)'));
    const spentRow = document.createElement('div');
    spentRow.className = 'muted';
    spentRow.append('累計課金額: ');
    this.spentEl.textContent = '¥0';
    spentRow.appendChild(this.spentEl);
    this.root.appendChild(spentRow);

    const packBtns = document.createElement('div');
    packBtns.className = 'topup-btns';
    for (const amount of TOPUP_PACKS) {
      const btn = document.createElement('button');
      btn.className = 'topup-btn';
      btn.textContent = `¥${amount}`;
      btn.addEventListener('click', () => this.h.onTopup(amount));
      packBtns.appendChild(btn);
    }
    this.root.appendChild(packBtns);
  }

  /** 自分の累計課金額を反映する (playerState 受信時)。 */
  setSpent(spent: number): void {
    this.spentEl.textContent = `¥${spent}`;
  }
}

export class AccountSettingsPanel {
  private readonly nameInput = document.createElement('input');
  private readonly nameBtn = document.createElement('button');

  constructor(
    private readonly root: HTMLElement,
    private readonly myUserId: string,
    initialUserName: string | null,
    private readonly h: AccountSettingsHandlers,
  ) {
    this.root.replaceChildren();

    const head = document.createElement('div');
    head.className = 'settings-section-title';
    head.textContent = 'アカウント';
    this.root.appendChild(head);

    // ユーザー名。
    this.root.appendChild(subLabel('ユーザー名'));
    const nameRow = document.createElement('div');
    nameRow.className = 'acct-code-row';
    this.nameInput.className = 'acct-login';
    this.nameInput.maxLength = 20;
    this.nameInput.placeholder = '未設定';
    this.nameInput.value = initialUserName ?? '';
    this.nameBtn.className = 'acct-login-btn';
    this.nameBtn.textContent = '保存';
    const saveName = (): void => {
      this.h.onUserName(this.nameInput.value);
      this.nameBtn.textContent = '✓';
      setTimeout(() => (this.nameBtn.textContent = '保存'), 1200);
    };
    this.nameBtn.addEventListener('click', saveName);
    this.nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') saveName();
    });
    nameRow.append(this.nameInput, this.nameBtn);
    this.root.appendChild(nameRow);

    // 自分のユーザーコード (コピー可能)。
    this.root.appendChild(subLabel('あなたのユーザーコード'));
    const codeRow = document.createElement('div');
    codeRow.className = 'acct-code-row';
    const codeInput = document.createElement('input');
    codeInput.className = 'acct-code';
    codeInput.value = this.myUserId;
    codeInput.readOnly = true;
    codeInput.addEventListener('focus', () => codeInput.select());
    const copyBtn = document.createElement('button');
    copyBtn.className = 'acct-copy';
    copyBtn.textContent = 'コピー';
    copyBtn.addEventListener('click', () => {
      codeInput.select();
      void navigator.clipboard?.writeText(this.myUserId).then(
        () => {
          copyBtn.textContent = '✓';
          setTimeout(() => (copyBtn.textContent = 'コピー'), 1500);
        },
        () => {
          copyBtn.textContent = '失敗';
          setTimeout(() => (copyBtn.textContent = 'コピー'), 1500);
        },
      );
    });
    codeRow.append(codeInput, copyBtn);
    this.root.appendChild(codeRow);

    // 別端末ログイン入力。
    this.root.appendChild(subLabel('別端末ログイン'));
    const loginRow = document.createElement('div');
    loginRow.className = 'acct-code-row';
    const loginInput = document.createElement('input');
    loginInput.className = 'acct-login';
    loginInput.placeholder = 'ユーザーコードを貼り付け';
    const loginBtn = document.createElement('button');
    loginBtn.className = 'acct-login-btn';
    loginBtn.textContent = 'ログイン';
    const submit = (): void => {
      const code = loginInput.value.trim();
      if (!isValidUserCode(code)) {
        loginBtn.textContent = '不正なコード';
        setTimeout(() => (loginBtn.textContent = 'ログイン'), 2000);
        return;
      }
      this.h.onLogin(code);
    };
    loginBtn.addEventListener('click', submit);
    loginInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
    loginRow.append(loginInput, loginBtn);
    this.root.appendChild(loginRow);
  }

  /** サーバから返った現在名を反映する。 */
  setUserName(name: string | null, force = false): void {
    if (!force && document.activeElement === this.nameInput) return;
    this.nameInput.value = name ?? '';
  }
}

function subLabel(text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'sub';
  el.textContent = text;
  return el;
}
