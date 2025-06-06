import { createEffect } from 'effector';
import { timeout } from 'lib';
import { Api } from 'telegram';

// CORRECTED: Import UserInfo from your central types.ts file
import {
  UserInfo,
  SendStoriesFxParams, // Import the SendStoriesFxParams interface
  SendStoriesArgs,        // Import SendStoriesArgs
  SendPaginatedStoriesArgs, // Import SendPaginatedStoriesArgs
  SendParticularStoryArgs   // Import SendParticularStoryArgs
} from 'types'; // Corrected import path

// Import the actual sending functions (relative to this file, which is in 'controllers/')
// Assuming these are in 'src/services/' and your tsconfig.json handles 'services/*' alias
import { sendActiveStories } from 'services/send-active-stories';
import { sendPaginatedStories } from 'services/send-paginated-stories';
import { sendParticularStory } from 'services/send-particular-story';
import { sendPinnedStories } from 'services/send-pinned-stories';

// Assuming mapStories is a utility function used to convert Api.TypeStoryItem to your internal Story type.
// You'll need this if sendActiveStories or sendPinnedStories takes MappedStoryItem[]
import { mapStories } from 'controllers/download-stories'; // Adjust path if needed

// Corrected: Explicitly type the effect with SendStoriesFxParams
export const sendStoriesFx = createEffect<SendStoriesFxParams, void, Error>(
  async (params) => {
    const {
      activeStories = [],
      pinnedStories = [],
      paginatedStories,
      particularStory,
      task,
    } = params;

    try {
      if (paginatedStories && paginatedStories.length > 0) {
        // sendPaginatedStories expects raw Api.TypeStoryItem[]
        await sendPaginatedStories({ stories: paginatedStories, task } as SendPaginatedStoriesArgs);
        return;
      }

      if (activeStories.length > 0) {
        // sendActiveStories expects MappedStoryItem[]
        // Need to map if activeStories are Api.TypeStoryItem[] here
        const mappedActiveStories = mapStories(activeStories);
        await sendActiveStories({ stories: mappedActiveStories, task } as SendStoriesArgs);
        await timeout(2000); // Wait after sending active stories
      }

      if (pinnedStories.length > 0) {
        // sendPinnedStories expects MappedStoryItem[]
        // Need to map if pinnedStories are Api.TypeStoryItem[] here
        const mappedPinnedStories = mapStories(pinnedStories);
        await sendPinnedStories({ stories: mappedPinnedStories, task } as SendStoriesArgs);
      }

      if (particularStory) {
        // sendParticularStory expects single Api.TypeStoryItem
        await sendParticularStory({ story: particularStory, task } as SendParticularStoryArgs);
      }
    } catch (error: any) { // Explicitly type error as any for now
      console.error(`[sendStoriesFx] Unhandled error during task for link "${params.task.link}" (User: ${params.task.chatId}):`, error);
      throw error;
    }
  }
);
