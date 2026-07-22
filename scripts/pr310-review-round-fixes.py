from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"pattern not found in {path}: {old[:220]!r}")
    p.write_text(text.replace(old, new, 1))


# ---------------------------------------------------------------------------
# 1. Recompute monitoring expiry from remaining purchases in payment order.
# This preserves a later renewal when an older, already-expired grant is refunded.
# ---------------------------------------------------------------------------
replace_once(
    "src/services/stars-mode-safety.ts",
    """          expires_at = MAX(
            CAST(strftime('%s','now') AS INTEGER),
            expires_at - COALESCE(
              (SELECT duration_seconds FROM star_monitor_grants WHERE bundle_id = NEW.bundle_id),
              0
            )
          ),""",
    """          expires_at = COALESCE(
            (
              WITH RECURSIVE
              ordered_grants AS (
                SELECT
                  g.duration_seconds,
                  p.paid_at,
                  ROW_NUMBER() OVER (ORDER BY p.paid_at ASC, p.rowid ASC) AS purchase_order
                FROM star_monitor_grants g
                JOIN star_payments p ON p.bundle_id = g.bundle_id
                WHERE g.user_id = star_monitor_entitlements.user_id
                  AND g.bundle_id <> NEW.bundle_id
                  AND g.refunded_at IS NULL
                  AND p.refunded_at IS NULL
              ),
              entitlement_timeline(purchase_order, expires_at) AS (
                SELECT purchase_order, paid_at + duration_seconds
                FROM ordered_grants
                WHERE purchase_order = 1
                UNION ALL
                SELECT
                  next_grant.purchase_order,
                  MAX(entitlement_timeline.expires_at, next_grant.paid_at) + next_grant.duration_seconds
                FROM entitlement_timeline
                JOIN ordered_grants next_grant
                  ON next_grant.purchase_order = entitlement_timeline.purchase_order + 1
              )
              SELECT expires_at
              FROM entitlement_timeline
              ORDER BY purchase_order DESC
              LIMIT 1
            ),
            CAST(strftime('%s','now') AS INTEGER)
          ),""",
)

# ---------------------------------------------------------------------------
# 2. A queue error is terminal too. Finalize any deferred refund after marking
# the row error, instead of waiting for stale recovery.
# ---------------------------------------------------------------------------
replace_once(
    "src/services/queue-manager.ts",
    """      await markErrorFx({ jobId: job.id, message: error?.message || 'Unknown processing error' });
      await bot.telegram.sendMessage(""",
    """      await markErrorFx({ jobId: job.id, message: error?.message || 'Unknown processing error' });
      if (currentTask.starsBundleId) {
        const { finalizeDeferredStarsRefund } = await import('./stars-payment');
        await finalizeDeferredStarsRefund(currentTask.starsBundleId).catch((refundError) => {
          console.error(
            `[QueueManager] Deferred Stars refund failed after error for ${currentTask.starsBundleId}:`,
            refundError,
          );
        });
      }
      await bot.telegram.sendMessage(""",
)

# ---------------------------------------------------------------------------
# 3. Preserve paid Stars monitoring controls while checkout mode is BTC.
# ---------------------------------------------------------------------------
replace_once(
    "src/services/stars-command-surface.ts",
    """function getLegacyPremiumCommands(locale: string) {
  return [
    { command: 'monitor', description: t(locale, 'cmd.monitor') },
    { command: 'unmonitor', description: t(locale, 'cmd.unmonitor') },
    { command: 'archive', description: t(locale, 'cmd.archive') },
  ];
}""",
    """function getLegacyMonitoringCommands(locale: string) {
  return [
    { command: 'monitor', description: t(locale, 'cmd.monitor') },
    { command: 'unmonitor', description: t(locale, 'cmd.unmonitor') },
  ];
}

function getLegacyPremiumCommands(locale: string) {
  return [{ command: 'archive', description: t(locale, 'cmd.archive') }];
}""",
)
replace_once(
    "src/services/stars-command-surface.ts",
    """function buildLegacyCommands(locale: string, userId?: string) {
  const commands = [...getLegacyBaseCommands(locale)];
  const admin = userId === String(BOT_ADMIN_ID);
  if (admin || (userId && isUserPremium(userId))) {
    commands.push(...getLegacyPremiumCommands(locale));
  }
  if (admin) commands.push(...getLegacyAdminCommands(locale));
  return commands;
}""",
    """function buildLegacyCommands(locale: string, userId?: string) {
  const commands = [...getLegacyBaseCommands(locale)];
  const admin = userId === String(BOT_ADMIN_ID);
  const premium = Boolean(userId && isUserPremium(userId));
  const paidMonitoring = Boolean(userId && getStarsMonitoringEntitlement(userId));
  if (admin || premium || paidMonitoring) {
    commands.push(...getLegacyMonitoringCommands(locale));
  }
  if (admin || premium) {
    commands.push(...getLegacyPremiumCommands(locale));
  }
  if (admin) commands.push(...getLegacyAdminCommands(locale));
  return commands;
}""",
)
replace_once(
    "src/services/stars-command-surface.ts",
    """  bot.use(async (ctx: any, next: () => Promise<void>) => {
    if (!isStarsMode()) return next();

    const rawText = String(ctx.message?.text || '').trim();
    const locale = ctx.from?.language_code || 'en';
    const userId = String(ctx.from?.id ?? '');
    const chatId = String(ctx.chat?.id ?? ctx.from?.id ?? '');
    const commandMatch = rawText.match(/^\\/([a-z0-9_]+)(?:@[a-z0-9_]+)?(?:\\s|$)/i);
    const command = commandMatch?.[1]?.toLowerCase();
""",
    """  bot.use(async (ctx: any, next: () => Promise<void>) => {
    const rawText = String(ctx.message?.text || '').trim();
    const locale = ctx.from?.language_code || 'en';
    const userId = String(ctx.from?.id ?? '');
    const chatId = String(ctx.chat?.id ?? ctx.from?.id ?? '');
    const commandMatch = rawText.match(/^\\/([a-z0-9_]+)(?:@[a-z0-9_]+)?(?:\\s|$)/i);
    const command = commandMatch?.[1]?.toLowerCase();

    if (!isStarsMode()) {
      const paidMonitoring = Boolean(userId && getStarsMonitoringEntitlement(userId));
      if (paidMonitoring && command === 'monitor') return handleStarsMonitor(ctx, next);
      if (paidMonitoring && command === 'unmonitor') return handleStarsUnmonitor(ctx, next);
      return next();
    }
""",
)

