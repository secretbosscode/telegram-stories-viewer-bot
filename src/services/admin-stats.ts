import fs from 'fs';
import path from 'path';
import { Telegraf } from 'telegraf';
import { BOT_ADMIN_ID, LOG_FILE } from '../config/env-config';
import { db, unblockUser } from '../db';

let startTimestamp = Math.floor(Date.now() / 1000);
let statusMessageId: number | null = null;
const STATUS_ID_FILE =
  process.env.STATUS_ID_FILE ||
  path.join(__dirname, '../../data/admin_status_id');

function readSavedStatusId(): number | null {
  try {
    const id = fs.readFileSync(STATUS_ID_FILE, 'utf8');
    return Number(id) || null;
  } catch {
    return null;
  }
}

function saveStatusId(id: number) {
  try {
    fs.mkdirSync(path.dirname(STATUS_ID_FILE), { recursive: true });
    fs.writeFileSync(STATUS_ID_FILE, String(id));
  } catch {}
}

function countRows(query: string, param: number): number {
  const row = db.prepare(query).get(param) as { c: number } | undefined;
  return row?.c || 0;
}

export function getDailyStats() {
  const since = Math.floor(Date.now() / 1000) - 86400;
  const newUsers = countRows(
    "SELECT COUNT(*) as c FROM users WHERE strftime('%s', created_at) > ?",
    since,
  );
  const paidInvoices = countRows(
    "SELECT COUNT(*) as c FROM payments WHERE paid_at IS NOT NULL AND paid_at > ?",
    since,
  );
  const invitesRedeemed = countRows(
    "SELECT COUNT(*) as c FROM referrals WHERE created_at > ?",
    since,
  );

  let errors = 0;
  try {
    const dayAgo = Date.now() - 86400 * 1000;
    const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n');
    for (const line of lines) {
      const m = line.match(/^\[(.+?)\]/);
      if (m) {
        const ts = Date.parse(m[1]);
        if (ts && ts > dayAgo) errors++;
      }
    }
  } catch {}

  return { newUsers, paidInvoices, invitesRedeemed, errors };
}

function formatUptime(): string {
  const seconds = Math.floor(Date.now() / 1000) - startTimestamp;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

export async function sendStartupStatus(bot: Telegraf<any>) {
  startTimestamp = Math.floor(Date.now() / 1000);
  const prev = readSavedStatusId();
  const stats = getDailyStats();
  const text =
    `🕒 Uptime: ${formatUptime()}\n` +
    `New users: ${stats.newUsers}\n` +
    `Payments: ${stats.paidInvoices}\n` +
    `Invites redeemed: ${stats.invitesRedeemed}\n` +
    `Errors last 24h: ${stats.errors}`;
  const msg = await bot.telegram.sendMessage(BOT_ADMIN_ID, text);
  if (bot.botInfo?.id) {
    unblockUser(String(bot.botInfo.id));
  }
  try {
    if (prev) {
      await bot.telegram.unpinChatMessage(BOT_ADMIN_ID, prev).catch(() => {});
    }
    await bot.telegram.pinChatMessage(BOT_ADMIN_ID, msg.message_id, {
      disable_notification: true,
    });
  } catch {}
  statusMessageId = msg.message_id;
  saveStatusId(msg.message_id);
}

export async function updateAdminStatus(bot: Telegraf<any>) {
  if (!statusMessageId) {
    statusMessageId = readSavedStatusId();
  }
  if (!statusMessageId) return;
  const stats = getDailyStats();
  const text =
    `🕒 Uptime: ${formatUptime()}\n` +
    `New users: ${stats.newUsers}\n` +
    `Payments: ${stats.paidInvoices}\n` +
    `Invites redeemed: ${stats.invitesRedeemed}\n` +
    `Errors last 24h: ${stats.errors}`;
  try {
    await bot.telegram.editMessageText(
      BOT_ADMIN_ID,
      statusMessageId,
      undefined,
      text,
    );
  } catch {}
}

export function startAdminStatusUpdates(bot: Telegraf<any>) {
  sendStartupStatus(bot);
  setInterval(() => updateAdminStatus(bot), 60 * 60 * 1000);
}

