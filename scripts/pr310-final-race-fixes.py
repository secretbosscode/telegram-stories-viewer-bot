from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"pattern not found in {path}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1))


# Export deterministic menu synchronization and allow a forced rebuild after
# an explicit BTC -> Stars mode switch.
replace_once(
    "src/services/stars-command-surface.ts",
    "async function migrateExistingCommandScopes(bot: Telegraf<IContextBot>): Promise<void> {\n  if (!isStarsMode()) return;",
    "async function migrateExistingCommandScopes(\n  bot: Telegraf<IContextBot>,\n  force = false,\n): Promise<void> {\n  if (!isStarsMode()) return;",
)
replace_once(
    "src/services/stars-command-surface.ts",
    "  if (done?.value === '1') return;",
    "  if (!force && done?.value === '1') return;",
)
replace_once(
    "src/services/stars-command-surface.ts",
    "export function registerStarsCommandSurface(bot: Telegraf<IContextBot>): void {",
    "export async function synchronizeStarsCommandMenus(\n  bot: Telegraf<IContextBot>,\n  force = false,\n): Promise<void> {\n  if (!isStarsMode()) return;\n  await bot.telegram.setMyCommands(getStarsBaseCommands('en'));\n  await bot.telegram.setMyCommands(buildCommands('en', String(BOT_ADMIN_ID)), {\n    scope: { type: 'chat', chat_id: BOT_ADMIN_ID },\n  });\n  await migrateExistingCommandScopes(bot, force);\n}\n\nexport function registerStarsCommandSurface(bot: Telegraf<IContextBot>): void {",
)
replace_once(
    "src/services/stars-command-surface.ts",
    "    try {\n      await bot.telegram.setMyCommands(getStarsBaseCommands('en'));\n      await bot.telegram.setMyCommands(buildCommands('en', String(BOT_ADMIN_ID)), {\n        scope: { type: 'chat', chat_id: BOT_ADMIN_ID },\n      });\n      await migrateExistingCommandScopes(bot);\n    } catch (error) {",
    "    try {\n      await synchronizeStarsCommandMenus(bot);\n    } catch (error) {",
)

