from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"pattern not found in {path}: {old[:200]!r}")
    p.write_text(text.replace(old, new, 1))


# Fulfilled monitoring purchases are services/entitlements, not delivered media.
# Allow only those DELIVERED bundle kinds through the refund fence.
replace_once(
    "src/services/stars-payment.ts",
    """       WHERE id = ? AND status IN ('PAID', 'DELIVERING', 'REFUND_PENDING')`,
    ).run(bundle.id);""",
    """       WHERE id = ?
         AND (
           status IN ('PAID', 'DELIVERING', 'REFUND_PENDING')
           OR (status = 'DELIVERED' AND request_kind IN ('monitor_week', 'monitor_month'))
         )`,
    ).run(bundle.id);""",
)

# Telegram can return the same story in active and pinned collections. Send it
# once as active media and only send genuinely additional pinned stories.
replace_once(
    "src/controllers/send-stories.ts",
    """      } else {
        if (activeStories.length > 0) {""",
    """      } else {
        const activeStoryIds = new Set(activeStories.map((story) => Number(story.id)));
        const uniquePinnedStories = pinnedStories.filter(
          (story) => !activeStoryIds.has(Number(story.id)),
        );

        if (activeStories.length > 0) {""",
)
replace_once(
    "src/controllers/send-stories.ts",
    """        if (pinnedStories.length > 0) {
          const pinnedDeliveredIds = await sendPinnedStories({
            stories: mapStories(pinnedStories),""",
    """        if (uniquePinnedStories.length > 0) {
          const pinnedDeliveredIds = await sendPinnedStories({
            stories: mapStories(uniquePinnedStories),""",
)

# Make the pinned sender mock explicitly async/array-valued for the new test.
replace_once(
    "__tests__/send-stories.test.ts",
    "const sendPinnedStories = jest.fn();",
    "const sendPinnedStories: any = jest.fn(async () => []);",
)
replace_once(
    "__tests__/send-stories.test.ts",
    """    sendPaginatedStories.mockResolvedValue([1]);
    sendActiveStories.mockResolvedValue([]);""",
    """    sendPaginatedStories.mockResolvedValue([1]);
    sendActiveStories.mockResolvedValue([]);
    sendPinnedStories.mockResolvedValue([]);""",
)

overlap_test = r'''

  test('does not deliver a story twice when Telegram returns it as active and pinned', async () => {
    sendActiveStories.mockResolvedValue([7]);
    sendPinnedStories.mockResolvedValue([8]);

    await sendStoriesFx({
      activeStories: [{ id: 7 }] as any,
      pinnedStories: [{ id: 7 }, { id: 8 }] as any,
      task: {
        chatId: '7',
        link: '@target',
        linkType: 'username',
        locale: 'en',
        initTime: 0,
      },
    } as any);

    expect(sendActiveStories).toHaveBeenCalledWith(
      expect.objectContaining({ stories: [{ id: 7 }] }),
    );
    expect(sendPinnedStories).toHaveBeenCalledWith(
      expect.objectContaining({ stories: [{ id: 8 }] }),
    );
  });
'''
replace_once(
    "__tests__/send-stories.test.ts",
    "\n  test('marks a paid bundle delivered only when every purchased ID was delivered', async () => {",
    overlap_test + "\n  test('marks a paid bundle delivered only when every purchased ID was delivered', async () => {",
)

monitor_refund_test = r'''

  test('refunds a fulfilled monitoring purchase without allowing delivered media refunds', async () => {
    const now = Math.floor(Date.now() / 1000);
    db.prepare(`
      INSERT INTO star_result_bundles (
        id, user_id, chat_id, target, locale, request_kind, story_ids,
        task_json, result_count, price_stars, status, created_at, expires_at,
        paid_at, delivered_at, attempt_count
      ) VALUES ('monitor-refund', '123', '123', 'story-monitoring', 'en',
        'monitor_week', '[]', '{}', 3, 199, 'DELIVERED', ?, ?, ?, ?, 0)
    `).run(now, now + 1800, now, now);
    db.prepare(`
      INSERT INTO star_payments (
        telegram_payment_charge_id, bundle_id, user_id, amount_stars, paid_at
      ) VALUES ('monitor-refund-charge', 'monitor-refund', '123', 199, ?)
    `).run(now);

    expect(await refundUndeliverableStarsBundle('monitor-refund')).toBe(true);
    expect(bot.telegram.callApi).toHaveBeenCalledWith('refundStarPayment', {
      user_id: 123,
      telegram_payment_charge_id: 'monitor-refund-charge',
    });
    expect((db.prepare(
      `SELECT status FROM star_result_bundles WHERE id = 'monitor-refund'`,
    ).get() as any).status).toBe('REFUNDED');
  });
'''
replace_once(
    "__tests__/stars-payment.test.ts",
    "\n  test('delivery cannot settle after refund fencing begins', () => {",
    monitor_refund_test + "\n  test('delivery cannot settle after refund fencing begins', () => {",
)

print('Applied latest PR 310 review fixes')
