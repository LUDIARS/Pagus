import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ChatChannel, ChatMessage, ChatSpeakerKind } from '@pagus/sim';
import { dataDir } from './load-data.js';
import { runtimeDb, type RuntimeDb } from './runtime-db.js';

const CHAT_CAP = 500;
const DISPLAY_NAME_CAP = 1_000;
const CHANNELS = new Set<ChatChannel>(['god', 'human', 'dm']);
const SPEAKERS = new Set<ChatSpeakerKind>(['human', 'villager', 'system']);

export class ChatStore {
  private readonly legacyPath: string;
  private readonly db: RuntimeDb;
  private readonly displayNames = new Map<string, string>();

  constructor(db: RuntimeDb = runtimeDb(), legacyPath = resolve(dataDir(), 'runtime', 'chat.json')) {
    this.db = db;
    this.legacyPath = legacyPath;
    this.migrateLegacy();
  }

  all(n = 300): ChatMessage[] {
    return this.db.recentChat(Math.min(n, CHAT_CAP)).map((message) => {
      const userName = message.speakerKind === 'human' ? this.displayNames.get(message.userId) : undefined;
      return userName === undefined ? message : { ...message, userName };
    });
  }

  add(message: ChatMessage): ChatMessage[] {
    this.rememberDisplayName(message);
    this.db.addChat(message);
    return this.all();
  }

  addMany(messages: ChatMessage[]): ChatMessage[] {
    for (const message of messages) this.rememberDisplayName(message);
    this.db.addChats(messages);
    return this.all();
  }

  updateUserName(userId: string, userName: string | null): ChatMessage[] {
    this.displayNames.delete(userId);
    if (userName !== null) this.displayNames.set(userId, userName);
    return this.all();
  }

  private rememberDisplayName(message: ChatMessage): void {
    if (message.speakerKind !== 'human' || !message.userName) return;
    this.displayNames.delete(message.userId);
    this.displayNames.set(message.userId, message.userName);
    if (this.displayNames.size <= DISPLAY_NAME_CAP) return;
    const oldest = this.displayNames.keys().next().value as string | undefined;
    if (oldest !== undefined) this.displayNames.delete(oldest);
  }

  private migrateLegacy(): void {
    if (this.db.chatCount() > 0) return;
    const legacy = this.loadLegacyJson();
    if (legacy.length > 0) this.db.replaceChat(legacy);
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
