/**
 * @sriinnu/tokmeter-core — Local calendar helpers.
 *
 * Keeps the definition of "today" consistent across history freezing,
 * daily aggregation, and statusline/dashboard refresh logic.
 */
/** Start of the local day for the provided timestamp (or now). */
export function startOfLocalDay(timestamp = Date.now()) {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}
/** End of the local day for the provided timestamp (or now). */
export function endOfLocalDay(timestamp = Date.now()) {
  const date = new Date(timestamp);
  date.setHours(23, 59, 59, 999);
  return date.getTime();
}
/** Format a timestamp as a local YYYY-MM-DD date key. */
export function localDateKey(timestamp = Date.now()) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
/** Local YYYY-MM-DD key for yesterday relative to the reference timestamp. */
export function yesterdayDateKey(referenceTimestamp = Date.now()) {
  return localDateKey(startOfLocalDay(referenceTimestamp) - 1);
}
/** True when both timestamps land on the same local calendar day. */
export function isSameLocalDay(left, right) {
  return localDateKey(left) === localDateKey(right);
}
/** True when the timestamp is before the current local day. */
export function isBeforeToday(timestamp, referenceTimestamp = Date.now()) {
  return timestamp < startOfLocalDay(referenceTimestamp);
}
