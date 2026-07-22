from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, text: str) -> None:
    (ROOT / path).write_text(text, encoding="utf-8")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


# 1. Keep Telegram successful_payment updates across restarts directly in startup.
index_path = "src/index.ts"
text = read(index_path)
text = replace_once(
    text,
    "bot.launch({ dropPendingUpdates: true }).then(() => {",
    "bot.launch({ dropPendingUpdates: false }).then(() => {",
    "retain pending Telegram updates",
)
write(index_path, text)


# 2. Make Stars mode safe, owner-bound, pause-safe, and migration-safe.
stars_path = "src/services/stars-payment.ts"
text = read(stars_path)
old_migration = """  const existingMode = getSetting('payment_mode');
  if (!existingMode) {
    const paidBtc = db
      .prepare('SELECT COUNT(*) AS count FROM payments WHERE paid_at IS NOT NULL')
      .get() as { count?: number } | undefined;
    // Existing installations with no completed BTC payments move to Stars
    // automatically, even if a wallet was previously required only to boot.
    const mode: PaymentMode = BTC_CONFIGURED && Number(paidBtc?.count ?? 0) > 0
      ? 'btc'
      : 'stars';
    setSetting('payment_mode', mode, 'migration');
  }
"""
new_migration = """  const existingMode = getSetting('payment_mode');
  if (!existingMode) {
    const activeInvoice = db
      .prepare(
        `SELECT COUNT(*) AS count FROM payments
         WHERE paid_at IS NULL AND COALESCE(expires_at, 0) >= ?`,
      )
      .get(now) as { count?: number } | undefined;
    const activeCheck = db
      .prepare('SELECT COUNT(*) AS count FROM payment_checks')
      .get() as { count?: number } | undefined;
    const hasActiveLegacyPayment =
      Number(activeInvoice?.count ?? 0) > 0 || Number(activeCheck?.count ?? 0) > 0;

    // Stars is the default. BTC remains active only long enough to honor a
    // genuinely outstanding legacy invoice/check, or when an admin later
    // selects it explicitly from the admin panel.
    const mode: PaymentMode = BTC_CONFIGURED && hasActiveLegacyPayment
      ? 'btc'
      : 'stars';
    setSetting('payment_mode', mode, 'migration');
  }
"""
text = replace_once(text, old_migration, new_migration, "payment mode migration")

old_gate = """function isPayableRequest(params: SendStoriesFxParams): boolean {
  const { task } = params;
  if (!isStarsMode() || !areStarsEnabled()) return false;
  if (task.starsUnlocked || task.isPremium) return false;
  if (task.chatId === String(BOT_ADMIN_ID)) return false;
  if (task.storyRequestType === 'archived' || task.storyRequestType === 'global' || task.storyRequestType === 'paginated') {
    return false;
  }
  if ((params.archivedStories?.length ?? 0) > 0 || (params.globalStories?.length ?? 0) > 0 || (params.paginatedStories?.length ?? 0) > 0) {
    return false;
  }
  return collectResultIds(params).length > 0;
}
"""
new_gate = """function isStarsGatedRequest(params: SendStoriesFxParams): boolean {
  const { task } = params;
  if (!isStarsMode()) return false;
  if (task.starsUnlocked || task.isPremium) return false;
  if (String(task.user?.id ?? task.chatId) === String(BOT_ADMIN_ID)) return false;
  if (task.storyRequestType === 'archived' || task.storyRequestType === 'global' || task.storyRequestType === 'paginated') {
    return false;
  }
  if ((params.archivedStories?.length ?? 0) > 0 || (params.globalStories?.length ?? 0) > 0 || (params.paginatedStories?.length ?? 0) > 0) {
    return false;
  }
  return collectResultIds(params).length > 0;
}
"""
text = replace_once(text, old_gate, new_gate, "Stars request gate")

text = replace_once(
    text,
    """  ).run(
    id,
    task.chatId,
    task.chatId,
""",
    """  ).run(
    id,
    String(task.user?.id ?? task.chatId),
    task.chatId,
""",
    "bundle purchaser ownership",
)

