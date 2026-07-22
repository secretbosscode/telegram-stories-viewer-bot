from pathlib import Path


def read(path: str) -> str:
    return Path(path).read_text()


def write(path: str, text: str) -> None:
    Path(path).write_text(text)


def replace_required(path: str, old: str, new: str, marker: str | None = None) -> None:
    text = read(path)
    if marker and marker in text:
        print(f"already applied: {path}: {marker}")
        return
    if old not in text:
        raise SystemExit(f"pattern not found in {path}: {old[:180]!r}")
    write(path, text.replace(old, new, 1))
    print(f"patched: {path}: {marker or old[:60]}")


def insert_before(path: str, anchor: str, insertion: str, marker: str) -> None:
    text = read(path)
    if marker in text:
        print(f"already applied: {path}: {marker}")
        return
    if anchor not in text:
        raise SystemExit(f"anchor not found in {path}: {anchor!r}")
    write(path, text.replace(anchor, insertion + anchor, 1))
    print(f"inserted: {path}: {marker}")


# ---------------------------------------------------------------------------
# Payment/refund state machine.
# ---------------------------------------------------------------------------
replace_required(
    "src/services/stars-payment.ts",
    "async function refundBundle(bundle: StarsBundleRow, notifyUser = true): Promise<boolean> {",
    "async function refundBundle(\n  bundle: StarsBundleRow,\n  notifyUser = true,\n  deferIfProcessing = false,\n): Promise<boolean> {",
    "deferIfProcessing = false",
)

replace_required(
    "src/services/stars-payment.ts",
    "    if (processing) {\n      db.exec('ROLLBACK');\n      return false;\n    }",
    "    if (processing) {\n      if (deferIfProcessing) {\n        db.prepare(\n          `UPDATE star_result_bundles\n           SET status = 'REFUND_PENDING'\n           WHERE id = ?\n             AND (\n               status IN ('PAID', 'DELIVERING', 'REFUND_PENDING')\n               OR (status = 'DELIVERED' AND request_kind IN ('monitor_week', 'monitor_month'))\n             )`,\n        ).run(bundle.id);\n        db.exec('COMMIT');\n      } else {\n        db.exec('ROLLBACK');\n      }\n      return false;\n    }",
    "if (deferIfProcessing)",
)

replace_required(
    "src/services/stars-payment.ts",
    "    const fenced = db.prepare(\n      `UPDATE star_result_bundles\n       SET status = 'REFUND_PENDING', last_error = NULL\n       WHERE id = ? AND status IN ('PAID', 'DELIVERING', 'REFUND_PENDING')`,\n    ).run(bundle.id);",
    "    const fenced = db.prepare(\n      `UPDATE star_result_bundles\n       SET status = 'REFUND_PENDING', last_error = NULL\n       WHERE id = ?\n         AND (\n           status IN ('PAID', 'DELIVERING', 'REFUND_PENDING')\n           OR (status = 'DELIVERED' AND request_kind IN ('monitor_week', 'monitor_month'))\n         )`,\n    ).run(bundle.id);",
    "status = 'DELIVERED' AND request_kind IN ('monitor_week', 'monitor_month')",
)

replace_required(
    "src/services/stars-payment.ts",
    "export async function refundUndeliverableStarsBundle(bundleId: string): Promise<boolean> {\n  const bundle = getBundle(bundleId);\n  if (!bundle) return false;\n  return refundBundle(bundle);\n}\n",
    "export async function refundUndeliverableStarsBundle(bundleId: string): Promise<boolean> {\n  const bundle = getBundle(bundleId);\n  if (!bundle) return false;\n  return refundBundle(bundle, true, true);\n}\n\nexport async function finalizeDeferredStarsRefund(bundleId: string): Promise<boolean> {\n  const bundle = getBundle(bundleId);\n  if (!bundle || bundle.status !== 'REFUND_PENDING') return false;\n  return refundBundle(bundle);\n}\n",
    "export async function finalizeDeferredStarsRefund",
)

replace_required(
    "src/services/stars-payment.ts",
    "      if (changed && mode === 'stars') {\n        const { synchronizeStarsCommandMenus } = await import('./stars-command-surface');\n        await synchronizeStarsCommandMenus(bot, true);\n      }",
    "      if (changed) {\n        const { synchronizeLegacyCommandMenus, synchronizeStarsCommandMenus } =\n          await import('./stars-command-surface');\n        if (mode === 'stars') {\n          await synchronizeStarsCommandMenus(bot, true);\n        } else {\n          await synchronizeLegacyCommandMenus(bot);\n        }\n      }",
    "await synchronizeLegacyCommandMenus(bot)",
)

