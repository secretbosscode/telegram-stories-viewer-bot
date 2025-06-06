// Just for type definitions! No logic here.
import { User } from 'telegraf/typings/core/types/typegram';

export interface UserInfo {
  chatId: string;
  link: string;
  linkType: 'username' | 'link';
  nextStoriesIds?: number[];
  locale: string;
  user?: User;
  tempMessages?: number[];
  initTime: number;
  isPremium?: boolean;
  instanceId?: string;
}
