export interface DownloadQueueItem {
  id: number;
  telegram_id: string;
  target_username: string;
  status: string;
  enqueued_ts: number;
  processed_ts?: number;
  error?: string;
  is_premium?: number;
}
