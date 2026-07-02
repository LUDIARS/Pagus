import type { ChatMessage } from '@pagus/sim';

export class ChatPanel {
  private messages: ChatMessage[] = [];
  private readonly list = document.createElement('div');
  private readonly input = document.createElement('input');

  constructor(
    private readonly root: HTMLElement,
    private readonly myUserId: string,
    private readonly onSend: (text: string) => void,
  ) {
    this.root.replaceChildren();
    const head = document.createElement('h3');
    head.textContent = '💬 チャット';
    this.list.className = 'chat-list';

    const form = document.createElement('div');
    form.className = 'chat-form';
    this.input.className = 'chat-input';
    this.input.maxLength = 160;
    this.input.placeholder = 'メッセージ';
    const send = document.createElement('button');
    send.className = 'chat-send';
    send.textContent = '送信';

    const submit = (): void => {
      const text = this.input.value.trim();
      if (!text) return;
      this.onSend(text);
      this.input.value = '';
    };
    send.addEventListener('click', submit);
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });

    form.append(this.input, send);
    this.root.append(head, this.list, form);
    this.render();
  }

  setMessages(messages: ChatMessage[]): void {
    this.messages = messages;
    this.render();
  }

  private render(): void {
    this.list.replaceChildren();
    if (this.messages.length === 0) {
      this.list.appendChild(div('まだ会話はありません。', 'muted'));
      return;
    }
    for (const msg of this.messages) {
      const row = div('', 'chat-row');
      const meta = div('', 'chat-meta');
      const name = div(displayName(msg.userId, msg.userName, this.myUserId), 'chat-name');
      const time = div(timeLabel(msg.at), 'chat-time');
      meta.append(name, time);
      row.append(meta, div(msg.text, 'chat-text'));
      this.list.appendChild(row);
    }
    this.list.scrollTop = this.list.scrollHeight;
  }
}

function displayName(userId: string, name: string | null, myUserId: string): string {
  if (name) return name;
  if (userId === myUserId) return 'あなた';
  return userId.length > 6 ? `${userId.slice(0, 6)}…` : userId;
}

function timeLabel(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function div(text: string, cls: string): HTMLElement {
  const el = document.createElement('div');
  if (text) el.textContent = text;
  el.className = cls;
  return el;
}
