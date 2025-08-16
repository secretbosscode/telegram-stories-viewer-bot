export interface UserInfo {
  chatId: string;
  link: string;
  linkType: 'username' | 'link';
  nextStoriesIds?: number[];
  locale: string;
  user?: any;  // Refine as needed
  tempMessages?: number[];
  initTime: number;
  isPremium?: boolean;
  instanceId?: string;
  storyRequestType?: 'active' | 'pinned' | 'archived' | 'particular' | 'paginated' | 'global';
  isPaginated?: boolean;
}
