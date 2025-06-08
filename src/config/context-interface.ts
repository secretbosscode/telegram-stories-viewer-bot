import { Context, Scenes } from 'telegraf';
import { User } from 'telegraf/typings/core/types/typegram';
import { PaymentRow } from 'db';

export interface UserSession extends User {
  messagesToRemove: number[];
}

interface SceneSession extends Scenes.SceneSession {
  usersList: UserSession[] | undefined;
  upgrade?: {
    invoice: PaymentRow;
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