replace_required(
    "src/services/queue-manager.ts",
    "        await markDoneFx(job.id);\n        console.log(`[QueueManager] Finished processing for ${currentTask.link} (Job ID: ${job.id})`);",
    "        await markDoneFx(job.id);\n        if (currentTask.starsBundleId) {\n          const { finalizeDeferredStarsRefund } = await import('./stars-payment');\n          await finalizeDeferredStarsRefund(currentTask.starsBundleId).catch((error) => {\n            console.error(`[QueueManager] Deferred Stars refund failed for ${currentTask.starsBundleId}:`, error);\n          });\n        }\n        console.log(`[QueueManager] Finished processing for ${currentTask.link} (Job ID: ${job.id})`);",
    "Deferred Stars refund failed",
)


# ---------------------------------------------------------------------------
# Monitoring grant ordering and Premium-expiry reconciliation.
# ---------------------------------------------------------------------------
replace_required(
    "src/services/stars-mode-safety.ts",
    "              SELECT max_targets\n              FROM star_monitor_grants\n              WHERE user_id = star_monitor_entitlements.user_id\n                AND bundle_id <> NEW.bundle_id\n                AND refunded_at IS NULL\n              ORDER BY granted_at DESC, bundle_id DESC\n              LIMIT 1",
    "              SELECT g.max_targets\n              FROM star_monitor_grants g\n              JOIN star_payments p ON p.bundle_id = g.bundle_id\n              WHERE g.user_id = star_monitor_entitlements.user_id\n                AND g.bundle_id <> NEW.bundle_id\n                AND g.refunded_at IS NULL\n              ORDER BY p.paid_at DESC, p.rowid DESC\n              LIMIT 1",
    "SELECT g.max_targets",
)
replace_required(
    "src/services/stars-mode-safety.ts",
    "              SELECT plan\n              FROM star_monitor_grants\n              WHERE user_id = star_monitor_entitlements.user_id\n                AND bundle_id <> NEW.bundle_id\n                AND refunded_at IS NULL\n              ORDER BY granted_at DESC, bundle_id DESC\n              LIMIT 1",
    "              SELECT g.plan\n              FROM star_monitor_grants g\n              JOIN star_payments p ON p.bundle_id = g.bundle_id\n              WHERE g.user_id = star_monitor_entitlements.user_id\n                AND g.bundle_id <> NEW.bundle_id\n                AND g.refunded_at IS NULL\n              ORDER BY p.paid_at DESC, p.rowid DESC\n              LIMIT 1",
    "SELECT g.plan",
)
replace_required(
    "src/services/stars-mode-safety.ts",
    "              SELECT bundle_id\n              FROM star_monitor_grants\n              WHERE user_id = star_monitor_entitlements.user_id\n                AND bundle_id <> NEW.bundle_id\n                AND refunded_at IS NULL\n              ORDER BY granted_at DESC, bundle_id DESC\n              LIMIT 1",
    "              SELECT g.bundle_id\n              FROM star_monitor_grants g\n              JOIN star_payments p ON p.bundle_id = g.bundle_id\n              WHERE g.user_id = star_monitor_entitlements.user_id\n                AND g.bundle_id <> NEW.bundle_id\n                AND g.refunded_at IS NULL\n              ORDER BY p.paid_at DESC, p.rowid DESC\n              LIMIT 1",
    "SELECT g.bundle_id",
)

