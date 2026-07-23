import { BOT_ADMIN_ID } from 'config/env-config';
import { db } from 'db';

// Telegram can redeliver successful_payment updates, and the bot can restart
// while a paid bundle is already queued. Ignore a second active queue insert
// for the same bundle while allowing retries after the old job reaches done or
// error. This preserves idempotent delivery without changing queue-manager.
db.exec(`
  DROP TRIGGER IF EXISTS route_star_delivery_to_bundle_chat;
  DROP TRIGGER IF EXISTS preserve_star_requester_entitlement;

  CREATE TRIGGER IF NOT EXISTS preserve_active_star_attempt_budget
  BEFORE UPDATE OF attempt_count ON star_result_bundles
  WHEN NEW.attempt_count > OLD.attempt_count
    AND EXISTS (
      SELECT 1
      FROM download_queue
      WHERE status IN ('pending', 'processing')
        AND json_extract(task_details, '$.starsBundleId') = OLD.id
    )
  BEGIN
    SELECT RAISE(IGNORE);
  END;

  CREATE TRIGGER IF NOT EXISTS prevent_duplicate_star_delivery
  BEFORE INSERT ON download_queue
  WHEN json_extract(NEW.task_details, '$.starsBundleId') IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM download_queue
      WHERE status IN ('pending', 'processing')
        AND json_extract(task_details, '$.starsBundleId') =
            json_extract(NEW.task_details, '$.starsBundleId')
    )
  BEGIN
    SELECT RAISE(IGNORE);
  END;

  -- Queue lookups join users through telegram_id, which is the delivery chat.
  -- For group requests that loses the member's Premium/admin entitlement. Restore
  -- the entitlement from the preserved requester identity before processing.
  CREATE TRIGGER preserve_star_requester_entitlement
  AFTER INSERT ON download_queue
  WHEN json_extract(NEW.task_details, '$.user.id') IS NOT NULL
    AND (
      CAST(json_extract(NEW.task_details, '$.user.id') AS TEXT) = '${BOT_ADMIN_ID}'
      OR EXISTS (
        SELECT 1
        FROM users u
        WHERE u.telegram_id = CAST(json_extract(NEW.task_details, '$.user.id') AS TEXT)
          AND COALESCE(u.is_premium, 0) = 1
          AND (
            u.premium_until IS NULL
            OR u.premium_until >= CAST(strftime('%s','now') AS INTEGER)
          )
      )
    )
  BEGIN
    UPDATE download_queue
    SET task_details = json_set(task_details, '$.isPremium', 1)
    WHERE id = NEW.id;
  END;

  -- Queue ownership and payment ownership are deliberately different for group
  -- purchases. The positive member ID owns the charge/refund, while chat_id is
  -- the destination that requested and paid for the result bundle. queue-manager
  -- restores task.chatId from download_queue.telegram_id, so route the inserted
  -- job to the retained bundle chat after the payment service enqueues it.
  CREATE TRIGGER route_star_delivery_to_bundle_chat
  AFTER INSERT ON download_queue
  WHEN json_extract(NEW.task_details, '$.starsBundleId') IS NOT NULL
  BEGIN
    UPDATE download_queue
    SET telegram_id = COALESCE(
      (
        SELECT chat_id
        FROM star_result_bundles
        WHERE id = json_extract(NEW.task_details, '$.starsBundleId')
      ),
      telegram_id
    )
    WHERE id = NEW.id;
  END;
`);
