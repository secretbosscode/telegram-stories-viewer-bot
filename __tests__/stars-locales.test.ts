import starsTranslations from '../src/locales/stars';

const supportedLocales = [
  'en',
  'es',
  'zh',
  'ru',
  'ko',
  'fr',
  'de',
  'pt',
  'ar',
  'nl',
  'it',
  'ms',
  'uk',
];

describe('Telegram Stars translations', () => {
  const englishKeys = Object.keys(starsTranslations.en).sort();

  test.each(supportedLocales)('%s contains every Stars key', (locale) => {
    expect(Object.keys(starsTranslations[locale]).sort()).toEqual(englishKeys);
  });

  test.each(supportedLocales)('%s has no empty Stars messages', (locale) => {
    for (const [key, value] of Object.entries(starsTranslations[locale])) {
      expect(key).toBeTruthy();
      expect(value.trim()).not.toBe('');
    }
  });

  test('customer payment lifecycle copy is present', () => {
    expect(englishKeys).toEqual(expect.arrayContaining([
      'stars.resultsFound',
      'stars.invoiceTitle',
      'stars.paymentReceived',
      'stars.deliveryRetry',
      'stars.refundedUnavailable',
      'stars.supportPending',
      'stars.termsText',
    ]));
  });
});