reconcile_function = r'''
export function reconcileStarsMonitorLimit(userId: string): number {
  const entitlement = getStarsMonitoringEntitlement(userId);
  if (!entitlement) return 0;

  const premium = db.prepare(
    `SELECT 1
     FROM users
     WHERE telegram_id = ?
       AND COALESCE(is_premium, 0) = 1
       AND (premium_until IS NULL OR premium_until >= ?)
     LIMIT 1`,
  ).get(userId, nowSeconds());
  if (premium) return 0;

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      `INSERT OR REPLACE INTO star_monitor_delete_authorizations (
         telegram_id, target_id, authorized_at
       )
       SELECT m.telegram_id, m.target_id, ?
       FROM monitors m
       WHERE m.telegram_id = ?
         AND (
           SELECT COUNT(*)
           FROM monitors earlier
           WHERE earlier.telegram_id = m.telegram_id
             AND (
               COALESCE(earlier.created_at, 0) < COALESCE(m.created_at, 0)
               OR (
                 COALESCE(earlier.created_at, 0) = COALESCE(m.created_at, 0)
                 AND earlier.id <= m.id
               )
             )
         ) > ?`,
    ).run(nowSeconds(), userId, entitlement.maxTargets);

    const removed = db.prepare(
      `DELETE FROM monitors
       WHERE telegram_id = ?
         AND (
           SELECT COUNT(*)
           FROM monitors earlier
           WHERE earlier.telegram_id = monitors.telegram_id
             AND (
               COALESCE(earlier.created_at, 0) < COALESCE(monitors.created_at, 0)
               OR (
                 COALESCE(earlier.created_at, 0) = COALESCE(monitors.created_at, 0)
                 AND earlier.id <= monitors.id
               )
             )
         ) > ?`,
    ).run(userId, entitlement.maxTargets);

    db.prepare(
      'DELETE FROM star_monitor_delete_authorizations WHERE telegram_id = ?',
    ).run(userId);
    db.exec('COMMIT');
    return Number(removed.changes ?? 0);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

'''
insert_before(
    "src/services/stars-mode-safety.ts",
    "export function authorizeStarsMonitorRemoval(",
    reconcile_function,
    "export function reconcileStarsMonitorLimit",
)

replace_required(
    "src/services/monitor-service.ts",
    "  getStarsMonitoringEntitlement,\n} from 'services/stars-mode-safety';",
    "  getStarsMonitoringEntitlement,\n  reconcileStarsMonitorLimit,\n} from 'services/stars-mode-safety';",
    "reconcileStarsMonitorLimit,",
)

old_force = '''export async function forceCheckMonitors(): Promise<number> {
  if (monitorTimer) {
    clearTimeout(monitorTimer);
    monitorTimer = null;
  }
  const monitors = listAllMonitors();
  const premiumCache = new Map<string, boolean>();
  try {
    for (const monitor of monitors) {
      let premium = premiumCache.get(monitor.telegram_id);
      if (premium === undefined) {
        premium = isUserPremium(monitor.telegram_id);
        premiumCache.set(monitor.telegram_id, premium);
      }
      const starsEntitlement = getStarsMonitoringEntitlement(monitor.telegram_id);
      if (!premium && Number(monitor.telegram_id) !== BOT_ADMIN_ID && !starsEntitlement) {
        removeMonitor(monitor.telegram_id, monitor.target_id);
        continue;
      }
      await checkSingleMonitor(monitor.id);
    }
  } finally {
    scheduleNextMonitorCheck();
  }
  return monitors.length;
}'''
new_force = '''export async function forceCheckMonitors(): Promise<number> {
  if (monitorTimer) {
    clearTimeout(monitorTimer);
    monitorTimer = null;
  }
  let monitors = listAllMonitors();
  const premiumCache = new Map<string, boolean>();
  const reconciledUsers = new Set<string>();
  try {
    for (const monitor of monitors) {
      let premium = premiumCache.get(monitor.telegram_id);
      if (premium === undefined) {
        premium = isUserPremium(monitor.telegram_id);
        premiumCache.set(monitor.telegram_id, premium);
      }
      const starsEntitlement = getStarsMonitoringEntitlement(monitor.telegram_id);
      if (
        !premium &&
        Number(monitor.telegram_id) !== BOT_ADMIN_ID &&
        starsEntitlement &&
        !reconciledUsers.has(monitor.telegram_id)
      ) {
        reconcileStarsMonitorLimit(monitor.telegram_id);
        reconciledUsers.add(monitor.telegram_id);
      }
    }

    monitors = listAllMonitors();
    for (const monitor of monitors) {
      let premium = premiumCache.get(monitor.telegram_id);
      if (premium === undefined) {
        premium = isUserPremium(monitor.telegram_id);
        premiumCache.set(monitor.telegram_id, premium);
      }
      const starsEntitlement = getStarsMonitoringEntitlement(monitor.telegram_id);
      if (!premium && Number(monitor.telegram_id) !== BOT_ADMIN_ID && !starsEntitlement) {
        removeMonitor(monitor.telegram_id, monitor.target_id);
        continue;
      }
      await checkSingleMonitor(monitor.id);
    }
  } finally {
    scheduleNextMonitorCheck();
  }
  return monitors.length;
}'''
replace_required(
    "src/services/monitor-service.ts",
    old_force,
    new_force,
    "const reconciledUsers = new Set<string>()",
)