old_offer = """export async function maybeOfferStoryUnlock(params: SendStoriesFxParams): Promise<boolean> {
  if (!isPayableRequest(params)) return false;
  if (!botInstance) throw new Error('Stars payment service has not been registered');

  const storyIds = collectResultIds(params);
"""
new_offer = """export async function maybeOfferStoryUnlock(params: SendStoriesFxParams): Promise<boolean> {
  if (!isStarsGatedRequest(params)) return false;
  if (!botInstance) throw new Error('Stars payment service has not been registered');

  if (!areStarsEnabled()) {
    await botInstance.telegram.sendMessage(
      params.task.chatId,
      t(params.task.locale, 'stars.paymentUnavailable'),
    );
    return true;
  }

  const storyIds = collectResultIds(params);
"""
text = replace_once(text, old_offer, new_offer, "paused Stars offer handling")
write(stars_path, text)


# 3. Count actual paid delivery, not merely attempted delivery.
send_path = "src/controllers/send-stories.ts"
text = read(send_path)
text = replace_once(
    text,
    """      else if (paginatedStories && paginatedStories.length > 0) {
        await sendPaginatedStories({ stories: paginatedStories, task });
        storiesWereSent = true;
      }
""",
    """      else if (paginatedStories && paginatedStories.length > 0) {
        const deliveredCount = await sendPaginatedStories({ stories: paginatedStories, task });
        storiesWereSent = deliveredCount > 0;
      }
""",
    "paid paginated delivery count",
)
write(send_path, text)


# 4. Use the proven monitor scheduler for both Premium and Stars entitlements.
monitor_path = "src/services/monitor-service.ts"
text = read(monitor_path)
text = replace_once(
    text,
    "import { ensureStealthMode } from 'services/stealth-mode';\n",
    "import { ensureStealthMode } from 'services/stealth-mode';\nimport { getStarsMonitoringEntitlement } from 'services/stars-mode-safety';\n",
    "monitor entitlement import",
)
old_access = """      if (!premium && Number(m.telegram_id) !== BOT_ADMIN_ID) {
        removeMonitor(m.telegram_id, m.target_id);
        continue;
      }
      await checkSingleMonitor(m.id);
"""
new_access = """      const starsMonitoring = getStarsMonitoringEntitlement(m.telegram_id);
      if (!premium && !starsMonitoring && Number(m.telegram_id) !== BOT_ADMIN_ID) {
        removeMonitor(m.telegram_id, m.target_id);
        continue;
      }
      await checkSingleMonitor(m.id);
"""
text = replace_once(text, old_access, new_access, "monitor access check")
write(monitor_path, text)


# 5. Remove the temporary second monitor loop and launch monkey patch.
safety_path = "src/services/stars-mode-safety.ts"
text = read(safety_path)
text = text.replace("const MONITOR_INTERVAL_MS = 60 * 60 * 1000;\n\n", "")
text = text.replace("let monitorTimer: NodeJS.Timeout | null = null;\nlet monitorCycleRunning = false;\nlet launchPatched = false;\n\n", "")
text = re.sub(
    r"\n    CREATE TABLE IF NOT EXISTS star_monitor_delete_authorizations \(.*?\n    \);\n",
    "\n",
    text,
    flags=re.S,
)
text = re.sub(
    r"\n    CREATE TRIGGER IF NOT EXISTS preserve_active_star_monitors.*?\n    END;\n",
    "\n",
    text,
    flags=re.S,
)
text = re.sub(
    r"\n  db\.prepare\(\n    'DELETE FROM star_monitor_delete_authorizations.*?\.run\(now - 300\);\n",
    "\n",
    text,
    flags=re.S,
)
text = re.sub(
    r"\nexport function authorizeStarsMonitorRemoval\(.*?\n}\n\nexport function clearStarsMonitorRemovalAuthorization\(.*?\n}\n",
    "\n",
    text,
    flags=re.S,
)
text = re.sub(
    r"\nasync function runStarsMonitorCycle\(\): Promise<void> \{.*?\n}\n\nfunction startStarsMonitorLoop\(\): void \{.*?\n}\n\nfunction retainPendingTelegramUpdates\(bot: Telegraf<IContextBot>\): void \{.*?\n}\n",
    "\n",
    text,
    flags=re.S,
)
text = text.replace("  retainPendingTelegramUpdates(bot);\n  startStarsMonitorLoop();\n", "")
write(safety_path, text)


