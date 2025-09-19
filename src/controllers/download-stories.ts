// src/controllers/download-stories.ts

import { Userbot } from 'config/userbot';
import { Api } from 'telegram';
import pLimit from 'p-limit'; // Ensure: npm install p-limit (if not already)

// --- Configuration for Concurrency ---
// If you get FLOOD_WAIT errors from Telegram, lower this.
const DOWNLOAD_CONCURRENCY_LIMIT = 3;
const limit = pLimit(DOWNLOAD_CONCURRENCY_LIMIT);

// ===============================
// Type Definitions - MOVED TO src/types.ts
// These definitions are NOW ONLY imported from src/types.ts
// ===============================

// CORRECTED: Import MappedStoryItem and StoriesModel from your central types.ts file
import { DownloadStoriesResult, MappedStoryItem, StoriesModel } from 'types'; // <--- This import is correct


// ===============================
// Download Stories (Concurrency-Safe)
// ===============================

/**
 * Downloads story media for each mapped story item, mutating the `stories` array in place.
 * Skips stories without media.
 */
export async function downloadStories(
  stories: StoriesModel, // Already MappedStoryItem[]
  storiesType: 'active' | 'pinned' | 'archived',
  onProgress?: (story: MappedStoryItem) => void,
  signal?: AbortSignal,
): Promise<DownloadStoriesResult> {
  if (!stories || stories.length === 0) {
    console.log(`[DownloadStories] No ${storiesType} stories to download.`);
    return { successCount: 0, failed: [], skipped: [] };
  }

  const client = await Userbot.getInstance();
  console.log(`[DownloadStories] Starting download of ${stories.length} ${storiesType} stories. Concurrency: ${DOWNLOAD_CONCURRENCY_LIMIT}.`);

  const failedStories: MappedStoryItem[] = [];
  const skippedStories: MappedStoryItem[] = [];
  let successfulDownloads = 0;

  const downloadPromises = stories.map((storyItem: MappedStoryItem) =>
    limit(async () => {
      storyItem.downloadStatus = 'pending';
      storyItem.downloadError = undefined;
      storyItem.downloadSkippedReason = undefined;
      if (signal?.aborted) {
        storyItem.downloadStatus = 'failed';
        storyItem.downloadError = 'aborted';
        failedStories.push(storyItem);
        return;
      }
      const mediaExists = !!storyItem.media;
      const isNoforwards = !!storyItem.noforwards;

      // If media doesn't exist, skip (do not skip just for noforwards)
      if (!mediaExists) {
        console.log(`[DownloadStories] Story ${storyItem.id} (${storiesType}): Skipping, media missing.`);
        storyItem.downloadStatus = 'skipped';
        storyItem.downloadSkippedReason = 'no_media';
        skippedStories.push(storyItem);
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
          storyItem.downloadStatus = 'success';
          storyItem.downloadError = undefined;
          console.log(`[DownloadStories] Downloaded story ID ${storyItem.id} (${storiesType}), Type: ${storyItem.mediaType}, Size: ${storyItem.bufferSize} MB.`);
          onProgress?.(storyItem);
          successfulDownloads++;
        } else {
          console.log(`[DownloadStories] Story ID ${storyItem.id} (${storiesType}): Empty or invalid buffer.`);
          storyItem.downloadStatus = 'failed';
          storyItem.downloadError = 'empty_buffer';
          failedStories.push(storyItem);
        }
      } catch (error: any) { // Explicitly type error as any for now
        console.error(`[DownloadStories] Error downloading story ID ${storyItem.id} (${storiesType}): ${error.message}`);
        storyItem.downloadStatus = 'failed';
        storyItem.downloadError = error?.message ?? 'unknown_error';
        failedStories.push(storyItem);
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

  const failedDownloads = results.filter(result => result.status === 'rejected').length + failedStories.length;

  console.log(`[DownloadStories] Finished all download attempts for ${stories.length} ${storiesType} stories. Success: ${successfulDownloads}, Failed: ${failedDownloads}.`);
  return { successCount: successfulDownloads, failed: failedStories, skipped: skippedStories };
}

// ===============================
// Map Stories Utility
// ===============================

/**
 * Maps Telegram API stories to the internal MappedStoryItem type.
 * Skips stories with no media, no valid date, or unknown media type.
 */
export function mapStories(
  stories: Api.TypeStoryItem[],
  storyOwnersById?: Map<number, Api.TypeEntityLike> | Record<number, Api.TypeEntityLike>
): StoriesModel {
  const mappedStories: MappedStoryItem[] = [];

  const resolveOwner: ((id: number) => Api.TypeEntityLike | undefined) | undefined =
    storyOwnersById
      ? storyOwnersById instanceof Map
        ? (id: number) => storyOwnersById.get(id)
        : (id: number) => storyOwnersById[id]
      : undefined;

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

    if (resolveOwner) {
      const owner = resolveOwner(x.id);
      if (owner) {
        story.owner = owner;
      }
    }

    if (story.id && story.media && story.mediaType && story.date) {
      mappedStories.push(story as MappedStoryItem);
    }
  });

  console.log(`[MapStories] Mapped ${mappedStories.length} out of ${stories.length} initial stories.`);
  return mappedStories;
}
