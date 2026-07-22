from pathlib import Path


def read(path: str) -> str:
    return Path(path).read_text()


def write(path: str, text: str) -> None:
    Path(path).write_text(text)


def one(path: str, old: str, new: str) -> None:
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one match, found {count}: {old[:120]!r}")
    write(path, text.replace(old, new, 1))


def append_before_last(path: str, marker: str, block: str) -> None:
    text = read(path)
    index = text.rfind(marker)
    if index < 0:
        raise RuntimeError(f"{path}: marker not found: {marker!r}")
    write(path, text[:index] + block + text[index:])


# Legacy command menus must never overwrite Stars menus, regardless of startup timing.
one(
    'src/index.ts',
    "import {\n  resumePendingChecks,\n  setBotInstance,\n  verifyPaymentByTxid,\n} from './services/btc-payment';\n",
    "import {\n  resumePendingChecks,\n  setBotInstance,\n  verifyPaymentByTxid,\n} from './services/btc-payment';\nimport { isStarsMode } from './services/stars-payment';\n",
)
one(
    'src/index.ts',
    "async function updateUserCommands(\n  ctx: IContextBot,\n  isAdmin: boolean,\n  isPremium: boolean,\n) {\n  const locale = ctx.from?.language_code || 'en';",
    "async function updateUserCommands(\n  ctx: IContextBot,\n  isAdmin: boolean,\n  isPremium: boolean,\n) {\n  if (isStarsMode()) return;\n  const locale = ctx.from?.language_code || 'en';",
)
one(
    'src/index.ts',
    "  await bot.telegram.setMyCommands(getBaseCommands('en'));\n  await bot.telegram.setMyCommands(\n    [...getBaseCommands('en'), ...getPremiumCommands('en'), ...getAdminCommands('en')],\n    { scope: { type: 'chat', chat_id: BOT_ADMIN_ID } }\n  );",
    "  if (!isStarsMode()) {\n    await bot.telegram.setMyCommands(getBaseCommands('en'));\n    await bot.telegram.setMyCommands(\n      [...getBaseCommands('en'), ...getPremiumCommands('en'), ...getAdminCommands('en')],\n      { scope: { type: 'chat', chat_id: BOT_ADMIN_ID } }\n    );\n  }",
)

# Enforce Stars monitoring capacity atomically in SQLite.
one(
    'src/services/stars-mode-safety.ts',
    "    DROP TRIGGER IF EXISTS revoke_latest_star_monitor_refund;\n    DROP TRIGGER IF EXISTS preserve_active_star_monitors;",
    "    DROP TRIGGER IF EXISTS revoke_latest_star_monitor_refund;\n    DROP TRIGGER IF EXISTS enforce_star_monitor_limit;\n    DROP TRIGGER IF EXISTS preserve_active_star_monitors;",
)
one(
    'src/services/stars-mode-safety.ts',
    "    CREATE TRIGGER preserve_active_star_monitors\n",
    "    CREATE TRIGGER enforce_star_monitor_limit\n    BEFORE INSERT ON monitors\n    WHEN EXISTS (\n      SELECT 1 FROM star_monitor_entitlements e\n      WHERE e.user_id = NEW.telegram_id\n        AND e.expires_at > CAST(strftime('%s','now') AS INTEGER)\n    )\n    AND NOT EXISTS (\n      SELECT 1 FROM users u\n      WHERE u.telegram_id = NEW.telegram_id\n        AND COALESCE(u.is_premium, 0) = 1\n        AND (u.premium_until IS NULL OR u.premium_until >= CAST(strftime('%s','now') AS INTEGER))\n    )\n    AND (\n      SELECT COUNT(*) FROM monitors existing\n      WHERE existing.telegram_id = NEW.telegram_id\n    ) >= COALESCE(\n      (SELECT e.max_targets FROM star_monitor_entitlements e WHERE e.user_id = NEW.telegram_id),\n      0\n    )\n    BEGIN\n      SELECT RAISE(ABORT, 'STAR_MONITOR_LIMIT');\n    END;\n\n    CREATE TRIGGER preserve_active_star_monitors\n",
)

# A Stars refund must not remove monitors that are still authorized by Premium.
one(
    'src/services/stars-mode-safety.ts',
    "      ) > COALESCE(\n        (SELECT max_targets FROM star_monitor_entitlements e WHERE e.user_id = monitors.telegram_id),\n        0\n      );",
    "      ) > COALESCE(\n        (SELECT max_targets FROM star_monitor_entitlements e WHERE e.user_id = monitors.telegram_id),\n        0\n      )\n      AND NOT EXISTS (\n        SELECT 1 FROM users u\n        WHERE u.telegram_id = monitors.telegram_id\n          AND COALESCE(u.is_premium, 0) = 1\n          AND (u.premium_until IS NULL OR u.premium_until >= CAST(strftime('%s','now') AS INTEGER))\n      );",
)
one(
    'src/services/stars-mode-safety.ts',
    "      AND NOT EXISTS (\n        SELECT 1 FROM star_monitor_entitlements e\n        WHERE e.user_id = monitors.telegram_id\n          AND e.expires_at > CAST(strftime('%s','now') AS INTEGER)\n      );",
    "      AND NOT EXISTS (\n        SELECT 1 FROM star_monitor_entitlements e\n        WHERE e.user_id = monitors.telegram_id\n          AND e.expires_at > CAST(strftime('%s','now') AS INTEGER)\n      )\n      AND NOT EXISTS (\n        SELECT 1 FROM users u\n        WHERE u.telegram_id = monitors.telegram_id\n          AND COALESCE(u.is_premium, 0) = 1\n          AND (u.premium_until IS NULL OR u.premium_until >= CAST(strftime('%s','now') AS INTEGER))\n      );",
)