# 6. Simplify command surface now that monitor deletion needs no authorization.
command_path = "src/services/stars-command-surface.ts"
text = read(command_path)
text = text.replace("  authorizeStarsMonitorRemoval,\n  clearStarsMonitorRemovalAuthorization,\n", "")
text = replace_once(
    text,
    """  const existing = listUserMonitors(userId).find(
    (monitor) =>
      monitor.target_username?.replace(/^@/, '').toLowerCase() === username.toLowerCase() ||
      monitor.target_id === username,
  );
  if (existing) authorizeStarsMonitorRemoval(userId, existing.target_id);
  try {
    await removeProfileMonitor(userId, username);
  } finally {
    if (existing) clearStarsMonitorRemovalAuthorization(userId, existing.target_id);
  }
""",
    """  await removeProfileMonitor(userId, username);
""",
    "monitor removal",
)
text = text.replace("function allowedCommandNames(", "export function allowedCommandNames(", 1)
write(command_path, text)


# 7. Extend the existing Stars tests for the hotfix cases.
test_path = "__tests__/stars-payment.test.ts"
text = read(test_path)
text = text.replace(
    """      paid_amount REAL DEFAULT 0,
      paid_at INTEGER
    );
""",
    """      paid_amount REAL DEFAULT 0,
      expires_at INTEGER,
      paid_at INTEGER
    );
    CREATE TABLE payment_checks (
      invoice_id INTEGER PRIMARY KEY,
      next_check INTEGER NOT NULL,
      check_start INTEGER NOT NULL
    );
""",
    1,
)
text = text.replace(
    """      initTime: Date.now(),
      ...overrides,
""",
    """      initTime: Date.now(),
      user: { id: 123, is_bot: false, first_name: 'Buyer' },
      ...overrides,
""",
    1,
)
text = text.replace("expect(bundle.user_id).toBe('123');", "expect(bundle.user_id).toBe('123');", 1)
insert_after = """  test('creates an XTR invoice only after verified results exist', async () => {
"""
if insert_after not in text:
    raise RuntimeError("stars test insertion anchor missing")
new_tests = """  test('paused Stars never falls through to free delivery', async () => {
    db.prepare(
      `INSERT INTO bot_settings (key, value, updated_at, updated_by)
       VALUES ('stars_enabled', '0', 1, 'test')
       ON CONFLICT(key) DO UPDATE SET value = '0'`,
    ).run();

    const handled = await maybeOfferStoryUnlock(makeParams());
    expect(handled).toBe(true);
    expect(bot.telegram.callApi).not.toHaveBeenCalled();
    expect(bot.telegram.sendMessage).toHaveBeenCalledWith(
      '123',
      expect.stringContaining('paused'),
    );

    db.prepare("UPDATE bot_settings SET value = '1' WHERE key = 'stars_enabled'").run();
  });

  test('group offers are owned by the requesting member, not the group chat', async () => {
    const offered = await maybeOfferStoryUnlock(makeParams({
      chatId: '-100777',
      user: { id: 456, is_bot: false, first_name: 'Group buyer' },
    }));
    expect(offered).toBe(true);
    const bundle = db.prepare('SELECT * FROM star_result_bundles').get() as any;
    expect(bundle.user_id).toBe('456');
    expect(bundle.chat_id).toBe('-100777');
  });

"""
text = text.replace(insert_after, new_tests + insert_after, 1)
write(test_path, text)


