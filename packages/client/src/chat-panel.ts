import type { ChatMessage } from '@pagus/sim';

export interface ChatPanelOptions {
  title?: string | null;
  placeholder?: string;
  emptyText?: string;
  readOnly?: boolean;
}

export class ChatPanel {
  private messages: ChatMessage[] = [];
  private readonly list = document.createElement('div');
  private readonly input = document.createElement('input');
  private readonly emptyText: string;

  constructor(
    private readonly root: HTMLElement,
    private readonly myUserId: string,
    private readonly onSend: (text: string) => void,
    private readonly options: ChatPanelOptions = {},
  ) {
    this.emptyText = options.emptyText ?? 'まだ会話はありません。';
    this.root.replaceChildren();
    const children: HTMLElement[] = [];
    if (options.title !== null) {
      const head = document.createElement('h3');
      head.textContent = options.title ?? '💬 チャット';
      children.push(head);
    }
    this.list.className = 'chat-list';
    children.push(this.list);

    if (!options.readOnly) {
      const form = document.createElement('div');
      form.className = 'chat-form';
      this.input.className = 'chat-input';
      this.input.maxLength = 160;
      this.input.placeholder = options.placeholder ?? 'メッセージ';
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
      children.push(form);
    }
    this.root.append(...children);
    this.render();
  }

  setMessages(messages: ChatMessage[]): void {
    this.messages = messages;
    this.render();
  }

  private render(): void {
    this.list.replaceChildren();
    if (this.messages.length === 0) {
      this.list.appendChild(div(this.emptyText, 'muted'));
      return;
    }
    for (const msg of this.messages) {
      const row = div('', 'chat-row');
      row.classList.add(`chat-row-${msg.speakerKind}`);
      if (msg.userId === this.myUserId) row.classList.add('chat-row-self');
      const meta = div('', 'chat-meta');
      const name = div(displayName(msg, this.myUserId), 'chat-name');
      const time = div(timeLabel(msg.at), 'chat-time');
      meta.append(name, time);
      row.append(meta, div(msg.text, 'chat-text'));
      this.list.appendChild(row);
    }
    this.list.scrollTop = this.list.scrollHeight;
  }
}

function displayName(msg: ChatMessage, myUserId: string): string {
  if (msg.speakerKind === 'villager') return msg.userName ?? '住民';
  if (msg.speakerKind === 'system') return msg.userName ?? 'システム';
  if (msg.userName) return msg.userName;
  if (msg.userId === myUserId) return 'あなた';
  return msg.userId.length > 6 ? `${msg.userId.slice(0, 6)}…` : msg.userId;
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
