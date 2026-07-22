from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"pattern not found in {path}: {old[:160]!r}")
    p.write_text(text.replace(old, new, 1))


# ---------------------------------------------------------------------------
# 1. Defer partial-delivery refunds until the active queue row exits processing.
# ---------------------------------------------------------------------------
replace_once(
    "src/services/stars-payment.ts",
    "async function refundBundle(bundle: StarsBundleRow, notifyUser = true): Promise<boolean> {",
    "async function refundBundle(\n  bundle: StarsBundleRow,\n  notifyUser = true,\n  deferIfProcessing = false,\n): Promise<boolean> {",
)
replace_once(
    "src/services/stars-payment.ts",
    "    if (processing) {\n      db.exec('ROLLBACK');\n      return false;\n    }",
    "    if (processing) {\n      if (deferIfProcessing) {\n        db.prepare(\n          `UPDATE star_result_bundles\n           SET status = 'REFUND_PENDING'\n           WHERE id = ? AND status IN ('PAID', 'DELIVERING', 'REFUND_PENDING')`,\n        ).run(bundle.id);\n        db.exec('COMMIT');\n      } else {\n        db.exec('ROLLBACK');\n      }\n      return false;\n    }",
)
replace_once(
    "src/services/stars-payment.ts",
    "export async function refundUndeliverableStarsBundle(bundleId: string): Promise<boolean> {\n  const bundle = getBundle(bundleId);\n  if (!bundle) return false;\n  return refundBundle(bundle);\n}\n",
    "export async function refundUndeliverableStarsBundle(bundleId: string): Promise<boolean> {\n  const bundle = getBundle(bundleId);\n  if (!bundle) return false;\n  return refundBundle(bundle, true, true);\n}\n\nexport async function finalizeDeferredStarsRefund(bundleId: string): Promise<boolean> {\n  const bundle = getBundle(bundleId);\n  if (!bundle || bundle.status !== 'REFUND_PENDING') return false;\n  return refundBundle(bundle);\n}\n",
)
replace_once(
    "src/services/queue-manager.ts",
    "        await markDoneFx(job.id);\n        console.log(`[QueueManager] Finished processing for ${currentTask.link} (Job ID: ${job.id})`);",
    "        await markDoneFx(job.id);\n        if (currentTask.starsBundleId) {\n          const { finalizeDeferredStarsRefund } = await import('./stars-payment');\n          await finalizeDeferredStarsRefund(currentTask.starsBundleId).catch((error) => {\n            console.error(`[QueueManager] Deferred Stars refund failed for ${currentTask.starsBundleId}:`, error);\n          });\n        }\n        console.log(`[QueueManager] Finished processing for ${currentTask.link} (Job ID: ${job.id})`);",
)

