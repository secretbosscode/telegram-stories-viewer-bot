// src/controllers/get-stories.ts

import { Userbot } from 'config/userbot';
import { createEffect } from 'effector';
import { bot } from 'index';
import { timeout } from 'lib';

// CORRECTED: Import UserInfo and NotifyAdminParams from your central types.ts file
import { UserInfo, NotifyAdminParams } from 'types';

// CORRECTED: Import tempMessageSent from stories-service.ts (which is now the orchestrator)
// As discussed, stories-service.ts now defines and exports these core events.
import { tempMessageSent } from 'services/stories-service'; // <--- CORRECTED PATH!

import { Api } from 'telegram';
import { FloodWaitError } from 'telegram/errors';
import { isDevEnv } from 'config/env-config';

// CORRECTED: Import notifyAdmin from the correct controller path
import { notifyAdmin } from 'controllers/send-message';


// =========================================================================
// This effect fetches all stories for a given user.
// It is responsible for giving the initial feedback to the user.
// =========================================================================
export const getAllStoriesFx = createEffect(async (task: UserInfo) => {
  let statusMessageId: number | undefined;
  try {
    const sentMessage = await bot.telegram.sendMessage(task.chatId, '⏳ Fetching story lists...');
    statusMessageId = sentMessage.message_id;
    tempMessageSent(statusMessageId);
  } catch (e) {
    console.error(`[GetStories] Could not send initial status message to chat ${task.chatId}`);
  }

  try {
    const client = await Userbot.getInstance();
    const entity = await client.getEntity(task.link);
    notifyAdmin({ task, status: 'start' } as NotifyAdminParams);

    // This path handles pagination clicks from inline buttons.
    if (task.nextStoriesIds) {
      const paginatedStoriesResult = await client.invoke(
        new Api.stories.GetStoriesByID({ peer: entity, id: task.nextStoriesIds })
      );
      // Ensure the return type matches what stories-service.ts expects for paginatedStories
      return paginatedStoriesResult.stories.length > 0
        ? { activeStories: [], pinnedStories: [], paginatedStories: paginatedStoriesResult.stories }
        : '🚫 Specified stories not found!';
    }

    // This is the main path for a new username request.
    const [activeResult, pinnedResult] = await Promise.all([
      client.invoke(new Api.stories.GetPeerStories({ peer: entity })),
      client.invoke(new Api.stories.GetPinnedStories({ peer: entity }))
    ]);

    let activeStories: Api.TypeStoryItem[] = activeResult.stories.stories || [];
    let pinnedStories: Api.TypeStoryItem[] = pinnedResult.stories || [];

    // Deduplication logic
    if (activeStories.length > 0 && pinnedStories.length > 0) {
      pinnedStories = pinnedStories.filter(p => !activeStories.some(a => a.id === p.id));
    }

    console.log(`[GetStories] Initial fetch for ${task.link}: ${activeStories.length} active, ${pinnedStories.length} initial pinned.`);

    // Logic for paginating through all pinned stories for a new request.
    if (!task.nextStoriesIds) { // This condition checks if it's the initial request for pinned stories
      let lastPinnedStoryId: number | null = pinnedStories.length > 0 ? pinnedStories[pinnedStories.length - 1].id : null;
      let fetchedCountInLoop = 0;
      while (lastPinnedStoryId !== null) {
        await timeout(1000);
        const olderPinnedResult = await client.invoke(
          new Api.stories.GetPinnedStories({ peer: entity, offsetId: lastPinnedStoryId })
        ).catch(() => null);

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

    if (activeStories.length > 0 || pinnedStories.length > 0) {
      const summaryText = `⚡️ ${activeStories.length} Active story items found.\n📌 ${pinnedStories.length} Pinned story items found.`;

      // Here we edit the original message with the final counts.
      if (statusMessageId) {
        await bot.telegram.editMessageText(task.chatId, statusMessageId, undefined, summaryText).catch(() => {
          bot.telegram.sendMessage(task.chatId, summaryText).then(({ message_id }) => tempMessageSent(message_id));
        });
      } else {
        bot.telegram.sendMessage(task.chatId, summaryText).then(({ message_id }) => tempMessageSent(message_id));
      }

      // Do not notify admin here to avoid duplicate notifications.
      return { activeStories, pinnedStories
