// src/controllers/download-stories.ts

import { Userbot } from 'config/userbot';
import { timeout } from 'lib';
import { Api } from 'telegram';
import pLimit from 'p-limit'; // Ensure: yarn add p-limit (if not already)

// --- Configuration for Concurrency ---
// If you get FLOOD_WAIT errors from Telegram, lower this.
const DOWNLOAD_CONCURRENCY_LIMIT = 3;
const limit = pLimit(DOWNLOAD_CONCURRENCY_LIMIT);

// ===============================
// Type Definitions - MOVED TO src/types.ts
// ===============================
// These type definitions (MappedStoryItem and StoriesModel) should now be in src/types.ts
// and imported from there.

// CORRECTED: Import MappedStoryItem and StoriesModel from your central types.ts file
import { MappedStoryItem, StoriesModel } from 'types'; // <--- Corrected import path


// ===============================
// Download Stories (Concurrency-Safe)
// ===============================

/**
 * Downloads story media for each mapped story item, mutating the `stories` array in place.
 * Skips stories without media.
 */
export async function downloadStories(
  stories: StoriesModel, // Already MappedStoryItem[]
  storiesType: 'active' | 'pinned'
): Promise<void> {
  if (!stories || stories.length === 0) {
    console.log(`[DownloadStories] No ${storiesType} stories to download.`);
    return;
  }

  const client = await Userbot.getInstance();
  console.log(`[DownloadStories] Starting download of ${stories.length} ${storiesType} stories. Concurrency: ${DOWNLOAD_CONCURRENCY_LIMIT}.`);

  const downloadPromises = stories.map((storyItem: MappedStoryItem) => // Explicitly type storyItem
    limit(async () => {
      const mediaExists = !!storyItem.media;
      const isNoforwards = !!storyItem.noforwards;

      // If media doesn't exist, skip (do not skip just for noforwards)
      if (!mediaExists) {
        console.log(`[DownloadStories] Story ${storyItem.id} (${storiesType}): Skipping, media missing.`);
        return;
      }

      if (isNoforwards) {
        console.log(`[DownloadStories] Note: Attempting to download story ${storyItem.id} marked 'noforwards'.`);
      }

      try {
        console.log(`[DownloadStories] Attempting download for story ID ${storyItem.id} (${storiesType})`);

        // storyItem.media is Api.StoryItem['media'] type
        const buffer = await client.downloadMedia(storyItem.media);

        if (buffer instanceof Buffer && buffer.length > 0) {
          storyItem.buffer = buffer;
          storyItem.bufferSize = parseFloat((buffer.byteLength / (1024 * 1024)).toFixed(2));
          console.log(`[DownloadStories] Downloaded story ID ${storyItem.id} (${storiesType}), Type: ${storyItem.mediaType}, Size: ${storyItem.bufferSize} MB.`);
        } else {
          console.log(`[DownloadStories] Story ID ${storyItem.id} (${storiesType}): Empty or invalid buffer.`);
        }
      } catch (error: any) { // Explicitly type error as any for now
        console.error(`[DownloadStories] Error downloading story ID ${storyItem.id} (${storiesType}): ${error.message}`);
        if (error.errorMessage && error.errorMessage.startsWith('FLOOD_WAIT_')) {
          const waitSeconds = parseInt(error.errorMessage.split('_').pop() || '30');
          console.warn(`[DownloadStories] Hit FLOOD_WAIT for ${waitSeconds}s on story ${storyItem.id}.`);
        }
      }
      // Optional throttle after each download
      // await timeout(200);
    })
  );

  const results = await Promise.allSettled(downloadPromises);

  let successfulDownloads = 0;
  let failedDownloads = 0;
  results.forEach(result => {
    if (result.status === 'fulfilled') successfulDownloads++;
    else failedDownloads++;
  });

  console.log(`[DownloadStories] Finished all download attempts for ${stories.length} ${storiesType} stories. Success: ${successfulDownloads}, Failed: ${failedDownloads}.`);
}

// ===============================
// Map Stories Utility
// ===============================

/**
 * Maps Telegram API stories to the internal MappedStoryItem type.
 * Skips stories with no media, no valid date, or unknown media type.
 */
export function mapStories(stories: Api.TypeStoryItem[]): StoriesModel {
  const mappedStories: MappedStoryItem[] = [];

  stories.forEach((x: Api.TypeStoryItem) => { // Explicitly type x
    if (!x || !('id' in x)) return;

    if (!('media' in x) || !x.media || typeof x.media !== 'object') return;

    const story: Partial<MappedStoryItem> = { id: x.id, media: x.media };

    // Determine mediaType
    if ('photo' in x.media && x.media.photo && typeof x.media.photo === 'object') {
      story.mediaType = 'photo';
    } else if ('document' in x.media && x.media.document && typeof x.media.document === 'object') {
      const doc = x.media.document as Api.Document;
      if (doc.mimeType && typeof doc.mimeType === 'string' && doc.mimeType.startsWith('video/')) {
        story.mediaType = 'video';
      } else {
        return; // Not a video document
      }
    } else {
      return; // Unknown or unsupported media structure
    }

    if ('date' in x && typeof x.date === 'number') {
      story.date = new Date(x.date * 1000);
    } else {
      return;
    }

    if ('caption' in x && typeof x.caption === 'string') {
      story.caption = x.caption;
    }

    story.noforwards = 'noforwards' in x && typeof x.noforwards === 'boolean' ? x.noforwards : false;

    if (story.id && story.media && story.mediaType && story.date) {
      mappedStories.push(story as MappedStoryItem);
    }
  });

  console.log(`[MapStories] Mapped ${mappedStories.length} out of ${stories.length} initial stories.`);
  return mappedStories;
}