# ---------------------------------------------------------------------------
# 2. Give monitor grants a monotonic payment order and reconcile limits after
#    Premium expires.
# ---------------------------------------------------------------------------
replace_once(
    "src/services/stars-mode-safety.ts",
    "      plan TEXT NOT NULL DEFAULT 'monitor_week',\n      granted_at INTEGER NOT NULL,",
    "      plan TEXT NOT NULL DEFAULT 'monitor_week',\n      payment_order INTEGER NOT NULL DEFAULT 0,\n      granted_at INTEGER NOT NULL,",
)
replace_once(
    "src/services/stars-mode-safety.ts",
    "  if (!grantColumns.some((column) => column.name === 'plan')) {\n    db.exec(\"ALTER TABLE star_monitor_grants ADD COLUMN plan TEXT NOT NULL DEFAULT 'monitor_week'\");\n  }",
    "  if (!grantColumns.some((column) => column.name === 'plan')) {\n    db.exec(\"ALTER TABLE star_monitor_grants ADD COLUMN plan TEXT NOT NULL DEFAULT 'monitor_week'\");\n  }\n  if (!grantColumns.some((column) => column.name === 'payment_order')) {\n    db.exec('ALTER TABLE star_monitor_grants ADD COLUMN payment_order INTEGER NOT NULL DEFAULT 0');\n  }",
)
replace_once(
    "src/services/stars-mode-safety.ts",
    "    CREATE INDEX IF NOT EXISTS star_monitor_grants_user_idx\n      ON star_monitor_grants (user_id, granted_at DESC);",
    "    DROP INDEX IF EXISTS star_monitor_grants_user_idx;\n    CREATE INDEX star_monitor_grants_user_idx\n      ON star_monitor_grants (user_id, payment_order DESC, granted_at DESC);",
)
replace_once(
    "src/services/stars-mode-safety.ts",
    "         plan = COALESCE(\n           (\n             SELECT b.request_kind\n             FROM star_result_bundles b\n             WHERE b.id = star_monitor_grants.bundle_id\n               AND b.request_kind IN ('monitor_week', 'monitor_month')\n           ),\n           plan,\n           'monitor_week'\n         );",
    "         plan = COALESCE(\n           (\n             SELECT b.request_kind\n             FROM star_result_bundles b\n             WHERE b.id = star_monitor_grants.bundle_id\n               AND b.request_kind IN ('monitor_week', 'monitor_month')\n           ),\n           plan,\n           'monitor_week'\n         ),\n         payment_order = COALESCE(\n           (SELECT p.rowid FROM star_payments p WHERE p.bundle_id = star_monitor_grants.bundle_id),\n           payment_order,\n           0\n         );",
)
replace_once(
    "src/services/stars-mode-safety.ts",
    "        bundle_id, user_id, duration_seconds, max_targets, plan, granted_at, refunded_at\n      ) VALUES (",
    "        bundle_id, user_id, duration_seconds, max_targets, plan, payment_order, granted_at, refunded_at\n      ) VALUES (",
)
replace_once(
    "src/services/stars-mode-safety.ts",
    "        NEW.request_kind,\n        CAST(strftime('%s','now') AS INTEGER),\n        NULL",
    "        NEW.request_kind,\n        COALESCE((SELECT p.rowid FROM star_payments p WHERE p.bundle_id = NEW.id), 0),\n        CAST(strftime('%s','now') AS INTEGER),\n        NULL",
)
# All three restoration selectors must use payment order, not UUID lexical order.
for _ in range(3):
    replace_once(
        "src/services/stars-mode-safety.ts",
        "              ORDER BY granted_at DESC, bundle_id DESC",
        "              ORDER BY payment_order DESC, granted_at DESC",
    )

insert_before_authorize = """
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

"""
replace_once(
    "src/services/stars-mode-safety.ts",
    "export function authorizeStarsMonitorRemoval(",
    insert_before_authorize + "export function authorizeStarsMonitorRemoval(",
)
replace_once(
    "src/services/monitor-service.ts",
    "  getStarsMonitoringEntitlement,\n} from 'services/stars-mode-safety';",
    "  getStarsMonitoringEntitlement,\n  reconcileStarsMonitorLimit,\n} from 'services/stars-mode-safety';",
)
replace_once(
    "src/services/monitor-service.ts",
    "  const monitors = listAllMonitors();\n  const premiumCache = new Map<string, boolean>();\n  try {\n    for (const monitor of monitors) {",
    "  let monitors = listAllMonitors();\n  const premiumCache = new Map<string, boolean>();\n  const reconciledUsers = new Set<string>();\n  try {\n    for (const monitor of monitors) {\n      let premium = premiumCache.get(monitor.telegram_id);\n      if (premium === undefined) {\n        premium = isUserPremium(monitor.telegram_id);\n        premiumCache.set(monitor.telegram_id, premium);\n      }\n      const starsEntitlement = getStarsMonitoringEntitlement(monitor.telegram_id);\n      if (!premium && starsEntitlement && !reconciledUsers.has(monitor.telegram_id)) {\n        reconcileStarsMonitorLimit(monitor.telegram_id);\n        reconciledUsers.add(monitor.telegram_id);\n      }\n    }\n\n    monitors = listAllMonitors();\n    for (const monitor of monitors) {",
)

