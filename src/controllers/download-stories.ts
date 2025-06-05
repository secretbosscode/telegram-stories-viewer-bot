import { Userbot } from 'config/userbot';
import { timeout } from 'lib';
import { Api } from 'telegram';
// Import p-limit (ensure you've installed it: yarn add p-limit)
import pLimit from 'p-limit';

// --- Configuration for Concurrency ---
// START VERY LOW (e.g., 2 or 3) for userbots.
// Monitor for FLOOD_WAIT errors from Telegram. If you get them, reduce this.
const DOWNLOAD_CONCURRENCY_LIMIT = 3; // Adjust this value based on testing
const limit = pLimit(DOWNLOAD_CONCURRENCY_LIMIT);

// Define the structure of your 'mapped' story items
// This matches the return type of your mapStories function.
export type MappedStoryItem = {
  id: number;
  caption?: string;
  media: Api.StoryItem['media']; // Assuming media is always present after initial mapping/filtering
  mediaType: 'photo' | 'video';
  date: Date;
  buffer?: Buffer;
  bufferSize?: number; // Size in MB
  noforwards?: boolean; // If you track this property
};

export type StoriesModel = MappedStoryItem[];

export async function downloadStories(
  stories: StoriesModel,
  storiesType: 'active' | 'pinned'
): Promise<void> { // The function modifies the stories array by reference
  if (!stories || stories.length === 0) {
    console.log(`[DownloadStories] No ${storiesType} stories to download.`);
    return;
  }

  const client = await Userbot.getInstance();
  console.log(`[DownloadStories] Starting download of ${stories.length} ${storiesType} stories. Concurrency: ${DOWNLOAD_CONCURRENCY_LIMIT}.`);

  const downloadPromises = stories.map((storyItem) =>
    // Each story download is a task managed by p-limit
    limit(async () => {
      if (!storyItem.media || storyItem.noforwards) {
        console.log(`[DownloadStories] Story ${storyItem.id} (${storiesType}): No media or 'noforwards'. Skipping.`);
        return; // Story item remains unmodified
      }

      try {
        console.log(`[DownloadStories] Attempting download for story ID ${storyItem.id} (${storiesType})`);

        // Your Promise.race logic for a 30s timeout on pinned videos was interesting.
        // For a simpler p-limit integration, we'll first try direct download.
        // If specific timeouts are crucial, they can be wrapped around this downloadMedia call.
        const buffer = await client.downloadMedia(storyItem.media, {
          // progressCallback: (progress) => console.log(`[DownloadStories] Story ${storyItem.id} Progress: ${Math.round(progress * 100)}%`),
        });

        if (buffer instanceof Buffer && buffer.length > 0) {
          storyItem.buffer = buffer;
          // Calculate size in MB and round to 2 decimal places
          storyItem.bufferSize = parseFloat((buffer.byteLength / (1024 * 1024)).toFixed(2));
          console.log(`[DownloadStories] Downloaded story ID ${storyItem.id} (${storiesType}), Type: ${storyItem.mediaType}, Size: ${storyItem.bufferSize} MB.`);
        } else {
          console.log(`[DownloadStories] Story ID ${storyItem.id} (${storiesType}): Downloaded empty or invalid buffer. Buffer:`, buffer);
        }
      } catch (error: any) {
        console.error(`[DownloadStories] Error downloading story ID ${storyItem.id} (${storiesType}): ${error.message}`);
        if (error.errorMessage && error.errorMessage.startsWith('FLOOD_WAIT_')) {
          const waitSeconds = parseInt(error.errorMessage.split('_').pop() || '30');
          console.warn(`[DownloadStories] Hit FLOOD_WAIT for ${waitSeconds}s. Download for story ${storyItem.id} failed for this attempt.`);
        }
        // Story item remains without buffer on error.
      }
      // Optional: A small delay after each download attempt (success or fail)
      // This can help reduce overall request intensity if you're still seeing issues.
      // Adjust or remove based on testing.
      // await timeout(200); // e.g., 200ms delay
    })
  );

  // Wait for all download operations managed by p-limit to settle (complete or fail)
  const results = await Promise.allSettled(downloadPromises);

  let successfulDownloads = 0;
  let failedDownloads = 0;
  results.forEach(result => {
    if (result.status === 'fulfilled') {
      // A fulfilled promise here means p-limit successfully executed the async function.
      // We need to check if the storyItem actually got a buffer to count it as a "successful download".
      // This is tricky because we modify by reference.
      // For simplicity, we'll count fulfilled p-limit tasks as operations that ran.
      // The check for storyItem.buffer happens later in sendPinnedStories.ts
      successfulDownloads++;
    } else {
      // status === 'rejected'
      failedDownloads++;
    }
  });

  console.log(`[DownloadStories] Finished all download attempts for ${stories.length} ${storiesType} stories. Operations run (fulfilled by p-limit): ${successfulDownloads}, Operations failed in p-limit: ${failedDownloads}.`);
  // The 'stories' array has its items modified by reference if they successfully received a buffer.
}

// Your mapStories function remains the same, but ensure it's robust.
export function mapStories(stories: Api.TypeStoryItem[]): StoriesModel {
  const mappedStories: MappedStoryItem[] = [];

  stories.forEach((x) => {
    if (!x || !('id' in x)) { // Basic check for a valid item
        // console.warn('[MapStories] Skipping potentially invalid story item:', x);
        return;
    }

    // Ensure media is present and is a valid type before proceeding
    if (!('media' in x) || !x.media || typeof x.media !== 'object') {
        // console.warn(`[MapStories] Story ID ${x.id}: Media is missing or not an object. Skipping.`);
        return;
    }

    const story: Partial<MappedStoryItem> = {};

    story.id = x.id;
    story.media = x.media; // Should be Api.TypeMessageMedia

    // Determine mediaType
    if ('photo' in x.media && x.media.photo) {
        story.mediaType = 'photo';
    } else if ('document' in x.media && x.media.document) {
        if ((x.media as Api.MessageMediaDocument).document.mimeType?.startsWith('video/')) {
            story.mediaType = 'video';
        } else {
            // console.warn(`[MapStories] Story ID ${x.id}: Media is a document but not a video. Skipping.`);
            return; // Skip if it's a document but not a video
        }
    } else {
        // console.warn(`[MapStories] Story ID ${x.id}: Unknown media structure. Skipping.`);
        return; // Skip if media structure is not recognized
    }

    if ('date' in x && typeof x.date === 'number') {
        story.date = new Date(x.date * 1000);
    } else {
        // console.warn(`[MapStories] Story ID ${x.id}: Date is missing or invalid. Skipping.`);
        return; // Skip if date is essential and missing/invalid
    }

    if ('caption' in x && typeof x.caption === 'string') {
        story.caption = x.caption;
    }
    if ('noforwards' in x && typeof x.noforwards === 'boolean') {
        story.noforwards = x.noforwards;
    }


    // Only push if essential fields are present
    if (story.id && story.media && story.mediaType && story.date) {
        mappedStories.push(story as MappedStoryItem);
    } else {
        // console.warn(`[MapStories] Story item for ID ${x.id} was not fully mappable after checks. Skipping.`);
    }
  });

  return mappedStories;
}
