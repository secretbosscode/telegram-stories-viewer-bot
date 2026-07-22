import { db } from 'db';

// Telegram can redeliver successful_payment updates, and the bot can restart
// while a paid bundle is already queued. Ignore a second active queue insert
// for the same bundle while allowing retries after the old job reaches done or
// error. This preserves idempotent delivery without changing queue-manager.
db.exec(`
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
`);
