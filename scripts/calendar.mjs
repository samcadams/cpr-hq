/**
 * Thin wrapper over Simple Calendar. Every function degrades to null/no-op when it is not active.
 */

export const SC_ID = "foundryvtt-simple-calendar";

/** Hook fired by Simple Calendar whenever the date/time changes. */
export const SC_DATE_HOOK = "simple-calendar-date-time-change";

export function calendarActive() {
  return !!(game.modules.get(SC_ID)?.active && globalThis.SimpleCalendar?.api);
}

/** Current in-game date as Simple Calendar displays it, e.g. "March 14, 2045". */
export function currentDateLabel() {
  if ( !calendarActive() ) return null;
  try {
    return SimpleCalendar.api.currentDateTimeDisplay()?.date ?? null;
  } catch ( err ) {
    console.warn("cpr-hq | Simple Calendar date lookup failed", err);
    return null;
  }
}

/** Current in-game month and year, e.g. "March 2045". */
export function currentMonthLabel() {
  if ( !calendarActive() ) return null;
  try {
    const d = SimpleCalendar.api.timestampToDate(SimpleCalendar.api.timestamp());
    return `${d.display.monthName} ${d.display.year}`;
  } catch ( err ) {
    return null;
  }
}

/** Current Simple Calendar timestamp (seconds), or null. */
export function currentTimestamp() {
  if ( !calendarActive() ) return null;
  try {
    return SimpleCalendar.api.timestamp();
  } catch ( err ) {
    return null;
  }
}

/** Date label for a Simple Calendar timestamp, e.g. "March 14, 2045". */
export function dateLabelAt(timestamp) {
  if ( !calendarActive() || !Number.isFinite(timestamp) ) return null;
  try {
    return SimpleCalendar.api.timestampToDate(timestamp)?.display?.date ?? null;
  } catch ( err ) {
    return null;
  }
}
