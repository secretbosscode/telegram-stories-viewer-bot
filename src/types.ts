// src/types.ts

// UserInfo: The task info passed around the bot queue
export interface UserInfo {
  chatId: string;
  link: string;
  linkType: 'link' | 'username';
  nextStoriesIds?: number[];
  locale?: string;
  user: any; // You may want to type this more strictly
  initTime: number;
  isPremium: boolean;
}

// DownloadQueueItem: An item in the download queue (if you use this pattern)
export interface DownloadQueueItem {
  id: string;
  chatId: string;
  task: UserInfo;
  status: 'pending' | 'in_progress' | 'done' | 'error';
}

export type TempMessage = { message_id: number };
