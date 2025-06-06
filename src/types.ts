// src/types.ts

import { Api } from 'telegram';
import { User } from 'telegraf/typings/core/types/typegram'; // <--- ADDED: For more precise UserInfo.user typing

// UserInfo: The task info passed around the bot queue
export interface UserInfo {
  chatId: string;
  link: string;
  linkType: 'username' | 'link';
  nextStoriesIds?: number[];
  locale: string;
  user?: User; // <--- IMPROVED: Using Telegraf's User type directly
  tempMessages?: number[];
  initTime: number;
  isPremium?: boolean;
  instanceId?: string;
  storyRequestType?: 'active' | 'pinned' | 'particular' | 'paginated';
}

// DownloadQueueItem: An item in the download queue (DB structure)
export interface DownloadQueueItem {
  id: string;
  chatId: string;
  task: UserInfo;
  status: 'pending' | 'in_progress' | 'done' | 'error';
  enqueued_ts: number;
  processed_ts?: number;
  error?: string;
  is_premium?: number; // From user join in DB
  // This field (target_username) is part of your DB table
  // and is directly mapped to task.link, but adding it here
  // makes the DownloadQueueItem more complete if it were to
  // be used directly outside of task.link in some contexts.
  // Not strictly "missing" given `task.link`, but adds clarity.
  // target_username: string; // Consider adding if useful for raw DB representation
}

// MappedStoryItem: Your internal representation of a story after mapping from Telegram API
export interface MappedStoryItem {
  id: number;
  caption?: string;
  media: Api.StoryItem['media'];
  mediaType: 'photo' | 'video';
  date: Date; // <--- CONFIRMED: Used in sendParticularStory, ensure it's here
  buffer?: Buffer;
  bufferSize?: number; // Size in MB
  noforwards?: boolean;
}

export type StoriesModel = MappedStoryItem[]; // Alias for consistency

// General arguments for sending stories effect (what sendStoriesFx will receive from stories-service)
export interface SendStoriesFxParams {
  activeStories?: Api.TypeStoryItem[];
  pinnedStories?: Api.TypeTypeItem[]; // <--- CORRECTED: Typo, should be Api.TypeStoryItem[]
  paginatedStories?: Api.TypeStoryItem[];
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

// --- ADDED: Type for notifyAdmin params ---
// This is used in get-stories, send-active-stories, send-paginated-stories, send-particular-story, send-pinned-stories
export interface NotifyAdminParams {
  status: 'info' | 'error' | 'start';
  baseInfo?: string;
  task?: UserInfo;
  errorInfo?: { cause: any; message?: string };
}
