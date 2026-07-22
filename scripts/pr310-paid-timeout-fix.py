from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"pattern not found in {path}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1))


replace_once(
    "src/services/queue-manager.ts",
    "  let timedOut = false;\n  const timeoutMs = currentTask.storyRequestType === 'paginated'",
    "  let timedOut = false;\n  let deliveryStarted = false;\n  const timeoutMs = currentTask.storyRequestType === 'paginated'",
)

replace_once(
    "src/services/queue-manager.ts",
    "  const timeoutId = setTimeout(async () => {\n    timedOut = true;",
    "  const timeoutId = setTimeout(async () => {\n    if (currentTask.starsBundleId && deliveryStarted) {\n      console.warn(\n        `[QueueManager] Paid delivery ${currentTask.starsBundleId} exceeded the normal timeout; keeping its queue row processing until the active Telegram send exits.`,\n      );\n      return;\n    }\n    timedOut = true;",
)

replace_once(
    "src/services/queue-manager.ts",
    "    if (!timedOut) {\n      await sendStoriesFx(payload);\n      await markDoneFx(job.id);\n      console.log(`[QueueManager] Finished processing for ${currentTask.link} (Job ID: ${job.id})`);\n    }",
    "    if (!timedOut) {\n      deliveryStarted = true;\n      try {\n        await sendStoriesFx(payload);\n      } finally {\n        deliveryStarted = false;\n      }\n      if (!timedOut) {\n        await markDoneFx(job.id);\n        console.log(`[QueueManager] Finished processing for ${currentTask.link} (Job ID: ${job.id})`);\n      }\n    }",
)

replace_once(
    "__tests__/stars-final-safety.test.ts",
    "  test('paid monitoring uses the existing stoppable scheduler', () => {",
    "  test('paid delivery timeouts remain non-retryable while Telegram send is active', () => {\n    const queue = source('src/services/queue-manager.ts');\n    expect(queue).toContain('let deliveryStarted = false');\n    expect(queue).toContain('currentTask.starsBundleId && deliveryStarted');\n    expect(queue).toContain('keeping its queue row processing until the active Telegram send exits');\n    expect(queue).toContain('deliveryStarted = true');\n  });\n\n  test('paid monitoring uses the existing stoppable scheduler', () => {",
)

print('Applied paid timeout safety fix')