# ---------------------------------------------------------------------------
# 3. Track command scopes and support a complete menu rebuild in either mode.
# ---------------------------------------------------------------------------
replace_once(
    "src/services/stars-command-surface.ts",
    "const COMMAND_SCOPE_MIGRATION_KEY = 'stars_command_scope_v4';\nconst syncedChats = new Set<string>();",
    "const COMMAND_SCOPE_MIGRATION_KEY = 'stars_command_scope_v4';\nconst syncedChats = new Set<string>();\n\ndb.exec(`\n  CREATE TABLE IF NOT EXISTS bot_command_scopes (\n    chat_id TEXT NOT NULL,\n    user_id TEXT NOT NULL,\n    locale TEXT NOT NULL DEFAULT 'en',\n    is_group INTEGER NOT NULL DEFAULT 0,\n    updated_at INTEGER NOT NULL,\n    PRIMARY KEY (chat_id, user_id)\n  );\n`);",
)
legacy_functions = """
function getLegacyBaseCommands(locale: string) {
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

"""
replace_once(
    "src/services/stars-command-surface.ts",
    "function buildCommands(locale: string, userId?: string) {",
    legacy_functions + "function buildCommands(locale: string, userId?: string) {",
)
replace_once(
    "src/services/stars-command-surface.ts",
    "  const scope: any = chatId === userId\n    ? { type: 'chat', chat_id: numericChatId }\n    : { type: 'chat_member', chat_id: numericChatId, user_id: numericUserId };\n\n  try {\n    await bot.telegram.setMyCommands(buildCommands(locale, userId), { scope });\n    syncedChats.add(cacheKey);",
    "  const isGroup = chatId !== userId;\n  const scope: any = isGroup\n    ? { type: 'chat_member', chat_id: numericChatId, user_id: numericUserId }\n    : { type: 'chat', chat_id: numericChatId };\n\n  try {\n    if (isGroup) {\n      // Clear any legacy broad chat scope the first time this group is seen.\n      await (bot.telegram as any).callApi('deleteMyCommands', {\n        scope: { type: 'chat', chat_id: numericChatId },\n      }).catch(() => {});\n    }\n    await bot.telegram.setMyCommands(buildCommands(locale, userId), { scope });\n    db.prepare(\n      `INSERT INTO bot_command_scopes (chat_id, user_id, locale, is_group, updated_at)\n       VALUES (?, ?, ?, ?, ?)\n       ON CONFLICT(chat_id, user_id) DO UPDATE SET\n         locale = excluded.locale,\n         is_group = excluded.is_group,\n         updated_at = excluded.updated_at`,\n    ).run(chatId, userId, locale || 'en', isGroup ? 1 : 0, Math.floor(Date.now() / 1000));\n    syncedChats.add(cacheKey);",
)
replace_once(
    "src/services/stars-command-surface.ts",
    "      SELECT CAST(chat_id AS TEXT) AS group_id\n       FROM star_result_bundles\n       WHERE CAST(chat_id AS INTEGER) < 0",
    "      SELECT CAST(chat_id AS TEXT) AS group_id\n       FROM star_result_bundles\n       WHERE CAST(chat_id AS INTEGER) < 0\n       UNION\n       SELECT chat_id AS group_id\n       FROM bot_command_scopes\n       WHERE is_group = 1",
)
replace_once(
    "src/services/stars-command-surface.ts",
    "  const users = db.prepare(\n    'SELECT telegram_id, language FROM users ORDER BY created_at ASC',\n  ).all() as { telegram_id: string; language?: string }[];",
    "  const trackedMembers = db.prepare(\n    `SELECT chat_id, user_id, locale\n     FROM bot_command_scopes\n     WHERE is_group = 1\n     ORDER BY updated_at ASC`,\n  ).all() as { chat_id: string; user_id: string; locale?: string }[];\n  for (const member of trackedMembers) {\n    await syncChatCommands(bot, member.chat_id, member.user_id, member.locale || 'en', true);\n    await new Promise((resolve) => setTimeout(resolve, 100));\n  }\n\n  const users = db.prepare(\n    'SELECT telegram_id, language FROM users ORDER BY created_at ASC',\n  ).all() as { telegram_id: string; language?: string }[];",
)
legacy_sync = """
export async function synchronizeLegacyCommandMenus(
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
  for (const scope of trackedScopes) {
    const chatId = Number(scope.chat_id);
    const userId = Number(scope.user_id);
    if (!Number.isFinite(chatId) || !Number.isFinite(userId)) continue;
    if (scope.is_group) {
      await (bot.telegram as any).callApi('deleteMyCommands', {
        scope: { type: 'chat_member', chat_id: chatId, user_id: userId },
      }).catch(() => {});
      if (!clearedGroups.has(scope.chat_id)) {
        await (bot.telegram as any).callApi('deleteMyCommands', {
          scope: { type: 'chat', chat_id: chatId },
        }).catch(() => {});
        clearedGroups.add(scope.chat_id);
      }
    } else {
      await bot.telegram.setMyCommands(
        buildLegacyCommands(scope.locale || 'en', scope.user_id),
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

"""
replace_once(
    "src/services/stars-command-surface.ts",
    "export async function synchronizeStarsCommandMenus(",
    legacy_sync + "export async function synchronizeStarsCommandMenus(",
)
replace_once(
    "src/services/stars-payment.ts",
    "      if (changed && mode === 'stars') {\n        const { synchronizeStarsCommandMenus } = await import('./stars-command-surface');\n        await synchronizeStarsCommandMenus(bot, true);\n      }",
    "      if (changed) {\n        const { synchronizeLegacyCommandMenus, synchronizeStarsCommandMenus } =\n          await import('./stars-command-surface');\n        if (mode === 'stars') {\n          await synchronizeStarsCommandMenus(bot, true);\n        } else {\n          await synchronizeLegacyCommandMenus(bot);\n        }\n      }",
)
replace_once(
    "src/index.ts",
    "  if (!isStarsMode()) {\n    await bot.telegram.setMyCommands(getBaseCommands('en'));\n    await bot.telegram.setMyCommands(\n      [...getBaseCommands('en'), ...getPremiumCommands('en'), ...getAdminCommands('en')],\n      { scope: { type: 'chat', chat_id: BOT_ADMIN_ID } }\n    );\n  }",
    "  const { synchronizeLegacyCommandMenus, synchronizeStarsCommandMenus } =\n    await import('./services/stars-command-surface');\n  if (isStarsMode()) {\n    await synchronizeStarsCommandMenus(bot, true);\n  } else {\n    await synchronizeLegacyCommandMenus(bot);\n  }",
)

