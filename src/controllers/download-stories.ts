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
      // await timeout(200); // e.g., 200ms delay
    })
  );

  // Wait for all download operations managed by p-limit to settle (complete or fail)
  const results = await Promise.allSettled(downloadPromises);

  let successfulDownloads = 0;
  let failedDownloads = 0;
  results.forEach(result => {
    if (result.status === 'fulfilled') {
      successfulDownloads++;
    } else {
      failedDownloads++;
    }
  });

  console.log(`[DownloadStories] Finished all download attempts for ${stories.length} ${storiesType} stories. Operations run (fulfilled by p-limit): ${successfulDownloads}, Operations failed in p-limit: ${failedDownloads}.`);
}

export function mapStories(stories: Api.TypeStoryItem[]): StoriesModel {
  const mappedStories: MappedStoryItem[] = [];

  stories.forEach((x) => {
    if (!x || !('id' in x)) {
        return;
    }

    if (!('media' in x) || !x.media || typeof x.media !== 'object') {
        return;
    }

    const story: Partial<MappedStoryItem> = {};
    story.id = x.id;
    story.media = x.media; // x.media is Api.TypeMessageMedia

    // Determine mediaType
    // Check if media is MessageMediaPhoto
    if ('photo' in x.media && x.media.photo && typeof x.media.photo === 'object') {
        story.mediaType = 'photo';
    // Check if media is MessageMediaDocument
    } else if ('document' in x.media && x.media.document && typeof x.media.document === 'object') {
        // Safely check for mimeType only if document is not DocumentEmpty
        // Api.Document has 'mimeType', Api.DocumentEmpty does not.
        // A common way to differentiate is to check for a property that only Api.Document has, like 'id' or 'accessHash',
        // or more directly, check if 'mimeType' exists before accessing it.
        const doc = x.media.document as Api.Document; // Tentatively cast to Api.Document
        if (doc.mimeType && typeof doc.mimeType === 'string' && doc.mimeType.startsWith('video/')) {
            story.mediaType = 'video';
        } else {
            // console.warn(`[MapStories] Story ID ${x.id}: Media is a document but not a recognized video. mimeType: ${doc.mimeType}. Skipping.`);
            return; 
        }
    } else {
        // console.warn(`[MapStories] Story ID ${x.id}: Unknown or unsupported media structure. Skipping.`);
        return; 
    }

    if ('date' in x && typeof x.date === 'number') {
        story.date = new Date(x.date * 1000);
    } else {
        return; 
    }

    if ('caption' in x && typeof x.caption === 'string') {
        story.caption = x.caption;
    }
    if ('noforwards' in x && typeof x.noforwards === 'boolean') {
        story.noforwards = x.noforwards;
    }

    if (story.id && story.media && story.mediaType && story.date) {
        mappedStories.push(story as MappedStoryItem);
    }
  });

  return mappedStories;
}
