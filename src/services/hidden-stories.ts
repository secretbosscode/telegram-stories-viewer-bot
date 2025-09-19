import { Userbot } from 'config/userbot';
import { Api } from 'telegram';

/**
 * Temporarily unhides a peer's stories, executes the provided async callback, and
 * re-hides the stories afterwards.
 */
export async function withPeerStoriesTemporarilyVisible<T>(
  peer: Api.TypeEntityLike,
  callback: () => Promise<T>,
): Promise<T> {
  const client = await Userbot.getInstance();
  let visibilityToggled = false;

  try {
    await client.invoke(new Api.stories.TogglePeerStoriesHidden({ peer, hidden: false }));
    visibilityToggled = true;
  } catch (error) {
    console.error('[HiddenStories] Failed to unhide peer stories:', error);
  }

  try {
    return await callback();
  } finally {
    if (visibilityToggled) {
      try {
        await client.invoke(new Api.stories.TogglePeerStoriesHidden({ peer, hidden: true }));
      } catch (error) {
        console.error('[HiddenStories] Failed to re-hide peer stories:', error);
      }
    }
  }
}
