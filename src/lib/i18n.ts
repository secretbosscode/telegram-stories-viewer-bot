import en from '../locales/en.json';
import es from '../locales/es.json';
import zh from '../locales/zh.json';
import ru from '../locales/ru.json';
import ko from '../locales/ko.json';
import fr from '../locales/fr.json';
import de from '../locales/de.json';
import pt from '../locales/pt.json';
import ar from '../locales/ar.json';
import nl from '../locales/nl.json';
import it from '../locales/it.json';
import ms from '../locales/ms.json';
import uk from '../locales/uk.json';

const locales: Record<string, Record<string, string>> = {
  en,
  es,
  zh,
  ru,
  ko,
  fr,
  de,
  pt,
  ar,
  nl,
  it,
  ms,
  uk,
};

export function t(locale: string | undefined, key: string, vars: Record<string, string | number> = {}): string {
  const lang = locale && locales[locale] ? locale : 'en';
  const fallback = locales['en'][key] || key;
  let text = locales[lang][key] || fallback;
  for (const [k, v] of Object.entries(vars)) {
    text = text.replace(new RegExp(`{{${k}}}`, 'g'), String(v));
  }
  return text;
}