# Fence paid delivery against refunds and prevent a refund from racing an
# already-processing queue job.
replace_once(
    "src/services/stars-payment.ts",
    "function getBundle(id: string): StarsBundleRow | undefined {\n  return db\n    .prepare('SELECT * FROM star_result_bundles WHERE id = ?')\n    .get(id) as StarsBundleRow | undefined;\n}\n",
    "function getBundle(id: string): StarsBundleRow | undefined {\n  return db\n    .prepare('SELECT * FROM star_result_bundles WHERE id = ?')\n    .get(id) as StarsBundleRow | undefined;\n}\n\nexport function isStarsBundleDeliverable(bundleId: string): boolean {\n  const bundle = getBundle(bundleId);\n  return Boolean(\n    bundle &&\n    bundle.status === 'DELIVERING' &&\n    !bundle.refunded_at\n  );\n}\n",
)
replace_once(
    "src/services/stars-payment.ts",
    "async function enqueuePaidBundle(bundle: StarsBundleRow, chargeId: string, force = false): Promise<void> {\n  if (!force && bundle.status === 'DELIVERED') return;\n  const originalTask = JSON.parse(bundle.task_json) as UserInfo;",
    "async function enqueuePaidBundle(bundle: StarsBundleRow, chargeId: string, force = false): Promise<void> {\n  const currentBundle = getBundle(bundle.id);\n  if (!currentBundle) return;\n  if (!force && currentBundle.status === 'DELIVERED') return;\n  if (currentBundle.status === 'DELIVERED' || currentBundle.status === 'REFUND_PENDING' || currentBundle.status === 'REFUNDED') return;\n  const originalTask = JSON.parse(currentBundle.task_json) as UserInfo;",
)
replace_once(
    "src/services/stars-payment.ts",
    "  const storyIds = JSON.parse(bundle.story_ids) as number[];",
    "  const storyIds = JSON.parse(currentBundle.story_ids) as number[];",
)
replace_once(
    "src/services/stars-payment.ts",
    "    chatId: bundle.chat_id,",
    "    chatId: currentBundle.chat_id,",
)
replace_once(
    "src/services/stars-payment.ts",
    "    starsBundleId: bundle.id,",
    "    starsBundleId: currentBundle.id,",
)
replace_once(
    "src/services/stars-payment.ts",
    "     WHERE id = ? AND status NOT IN ('DELIVERED', 'REFUNDED')`,\n  ).run(now, bundle.id);\n\n  try {",
    "     WHERE id = ? AND status IN ('PAID', 'DELIVERING')`,\n  ).run(now, currentBundle.id);\n  if (updated.changes === 0) return;\n\n  try {",
)
# The prior replacement needs the UPDATE result assigned.
replace_once(
    "src/services/stars-payment.ts",
    "  db.prepare(\n    `UPDATE star_result_bundles\n     SET status = 'DELIVERING',",
    "  const updated = db.prepare(\n    `UPDATE star_result_bundles\n     SET status = 'DELIVERING',",
)
replace_once(
    "src/services/stars-payment.ts",
    "      telegram_id: bundle.user_id,",
    "      telegram_id: currentBundle.user_id,",
)
replace_once(
    "src/services/stars-payment.ts",
    "       WHERE id = ? AND status NOT IN ('DELIVERED', 'REFUNDED')`,\n    ).run(error?.message || String(error), bundle.id);",
    "       WHERE id = ? AND status IN ('PAID', 'DELIVERING')`,\n    ).run(error?.message || String(error), currentBundle.id);",
)
replace_once(
    "src/services/stars-payment.ts",
    "     WHERE id = ? AND status NOT IN ('REFUNDED')`,\n  ).run(nowSeconds(), bundleId);",
    "     WHERE id = ? AND status = 'DELIVERING'`,\n  ).run(nowSeconds(), bundleId);",
)
replace_once(
    "src/services/stars-payment.ts",
    "     WHERE id = ? AND status NOT IN ('DELIVERED', 'REFUNDED')`,\n  ).run(error instanceof Error ? error.message : String(error), bundleId);",
    "     WHERE id = ? AND status IN ('PAID', 'DELIVERING')`,\n  ).run(error instanceof Error ? error.message : String(error), bundleId);",
)
replace_once(
    "src/services/stars-payment.ts",
    "  db.prepare(\n    `UPDATE star_result_bundles\n     SET status = 'REFUND_PENDING', last_error = NULL\n     WHERE id = ? AND status <> 'DELIVERED'`,\n  ).run(bundle.id);\n\n  try {",
    "  db.exec('BEGIN IMMEDIATE');\n  try {\n    const processing = db.prepare(\n      `SELECT 1\n       FROM download_queue\n       WHERE status = 'processing'\n         AND json_extract(task_details, '$.starsBundleId') = ?\n       LIMIT 1`,\n    ).get(bundle.id);\n    if (processing) {\n      db.exec('ROLLBACK');\n      return false;\n    }\n\n    db.prepare(\n      `DELETE FROM download_queue\n       WHERE status = 'pending'\n         AND json_extract(task_details, '$.starsBundleId') = ?`,\n    ).run(bundle.id);\n\n    const fenced = db.prepare(\n      `UPDATE star_result_bundles\n       SET status = 'REFUND_PENDING', last_error = NULL\n       WHERE id = ? AND status IN ('PAID', 'DELIVERING', 'REFUND_PENDING')`,\n    ).run(bundle.id);\n    if (fenced.changes === 0) {\n      db.exec('ROLLBACK');\n      return false;\n    }\n    db.exec('COMMIT');\n  } catch (error) {\n    try { db.exec('ROLLBACK'); } catch {}\n    throw error;\n  }\n\n  try {",
)
replace_once(
    "src/services/stars-payment.ts",
    "      const changed = setPaymentMode(mode, String(ctx.from.id));\n      await ctx.answerCbQuery(",
    "      const changed = setPaymentMode(mode, String(ctx.from.id));\n      if (changed && mode === 'stars') {\n        const { synchronizeStarsCommandMenus } = await import('./stars-command-surface');\n        await synchronizeStarsCommandMenus(bot, true);\n      }\n      await ctx.answerCbQuery(",
)

# Refuse any stale in-memory paid task whose bundle was fenced for refund.
replace_once(
    "src/controllers/send-stories.ts",
    "  isStarsMode,\n  markStarsBundleDelivered,",
    "  isStarsMode,\n  isStarsBundleDeliverable,\n  markStarsBundleDelivered,",
)
replace_once(
    "src/controllers/send-stories.ts",
    "    const requesterId = String(task.user?.id ?? task.chatId);\n    const isAdmin = requesterId === String(BOT_ADMIN_ID);\n\n    if (",
    "    const requesterId = String(task.user?.id ?? task.chatId);\n    const isAdmin = requesterId === String(BOT_ADMIN_ID);\n\n    if (task.starsBundleId && !isStarsBundleDeliverable(task.starsBundleId)) {\n      console.warn(`[Stars] Skipping delivery for non-deliverable bundle ${task.starsBundleId}`);\n      return;\n    }\n\n    if (",
)