# 8. Add focused monitoring entitlement and command-surface tests.
monitor_test = r"""import { jest } from '@jest/globals';

jest.mock('../src/db', () => {
  const SyncDatabase = require('../src/db/sqlite-sync').default;
  const db = new SyncDatabase(':memory:');
  db.exec(`
    CREATE TABLE users (
      telegram_id TEXT PRIMARY KEY,
      is_premium INTEGER DEFAULT 0,
      premium_until INTEGER,
      created_at INTEGER DEFAULT 0,
      language TEXT
    );
    CREATE TABLE payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT,
      invoice_amount REAL,
      user_address TEXT,
      paid_amount REAL DEFAULT 0,
      expires_at INTEGER,
      paid_at INTEGER
    );
    CREATE TABLE payment_checks (
      invoice_id INTEGER PRIMARY KEY,
      next_check INTEGER NOT NULL,
      check_start INTEGER NOT NULL
    );
    CREATE TABLE monitors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT NOT NULL,
      target_id TEXT,
      target_username TEXT,
      target_access_hash TEXT,
      last_checked INTEGER,
      last_photo_id TEXT,
      created_at INTEGER DEFAULT 0
    );
    CREATE TABLE download_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT,
      target_username TEXT,
      status TEXT,
      enqueued_ts INTEGER,
      task_details TEXT
    );
  `);
  return { db };
});

jest.mock('../src/db/effects', () => ({ enqueueDownloadFx: jest.fn(async () => 1) }));
jest.mock('../src/config/env-config', () => ({ BOT_ADMIN_ID: 999, BTC_CONFIGURED: true }));

import { db } from '../src/db';
import {
  getStarsMonitoringEntitlement,
  getStarsMonitorPrice,
  initializeStarsModeSafety,
} from '../src/services/stars-mode-safety';

const bot = { launch: jest.fn(), telegram: {} } as any;

describe('Stars monitoring entitlements', () => {
  beforeAll(() => initializeStarsModeSafety(bot));

  beforeEach(() => {
    db.prepare('DELETE FROM star_monitor_entitlements').run();
    db.prepare('DELETE FROM star_result_bundles').run();
    db.prepare('DELETE FROM star_payments').run();
  });

  test('uses the simple one-week and one-month defaults', () => {
    expect(getStarsMonitorPrice('week')).toBe(199);
    expect(getStarsMonitorPrice('month')).toBe(499);
  });

  test('a paid weekly monitoring bundle grants three-target access and is delivered immediately', () => {
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`
      INSERT INTO star_result_bundles (
        id, user_id, chat_id, target, locale, request_kind, story_ids,
        task_json, result_count, price_stars, status, created_at, expires_at
      ) VALUES ('monitor-1', '123', '123', 'story-monitoring', 'en',
        'monitor_week', '[]', '{}', 3, 199, 'OFFERED', ?, ?)
    `).run(now, now + 1800);

    db.prepare("UPDATE star_result_bundles SET status = 'PAID', paid_at = ? WHERE id = 'monitor-1'").run(now);

    const entitlement = getStarsMonitoringEntitlement('123');
    expect(entitlement).toBeDefined();
    expect(entitlement?.maxTargets).toBe(3);
    expect(entitlement?.plan).toBe('monitor_week');
    expect((entitlement?.expiresAt ?? 0) - now).toBeGreaterThanOrEqual(7 * 24 * 60 * 60 - 2);

    const bundle = db.prepare("SELECT status, delivered_at FROM star_result_bundles WHERE id = 'monitor-1'").get() as any;
    expect(bundle.status).toBe('DELIVERED');
    expect(bundle.delivered_at).toBeTruthy();
  });
});
"""
write("__tests__/stars-monitoring.test.ts", monitor_test)

# Remove the staging helper itself and its one-shot workflow from the resulting commit.
for ephemeral in [
    ROOT / "scripts/apply-stars-hotfix.py",
    ROOT / ".github/workflows/apply-stars-hotfix.yml",
]:
    if ephemeral.exists():
        ephemeral.unlink()

print("Stars hotfix patch applied successfully")
