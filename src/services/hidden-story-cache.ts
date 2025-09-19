import { Api, TelegramClient, utils } from 'telegram';
import { db } from 'db';

interface HiddenStoryRow {
  peer_id: string;
  access_hash: string | null;
  story_id: number;
  media: string;
  expires_at: number;
}

interface CachedHiddenStory {
  peerId: string;
  accessHash: string | null;
  storyId: number;
  expiresAt: number;
  story: Api.StoryItem;
  peer?: Api.TypePeer | null;
}

export interface StoryWithPeer {
  peerId: string;
  story: Api.TypeStoryItem;
}

const upsertStoryStmt = db.prepare(`
  INSERT INTO hidden_story_cache (peer_id, access_hash, story_id, media, expires_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(peer_id, story_id) DO UPDATE SET
    media = excluded.media,
    access_hash = excluded.access_hash,
    expires_at = excluded.expires_at
`);

const deleteExpiredStmt = db.prepare(
  `DELETE FROM hidden_story_cache WHERE expires_at <= ?`
);

const selectActiveStoriesStmt = db.prepare(
  `SELECT peer_id, access_hash, story_id, media, expires_at
     FROM hidden_story_cache
    WHERE expires_at > ?`
);

function pruneExpiredStories(): void {
  const now = Math.floor(Date.now() / 1000);
  try {
    deleteExpiredStmt.run(now);
  } catch (err) {
    console.error('[HiddenStoryCache] Failed to prune expired stories:', err);
  }
}

function makeCacheKey(peerId: string, storyId: number): string {
  return `${peerId}:${storyId}`;
}

function normalizePeer(peer?: Api.TypePeer | null): any | undefined {
  if (!peer) return undefined;
  try {
    const maybeToJSON = (peer as any).toJSON;
    if (typeof maybeToJSON === 'function') {
      return maybeToJSON.call(peer);
    }
  } catch (err) {
    console.warn('[HiddenStoryCache] Failed to normalize peer', err);
  }
  return undefined;
}

function hydrateFromJSON(value: any): any {
  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => hydrateFromJSON(item));
  }

  if (typeof value === 'object') {
    const className = value.className as string | undefined;
    if (className) {
      const args = { ...value };
      delete (args as any).className;

      for (const key of Object.keys(args)) {
        args[key] = hydrateFromJSON(args[key]);
      }

      try {
        let ctor: any = Api;
        for (const part of className.split('.')) {
          ctor = ctor?.[part];
        }
        if (!ctor) {
          return value;
        }
        return new ctor(args);
      } catch (err) {
        console.error('[HiddenStoryCache] Failed to hydrate class', className, err);
        return value;
      }
    }

    const hydrated: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      hydrated[key] = hydrateFromJSON(val);
    }
    return hydrated;
  }

  return value;
}

function deserializeStoryPayload(serialized: string): { story: Api.StoryItem; peer?: Api.TypePeer | null } | null {
  try {
    const payload = JSON.parse(serialized);
    if (!payload || typeof payload !== 'object') {
      return null;
    }

    const story = hydrateFromJSON(payload.story) as Api.StoryItem | undefined;
    const peer = hydrateFromJSON(payload.peer) as Api.TypePeer | undefined;

    if (!story || !(story instanceof Api.StoryItem)) {
      return null;
    }

    return { story, peer };
  } catch (err) {
    console.error('[HiddenStoryCache] Failed to deserialize cached story', err);
    return null;
  }
}

function loadActiveStories(): CachedHiddenStory[] {
  const now = Math.floor(Date.now() / 1000);
  let rows: HiddenStoryRow[] = [];
  try {
    rows = selectActiveStoriesStmt.all(now) as unknown as HiddenStoryRow[];
  } catch (err) {
    console.error('[HiddenStoryCache] Failed to load cached stories:', err);
    return [];
  }

  const results: CachedHiddenStory[] = [];
  for (const row of rows) {
    const payload = deserializeStoryPayload(row.media);
    if (!payload) continue;

    const story = payload.story;
    const peer = payload.peer ?? story.fromId ?? null;

    results.push({
      peerId: row.peer_id,
      accessHash: row.access_hash,
      storyId: row.story_id,
      expiresAt: row.expires_at,
      story,
      peer,
    });
  }
  return results;
}

async function resolveUpdatePeer(
  client: TelegramClient,
  update: Api.UpdateStory | Api.UpdateStoryID,
): Promise<{ peerId: string; accessHash: string | null; peer: Api.TypePeer | null } | null> {
  if (update instanceof Api.UpdateStory) {
    const candidatePeer = update.peer ?? (update.story instanceof Api.StoryItem ? update.story.fromId : null);
    if (!candidatePeer) return null;

    try {
      const inputPeer = await client.getInputEntity(candidatePeer);
      const peerId = utils.getPeerId(candidatePeer);
      const accessHash =
        typeof (inputPeer as any).accessHash !== 'undefined' && (inputPeer as any).accessHash !== null
          ? String((inputPeer as any).accessHash)
          : null;
      return { peerId, accessHash, peer: candidatePeer };
    } catch (err) {
      console.error('[HiddenStoryCache] Failed to resolve peer for story update:', err);
      return null;
    }
  }

  return null;
}

function shouldPreferCached(story: Api.StoryItem): boolean {
  if (story.min) return true;
  if (!story.media) return true;
  if (story.media instanceof Api.MessageMediaEmpty) return true;
  if (story.media instanceof Api.MessageMediaUnsupported) return true;
  return false;
}

