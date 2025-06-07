import { createEffect } from 'effector';
import { timeout } from 'lib';
import { Api } from 'telegram';

// CORRECTED: Import all necessary types from your central types.ts file
import {
  UserInfo,
  SendStoriesFxParams,
  SendStoriesArgs,
  SendPaginatedStoriesArgs,
  SendParticularStoryArgs,
  MappedStoryItem // Needed for mapStories return type
} from 'types';

// Import the actual sending functions (assuming they are in 'src/services/')
// Your tsconfig.json must map "services/*": ["services/*"] for these to resolve.
import { sendActiveStories } from 'services/send-active-stories';
import { sendPaginatedStories } from 'services/send-paginated-stories';
import { sendParticularStory } from 'services/send-particular-story';
import { sendPinnedStories } from 'services/send-pinned-stories';

// Assuming mapStories is a utility function used to convert Api.TypeStoryItem to your internal MappedStoryItem type.
// It is located in 'controllers/download-stories.ts'.
import { mapStories } from 'controllers/download-stories';

// Explicitly type the effect with SendStoriesFxParams
export const sendStoriesFx = createEffect<SendStoriesFxParams, void, Error>(
  async (params) => {
    const {
      activeStories = [], // Default to empty array if undefined
      pinnedStories = [], // Default to empty array if undefined
      paginatedStories,
      particularStory,
      task,
    } = params;

    try {
      // 1. Handle particular story (highest priority if present)
      if (particularStory) {
        // sendParticularStory expects single Api.TypeStoryItem
        await sendParticularStory({ story: particularStory, task } as SendParticularStoryArgs);
        return; // Exit after sending this specific story
      }

      // 2. Handle paginated stories (if present and implies specific pagination request)
      //    These are typically raw Api.TypeStoryItem[] from a next page button.
      if (paginatedStories && paginatedStories.length > 0) {
        await sendPaginatedStories({ stories: paginatedStories, task } as SendPaginatedStoriesArgs);
        return; // Exit after sending paginated stories
      }

      // 3. Handle active stories (general username lookup results)
      //    These are raw Api.TypeStoryItem[] from getAllStoriesFx.
      if (activeStories.length > 0) {
        // sendActiveStories expects MappedStoryItem[], so map them first
        const mappedActiveStories: MappedStoryItem[] = mapStories(activeStories);
        await sendActiveStories({ stories: mappedActiveStories, task } as SendStoriesArgs);
        await timeout(2000); // Wait after sending active stories
      }

      // 4. Handle pinned stories (general username lookup results)
      //    These are raw Api.TypeStoryItem[] from getAllStoriesFx.
      if (pinnedStories.length > 0) {
        // sendPinnedStories expects MappedStoryItem[], so map them first
        const mappedPinnedStories: MappedStoryItem[] = mapStories(pinnedStories);
        await sendPinnedStories({ stories: mappedPinnedStories, task } as SendStoriesArgs);
      }

      // If no stories were found in any of the above conditions, or were empty arrays,
      // the function will simply complete without sending stories.
      // Error handling for empty sets of stories should ideally be done by the calling
      // (fetching) effects or by a separate user feedback mechanism if nothing is sent.

    } catch (error: any) { // Explicitly type error as any for now
      console.error(`[sendStoriesFx] Unhandled error during task for link "${params.task.link}" (User: ${params.task.chatId}):`, error);
      throw error; // Re-throw to propagate to Effector's .fail handler
    }
  }
);