# ---------------------------------------------------------------------------
# Command-scope tracking and deterministic menu rebuilds in both modes.
# ---------------------------------------------------------------------------
insert_before(
    "src/services/stars-command-surface.ts",
    "function getStarsBaseCommands(locale: string) {",
    """db.exec(`
  CREATE TABLE IF NOT EXISTS bot_command_scopes (
    chat_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    locale TEXT NOT NULL DEFAULT 'en',
    is_group INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (chat_id, user_id)
  );
`);

""",
    "CREATE TABLE IF NOT EXISTS bot_command_scopes",
)

legacy_functions = r'''function getLegacyBaseCommands(locale: string) {
  return [
    { command: 'start', description: t(locale, 'cmd.start') },
    { command: 'help', description: t(locale, 'cmd.help') },
    { command: 'premium', description: t(locale, 'cmd.premium') },
    { command: 'upgrade', description: t(locale, 'cmd.upgrade') },
    { command: 'freetrial', description: t(locale, 'cmd.freetrial') },
    { command: 'verify', description: t(locale, 'cmd.verify') },
    { command: 'queue', description: t(locale, 'cmd.queue') },
    { command: 'invite', description: t(locale, 'cmd.invite') },
    { command: 'profile', description: t(locale, 'cmd.profile') },
    { command: 'bugs', description: t(locale, 'cmd.bugs') },
  ];
}

function getLegacyPremiumCommands(locale: string) {
  return [
    { command: 'monitor', description: t(locale, 'cmd.monitor') },
    { command: 'unmonitor', description: t(locale, 'cmd.unmonitor') },
    { command: 'archive', description: t(locale, 'cmd.archive') },
  ];
}

function getLegacyAdminCommands(locale: string) {
  return [
    { command: 'setpremium', description: t(locale, 'cmd.setpremium') },
    { command: 'unsetpremium', description: t(locale, 'cmd.unsetpremium') },
    { command: 'ispremium', description: t(locale, 'cmd.ispremium') },
    { command: 'listpremium', description: t(locale, 'cmd.listpremium') },
    { command: 'users', description: t(locale, 'cmd.users') },
    { command: 'history', description: t(locale, 'cmd.history') },
    { command: 'block', description: t(locale, 'cmd.block') },
    { command: 'unblock', description: t(locale, 'cmd.unblock') },
    { command: 'blocklist', description: t(locale, 'cmd.blocklist') },
    { command: 'status', description: t(locale, 'cmd.status') },
    { command: 'restart', description: t(locale, 'cmd.restart') },
    { command: 'flush', description: t(locale, 'cmd.flush') },
    { command: 'forcemonitor', description: t(locale, 'cmd.forcemonitor') },
    { command: 'stopmonitor', description: t(locale, 'cmd.stopmonitor') },
    { command: 'globalstories', description: t(locale, 'cmd.globalstories') },
    { command: 'welcome', description: t(locale, 'cmd.welcome') },
    { command: 'bugreport', description: t(locale, 'cmd.listbugs') },
  ];
}

function buildLegacyCommands(locale: string, userId?: string) {
  const commands = [...getLegacyBaseCommands(locale)];
  const admin = userId === String(BOT_ADMIN_ID);
  if (admin || (userId && isUserPremium(userId))) {
    commands.push(...getLegacyPremiumCommands(locale));
  }
  if (admin) commands.push(...getLegacyAdminCommands(locale));
  return commands;
}

'''
insert_before(
    "src/services/stars-command-surface.ts",
    "function buildCommands(locale: string, userId?: string) {",
    legacy_functions,
    "function getLegacyBaseCommands",
)

