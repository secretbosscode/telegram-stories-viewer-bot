import { Userbot } from 'config/userbot';
import { bot } from 'index';
import { Markup } from 'telegraf';
import { Api } from 'telegram';

import { t } from 'lib/i18n';
import { MappedStoryItem, StorySourceContext, UserInfo } from 'types';

function resolveIdentifier(source: StorySourceContext | undefined, fallback?: string): string | undefined {
  return source?.identifier || source?.displayName || fallback;
}

export async function sendStoryFallbacks(task: UserInfo, stories: MappedStoryItem[]) {
  if (!stories || stories.length === 0) return;

  const client = await Userbot.getInstance();
  const peerCache = new Map<string, Api.TypeInputPeer>();

  for (const story of stories) {
    try {
      const identifier = resolveIdentifier(story.source, task.link);
      if (!identifier && !story.source?.peer) {
        console.warn(`[StoryFallback] Missing identifier for story ${story.id}; skipping fallback message.`);
        continue;
      }

      let inputPeer = story.source?.peer;
      if (!inputPeer) {
        const cacheKey = identifier!;
        inputPeer = peerCache.get(cacheKey);
        if (!inputPeer) {
          inputPeer = (await client.getInputEntity(identifier!)) as Api.TypeInputPeer;
          peerCache.set(cacheKey, inputPeer);
        }
        story.source = {
          ...(story.source ?? {}),
          identifier: identifier!,
          peer: inputPeer,
        };
      }

      const exported = await client.invoke(
        new Api.stories.ExportStoryLink({ peer: inputPeer, id: story.id }),
      );
      const link = (exported as any)?.link;
      if (!link || typeof link !== 'string') {
        console.warn(`[StoryFallback] Exported story link for ${story.id} did not contain a usable link.`);
        continue;
      }

      const message = t(task.locale, 'stories.fallbackMessage', { id: story.id });
      const buttonText = t(task.locale, 'stories.fallbackButton', { id: story.id });

      await bot.telegram.sendMessage(
        task.chatId,
        message,
        Markup.inlineKeyboard([
          Markup.button.url(buttonText, link),
        ]),
      );
    } catch (error) {
      console.error(`[StoryFallback] Failed to deliver fallback for story ${story.id}:`, error);
    }
  }
}
