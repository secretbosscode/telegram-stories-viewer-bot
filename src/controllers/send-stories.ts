import { createEffect } from 'effector';
import { timeout } from 'lib';
import { UserInfo } from 'services/stories-service';
import { Api } from 'telegram';

import { sendActiveStories } from './send-active-stories';
import { sendPaginatedStories } from './send-paginated-stories';
import { sendParticularStory } from './send-particular-story';
import { sendPinnedStories } from './send-pinned-stories';

export const sendStoriesFx = createEffect(
  async (params: {
    activeStories?: Api.TypeStoryItem[];
    pinnedStories?: Api.TypeStoryItem[];
    paginatedStories?: Api.TypeStoryItem[];
    particularStory?: Api.TypeStoryItem;
    task: UserInfo;
  }) => {
    // Keep params as a single object to access it in the catch block
    const {
      activeStories = [],
      pinnedStories = [],
      paginatedStories,
      particularStory,
      task,
    } = params;

    // CORRECTED: Wrap all async operations in a try...catch block
    try {
      if (paginatedStories && paginatedStories.length > 0) {
        await sendPaginatedStories({ stories: paginatedStories, task });
        return;
      }

      if (activeStories.length > 0) {
        await sendActiveStories({ stories: activeStories, task });
        await timeout(2000);
      }

      if (pinnedStories.length > 0) {
        await sendPinnedStories({ stories: pinnedStories, task });
      }

      if (particularStory) {
        await sendParticularStory({ story: particularStory, task });
      }
    } catch (error) {
        console.error(`[sendStoriesFx] Unhandled error during task for link "${params.task.link}" (User: ${params.task.chatId}):`, error);

        // IMPORTANT: Re-throw the error.
        // This ensures the effect's promise is rejected, which triggers the .fail event in Effector.
        // The .fail event is handled in stories-service.ts to clean up the failed task and move to the next one.
        throw error;
    }
  }
);
