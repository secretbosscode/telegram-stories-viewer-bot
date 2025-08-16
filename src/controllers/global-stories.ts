import { IContextBot } from 'config/context-interface';
import { handleNewTask } from 'services/queue-manager';
import { isUserPremium } from 'services/premium-service';
import { sendTemporaryMessage } from 'lib';
import { bot } from 'index';
import { t } from 'lib/i18n';
import { UserInfo } from 'types';

/**
 * Handle the `/globalstories` command.
 * Premium users can fetch stories from the global feed.
 */
export async function handleGlobalStories(ctx: IContextBot): Promise<void> {
  const userId = String(ctx.from!.id);
  const locale = ctx.from?.language_code || 'en';
  if (!isUserPremium(userId)) {
    await sendTemporaryMessage(bot, ctx.chat!.id, t(locale, 'feature.requiresPremium'));
    return;
  }

  const task: UserInfo = {
    chatId: String(ctx.chat!.id),
    link: t(locale, 'global.label'),
    linkType: 'username',
    locale,
    user: ctx.from,
    initTime: Date.now(),
    isPremium: true,
    storyRequestType: 'global',
  };

  handleNewTask(task);
}
