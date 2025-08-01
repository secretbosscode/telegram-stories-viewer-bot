import { Userbot } from 'config/userbot';
import { Api } from 'telegram';
import { isPhoneNumber } from './helpers';
import bigInt, { BigInteger } from 'big-integer';

export async function getEntityWithTempContact(input: string): Promise<any> {
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

  let importedId: BigInteger | null = null;
  let accessHash: BigInteger | null = null;
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
      })
    );
    if ('imported' in result && result.imported.length > 0) {
      importedId = result.imported[0].userId;
      const user = (result.users as any[]).find(
        (u: any) => 'id' in u && u.id.equals(importedId)
      );
      if (user && 'accessHash' in user) {
        accessHash = user.accessHash as BigInteger;
      }
    }
    return await client.getEntity(input);
  } finally {
    if (importedId && accessHash) {
      try {
        await client.invoke(
          new Api.contacts.DeleteContacts({
            id: [new Api.InputUser({ userId: importedId, accessHash })],
          })
        );
      } catch (err) {
        console.error('[contacts] Failed to remove temporary contact:', err);
      }
    }
  }
}

