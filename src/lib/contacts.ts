import { Userbot } from 'config/userbot';
import { Api } from 'telegram';
import { isPhoneNumber } from './helpers';
import bigInt, { BigInteger } from 'big-integer';

type EntityResult = Api.TypeUser | Api.TypeChat;

function isPhoneNotOccupiedError(err: unknown): boolean {
  return Boolean(
    err &&
    typeof err === 'object' &&
    'errorMessage' in err &&
    (err as { errorMessage?: string }).errorMessage === 'PHONE_NOT_OCCUPIED',
  );
}

function findUserById(
  id: BigInteger,
  users: Api.TypeUser[],
): Api.User | null {
  for (const user of users) {
    if (user instanceof Api.User && (user.id as BigInteger).equals(id)) {
      return user;
    }
  }
  return null;
}

function findChannelById(
  id: BigInteger,
  chats: Api.TypeChat[],
): Api.Channel | null {
  for (const chat of chats) {
    if (chat instanceof Api.Channel && (chat.id as BigInteger).equals(id)) {
      return chat;
    }
  }
  return null;
}

function findChatById(
  id: BigInteger,
  chats: Api.TypeChat[],
): Api.Chat | null {
  for (const chat of chats) {
    if (chat instanceof Api.Chat && (chat.id as BigInteger).equals(id)) {
      return chat;
    }
  }
  return null;
}

async function getEntityFromInputPeer(client: any, peer: Api.TypeInputPeer): Promise<EntityResult> {
  if (peer instanceof Api.InputPeerUser) {
    const res = await client.invoke(
      new Api.users.GetUsers({
        id: [
          new Api.InputUser({
            userId: peer.userId,
            accessHash: peer.accessHash,
          }),
        ],
      }),
    );
    return Array.isArray(res) ? res[0] : res;
  }

  if (peer instanceof Api.InputPeerChannel) {
    const res = await client.invoke(
      new Api.channels.GetChannels({
        id: [
          new Api.InputChannel({
            channelId: peer.channelId,
            accessHash: peer.accessHash,
          }),
        ],
      }),
    );
    const chats = (res as any)?.chats ?? [];
    if (Array.isArray(chats) && chats.length > 0) {
      return chats[0];
    }
    throw new Error('Failed to resolve channel from input peer');
  }

  if (peer instanceof Api.InputPeerChat) {
    const res = await client.invoke(
      new Api.messages.GetChats({ id: [peer.chatId] }),
    );
    const chats = (res as any)?.chats ?? [];
    if (Array.isArray(chats) && chats.length > 0) {
      return chats[0];
    }
    throw new Error('Failed to resolve chat from input peer');
  }

  throw new Error('Unsupported input peer type');
}

async function resolvePhone(client: any, phone: string): Promise<EntityResult> {
  const resolved = await client.invoke(
    new Api.contacts.ResolvePhone({ phone }),
  );

  if (resolved.peer instanceof Api.PeerUser) {
    const user = findUserById(resolved.peer.userId, resolved.users);
    if (!user || user.accessHash === undefined) {
      throw new Error('Resolved user is missing required access hash');
    }
    const inputPeer = new Api.InputPeerUser({
      userId: user.id,
      accessHash: user.accessHash,
    });
    return getEntityFromInputPeer(client, inputPeer);
  }

  if (resolved.peer instanceof Api.PeerChannel) {
    const channel = findChannelById(resolved.peer.channelId, resolved.chats);
    if (!channel || channel.accessHash === undefined) {
      throw new Error('Resolved channel is missing required access hash');
    }
    const inputPeer = new Api.InputPeerChannel({
      channelId: channel.id,
      accessHash: channel.accessHash,
    });
    return getEntityFromInputPeer(client, inputPeer);
  }

  if (resolved.peer instanceof Api.PeerChat) {
    const chat = findChatById(resolved.peer.chatId, resolved.chats);
    if (!chat) {
      throw new Error('Resolved chat is missing from response');
    }
    const inputPeer = new Api.InputPeerChat({ chatId: chat.id });
    return getEntityFromInputPeer(client, inputPeer);
  }

  throw new Error('Unsupported resolved peer type');
}

export async function getEntityWithTempContact(input: string): Promise<EntityResult> {
  const client = await Userbot.getInstance();
  if (!isPhoneNumber(input)) {
    if (/^\d+$/.test(input)) {
      try {
        return client.getEntity(bigInt(input));
      } catch {
        // fall back to treating as username below
      }
    }
    return client.getEntity(input);
  }

  try {
    return await resolvePhone(client, input);
  } catch (err) {
    if (!isPhoneNotOccupiedError(err)) {
      throw err;
    }
  }

  let cleanupUserId: BigInteger | null = null;
  let cleanupAccessHash: BigInteger | null = null;
  let shouldCleanup = false;

  try {
    const result = await client.invoke(
      new Api.contacts.ImportContacts({
        contacts: [
          new Api.InputPhoneContact({
            clientId: bigInt(Date.now()),
            phone: input,
            firstName: 'Temp',
            lastName: 'User',
          }),
        ],
      }),
    );

    const users = (result.users as Api.TypeUser[]).filter(
      (u): u is Api.User => u instanceof Api.User,
    );

    let targetUser: Api.User | null = null;
    if ('imported' in result && result.imported.length > 0) {
      const imported = result.imported[0];
      targetUser = users.find((u) => (u.id as BigInteger).equals(imported.userId)) ?? null;
      shouldCleanup = Boolean(targetUser);
    } else {
      targetUser = users[0] ?? null;
    }

    if (targetUser && targetUser.accessHash !== undefined) {
      if (shouldCleanup) {
        cleanupUserId = targetUser.id as BigInteger;
        cleanupAccessHash = targetUser.accessHash as BigInteger;
      }
      const inputPeer = new Api.InputPeerUser({
        userId: targetUser.id,
        accessHash: targetUser.accessHash,
      });
      return await getEntityFromInputPeer(client, inputPeer);
    }

    throw new Error('Unable to resolve phone number via contact import');
  } finally {
    if (shouldCleanup && cleanupUserId && cleanupAccessHash) {
      try {
        await client.invoke(
          new Api.contacts.DeleteContacts({
            id: [
              new Api.InputUser({
                userId: cleanupUserId,
                accessHash: cleanupAccessHash,
              }),
            ],
          }),
        );
      } catch (err) {
        console.error('[contacts] Failed to remove temporary contact:', err);
      }
    }
  }
}