# Unit-test support for queue/refund behavior.
replace_once(
    "__tests__/stars-payment.test.ts",
    "    CREATE TABLE payment_checks (\n      invoice_id INTEGER PRIMARY KEY,\n      next_check INTEGER NOT NULL,\n      check_start INTEGER NOT NULL\n    );",
    "    CREATE TABLE payment_checks (\n      invoice_id INTEGER PRIMARY KEY,\n      next_check INTEGER NOT NULL,\n      check_start INTEGER NOT NULL\n    );\n    CREATE TABLE download_queue (\n      id INTEGER PRIMARY KEY AUTOINCREMENT,\n      telegram_id TEXT NOT NULL,\n      target_username TEXT NOT NULL,\n      status TEXT NOT NULL DEFAULT 'pending',\n      enqueued_ts INTEGER NOT NULL,\n      processed_ts INTEGER,\n      error TEXT,\n      task_details TEXT\n    );",
)
replace_once(
    "__tests__/stars-payment.test.ts",
    "  getPaymentMode,\n  getStarsPrice,",
    "  getPaymentMode,\n  getStarsPrice,\n  isStarsBundleDeliverable,\n  markStarsBundleDelivered,",
)
replace_once(
    "__tests__/stars-payment.test.ts",
    "  registerStarsPayments,\n  setPaymentMode,",
    "  registerStarsPayments,\n  refundUndeliverableStarsBundle,\n  setPaymentMode,",
)
replace_once(
    "__tests__/stars-payment.test.ts",
    "    db.prepare('DELETE FROM star_payments').run();",
    "    db.prepare('DELETE FROM star_payments').run();\n    db.prepare('DELETE FROM download_queue').run();",
)
insert_tests = r'''

  test('refund atomically cancels a pending paid-delivery job', async () => {
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`
      INSERT INTO star_result_bundles (
        id, user_id, chat_id, target, locale, request_kind, story_ids,
        task_json, result_count, price_stars, status, created_at, expires_at,
        paid_at, attempt_count
      ) VALUES ('refund-pending-job', '123', '123', '@target', 'en', 'current',
        '[101]', '{}', 1, 25, 'DELIVERING', ?, ?, ?, 1)
    `).run(now, now + 1800, now);
    db.prepare(`
      INSERT INTO star_payments (
        telegram_payment_charge_id, bundle_id, user_id, amount_stars, paid_at
      ) VALUES ('charge-pending-job', 'refund-pending-job', '123', 25, ?)
    `).run(now);
    db.prepare(`
      INSERT INTO download_queue (
        telegram_id, target_username, status, enqueued_ts, task_details
      ) VALUES ('123', '@target', 'pending', ?, ?)
    `).run(now, JSON.stringify({ starsBundleId: 'refund-pending-job' }));

    const refunded = await refundUndeliverableStarsBundle('refund-pending-job');

    expect(refunded).toBe(true);
    expect((db.prepare(`SELECT COUNT(*) AS count FROM download_queue`).get() as any).count).toBe(0);
    expect((db.prepare(`SELECT status FROM star_result_bundles WHERE id = 'refund-pending-job'`).get() as any).status).toBe('REFUNDED');
    expect(bot.telegram.callApi).toHaveBeenCalledWith('refundStarPayment', {
      user_id: 123,
      telegram_payment_charge_id: 'charge-pending-job',
    });
  });

  test('refund waits while a paid-delivery job is already processing', async () => {
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`
      INSERT INTO star_result_bundles (
        id, user_id, chat_id, target, locale, request_kind, story_ids,
        task_json, result_count, price_stars, status, created_at, expires_at,
        paid_at, attempt_count
      ) VALUES ('refund-processing-job', '123', '123', '@target', 'en', 'current',
        '[101]', '{}', 1, 25, 'DELIVERING', ?, ?, ?, 1)
    `).run(now, now + 1800, now);
    db.prepare(`
      INSERT INTO star_payments (
        telegram_payment_charge_id, bundle_id, user_id, amount_stars, paid_at
      ) VALUES ('charge-processing-job', 'refund-processing-job', '123', 25, ?)
    `).run(now);
    db.prepare(`
      INSERT INTO download_queue (
        telegram_id, target_username, status, enqueued_ts, task_details
      ) VALUES ('123', '@target', 'processing', ?, ?)
    `).run(now, JSON.stringify({ starsBundleId: 'refund-processing-job' }));

    const refunded = await refundUndeliverableStarsBundle('refund-processing-job');

    expect(refunded).toBe(false);
    expect(bot.telegram.callApi).not.toHaveBeenCalledWith('refundStarPayment', expect.anything());
    expect((db.prepare(`SELECT status FROM star_result_bundles WHERE id = 'refund-processing-job'`).get() as any).status).toBe('DELIVERING');
  });

  test('delivery cannot settle after refund fencing begins', () => {
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`
      INSERT INTO star_result_bundles (
        id, user_id, chat_id, target, locale, request_kind, story_ids,
        task_json, result_count, price_stars, status, created_at, expires_at,
        paid_at, attempt_count
      ) VALUES ('refund-fenced', '123', '123', '@target', 'en', 'current',
        '[101]', '{}', 1, 25, 'REFUND_PENDING', ?, ?, ?, 1)
    `).run(now, now + 1800, now);

    expect(isStarsBundleDeliverable('refund-fenced')).toBe(false);
    markStarsBundleDelivered('refund-fenced');
    expect((db.prepare(`SELECT status FROM star_result_bundles WHERE id = 'refund-fenced'`).get() as any).status).toBe('REFUND_PENDING');
  });
'''
replace_once(
    "__tests__/stars-payment.test.ts",
    "  test('legacy BTC mode leaves the existing delivery path untouched', async () => {",
    insert_tests + "\n  test('legacy BTC mode leaves the existing delivery path untouched', async () => {",
)

