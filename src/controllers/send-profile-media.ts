import { Userbot } from 'config/userbot';
import { bot } from 'index';
import { sendTemporaryMessage, chunkArray, getEntityWithTempContact } from 'lib';
import { Api } from 'telegram';
import { notifyAdmin } from 'controllers/send-message';
import { t } from "lib/i18n";
import { User } from 'telegraf/typings/core/types/typegram';
import {
  downloadProfilePhoto,
  listDeletedArchivedPhotos,
} from 'services/profile-photo-archive';

/**
 * A privacy-restricted account may still expose a public "fallback" photo,
 * which official clients show to people outside the privacy circle. It is
 * returned by users.GetFullUser and is never part of photos.GetUserPhotos.
 */
async function fetchFallbackPhoto(client: any, entity: any): Promise<Api.Photo | null> {
  try {
    const full = await client.invoke(new Api.users.GetFullUser({ id: entity }));
    const photo = (full as any)?.fullUser?.fallbackPhoto;
    return photo instanceof Api.Photo ? photo : null;
  } catch (error) {
    console.error('[sendProfileMedia] Could not fetch the fallback photo:', error);
    return null;
  }
}

/**
 * Sends photos the target deleted from their history but the monitoring
 * archive kept. Returns whether anything was sent.
 */
async function sendArchivedDeletedPhotos(
  chatId: number | string,
  entity: any,
  input: string,
  locale: string,
): Promise<boolean> {
  const targetId = entity?.id !== undefined && entity?.id !== null ? String(entity.id) : '';
  if (!targetId) return false;
  const rows = listDeletedArchivedPhotos(targetId, 10);
  if (rows.length === 0) return false;
  try {
    await bot.telegram.sendMessage(
      chatId,
      t(locale, 'profile.archivedDeleted', { count: rows.length, user: input }),
    );
    if (rows.length === 1) {
      const only = rows[0];
      if (only.is_video) await bot.telegram.sendVideo(chatId, { source: only.file_path! });
      else await bot.telegram.sendPhoto(chatId, { source: only.file_path! });
    } else {
      await bot.telegram.sendMediaGroup(
        chatId,
        rows.map((row) => ({
          type: row.is_video ? ('video' as const) : ('photo' as const),
          media: { source: row.file_path! },
        })),
      );
    }
    return true;
  } catch (error) {
    console.error('[sendProfileMedia] Could not send archived photos:', error);
    return false;
  }
}

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
    const locale = user?.language_code || '';
    if (!photos.length) {
      let sentSomething = false;
      const fallback = await fetchFallbackPhoto(client, entity);
      if (fallback) {
        try {
          const { buffer, isVideo } = await downloadProfilePhoto(client, fallback);
          const caption = t(locale, 'profile.fallbackOnly', { user: input });
          if (isVideo) await bot.telegram.sendVideo(chatId, { source: buffer }, { caption });
          else await bot.telegram.sendPhoto(chatId, { source: buffer }, { caption });
          sentSomething = true;
        } catch (error) {
          console.error('[sendProfileMedia] Could not send the fallback photo:', error);
        }
      }
      if (await sendArchivedDeletedPhotos(chatId, entity, input, locale)) sentSomething = true;
      if (!sentSomething) {
        await bot.telegram.sendMessage(chatId, t(locale, 'profile.none'));
      }
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
      await sendArchivedDeletedPhotos(chatId, entity, input, locale);
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
