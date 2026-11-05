/** Format a number with locale thousands separators, e.g. 20000 -> "20,000". */
export function formatNumber(n) {
  return Number(n ?? 0).toLocaleString(game.i18n.lang);
}