# ---------------------------------------------------------------------------
# Regression tests.
# ---------------------------------------------------------------------------
replace_once(
    "__tests__/stars-payment.test.ts",
    "  getPaymentMode,",
    "  finalizeDeferredStarsRefund,\n  getPaymentMode,",
)
replace_once(
    "__tests__/stars-payment.test.ts",
    "    expect((db.prepare(`SELECT status FROM star_result_bundles WHERE id = 'refund-processing-job'`).get() as any).status).toBe('DELIVERING');",
    "    expect((db.prepare(`SELECT status FROM star_result_bundles WHERE id = 'refund-processing-job'`).get() as any).status).toBe('REFUND_PENDING');\n\n    db.prepare(\"UPDATE download_queue SET status = 'done' WHERE json_extract(task_details, '$.starsBundleId') = 'refund-processing-job'\").run();\n    const finalized = await finalizeDeferredStarsRefund('refund-processing-job');\n    expect(finalized).toBe(true);\n    expect((db.prepare(`SELECT status FROM star_result_bundles WHERE id = 'refund-processing-job'`).get() as any).status).toBe('REFUNDED');",
)
replace_once(
    "__tests__/stars-mode-safety.test.ts",
    "  initializeStarsModeSafety,\n  setStarsMonitorPrice,",
    "  initializeStarsModeSafety,\n  reconcileStarsMonitorLimit,\n  setStarsMonitorPrice,",
)
ordering_test = r'''

  test('same-second grants restore the actual latest remaining purchase', () => {
    const now = Math.floor(Date.now() / 1000);
    insertMonitorBundle('z-first', 'ordered-user', 'monitor_week', 199, now, 1);
    payMonitorBundle('z-first', 'ordered-user', 'ordered-charge-1', 199, now);
    insertMonitorBundle('a-second', 'ordered-user', 'monitor_month', 499, now, 5);
    payMonitorBundle('a-second', 'ordered-user', 'ordered-charge-2', 499, now);
    insertMonitorBundle('m-third', 'ordered-user', 'monitor_week', 199, now, 2);
    payMonitorBundle('m-third', 'ordered-user', 'ordered-charge-3', 199, now);

    const orders = db.prepare(
      `SELECT bundle_id, payment_order FROM star_monitor_grants
       WHERE user_id = 'ordered-user' ORDER BY payment_order ASC`,
    ).all() as any[];
    expect(orders.map((row) => row.bundle_id)).toEqual(['z-first', 'a-second', 'm-third']);

    db.prepare(
      "UPDATE star_payments SET refunded_at = ? WHERE telegram_payment_charge_id = 'ordered-charge-3'",
    ).run(now + 1);

    const remaining = getStarsMonitoringEntitlement('ordered-user');
    expect(remaining?.plan).toBe('monitor_month');
    expect(remaining?.maxTargets).toBe(5);
  });

  test('Stars monitor limit is reconciled after Premium expires', () => {
    const now = Math.floor(Date.now() / 1000);
    insertMonitorBundle('reconcile-plan', 'reconcile-user', 'monitor_week', 199, now, 2);
    payMonitorBundle('reconcile-plan', 'reconcile-user', 'reconcile-charge', 199, now);
    db.prepare(
      `INSERT INTO users (telegram_id, is_premium, premium_until)
       VALUES ('reconcile-user', 0, ?)`,
    ).run(now - 1);

    for (let i = 1; i <= 4; i += 1) {
      db.prepare(
        `INSERT INTO monitors (telegram_id, target_id, target_username, created_at)
         VALUES ('reconcile-user', ?, ?, ?)`,
      ).run(String(i), `target-${i}`, now + i);
    }

    expect(reconcileStarsMonitorLimit('reconcile-user')).toBe(2);
    const rows = db.prepare(
      `SELECT target_id FROM monitors WHERE telegram_id = 'reconcile-user'
       ORDER BY created_at ASC, id ASC`,
    ).all() as any[];
    expect(rows.map((row) => row.target_id)).toEqual(['1', '2']);
  });
'''
replace_once(
    "__tests__/stars-mode-safety.test.ts",
    "  test('monitor target limit is enforced atomically by SQLite', () => {",
    ordering_test + "\n  test('monitor target limit is enforced atomically by SQLite', () => {",
)
replace_once(
    "__tests__/monitor-premium-expiration.test.ts",
    "const clearStarsMonitorRemovalAuthorization = jest.fn();",
    "const clearStarsMonitorRemovalAuthorization = jest.fn();\nconst reconcileStarsMonitorLimit = jest.fn();",
)
replace_once(
    "__tests__/monitor-premium-expiration.test.ts",
    "  clearStarsMonitorRemovalAuthorization,\n}));",
    "  clearStarsMonitorRemovalAuthorization,\n  reconcileStarsMonitorLimit,\n}));",
)
reconcile_call_test = r'''

test('reconciles Stars monitor limits when Premium is no longer active', async () => {
  addMonitor('stars-user', '501', 'one', null, null);
  (isUserPremium as jest.Mock).mockReturnValue(false);
  getStarsMonitoringEntitlement.mockReturnValue({
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    maxTargets: 1,
    plan: 'monitor_week',
  });

  await monitorService.forceCheckMonitors();

  expect(reconcileStarsMonitorLimit).toHaveBeenCalledWith('stars-user');
});
'''
replace_once(
    "__tests__/monitor-premium-expiration.test.ts",
    "test('explicit removal is authorized when paid monitoring and Premium overlap', async () => {",
    reconcile_call_test + "\ntest('explicit removal is authorized when paid monitoring and Premium overlap', async () => {",
)
replace_once(
    "__tests__/stars-command-surface.test.ts",
    "  test('administrators can tune both monitoring prices without environment changes', () => {",
    "  test('group scopes are persisted and legacy broad scopes are cleared on interaction', () => {\n    expect(source).toContain('CREATE TABLE IF NOT EXISTS bot_command_scopes');\n    expect(source).toContain(\"scope: { type: 'chat', chat_id: numericChatId }\");\n    expect(source).toContain('INSERT INTO bot_command_scopes');\n  });\n\n  test('switching to BTC removes member-scoped Stars menus', () => {\n    expect(source).toContain('export async function synchronizeLegacyCommandMenus');\n    expect(source).toContain(\"type: 'chat_member'\");\n    expect(source).toContain('buildLegacyCommands');\n  });\n\n  test('administrators can tune both monitoring prices without environment changes', () => {",
)
replace_once(
    "__tests__/stars-final-safety.test.ts",
    "  test('monitor limits are atomic and Premium eligibility survives Stars refunds', () => {",
    "  test('deferred refunds finalize only after the paid queue row exits processing', () => {\n    const payment = source('src/services/stars-payment.ts');\n    const queue = source('src/services/queue-manager.ts');\n    expect(payment).toContain('deferIfProcessing');\n    expect(payment).toContain('export async function finalizeDeferredStarsRefund');\n    expect(queue).toContain('await finalizeDeferredStarsRefund(currentTask.starsBundleId)');\n  });\n\n  test('grant ordering, Premium expiry, and bidirectional menu switches are deterministic', () => {\n    const safety = source('src/services/stars-mode-safety.ts');\n    const commands = source('src/services/stars-command-surface.ts');\n    const payment = source('src/services/stars-payment.ts');\n    expect(safety).toContain('payment_order INTEGER NOT NULL DEFAULT 0');\n    expect(safety).toContain('export function reconcileStarsMonitorLimit');\n    expect(commands).toContain('export async function synchronizeLegacyCommandMenus');\n    expect(commands).toContain('CREATE TABLE IF NOT EXISTS bot_command_scopes');\n    expect(payment).toContain('await synchronizeLegacyCommandMenus(bot)');\n  });\n\n  test('monitor limits are atomic and Premium eligibility survives Stars refunds', () => {",
)

print('Applied remaining PR 310 review fixes')