replace_required(
    "src/services/stars-command-surface.ts",
    "  const scope: any = chatId === userId\n    ? { type: 'chat', chat_id: numericChatId }\n    : { type: 'chat_member', chat_id: numericChatId, user_id: numericUserId };\n\n  try {\n    await bot.telegram.setMyCommands(buildCommands(locale, userId), { scope });\n    syncedChats.add(cacheKey);",
    "  const isGroup = chatId !== userId;\n  const scope: any = isGroup\n    ? { type: 'chat_member', chat_id: numericChatId, user_id: numericUserId }\n    : { type: 'chat', chat_id: numericChatId };\n\n  try {\n    if (isGroup) {\n      await (bot.telegram as any).callApi('deleteMyCommands', {\n        scope: { type: 'chat', chat_id: numericChatId },\n      }).catch(() => {});\n    }\n    await bot.telegram.setMyCommands(buildCommands(locale, userId), { scope });\n    db.prepare(\n      `INSERT INTO bot_command_scopes (chat_id, user_id, locale, is_group, updated_at)\n       VALUES (?, ?, ?, ?, ?)\n       ON CONFLICT(chat_id, user_id) DO UPDATE SET\n         locale = excluded.locale,\n         is_group = excluded.is_group,\n         updated_at = excluded.updated_at`,\n    ).run(chatId, userId, locale || 'en', isGroup ? 1 : 0, Math.floor(Date.now() / 1000));\n    syncedChats.add(cacheKey);",
    "INSERT INTO bot_command_scopes (chat_id, user_id, locale, is_group, updated_at)",
)

replace_required(
    "src/services/stars-command-surface.ts",
    "      SELECT CAST(chat_id AS TEXT) AS group_id\n       FROM star_result_bundles\n       WHERE CAST(chat_id AS INTEGER) < 0",
    "      SELECT CAST(chat_id AS TEXT) AS group_id\n       FROM star_result_bundles\n       WHERE CAST(chat_id AS INTEGER) < 0\n       UNION\n       SELECT chat_id AS group_id\n       FROM bot_command_scopes\n       WHERE is_group = 1",
    "SELECT chat_id AS group_id\n       FROM bot_command_scopes",
)

replace_required(
    "src/services/stars-command-surface.ts",
    "  const users = db.prepare(\n    'SELECT telegram_id, language FROM users ORDER BY created_at ASC',\n  ).all() as { telegram_id: string; language?: string }[];",
    "  const trackedMembers = db.prepare(\n    `SELECT chat_id, user_id, locale\n     FROM bot_command_scopes\n     WHERE is_group = 1\n     ORDER BY updated_at ASC`,\n  ).all() as { chat_id: string; user_id: string; locale?: string }[];\n  for (const member of trackedMembers) {\n    await syncChatCommands(bot, member.chat_id, member.user_id, member.locale || 'en', true);\n    await new Promise((resolve) => setTimeout(resolve, 100));\n  }\n\n  const users = db.prepare(\n    'SELECT telegram_id, language FROM users ORDER BY created_at ASC',\n  ).all() as { telegram_id: string; language?: string }[];",
    "const trackedMembers = db.prepare",
)

legacy_sync = r'''export async function synchronizeLegacyCommandMenus(
  bot: Telegraf<IContextBot>,
): Promise<void> {
  syncedChats.clear();
  await bot.telegram.setMyCommands(getLegacyBaseCommands('en'));
  await bot.telegram.setMyCommands(
    buildLegacyCommands('en', String(BOT_ADMIN_ID)),
    { scope: { type: 'chat', chat_id: BOT_ADMIN_ID } },
  );

  const trackedScopes = db.prepare(
    `SELECT chat_id, user_id, locale, is_group
     FROM bot_command_scopes
     ORDER BY updated_at ASC`,
  ).all() as { chat_id: string; user_id: string; locale?: string; is_group: number }[];

  const clearedGroups = new Set<string>();
  for (const tracked of trackedScopes) {
    const chatId = Number(tracked.chat_id);
    const userId = Number(tracked.user_id);
    if (!Number.isFinite(chatId) || !Number.isFinite(userId)) continue;
    if (tracked.is_group) {
      if (!clearedGroups.has(tracked.chat_id)) {
        await (bot.telegram as any).callApi('deleteMyCommands', {
          scope: { type: 'chat', chat_id: chatId },
        }).catch(() => {});
        clearedGroups.add(tracked.chat_id);
      }
      await bot.telegram.setMyCommands(
        buildLegacyCommands(tracked.locale || 'en', tracked.user_id),
        { scope: { type: 'chat_member', chat_id: chatId, user_id: userId } },
      ).catch(() => {});
    } else {
      await bot.telegram.setMyCommands(
        buildLegacyCommands(tracked.locale || 'en', tracked.user_id),
        { scope: { type: 'chat', chat_id: chatId } },
      ).catch(() => {});
    }
  }

  const users = db.prepare(
    'SELECT telegram_id, language FROM users ORDER BY created_at ASC',
  ).all() as { telegram_id: string; language?: string }[];
  for (const user of users) {
    const chatId = Number(user.telegram_id);
    if (!Number.isFinite(chatId)) continue;
    await bot.telegram.setMyCommands(
      buildLegacyCommands(user.language || 'en', user.telegram_id),
      { scope: { type: 'chat', chat_id: chatId } },
    ).catch(() => {});
  }
}

'''
insert_before(
    "src/services/stars-command-surface.ts",
    "export async function synchronizeStarsCommandMenus(",
    legacy_sync,
    "export async function synchronizeLegacyCommandMenus",
)

