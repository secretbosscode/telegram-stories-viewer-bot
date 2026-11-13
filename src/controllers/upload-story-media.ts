import { bot } from 'index';
import { chunkMediafiles } from 'lib';
import type { MappedStoryItem } from 'types';

function isUploadTooLarge(error: unknown): boolean {
  const response = (error as { response?: { error_code?: number; description?: string } } | null)?.response;
  return response?.error_code === 413 || (response?.error_code === 400 &&
    /(?:file|photo|request entity|payload) (?:is )?too (?:large|big)|FILE_TOO_BIG/i.test(response.description ?? ''));
}

/** Record each acknowledged upload immediately so a later failure preserves partial delivery. */
export async function uploadStoryMedia(
  chatId: string,
  stories: MappedStoryItem[],
  captionFor: (story: MappedStoryItem) => string,
  deliveredIds: Set<number>,
): Promise<MappedStoryItem[]> {
  const tooLarge: MappedStoryItem[] = [];
  for (const album of chunkMediafiles(stories)) {
    if (album.length > 1) {
      try {
        await bot.telegram.sendMediaGroup(chatId, album.map((story) => ({
          type: story.mediaType,
          media: { source: story.buffer! },
          caption: captionFor(story).slice(0, 1024),
        })));
        for (const story of album) deliveredIds.add(story.id);
        continue;
      } catch (error) {
        if (!isUploadTooLarge(error)) throw error;
        // The request was explicitly rejected. Try each member separately so
        // an oversized album or photo does not turn every member into a link.
      }
    }
    for (const story of album) {
      const media = { source: story.buffer! };
      const extra = { caption: captionFor(story).slice(0, 1024) };
      try {
        if (story.mediaType === 'photo') {
          await bot.telegram.sendPhoto(chatId, media, extra);
        } else {
          await bot.telegram.sendVideo(chatId, media, extra);
        }
        deliveredIds.add(story.id);
      } catch (error) {
        if (!isUploadTooLarge(error)) throw error;
        console.warn(`[StoryUpload] Telegram rejected story ${story.id} (${story.buffer!.byteLength} bytes) for size; trying its link.`);
        tooLarge.push(story);
      }
    }
  }
  return tooLarge;
}
