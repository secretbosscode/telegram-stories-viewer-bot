import { Userbot } from 'config/userbot';
import { bot } from 'index';
import { sendTemporaryMessage, chunkArray, getEntityWithTempContact } from 'lib';
import { Api } from 'telegram';
import { notifyAdmin } from 'controllers/send-message';
import { t } from "lib/i18n";
import { User } from 'telegraf/typings/core/types/typegram';
// No need for the private _downloadPhoto helper; use downloadMedia instead

/**
 * Download and send profile photos and videos for a given username or phone number.
 * Sends up to LIMIT items as a media group.
 *
 * @param chatId - ID of the chat to send media to
 * @param input - Username or phone number to look up
 * @param user - Telegram user requesting the media (for admin audit)
 * @param limit - Optional limit on number of items to fetch
 */
export async function sendProfileMedia(
  chatId: number | string,
  input: string,
  user?: User,
  limit?: number,
) {
  try {

    const client = await Userbot.getInstance();
    const entity = await getEntityWithTempContact(input);

    const photos: Api.Photo[] = [];
    let offset = 0;
    const requestLimit = 100;
    while (true) {
      const batchLimit =
        limit !== undefined ? Math.min(requestLimit, limit - photos.length) : requestLimit;
      if (batchLimit <= 0) break;
      const result = (await client.invoke(
        new Api.photos.GetUserPhotos({ userId: entity, offset, limit: batchLimit })
      )) as Api.photos.Photos;
      const batch = 'photos' in result ? result.photos : [];
      photos.push(...batch.filter((p): p is Api.Photo => p instanceof Api.Photo));
      if (batch.length < batchLimit) break;
      offset += batch.length;
      if (limit !== undefined && photos.length >= limit) break;
    }
    if (!photos.length) {
      await bot.telegram.sendMessage(chatId, t(user?.language_code || '', 'profile.none'));
      return;
    }

    const sendAlbum = [] as { media: { source: Buffer }; type: 'photo' | 'video' }[];
    for (const photo of photos.slice(0, limit ?? photos.length)) {
      if (!(photo instanceof Api.Photo)) continue;
      try {
        const videoSizes = Array.isArray((photo as any).videoSizes)
          ? (photo as any).videoSizes
          : [];
        const isVideo = videoSizes.length > 0;
        // Pick the size explicitly. With no thumb argument, downloadMedia sorts
        // static sizes and video sizes together and returns the largest, so an
        // animated avatar whose still frame outweighs its clip would be
        // downloaded as a JPEG and then sent as a video, failing the album.
        const buffer = (await client.downloadMedia(photo as any, {
          thumb: isVideo ? videoSizes[videoSizes.length - 1] : undefined,
        })) as Buffer;
        if (Buffer.isBuffer(buffer) && buffer.length > 0) {
          sendAlbum.push({ media: { source: buffer }, type: isVideo ? 'video' : 'photo' });
        }
      } catch (e) {
        console.error('[sendProfileMedia] Error downloading media:', e);
      }
    }

    if (sendAlbum.length) {
      const albums = chunkArray(sendAlbum, 10);
      let sentCount = 0;
      for (const album of albums) {
        try {
          if (album.length === 1) {
            // A media group needs 2-10 items.
            const only = album[0];
            if (only.type === 'photo') {
              await bot.telegram.sendPhoto(chatId, only.media);
            } else {
              await bot.telegram.sendVideo(chatId, only.media);
            }
          } else {
            await bot.telegram.sendMediaGroup(chatId, album);
          }
          sentCount += album.length;
        } catch (albumError) {
          // One rejected batch must not discard the albums that follow.
          console.error('[sendProfileMedia] Failed to send an album:', albumError);
        }
      }
      if (sentCount === 0) {
        await bot.telegram.sendMessage(chatId, t(user?.language_code || '', 'profile.downloadError'));
        return;
      }
      await sendTemporaryMessage(
        bot,
        chatId,
        t(user?.language_code || '', 'profile.sent', { count: sentCount, user: input }),
      );
      notifyAdmin({
        status: 'info',
        baseInfo: `📸 Sent ${sentCount} profile media item(s) of ${input}`,
        task: { chatId: String(chatId), user } as any,
      });
    } else {
      await bot.telegram.sendMessage(chatId, t(user?.language_code || '', 'profile.downloadError'));
    }
  } catch (e) {
    console.error('[sendProfileMedia] Error:', e);
    notifyAdmin({ status: 'error', task: { chatId: String(chatId), user } as any, errorInfo: { cause: e } });
    await bot.telegram.sendMessage(chatId, t(user?.language_code || '', 'profile.error'));
  }
}

export default sendProfileMedia;
