from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    if new in text:
        print(f'already updated: {path}')
        return
    if old not in text:
        raise SystemExit(f'pattern not found in {path}: {old[:160]!r}')
    p.write_text(text.replace(old, new, 1))
    print(f'updated: {path}')


replace_once(
    '__tests__/stars-payment.test.ts',
    '  getPaymentMode,',
    '  finalizeDeferredStarsRefund,\n  getPaymentMode,',
)

replace_once(
    '__tests__/stars-payment.test.ts',
    "    expect((db.prepare(`SELECT status FROM star_result_bundles WHERE id = 'refund-processing-job'`).get() as any).status).toBe('DELIVERING');",
    "    expect((db.prepare(`SELECT status FROM star_result_bundles WHERE id = 'refund-processing-job'`).get() as any).status).toBe('REFUND_PENDING');\n\n    db.prepare(\"UPDATE download_queue SET status = 'done' WHERE json_extract(task_details, '$.starsBundleId') = 'refund-processing-job'\").run();\n    expect(await finalizeDeferredStarsRefund('refund-processing-job')).toBe(true);\n    expect((db.prepare(`SELECT status FROM star_result_bundles WHERE id = 'refund-processing-job'`).get() as any).status).toBe('REFUNDED');",
)

replace_once(
    '__tests__/stars-final-safety.test.ts',
    "    expect(index).toContain('if (!isStarsMode()) {');",
    "    expect(index).toContain('await synchronizeStarsCommandMenus(bot, true)');\n    expect(index).toContain('await synchronizeLegacyCommandMenus(bot)');",
)

print('Updated final PR 310 expectations')
