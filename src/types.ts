// src/types.ts

import { Api } from 'telegram';
import { User } from 'telegraf/typings/core/types/typegram';

// UserInfo: The task info passed around the bot queue
export interface UserInfo {
  chatId: string;
  link: string;
  linkType: 'username' | 'link';
  nextStoriesIds?: number[];
  locale: string;
  user?: User; // Using Telegraf's User type directly
  tempMessages?: number[];
  initTime: number;
  isPremium?: boolean;
  instanceId?: string;
  storyRequestType?: 'active' | 'pinned' | 'archived' | 'particular' | 'paginated' | 'global';
  isPaginated?: boolean;
  includeHiddenStories?: boolean;
  offset?: number;
  globalStoriesMessageId?: number;
}

// DownloadQueueItem: An item in the download queue (DB structure)
export interface DownloadQueueItem {
  id: string; // Changed from number to string to match DB output
  chatId: string; // Mapped from telegram_id in DB
  task: UserInfo; // Contains detailed task info
  status: 'pending' | 'processing' | 'done' | 'error';
  enqueued_ts: number;
  processed_ts?: number;
  error?: string;
  is_premium?: number; // From user join in DB
  // Optional: target_username is part of your DB table, adding for clarity if useful for raw DB representation
  // target_username?: string;
}

// MappedStoryItem: Your internal representation of a story after mapping from Telegram API
export interface MappedStoryItem {
  id: number;
  caption?: string;
  media: Api.StoryItem['media'];
  mediaType: 'photo' | 'video';
  date: Date;
  buffer?: Buffer;
  bufferSize?: number; // Size in MB
  noforwards?: boolean;
}

export type StoriesModel = MappedStoryItem[]; // Alias for consistency

// General arguments for sending stories effect (what sendStoriesFx will receive from stories-service)
export interface SendStoriesFxParams {
  activeStories?: Api.TypeStoryItem[];
  pinnedStories?: Api.TypeStoryItem[]; // **FIXED:** Changed 'Api.TypeTypeItem' to 'Api.TypeStoryItem'
  archivedStories?: Api.TypeStoryItem[];
  paginatedStories?: Api.TypeStoryItem[];
  globalStories?: Api.TypeStoryItem[];
  particularStory?: Api.TypeStoryItem;
  task: UserInfo;
}

// Arguments specific to sendActiveStories, sendPinnedStories
export interface SendStoriesArgs {
  stories: MappedStoryItem[];
  task: UserInfo;
}

// Arguments specific to sendPaginatedStories
export type SendPaginatedStoriesArgs = Omit<SendStoriesArgs, 'stories'> & { stories: Api.TypeStoryItem[] };

// Arguments specific to sendParticularStory
export type SendParticularStoryArgs = Omit<SendStoriesArgs, 'stories'> & { story: Api.TypeStoryItem };

export type TempMessage = { message_id: number };

// Type for notifyAdmin params
export interface NotifyAdminParams {
  status: 'info' | 'error' | 'start';
  baseInfo?: string;
  task?: UserInfo;
  errorInfo?: { cause: any; message?: string };
}

export interface BlockedUserRow {
  telegram_id: string;
  blocked_at: number;
  is_bot: number;
}
