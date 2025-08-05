/**
 * Utilities for consolidating an array of transcript snippets into
 * a single timeline-style summary. This helps the bot avoid sending
 * many small fragments and instead return one coherent overview.
 */
export interface TranscriptSnippet {
  /**
   * ISO date (YYYY-MM-DD) or any string that sorts chronologically.
   */
  date: string;
  /**
    * Raw text content of the snippet.
    */
  text: string;
}

/**
 * Build a consolidated summary sorted by date. Each line is formatted as:
 *
 * "- YYYY-MM-DD — text"
 */
export function consolidateTranscripts(
  snippets: TranscriptSnippet[],
): string {
  return snippets
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((s) => `- ${s.date} — ${s.text.trim()}`)
    .join('\n');
}
