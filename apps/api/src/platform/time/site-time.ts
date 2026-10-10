/**
 * "Hôm nay" theo múi giờ của site (BR-34): trả về thời điểm UTC của 00:00 giờ địa phương.
 */
export function startOfTodayInTz(timeZone: string, now = new Date()): Date {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const localAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  const offsetMs = localAsUtc - now.getTime();
  const localMidnightAsUtc = Date.UTC(get('year'), get('month') - 1, get('day'));
  return new Date(localMidnightAsUtc - offsetMs);
}
