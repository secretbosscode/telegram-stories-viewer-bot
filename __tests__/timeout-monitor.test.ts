import { jest } from '@jest/globals';
import { recordTimeoutError, MAX_TIMEOUT_ERRORS } from '../src/config/timeout-monitor';

// Ensure we exit once timeout errors exceed the threshold within the time window
// by mocking process.exit and using fake timers.
test('triggers process exit after repeated timeout errors', () => {
  jest.useFakeTimers();
  jest.setSystemTime(0);
  const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as any);

  for (let i = 0; i < MAX_TIMEOUT_ERRORS; i++) {
    recordTimeoutError('TIMEOUT');
    // Advance slightly so each record has a unique timestamp but remains within the window
    jest.advanceTimersByTime(1);
  }

  expect(exitSpy).toHaveBeenCalledWith(1);
  exitSpy.mockRestore();
  jest.useRealTimers();
});