# ---------------------------------------------------------------------------
# 4. A story already delivered as active must never be re-sent after it later
# moves into the pinned response.
# ---------------------------------------------------------------------------
replace_once(
    "src/services/monitor-service.ts",
    "return !persistedPinnedKeys.has(key) && !activeCandidateKeys.has(key);",
    "return (\n        !persistedPinnedKeys.has(key) &&\n        !persistedActiveKeys.has(key) &&\n        !activeCandidateKeys.has(key)\n      );",
)

# ---------------------------------------------------------------------------
# Behavioral regression tests.
# ---------------------------------------------------------------------------
expiry_test = r'''

  test('refunding an expired earlier grant does not shorten a later renewal', () => {
    const now = Math.floor(Date.now() / 1000);
    const expiredWeekPaidAt = now - (8 * 24 * 60 * 60);
    insertMonitorBundle(
      'expired-week',
      'renewed-user',
      'monitor_week',
      199,
      expiredWeekPaidAt,
      3,
    );
    payMonitorBundle(
      'expired-week',
      'renewed-user',
      'expired-week-charge',
      199,
      expiredWeekPaidAt,
    );

    insertMonitorBundle('later-month', 'renewed-user', 'monitor_month', 499, now, 5);
    payMonitorBundle('later-month', 'renewed-user', 'later-month-charge', 499, now);
    const beforeRefund = getStarsMonitoringEntitlement('renewed-user')!;

    db.prepare(
      "UPDATE star_payments SET refunded_at = ? WHERE telegram_payment_charge_id = 'expired-week-charge'",
    ).run(now + 1);

    const afterRefund = getStarsMonitoringEntitlement('renewed-user')!;
    expect(afterRefund.expiresAt).toBe(beforeRefund.expiresAt);
    expect(afterRefund.plan).toBe('monitor_month');
    expect(afterRefund.maxTargets).toBe(5);
  });
'''
replace_once(
    "__tests__/stars-mode-safety.test.ts",
    "\n  test('monitor target limit is enforced atomically by SQLite', () => {",
    expiry_test + "\n  test('monitor target limit is enforced atomically by SQLite', () => {",
)

transition_test = r'''

test('does not resend an earlier active story after it later becomes pinned', async () => {
  const row = addMonitor('user', '792', 'tester', '999', null);
  const active = [{ id: 13, date: 130, expireDate: 2000000000 }];
  const pinned: any[] = [];
  const invoke = createInvoke(active, pinned);
  (Userbot.getInstance as any).mockResolvedValue({ invoke } as any);

  const sendActiveStoriesMock = activeSenderMock();
  sendActiveStoriesMock.mockReset().mockResolvedValue([13]);

  await checkSingleMonitor(row.id);
  expect(listSentStoryKeys(row.id, 'active')).toContain('13:130');

  active.splice(0, active.length);
  pinned.push({ id: 13, date: 130 });
  sendActiveStoriesMock.mockClear();

  await checkSingleMonitor(row.id);
  expect(sendActiveStoriesMock).not.toHaveBeenCalled();

  removeMonitor('user', '792');
});
'''
replace_once(
    "__tests__/monitor-active-stories.test.ts",
    "\ntest('does not persist a story key when delivery throws and retries later', async () => {",
    transition_test + "\ntest('does not persist a story key when delivery throws and retries later', async () => {",
)

replace_once(
    "__tests__/stars-command-surface.test.ts",
    """  test('administrators can tune both monitoring prices without environment changes', () => {""",
    """  test('BTC mode preserves controls for active Stars monitoring customers', () => {
    expect(source).toContain('const paidMonitoring = Boolean(userId && getStarsMonitoringEntitlement(userId))');
    expect(source).toContain("if (paidMonitoring && command === 'monitor')");
    expect(source).toContain("if (paidMonitoring && command === 'unmonitor')");
    expect(source).toContain('commands.push(...getLegacyMonitoringCommands(locale))');
  });

  test('administrators can tune both monitoring prices without environment changes', () => {""",
)

replace_once(
    "__tests__/stars-pr310-final-review.test.ts",
    """    expect(queue).toContain('await finalizeDeferredStarsRefund(currentTask.starsBundleId)');""",
    """    expect(
      queue.match(/await finalizeDeferredStarsRefund\\(currentTask\\.starsBundleId\\)/g)?.length,
    ).toBeGreaterThanOrEqual(2);""",
)

print('Applied current PR 310 review-round fixes')
