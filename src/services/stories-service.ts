// stories-service.ts

import { handleNewTask } from 'services/queue-manager'; // Main DB-backed queue logic
import { saveUser } from 'repositories/user-repository'; // Save Telegram user for analytics/CRM
import { bot } from 'index';
import { User } from 'telegraf/typings/core/types/typegram';

/**
 * Represents information about a user's download request.
 * This should be consistent with how your bot receives requests.
 */
export interface UserInfo {
  chatId: string;                        // Telegram chat/user ID
  link: string;                          // Username or link to download from
  linkType: 'username' | 'link';         // Type of target (for routing logic)
  nextStoriesIds?: number[];             // (Optional) For partial/batched downloads
  locale: string;                        // User locale, for i18n
  user?: User;                           // Telegraf user object (for user DB)
  tempMessages?: number[];               // Message IDs to delete after (UX cleanup)
  initTime: number;                      // Timestamp when request initiated
  isPremium?: boolean;                   // Is the user premium?
  instanceId?: string;                   // (Optional) Unique per request instance
}

// --- Optional: Track temporary messages for later cleanup (UX)
const tempMessageMap = new Map<string, number[]>();

/**
 * Entry point: Handles a new story download request from a user.
 * - Saves the user in DB for analytics/premium support
 * - Enqueues the request (persistent DB, via queue-manager)
 * - Tracks temporary messages for optional UX cleanup
 */
export async function handleStoryRequest(userInfo: UserInfo) {
  // 1. Save the Telegram user to your DB for stats, premium, etc.
  if (userInfo.user) {
    saveUser(userInfo.user);
  }

  // 2. Track any temporary message IDs for this user (if any, optional)
  if (userInfo.tempMessages && userInfo.tempMessages.length > 0) {
    tempMessageMap.set(userInfo.chatId, userInfo.tempMessages);
  }

  // 3. Main logic: Pass the request to queue-manager (handles duplicates, limits, privilege, etc)
  await handleNewTask(userInfo);
}

/**
 * Optionally clean up any temporary "please wait"/progress messages for a user.
 * Call after a user's request is finished (in queue-manager or on-demand).
 */
export async function cleanupTempMessages(chatId: string) {
  const tempMessages = tempMessageMap.get(chatId) || [];
  if (tempMessages.length === 0) return;

  await Promise.allSettled(
    tempMessages.map((id) =>
      bot.telegram.deleteMessage(chatId, id).catch(() => null)
    )
  );
  tempMessageMap.delete(chatId);
}

// --- (Optional) You could also add helpers here for further UX improvements ---
// e.g., expose a sendProgressMessage(chatId, msg) function, etc.

// Export the entrypoints for use in your bot
export { handleStoryRequest, cleanupTempMessages };
