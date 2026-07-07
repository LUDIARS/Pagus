import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ChatChannel, ChatMessage, ChatSpeakerKind } from '@pagus/sim';
import { dataDir } from './load-data.js';
import { runtimeDb } from './runtime-db.js';

const CHAT_CAP = 500;
const CHANNELS = new Set<ChatChannel>(['god', 'human', 'dm']);
const SPEAKERS = new Set<ChatSpeakerKind>(['human', 'villager', 'system']);

export class ChatStore {
  private readonly legacyPath: string;
  private readonly db = runtimeDb();
  private messages: ChatMessage[];

  constructor() {
    this.legacyPath = resolve(dataDir(), 'runtime', 'chat.json');
    this.messages = this.load();
  }

  all(n = 300): ChatMessage[] {
    return this.messages.slice(-n);
  }

  add(message: ChatMessage): ChatMessage[] {
    this.messages.push(message);
    if (this.messages.length > CHAT_CAP) this.messages = this.messages.slice(-CHAT_CAP);
    this.db.addChat(message);
    return this.all();
  }

  addMany(messages: ChatMessage[]): ChatMessage[] {
    this.messages.push(...messages);
    if (this.messages.length > CHAT_CAP) this.messages = this.messages.slice(-CHAT_CAP);
    this.db.addChats(messages);
    return this.all();
  }

  updateUserName(userId: string, userName: string | null): ChatMessage[] {
    let changed = false;
    for (const msg of this.messages) {
      if (msg.speakerKind !== 'human' || msg.userId !== userId || msg.userName === userName) continue;
      msg.userName = userName;
      changed = true;
    }
    if (changed) this.db.replaceChat(this.messages);
    return this.all();
  }

  private load(): ChatMessage[] {
    const stored = this.db.recentChat(CHAT_CAP);
    if (stored.length > 0 || this.db.chatCount() > 0) return stored;

    const legacy = this.loadLegacyJson();
    if (legacy.length > 0) this.db.replaceChat(legacy);
    return legacy;
  }

  private loadLegacyJson(): ChatMessage[] {
    try {
      const raw = JSON.parse(readFileSync(this.legacyPath, 'utf8')) as unknown;
      if (!Array.isArray(raw)) return [];
      return raw.map(coerceChatMessage).filter((msg): msg is ChatMessage => msg !== null).slice(-CHAT_CAP);
    } catch {
      return [];
    }
  }
}

function coerceChatMessage(raw: unknown): ChatMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Partial<ChatMessage>;
  if (typeof obj.id !== 'string' || typeof obj.userId !== 'string' || typeof obj.text !== 'string') return null;
  const channel = CHANNELS.has(obj.channel as ChatChannel) ? obj.channel as ChatChannel : 'human';
  const speakerKind = SPEAKERS.has(obj.speakerKind as ChatSpeakerKind) ? obj.speakerKind as ChatSpeakerKind : 'human';
  const msg: ChatMessage = {
    id: obj.id,
    channel,
    speakerKind,
    userId: obj.userId,
    userName: typeof obj.userName === 'string' ? obj.userName : null,
    text: obj.text,
    at: typeof obj.at === 'number' ? obj.at : Date.now(),
  };
  if (typeof obj.villagerId === 'string') msg.villagerId = obj.villagerId;
  if (typeof obj.dmWithVillagerId === 'string') msg.dmWithVillagerId = obj.dmWithVillagerId;
  if (Array.isArray(obj.keywords)) {
    const keywords = obj.keywords.filter((x): x is string => typeof x === 'string').slice(0, 8);
    if (keywords.length > 0) msg.keywords = keywords;
  }
  return msg;
}
