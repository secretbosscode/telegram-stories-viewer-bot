import { db, enqueueDownload, getNextQueueItem, markProcessing, markDone, markError, cleanupQueue, wasRecentlyDownloaded, isDuplicatePending } from './index';
import { BOT_ADMIN_ID } from 'config/env-config'; // or process.env.BOT_ADMIN_ID
import { bot } from 'index';
import { UserInfo } from './your-types-file'; // Define as in your project

// ======= COOLDOWN SETTINGS =======
const COOLDOWN_HOURS = { free: 12, premium: 2, admin: 0 };

function getCooldownHours({ isPremium, isAdmin }: { isPremium?: boolean, isAdmin?: boolean }) {
  if (isAdmin) return COOLDOWN_HOURS.admin;
  if (isPremium) return COOLDOWN_HOURS.premium;
  return COOLDOWN_HOURS.free;
}

export async function handleNewTask(user: UserInfo) {
  const telegram_id = user.chatId;
  const target_username = user.link;
  const is_admin = telegram_id === BOT_ADMIN_ID.toString();
  const is_premium = !!user.isPremium;
  const cooldown = getCooldownHours({ isPremium: is_premium, isAdmin: is_admin });

  // Abuse/cooldown checks
  if (wasRecentlyDownloaded(telegram_id, target_username, cooldown)) {
    await bot.telegram.sendMessage(telegram_id, `⏳ Please wait before downloading ${target_username} again. Try later.`);
    return;
  }

  // Prevent duplicate pending jobs
  if (isDuplicatePending(telegram_id, target_username)) {
    await bot.telegram.sendMessage(telegram_id, `⚠️ This download is already queued for you. Please wait for it to finish.`);
    return;
  }

  // Insert into queue
  enqueueDownload(telegram_id, target_username);
  await bot.telegram.sendMessage(telegram_id, `✅ Download for ${target_username} queued!`);
  processQueue(); // Try to process immediately if nothing running
}

let isProcessing = false;
export async function processQueue() {
  if (isProcessing) return;
  const job = getNextQueueItem();
  if (!job) return;

  isProcessing = true;
  markProcessing(job.id);

  try {
    // TODO: Replace with your actual story downloading logic:
    // e.g., await downloadStoriesFx({ ...job });
    // For demo, use a dummy timeout
    await new Promise(res => setTimeout(res, 2000)); // simulate work

    markDone(job.id);
    await bot.telegram.sendMessage(job.telegram_id, `🎉 Download for ${job.target_username} completed!`);
  } catch (err: any) {
    markError(job.id, err?.message || 'Unknown error');
    await bot.telegram.sendMessage(job.telegram_id, `❌ Download failed for ${job.target_username}: ${err?.message || ''}`);
  }

  isProcessing = false;
  cleanupQueue();
  setImmediate(processQueue); // Process next in queue
}