# Delivery orchestrator mock and regression coverage.
replace_once(
    "__tests__/send-stories.test.ts",
    "const isStarsMode = jest.fn(() => false);\nconst areStarsEnabled = jest.fn(() => true);",
    "const isStarsMode = jest.fn(() => false);\nconst areStarsEnabled = jest.fn(() => true);\nconst isStarsBundleDeliverable = jest.fn(() => true);",
)
replace_once(
    "__tests__/send-stories.test.ts",
    "  isStarsMode,\n  areStarsEnabled,",
    "  isStarsMode,\n  areStarsEnabled,\n  isStarsBundleDeliverable,",
)
replace_once(
    "__tests__/send-stories.test.ts",
    "    areStarsEnabled.mockReturnValue(true);",
    "    areStarsEnabled.mockReturnValue(true);\n    isStarsBundleDeliverable.mockReturnValue(true);",
)
refund_delivery_test = r'''

  test('does not send paid media after refund fencing begins', async () => {
    isStarsBundleDeliverable.mockReturnValue(false);

    await sendStoriesFx({
      particularStory: { id: 88 } as any,
      task: {
        chatId: '88',
        link: '@target',
        linkType: 'username',
        locale: 'en',
        initTime: 0,
        starsUnlocked: true,
        starsBundleId: 'bundle-refunding',
        starsExpectedStoryIds: [88],
      },
    } as any);

    expect(sendParticularStory).not.toHaveBeenCalled();
    expect(markStarsBundleDelivered).not.toHaveBeenCalled();
    expect(refundUndeliverableStarsBundle).not.toHaveBeenCalled();
  });
'''
replace_once(
    "__tests__/send-stories.test.ts",
    "  test('refunds a paid particular story when Telegram received no media', async () => {",
    refund_delivery_test + "\n  test('refunds a paid particular story when Telegram received no media', async () => {",
)

# Structural coverage for the explicit forced menu refresh.
replace_once(
    "__tests__/stars-final-safety.test.ts",
    "  test('monitor limits are atomic and Premium eligibility survives Stars refunds', () => {",
    "  test('switching to Stars forces an immediate command-menu rebuild', () => {\n    const payment = source('src/services/stars-payment.ts');\n    const commands = source('src/services/stars-command-surface.ts');\n    expect(commands).toContain('export async function synchronizeStarsCommandMenus');\n    expect(commands).toContain('migrateExistingCommandScopes(bot, force)');\n    expect(payment).toContain('await synchronizeStarsCommandMenus(bot, true)');\n  });\n\n  test('monitor limits are atomic and Premium eligibility survives Stars refunds', () => {",
)

print('Applied final PR 310 menu/refund race fixes')
