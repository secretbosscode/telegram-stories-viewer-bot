import { Userbot } from 'config/userbot';
import { bot } from 'index';
import { sendTemporaryMessage } from 'lib';
import { Api } from 'telegram';
import { notifyAdmin } from 'controllers/send-message';
// No need for the private _downloadPhoto helper; use downloadMedia instead

/**
 * Download and send profile photos and videos for a given username or phone number.
 * Sends up to LIMIT items as a media group.
 */
export async function sendProfileMedia(
  chatId: number | string,
  input: string,
  limit = 3,
) {
  try {
    await sendTemporaryMessage(bot, chatId, `⏳ Fetching profile media for ${input}...`);

    const client = await Userbot.getInstance();
    const entity = await client.getEntity(input);

    const result = (await client.invoke(
      new Api.photos.GetUserPhotos({ userId: entity, offset: 0, limit })
    )) as Api.photos.Photos;

    const photos = 'photos' in result ? result.photos : [];
    if (!photos.length) {
      await bot.telegram.sendMessage(chatId, 'No profile media found.');
      return;
    }

    const sendAlbum = [] as { media: { source: Buffer }; type: 'photo' | 'video' }[];
    for (const photo of photos.slice(0, limit)) {
      if (!(photo instanceof Api.Photo)) continue;
      try {
        const buffer = (await client.downloadMedia(photo as any)) as Buffer;
        if (Buffer.isBuffer(buffer)) {
          const isVideo = 'videoSizes' in photo && Array.isArray((photo as any).videoSizes) && (photo as any).videoSizes.length > 0;
          sendAlbum.push({ media: { source: buffer }, type: isVideo ? 'video' : 'photo' });
        }
      } catch (e) {
        console.error('[sendProfileMedia] Error downloading media:', e);
      }
    }

    if (sendAlbum.length) {
      await bot.telegram.sendMediaGroup(chatId, sendAlbum);
      notifyAdmin({ status: 'info', baseInfo: `📸 Sent ${sendAlbum.length} profile media item(s) of ${input}` });
    } else {
      await bot.telegram.sendMessage(chatId, 'Failed to download profile media.');
    }
  } catch (e) {
    console.error('[sendProfileMedia] Error:', e);
    notifyAdmin({ status: 'error', errorInfo: { cause: e } });
    await bot.telegram.sendMessage(chatId, 'Error retrieving profile media.');
  }
}

export default sendProfileMedia;
