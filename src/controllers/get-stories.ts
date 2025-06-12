// src/controllers/get-stories.ts

import { Userbot } from 'config/userbot';
import { createEffect } from 'effector';
import { bot } from 'index';
import { timeout, sendTemporaryMessage, isValidStoryLink, getEntityWithTempContact } from 'lib';
import { UserInfo, NotifyAdminParams } from 'types';
import { Api } from 'telegram';
import { FloodWaitError } from 'telegram/errors';
import { isDevEnv } from 'config/env-config';
import { notifyAdmin } from 'controllers/send-message';
import { t } from 'lib/i18n';


// =========================================================================
// This effect fetches all stories for a given user.
// =========================================================================
export const getAllStoriesFx = createEffect(async (task: UserInfo) => {
  try {
    await sendTemporaryMessage(
      bot,
      task.chatId,
      t(task.locale, 'stories.fetchingList')
    );

    const client = await Userbot.getInstance();
    const entity = await getEntityWithTempContact(task.link);
    notifyAdmin({ task, status: 'start' });

    // This path handles pagination clicks from inline buttons.
    if (task.nextStoriesIds) {
      const paginatedStoriesResult = await client.invoke(
        new Api.stories.GetStoriesByID({ peer: entity, id: task.nextStoriesIds })
      );
      return paginatedStoriesResult.stories.length > 0
        ? { activeStories: [], pinnedStories: [], paginatedStories: paginatedStoriesResult.stories }
        : '🚫 Specified stories not found!';
    }

    // This is the main path for a new username request.
    const [activeResult, pinnedResult] = await Promise.all([
      client.invoke(new Api.stories.GetPeerStories({ peer: entity })),
      client.invoke(new Api.stories.GetPinnedStories({ peer: entity }))
    ]);

    let activeStories: Api.TypeStoryItem[] = activeResult.stories?.stories || [];
    let pinnedStories: Api.TypeStoryItem[] = pinnedResult?.stories || [];

    if (activeStories.length > 0 && pinnedStories.length > 0) {
      pinnedStories = pinnedStories.filter(p => !activeStories.some(a => a.id === p.id));
    }

    console.log(`[GetStories] Initial fetch for ${task.link}: ${activeStories.length} active, ${pinnedStories.length} initial pinned.`);

    if (!task.nextStoriesIds) {
      let lastPinnedStoryId: number | null = pinnedStories.length > 0 ? pinnedStories[pinnedStories.length - 1].id : null;
      let fetchedCountInLoop = 0;
      while (lastPinnedStoryId !== null) {
        await timeout(1000);
        const olderPinnedResult = await client
          .invoke(new Api.stories.GetPinnedStories({ peer: entity, offsetId: lastPinnedStoryId }))
          .catch((err) => {
            console.error(
              `[getStories] Error fetching older pinned stories for ${task.link} (${task.chatId}):`,
              err
            );
            return null;
          });

        if (olderPinnedResult && olderPinnedResult.stories.length > 0) {
          const newPinnedStories = olderPinnedResult.stories.filter(
            newStory => !activeStories.some(aS => aS.id === newStory.id) && !pinnedStories.some(pS => pS.id === newStory.id)
          );
          if (newPinnedStories.length > 0) {
            pinnedStories.push(...newPinnedStories);
            lastPinnedStoryId = newPinnedStories[newPinnedStories.length - 1].id;
            fetchedCountInLoop += newPinnedStories.length;
          } else {
            lastPinnedStoryId = null;
          }
        } else {
          lastPinnedStoryId = null;
        }
        if (fetchedCountInLoop > 500 && isDevEnv) {
          console.warn("[GetStories] DEV MODE: Safety break in pagination loop.");
          break;
        }
      }
      console.log(`[GetStories] Total pinned stories after pagination for ${task.link}: ${pinnedStories.length}`);
    }
    
    // The "No stories found" and "Completed" logic is now handled in `send-stories.ts`.
    // This effect's only job is to return the data it found.
    return { activeStories, pinnedStories };

  } catch (error: any) {
    console.error(`[GetStories] Error in getAllStoriesFx for task ${task.link}:`, error);
    if (error?.message?.toLowerCase().includes('auth') && error?.message?.includes('key')) {
      console.warn('[GetStories] Possible session error, reinitializing Userbot');
      try {
        await Userbot.reset();
        await Userbot.getInstance();
      } catch (reinitErr) {
        console.error('[GetStories] Failed to reinitialize Userbot:', reinitErr);
      }
    }
    if (error instanceof FloodWaitError) {
      const seconds = error.seconds || 60;
        return t(task.locale, 'stories.floodWait', { minutes: Math.ceil(seconds / 60) });
    }
      if (error.message?.includes('No user corresponding to')) {
        return t(task.locale, 'stories.userNotFound', { user: task.link });
    }
        return t(task.locale, 'stories.errorGeneric', { user: task.link });
  }
});


// =========================================================================
// Fetch a particular story from a link like t.me/username/s/123
// =========================================================================
export const getParticularStoryFx = createEffect(async (task: UserInfo) => {
  try {
    await sendTemporaryMessage(
      bot,
      task.chatId,
      t(task.locale, 'stories.fetchingSpecific')
    );

    const client = await Userbot.getInstance();

    if (!isValidStoryLink(task.link)) {
      return t(task.locale, 'stories.invalidLinkFormat');
    }

    const match = /^(?:https?:\/\/)?t\.me\/([^\/]+)\/s\/(\d+)/i.exec(task.link.trim());
    if (!match) {
      return t(task.locale, 'stories.invalidLinkParse');
    }
    const usernameOrChannelId = match[1];
    const storyId = Number(match[2]);

    if (!usernameOrChannelId || isNaN(storyId)) {
      return t(task.locale, 'stories.invalidLinkParse');
    }

    console.log(`[GetStories] Fetching particular story for ${usernameOrChannelId}, story ID: ${storyId}`);
    const entity = await client.getEntity(usernameOrChannelId);
    notifyAdmin({ task, status: 'start' });

    const storyData = await client.invoke(
      new Api.stories.GetStoriesByID({ id: [storyId], peer: entity })
    );

    if (storyData.stories.length === 0) {
      return t(task.locale, 'stories.storyNotFound', { id: storyId, user: usernameOrChannelId });
    }

    return {
      activeStories: [],
      pinnedStories: [],
      particularStory: storyData.stories[0],
    };
  } catch (error: any) {
    console.error(`[GetStories] ERROR in getParticularStoryFx for ${task.link}:`, error);
    if (error instanceof FloodWaitError) {
      const seconds = error.seconds || 60;
        return t(task.locale, 'stories.floodWait', { minutes: Math.ceil(seconds / 60) });
    }
    if (error.message?.includes('No user corresponding to')) {
        return t(task.locale, 'stories.userNotFound', { user: task.link });
    }
      return t(task.locale, 'stories.errorGeneric', { user: task.link });
  }
});