# Convert the atomic database rejection into the localized limit response.
one(
    'src/services/stars-command-surface.ts',
    "  const added = await addProfileMonitor(userId, username);\n  if (!added) return ctx.reply(t(locale, 'stars.monitorAlready'));",
    "  let added;\n  try {\n    added = await addProfileMonitor(userId, username);\n  } catch (error) {\n    if (String(error).includes('STAR_MONITOR_LIMIT')) {\n      return ctx.reply(t(locale, 'stars.monitorLimit', { maxTargets: entitlement.maxTargets }));\n    }\n    throw error;\n  }\n  if (!added) return ctx.reply(t(locale, 'stars.monitorAlready'));",
)

# Keep test state isolated.
one(
    '__tests__/stars-mode-safety.test.ts',
    "    db.prepare('DELETE FROM star_payments').run();\n    db.prepare('DELETE FROM payment_checks').run();",
    "    db.prepare('DELETE FROM star_payments').run();\n    db.prepare('DELETE FROM monitors').run();\n    db.prepare('DELETE FROM users').run();\n    db.prepare('DELETE FROM payment_checks').run();",
)

append_before_last(
    '__tests__/stars-mode-safety.test.ts',
    "});\n",
    """

  test('monitor target limit is enforced atomically by SQLite', () => {
    const now = Math.floor(Date.now() / 1000);
    insertMonitorBundle('atomic-limit', 'atomic-user', 'monitor_week', 199, now, 1);
    payMonitorBundle('atomic-limit', 'atomic-user', 'atomic-charge', 199, now);

    db.prepare(
      `INSERT INTO monitors (telegram_id, target_id, target_username, created_at)
       VALUES ('atomic-user', '1', 'first', ?)`
    ).run(now);

    expect(() => db.prepare(
      `INSERT INTO monitors (telegram_id, target_id, target_username, created_at)
       VALUES ('atomic-user', '2', 'second', ?)`
    ).run(now + 1)).toThrow(/STAR_MONITOR_LIMIT/);

    const row = db.prepare(
      "SELECT COUNT(*) AS count FROM monitors WHERE telegram_id = 'atomic-user'"
    ).get() as any;
    expect(Number(row.count)).toBe(1);
  });

  test('refunding Stars monitoring preserves monitors for active Premium users', () => {
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      `INSERT INTO users (telegram_id, is_premium, premium_until)
       VALUES ('premium-monitor', 1, ?)`
    ).run(now + 86400);
    insertMonitorBundle('premium-refund', 'premium-monitor', 'monitor_week', 199, now, 1);
    payMonitorBundle('premium-refund', 'premium-monitor', 'premium-refund-charge', 199, now);
    db.prepare(
      `INSERT INTO monitors (telegram_id, target_id, target_username, created_at)
       VALUES ('premium-monitor', '1', 'kept', ?)`
    ).run(now);

    db.prepare(
      "UPDATE star_payments SET refunded_at = ? WHERE telegram_payment_charge_id = 'premium-refund-charge'"
    ).run(now + 1);

    expect(getStarsMonitoringEntitlement('premium-monitor')).toBeUndefined();
    const row = db.prepare(
      "SELECT COUNT(*) AS count FROM monitors WHERE telegram_id = 'premium-monitor'"
    ).get() as any;
    expect(Number(row.count)).toBe(1);
  });
""",
)

append_before_last(
    '__tests__/stars-final-safety.test.ts',
    "});\n",
    """

  test('Stars menus cannot be overwritten by legacy startup or per-user updates', () => {
    const index = source('src/index.ts');
    expect(index).toContain("import { isStarsMode } from './services/stars-payment'");
    expect(index).toContain('if (isStarsMode()) return;');
    expect(index).toContain('if (!isStarsMode()) {');
  });

  test('monitor limits are atomic and Premium eligibility survives Stars refunds', () => {
    const safety = source('src/services/stars-mode-safety.ts');
    const commands = source('src/services/stars-command-surface.ts');
    expect(safety).toContain('CREATE TRIGGER enforce_star_monitor_limit');
    expect(safety).toContain("RAISE(ABORT, 'STAR_MONITOR_LIMIT')");
    expect(safety.match(/COALESCE\(u\.is_premium, 0\) = 1/g)?.length).toBeGreaterThanOrEqual(3);
    expect(commands).toContain("String(error).includes('STAR_MONITOR_LIMIT')");
  });
""",
)

print('Final Codex P2 findings patched.')
