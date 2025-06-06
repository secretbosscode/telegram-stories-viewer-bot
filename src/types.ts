// src/types.ts

import { Api } from 'telegram'; // Needed for Api.TypeStoryItem

// UserInfo: The task info passed around the bot queue
export interface UserInfo {
  chatId: string;
  link: string;
  linkType: 'username' | 'link';
  nextStoriesIds?: number[];
  locale: string;
  user?: any; // Refine as needed, e.g., 'telegraf/typings/core/types/typegram'.User
  tempMessages?: number[];
  initTime: number;
  isPremium?: boolean;
  instanceId?: string; // Used by orchestrator for unique task ID
  storyRequestType?: 'active' | 'pinned' | 'particular' | 'paginated'; // Crucial for dispatcher logic
}

// DownloadQueueItem: An item in the download queue (DB structure)
export interface DownloadQueueItem {
  id: string; // Changed from number to string to match DB output
  chatId: string; // Mapped from telegram_id in DB
  task: UserInfo; // Contains detailed task info
  status: 'pending' | 'in_progress' | 'done' | 'error';
  enqueued_ts: number;
  processed_ts?: number;
  error?: string;
  is_premium?: number; // From user join in DB
  // Add other properties that getNextQueueItem might return if needed for DownloadQueueItem directly
  // such as target_username which is now within task.link
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
  // It could be a single raw API story, or an array of raw API stories for various types.
  // This allows sendStoriesFx to differentiate and dispatch.
  activeStories?: Api.TypeStoryItem[];
  pinnedStories?: Api.TypeStoryItem[];
  paginatedStories?: Api.TypeStoryItem[];
  particularStory?: Api.TypeStoryItem;
  task: UserInfo;
}

// Arguments specific to sendActiveStories, sendPinnedStories (they expect mapped Story[])
export interface SendStoriesArgs {
  stories: MappedStoryItem[]; // Mapped stories (MappedStoryItem[])
  task: UserInfo;
}

// Arguments specific to sendPaginatedStories (expects raw Api.TypeStoryItem[])
export type SendPaginatedStoriesArgs = Omit<SendStoriesArgs, 'stories'> & { stories: Api.TypeStoryItem[] };

// Arguments specific to sendParticularStory (expects single raw Api.TypeStoryItem)
export type SendParticularStoryArgs = Omit<SendStoriesArgs, 'stories'> & { story: Api.TypeStoryItem };

export type TempMessage = { message_id: number }; // Not directly used in our discussions, but from your snippet
