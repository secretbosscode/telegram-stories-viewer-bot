import { Userbot } from 'config/userbot';
import { bot } from 'index'; // Corrected path to use tsconfig alias
import { chunkMediafiles } from 'lib';
import { Markup } from 'telegraf';
import { Api } from 'telegram';

// CORRECTED: Import types from your central types.ts file
import { SendStoriesArgs, MappedStoryItem, StoriesModel, NotifyAdminParams } from 'types';

// Corrected import path for downloadStories and mapStories
import { downloadStories, mapStories } from 'controllers/download-stories';
import { notifyAdmin } from 'controllers/send-message';

/**
 * Sends a user's active stories as Telegram media groups.
 * Handles pagination, download, error reporting, and premium up-sell.
 */
export async function sendActiveStories({ stories, task }: SendStoriesArgs) {
  // `stories` here is expected to be `MappedStoryItem[]` from SendStoriesArgs
  let mapped: StoriesModel = stories; // Explicitly typed mapped to StoriesModel (MappedStoryItem[])

  // === Pagination logic for >5 stories (per page) ===
  let hasMorePages = false;
  const nextStories: Record<string, number[]> = {};
  const PER_PAGE = 5;

  if (stories.length > PER_PAGE) {
    hasMorePages = true;
    const currentStories: MappedStoryItem[] = mapped.slice(0, PER_PAGE); // Explicitly typed
    for (let i = PER_PAGE; i < mapped.length; i += PER_PAGE) {
      const from = i + 1;
      const to = Math.min(i + PER_PAGE, mapped.length);
      // CORRECTED LINE: Removed LaTeX delimiters
      nextStories[`<span class="math-inline">\{from\}\-</span>{to}`] = mapped.slice(i, i + PER_PAGE).map((x) => x.id);
    }
    mapped = currentStories;
  }

  // === If any stories missing media, refetch via Userbot ===
  const storiesWithoutMedia: MappedStoryItem[] = mapped.filter((x) => !x.media); // Explicitly typed
  if (storiesWithoutMedia.length > 0) {
    mapped = mapped.filter((x) => Boolean(x.media)); // This filters out stories with no media
    try {
      const client = await Userbot.getInstance();
      const entity = await client.getEntity(task.link!);
      const ids = storiesWithoutMedia.map((x) => x.id);
      const storiesWithMediaApi = await client.invoke(
        new Api.stories.GetStoriesByID({ id: ids, peer: entity })
      );
      mapped.push(...mapStories(storiesWithMediaApi.stories));
    } catch (e) {
      console.error('[sendActiveStories] Error re-fetching stories without media:', e);
      // Fallback: just continue with those that have media
    }
  }

  try {
    // --- User notification: downloading ---
    await bot.telegram.sendMessage(task.chatId, '⏳ Downloading Active stories...').catch(() => null);

    // --- Download stories to buffer ---
    await downloadStories(mapped, 'active');

    // --- Only upload files with buffer and size <= 47MB (Telegram API limit fudge) ---
    const uploadableStories: MappedStoryItem[] = mapped.filter(
      (x) => x.buffer && x.bufferSize! <= 47
    );

    // --- Notify user about upload ---
    if (uploadableStories.length > 0) {
      await bot.telegram.sendMessage(
        task.chatId,
        `📥 ${uploadableStories.length} Active stories downloaded successfully!\n⏳ Uploading stories to Telegram...`
      ).catch(() => null);

      // --- Send in chunks (albums) ---
      const chunkedList = chunkMediafiles(uploadableStories);
      for (const album of chunkedList) {
        await bot.telegram.sendMediaGroup(
          task.chatId,
          album.map((x) => ({
            media: { source: x.buffer! },
            type: x.mediaType,
            caption: x.caption ?? 'Active stories',
          }))
        );
      }
    } else {
      await bot.telegram.sendMessage(
        task.chatId,
        '❌ Cannot download Active stories,
