import starsMonitoringTranslations from '../src/locales/stars-monitoring';

const supportedLocales = [
  'en', 'es', 'zh', 'ru', 'ko', 'fr', 'de', 'pt', 'ar', 'nl', 'it', 'ms', 'uk',
];

describe('Stars monitoring translations', () => {
  const englishKeys = Object.keys(starsMonitoringTranslations.en).sort();

  test.each(supportedLocales)('%s contains every monitoring key', (locale) => {
    expect(Object.keys(starsMonitoringTranslations[locale]).sort()).toEqual(englishKeys);
  });

  test.each(supportedLocales)('%s contains no empty monitoring copy', (locale) => {
    for (const value of Object.values(starsMonitoringTranslations[locale])) {
      expect(value.trim()).not.toBe('');
    }
  });

  test('launch copy explains the two monitoring plans and commands', () => {
    const text = starsMonitoringTranslations.en['stars.helpText'];
    expect(text).toContain('/monitor @username');
    expect(text).toContain('/unmonitor @username');
    expect(text).toContain('1 week');
    expect(text).toContain('1 month');
    expect(text).not.toContain('/verify');
    expect(text).not.toContain('/upgrade');
    expect(text).not.toContain('/invite');
  });
});
