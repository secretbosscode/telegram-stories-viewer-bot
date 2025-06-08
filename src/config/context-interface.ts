import { Context, Scenes } from 'telegraf';
import { User } from 'telegraf/typings/core/types/typegram';

export interface UserSession extends User {
  messagesToRemove: number[];
}

interface SceneSession extends Scenes.SceneSession {
  usersList: UserSession[] | undefined;
  upgrade?: {
    invoice: { address: string; amountBtc: number };
    awaitingAddressUntil: number;
    fromAddress?: string;
    checkStart?: number;
    timerId?: any;
  };
}

export interface IContextBot extends Context {
  scene: Scenes.SceneContextScene<IContextBot>;
  session: SceneSession;
}