function serializeStory(story: Api.StoryItem, peer: Api.TypePeer | null | undefined): string {
  const payload = {
    story: story.toJSON(),
    peer: normalizePeer(peer ?? story.fromId ?? null),
  };
  return JSON.stringify(payload);
}

function getStoryId(story: Api.TypeStoryItem): number | null {
  if (!story) return null;
  if ('id' in story && typeof (story as any).id === 'number') {
    return (story as any).id as number;
  }
  return null;
}

function ensurePeerId(peer?: Api.TypePeer | null, fallbackStory?: Api.TypeStoryItem): string | null {
  const candidate = peer ?? (fallbackStory instanceof Api.StoryItem ? fallbackStory.fromId ?? null : null);
  if (!candidate) return null;
  try {
    return utils.getPeerId(candidate);
  } catch (err) {
    console.warn('[HiddenStoryCache] Failed to derive peer id', err);
    return null;
  }
}

function unwrapPeerStories(
  item: Api.TypePeerStories | Api.PeerStories | Api.stories.PeerStories | undefined,
): { peer?: Api.TypePeer | null; stories: Api.TypeStoryItem[] } {
  if (!item) {
    return { peer: null, stories: [] };
  }

  if (item instanceof Api.PeerStories) {
    return { peer: item.peer ?? null, stories: item.stories ?? [] };
  }

  if (item instanceof Api.stories.PeerStories) {
    const nested = item.stories;
    if (nested instanceof Api.PeerStories) {
      return { peer: nested.peer ?? null, stories: nested.stories ?? [] };
    }
    if (nested && typeof nested === 'object' && 'stories' in nested) {
      const stories = (nested as { stories?: Api.TypeStoryItem[] }).stories ?? [];
      const peer = (nested as { peer?: Api.TypePeer }).peer ?? null;
      return { peer, stories };
    }
    return { peer: null, stories: [] };
  }

  if (typeof item === 'object' && 'stories' in item) {
    const stories = (item as { stories?: Api.TypeStoryItem[] }).stories ?? [];
    const peer = (item as { peer?: Api.TypePeer }).peer ?? null;
    return { peer, stories };
  }

  return { peer: null, stories: [] };
}

export function collectStoriesFromAllStories(allStories: Api.stories.AllStories): StoryWithPeer[] {
  const entries: StoryWithPeer[] = [];
  const peerStories = allStories.peerStories ?? [];
  for (const item of peerStories) {
    const { peer, stories } = unwrapPeerStories(item);
    if (!stories || stories.length === 0) continue;

    for (const story of stories) {
      const peerId = ensurePeerId(peer, story);
      if (!peerId) continue;
      entries.push({ peerId, story });
    }
  }
  return entries;
}

export async function handleHiddenStoryUpdate(
  client: TelegramClient,
  update: Api.UpdateStory | Api.UpdateStoryID,
): Promise<void> {
  if (!(update instanceof Api.UpdateStory)) {
    if (update instanceof Api.UpdateStoryID) {
      pruneExpiredStories();
    }
    return;
  }

  const story = update.story;
  if (!(story instanceof Api.StoryItem)) {
    return;
  }
  if (!story.media) {
    return;
  }

  const resolved = await resolveUpdatePeer(client, update);
  if (!resolved) {
    return;
  }

  try {
    const serialized = serializeStory(story, resolved.peer);
    upsertStoryStmt.run(resolved.peerId, resolved.accessHash, story.id, serialized, story.expireDate);
  } catch (err) {
    console.error('[HiddenStoryCache] Failed to persist story cache:', err);
  }

  pruneExpiredStories();
}

function buildCacheMap(): Map<string, CachedHiddenStory> {
  const cache = loadActiveStories();
  const now = Math.floor(Date.now() / 1000);
  const map = new Map<string, CachedHiddenStory>();
  for (const record of cache) {
    if (!record.story || record.expiresAt <= now) continue;
    const key = makeCacheKey(record.peerId, record.storyId);
    if (!map.has(key)) {
      map.set(key, record);
    }
  }
  return map;
}

function isMediaEmpty(media: Api.TypeMessageMedia | null | undefined): boolean {
  if (!media) return true;
  if (media instanceof Api.MessageMediaEmpty) return true;
  if (media instanceof Api.MessageMediaUnsupported) return true;
  return false;
}

export function mergeStoriesWithHiddenCache(
  stories: StoryWithPeer[],
  options?: { includeHidden?: boolean },
): Api.StoryItem[] {
  const includeHidden = options?.includeHidden ?? false;
  const cacheMap = buildCacheMap();
  const merged = new Map<string, Api.StoryItem>();

  for (const { peerId, story } of stories) {
    const storyId = getStoryId(story);
    if (storyId === null) continue;
    const key = makeCacheKey(peerId, storyId);
    const cached = cacheMap.get(key);

    if (story instanceof Api.StoryItem) {
      if (cached) {
        let chosen: Api.StoryItem = story;
        if (shouldPreferCached(story)) {
          chosen = cached.story;
        } else if (isMediaEmpty(story.media)) {
          chosen.media = cached.story.media;
        }
        merged.set(key, chosen);
        cacheMap.delete(key);
      } else {
        merged.set(key, story);
      }
    } else if (cached) {
      merged.set(key, cached.story);
      cacheMap.delete(key);
    }
  }

  if (includeHidden) {
    for (const [key, cached] of cacheMap) {
      merged.set(key, cached.story);
    }
  }

  const storiesArr = Array.from(merged.values()).filter((value): value is Api.StoryItem => value instanceof Api.StoryItem);
  storiesArr.sort((a, b) => (b.date ?? 0) - (a.date ?? 0));
  return storiesArr;
}

