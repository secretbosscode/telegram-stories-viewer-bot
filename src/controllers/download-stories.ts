// src/controllers/download-stories.ts

import { Userbot } from 'config/userbot';
import { Api } from 'telegram';
import pLimit from 'p-limit'; // Ensure: npm install p-limit (if not already)
import { ensureStealthMode } from 'services/stealth-mode';
import { isNotConnectedError } from 'lib/telegram-retry';

// --- Configuration for Concurrency ---
// If you get FLOOD_WAIT errors from Telegram, lower this.
const DOWNLOAD_CONCURRENCY_LIMIT = 3;
const limit = pLimit(DOWNLOAD_CONCURRENCY_LIMIT);

// Upper bound for a single story download. A gramJS transfer can hang without
// ever rejecting after "Connection closed while receiving data" on an exported
// data-centre sender; in production that froze the whole monitor loop behind
// one story (Sep 4: 08:37 until the next restart; Sep 5: 19:01 until redeploy).
// Stories are at most ~50 MB and a 12 MB video took ~25 s in the logs, so three
// minutes is generous. Overridable for tests and slow links.
export const DOWNLOAD_TIMEOUT_MS = Number(process.env.STORY_DOWNLOAD_TIMEOUT_MS) || 3 * 60 * 1000;

class DownloadTimeoutError extends Error {
  constructor(storyId: number, ms: number) {
    super(`Download of story ${storyId} timed out after ${Math.round(ms / 1000)}s`);
    this.name = 'DownloadTimeoutError';
  }
}

// Bound for replacing the client after a stalled transfer. Reconnecting is a
// fresh client.start() on the saved session and normally takes a second; the
// bound only stops a pathological reconnect from becoming the next hang.
const RECONNECT_TIMEOUT_MS = 60 * 1000;

function raceTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
    timer.unref?.();
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

/**
 * Replaces the userbot client. A stalled transfer leaves its sender wedged,
 * so this runs even when no retry follows: otherwise the next story (or the
 * next request) inherits the dead sender and burns another full timeout.
 */
async function replaceClient(reason: string): Promise<void> {
  try {
    await raceTimeout(
      Userbot.reconnect(reason),
      RECONNECT_TIMEOUT_MS,
      () => new Error(`Reconnect after "${reason}" timed out`),
    );
  } catch (error) {
    console.error('[DownloadStories] Could not replace the client:', error);
  }
}

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

  await ensureStealthMode();
  // Warm the client, but do not hold the reference: downloadWithReconnect
  // resolves it per attempt so a reconnect cannot leave callers on a dead one.
  await Userbot.getInstance();
  console.log(`[DownloadStories] Starting download of ${stories.length} ${storiesType} stories. Concurrency: ${DOWNLOAD_CONCURRENCY_LIMIT}.`);

  const failedStories: MappedStoryItem[] = [];
  const skippedStories: MappedStoryItem[] = [];
  let successfulDownloads = 0;

  const downloadWithReconnect = async (media: Api.TypeMessageMedia, storyId: number) => {
    const maxAttempts = 2;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        // Resolve the client on every attempt. Userbot.reconnect() disconnects
        // the current instance and installs a new one, so a reference captured
        // before the loop would be permanently dead on the retry.
        const activeClient = await Userbot.getInstance();
        return await raceTimeout(
          activeClient.downloadMedia(media),
          DOWNLOAD_TIMEOUT_MS,
          () => new DownloadTimeoutError(storyId, DOWNLOAD_TIMEOUT_MS),
        );
      } catch (err) {
        lastError = err;
        const stalled = err instanceof DownloadTimeoutError;
        if (!stalled && !isNotConnectedError(err)) throw err;
        // Either way the sender is suspect: replace the client, then retry once.
        // The replacement happens even on the final attempt so a wedged sender
        // is not handed to the next story.
        if (signal?.aborted) {
          console.warn(`[DownloadStories] Story ${storyId}: request aborted; not retrying.`);
          if (stalled) await replaceClient(`stalled download of story ${storyId}`);
          throw new Error('aborted');
        }
        console.warn(
          `[DownloadStories] ${stalled ? 'Download stalled' : 'Connection lost'} while downloading story ${storyId}. Reconnecting (attempt ${attempt}/${maxAttempts})...`,
        );
        await replaceClient(`download story ${storyId}`);
        if (attempt === maxAttempts) throw err;
      }
    }
    throw lastError;
  };

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
        const buffer = await downloadWithReconnect(storyItem.media, storyItem.id);

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

  if (stories.length > 0) {
    await ensureStealthMode({ past: true });
  }

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
