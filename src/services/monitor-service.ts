export async function refreshMonitorUsername(m: MonitorRow): Promise<void> {
  const last = usernameRefreshTimes.get(m.id) || 0;
  if (Date.now() - last < USERNAME_REFRESH_INTERVAL_MS) return;
  usernameRefreshTimes.set(m.id, Date.now());

  try {
    if (m.target_access_hash) {
      const client = await Userbot.getInstance();
      const res = await client.invoke(
        new Api.users.GetUsers({
          id: [
            new Api.InputUser({
              userId: bigInt(m.target_id),
              accessHash: bigInt(m.target_access_hash),
            }),
          ],
        }),
      );
      const user = Array.isArray(res) ? res[0] : res;
      if (user) {
        const username = (user as any).username || null;
        const accessHash = (user as any).accessHash
          ? String((user as any).accessHash)
          : null;
        if (username && username !== m.target_username) {
          updateMonitorUsername(m.id, username);
          m.target_username = username;
        }
        if (accessHash && accessHash !== m.target_access_hash) {
          updateMonitorAccessHash(m.id, accessHash);
          m.target_access_hash = accessHash;
        }
      }
      return;
    }

    // fallback to entity resolution (rare case if no accessHash available)
    const entity = await getEntityWithTempContact(
      m.target_username || m.target_id,
    );
    const username = (entity as any).username || null;
    const idStr = String((entity as any).id);
    const accessHash = (entity as any).accessHash
      ? String((entity as any).accessHash)
      : null;

    if (username && username !== m.target_username) {
      updateMonitorUsername(m.id, username);
      m.target_username = username;
    }
    if (idStr !== m.target_id) {
      updateMonitorTarget(m.id, idStr);
      m.target_id = idStr;
    }
    if (accessHash && accessHash !== m.target_access_hash) {
      updateMonitorAccessHash(m.id, accessHash);
      m.target_access_hash = accessHash;
    }
  } catch (err) {
    console.error(
      `[Monitor] Error refreshing username for ${formatMonitorTarget(m)}:`,
      err,
    );
  }
}