replace_required(
    "src/index.ts",
    "  if (!isStarsMode()) {\n    await bot.telegram.setMyCommands(getBaseCommands('en'));\n    await bot.telegram.setMyCommands(\n      [...getBaseCommands('en'), ...getPremiumCommands('en'), ...getAdminCommands('en')],\n      { scope: { type: 'chat', chat_id: BOT_ADMIN_ID } }\n    );\n  }",
    "  const { synchronizeLegacyCommandMenus, synchronizeStarsCommandMenus } =\n    await import('./services/stars-command-surface');\n  if (isStarsMode()) {\n    await synchronizeStarsCommandMenus(bot, true);\n  } else {\n    await synchronizeLegacyCommandMenus(bot);\n  }",
    "await synchronizeLegacyCommandMenus(bot)",
)


# ---------------------------------------------------------------------------
# Focused final regression contract. Full Jest still runs afterwards.
# ---------------------------------------------------------------------------
final_test = r'''import fs from 'fs';

const source = (path: string) => fs.readFileSync(path, 'utf8');

describe('PR 310 final review regressions', () => {
  test('partial paid deliveries enter a deferred refund and finalize after queue completion', () => {
    const payment = source('src/services/stars-payment.ts');
    const queue = source('src/services/queue-manager.ts');
    expect(payment).toContain('deferIfProcessing = false');
    expect(payment).toContain("SET status = 'REFUND_PENDING'");
    expect(payment).toContain('export async function finalizeDeferredStarsRefund');
    expect(queue).toContain('await finalizeDeferredStarsRefund(currentTask.starsBundleId)');
  });

  test('monitor purchases remain refundable after fulfillment', () => {
    const payment = source('src/services/stars-payment.ts');
    expect(payment).toContain("status = 'DELIVERED' AND request_kind IN ('monitor_week', 'monitor_month')");
  });

  test('monitor plan restoration follows payment order and Premium expiry reconciles excess rows', () => {
    const safety = source('src/services/stars-mode-safety.ts');
    const monitor = source('src/services/monitor-service.ts');
    expect(safety).toContain('JOIN star_payments p ON p.bundle_id = g.bundle_id');
    expect(safety).toContain('ORDER BY p.paid_at DESC, p.rowid DESC');
    expect(safety).toContain('export function reconcileStarsMonitorLimit');
    expect(monitor).toContain('reconcileStarsMonitorLimit(monitor.telegram_id)');
  });

  test('command scopes are tracked and rebuilt in either payment mode', () => {
    const commands = source('src/services/stars-command-surface.ts');
    const payment = source('src/services/stars-payment.ts');
    const index = source('src/index.ts');
    expect(commands).toContain('CREATE TABLE IF NOT EXISTS bot_command_scopes');
    expect(commands).toContain('export async function synchronizeLegacyCommandMenus');
    expect(commands).toContain("type: 'chat_member'");
    expect(payment).toContain('await synchronizeLegacyCommandMenus(bot)');
    expect(index).toContain('await synchronizeStarsCommandMenus(bot, true)');
  });
});
'''
Path('__tests__/stars-pr310-final-review.test.ts').write_text(final_test)
print('wrote: __tests__/stars-pr310-final-review.test.ts')

print('Applied current-head PR 310 review fixes')
