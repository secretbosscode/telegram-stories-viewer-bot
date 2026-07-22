from pathlib import Path
import re


def regex_replace(path: str, pattern: str, replacement: str, label: str, flags: int = re.MULTILINE | re.DOTALL) -> None:
    file_path = Path(path)
    text = file_path.read_text()
    updated, count = re.subn(pattern, replacement, text, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f"[{label}] expected one match in {path}, found {count}")
    file_path.write_text(updated)
    print(f"applied: {label}")


def literal_insert(path: str, marker: str, insertion: str, label: str) -> None:
    file_path = Path(path)
    text = file_path.read_text()
    if marker not in text:
        raise SystemExit(f"[{label}] marker not found in {path}: {marker[:160]!r}")
    file_path.write_text(text.replace(marker, insertion + marker, 1))
    print(f"applied: {label}")


# 1. Recompute monitoring expiry from every remaining, unrefunded purchase.
# This prevents refunding an old expired grant from shortening a newer renewal.
expiry_replacement = """SET expires_at = COALESCE(
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
           ),"""
regex_replace(
    "src/services/stars-mode-safety.ts",
    r"SET\s+expires_at\s*=\s*MAX\(\s*CAST\(strftime\('%s','now'\)\s+AS\s+INTEGER\),\s*expires_at\s*-\s*COALESCE\(\s*\(SELECT\s+duration_seconds\s+FROM\s+star_monitor_grants\s+WHERE\s+bundle_id\s*=\s*NEW\.bundle_id\),\s*0\s*\)\s*\),",
    expiry_replacement,
    "recompute monitoring expiry",
)

# 2. Finalize a deferred refund after an errored queue job becomes terminal.
queue_replacement = """await markErrorFx({ jobId: job.id, message: error?.message || 'Unknown processing error' });
      if (currentTask.starsBundleId) {
        const { finalizeDeferredStarsRefund } = await import('./stars-payment');
        await finalizeDeferredStarsRefund(currentTask.starsBundleId).catch((refundError) => {
          console.error(
            `[QueueManager] Deferred Stars refund failed after error for ${currentTask.starsBundleId}:`,
            refundError,
          );
        });
      }
      await bot.telegram.sendMessage("""
regex_replace(
    "src/services/queue-manager.ts",
    r"await\s+markErrorFx\(\{\s*jobId:\s*job\.id,\s*message:\s*error\?\.message\s*\|\|\s*'Unknown processing error'\s*\}\);\s*await\s+bot\.telegram\.sendMessage\(",
    queue_replacement,
    "finalize refund after queue error",
)

# 3. Keep paid Stars-monitoring controls usable when checkout mode is BTC.
legacy_monitoring_functions = """function getLegacyMonitoringCommands(locale: string) {
  return [
    { command: 'monitor', description: t(locale, 'cmd.monitor') },
    { command: 'unmonitor', description: t(locale, 'cmd.unmonitor') },
  ];
}

function getLegacyPremiumCommands(locale: string) {
  return [{ command: 'archive', description: t(locale, 'cmd.archive') }];
}"""
regex_replace(
    "src/services/stars-command-surface.ts",
    r"function\s+getLegacyPremiumCommands\(locale:\s*string\)\s*\{.*?\n\}",
    legacy_monitoring_functions,
    "split legacy monitoring and Premium commands",
)

legacy_builder = """function buildLegacyCommands(locale: string, userId?: string) {
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
}"""
regex_replace(
    "src/services/stars-command-surface.ts",
    r"function\s+buildLegacyCommands\(locale:\s*string,\s*userId\?:\s*string\)\s*\{.*?\n\}",
    legacy_builder,
    "authorize paid monitoring in legacy menus",
)

middleware_start = """bot.use(async (ctx: any, next: () => Promise<void>) => {
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
"""
regex_replace(
    "src/services/stars-command-surface.ts",
    r"bot\.use\(async\s*\(ctx:\s*any,\s*next:\s*\(\)\s*=>\s*Promise<void>\)\s*=>\s*\{\s*if\s*\(!isStarsMode\(\)\)\s*return\s+next\(\);\s*const\s+rawText\s*=\s*String\(ctx\.message\?\.text\s*\|\|\s*''\)\.trim\(\);\s*const\s+locale\s*=\s*ctx\.from\?\.language_code\s*\|\|\s*'en';\s*const\s+userId\s*=\s*String\(ctx\.from\?\.id\s*\?\?\s*''\);\s*const\s+chatId\s*=\s*String\(ctx\.chat\?\.id\s*\?\?\s*ctx\.from\?\.id\s*\?\?\s*''\);\s*const\s+commandMatch\s*=\s*rawText\.match\(.*?\);\s*const\s+command\s*=\s*commandMatch\?\.\[1\]\?\.toLowerCase\(\);\s*",
    middleware_start,
    "route paid monitoring commands in BTC mode",
)

# 4. Never resend a story as pinned if it was already delivered as active in an earlier poll.
regex_replace(
    "src/services/monitor-service.ts",
    r"return\s+!persistedPinnedKeys\.has\(key\)\s*&&\s*!activeCandidateKeys\.has\(key\);",
    "return (\n        !persistedPinnedKeys.has(key) &&\n        !persistedActiveKeys.has(key) &&\n        !activeCandidateKeys.has(key)\n      );",
    "deduplicate active-to-pinned monitoring transitions",
)

# Regression tests.
expiry_test = r'''

  test('refunding an expired earlier grant does not shorten a later renewal', () => {
    const now = Math.floor(Date.now() / 1000);
    const expiredWeekPaidAt = now - (8 * 24 * 60 * 60);
    insertMonitorBundle('expired-week', 'renewed-user', 'monitor_week', 199, expiredWeekPaidAt, 3);
    payMonitorBundle('expired-week', 'renewed-user', 'expired-week-charge', 199, expiredWeekPaidAt);

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
literal_insert(
    "__tests__/stars-mode-safety.test.ts",
    "\n  test('monitor target limit is enforced atomically by SQLite', () => {",
    expiry_test,
    "test old-grant refund renewal safety",
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
literal_insert(
    "__tests__/monitor-active-stories.test.ts",
    "\ntest('does not persist a story key when delivery throws and retries later', async () => {",
    transition_test,
    "test active-to-pinned transition dedupe",
)

legacy_test = r'''
  test('BTC mode preserves controls for active Stars monitoring customers', () => {
    expect(source).toContain('const paidMonitoring = Boolean(userId && getStarsMonitoringEntitlement(userId))');
    expect(source).toContain("if (paidMonitoring && command === 'monitor')");
    expect(source).toContain("if (paidMonitoring && command === 'unmonitor')");
    expect(source).toContain('commands.push(...getLegacyMonitoringCommands(locale))');
  });

'''
literal_insert(
    "__tests__/stars-command-surface.test.ts",
    "  test('administrators can tune both monitoring prices without environment changes', () => {",
    legacy_test,
    "test paid monitoring controls in BTC mode",
)

regex_replace(
    "__tests__/stars-pr310-final-review.test.ts",
    r"expect\(queue\)\.toContain\('await finalizeDeferredStarsRefund\(currentTask\.starsBundleId\)'\);",
    "expect(\n      queue.match(/await finalizeDeferredStarsRefund\\(currentTask\\.starsBundleId\\)/g)?.length,\n    ).toBeGreaterThanOrEqual(2);",
    "test deferred refunds finalize on success and error",
)

print('Applied current PR 310 review-round fixes')
