/**
 * Time helpers. The engine works in integer minutes since the Unix epoch so a
 * schedule is just numbers; time zones only matter when we speak or parse.
 */

export const GRID = 5; // scheduling resolution in minutes

export const toMin = (ms: number | Date): number =>
  Math.floor((ms instanceof Date ? ms.getTime() : ms) / 60_000);
export const fromMin = (min: number): Date => new Date(min * 60_000);

export const ceilGrid = (m: number): number => Math.ceil(m / GRID) * GRID;
export const floorGrid = (m: number): number => Math.floor(m / GRID) * GRID;

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0 = Sunday
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'long',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export function zonedParts(min: number, tz: string): Parts {
  const out: Record<string, string> = {};
  for (const p of partsFormatter(tz).formatToParts(fromMin(min))) out[p.type] = p.value;
  return {
    year: +out.year,
    month: +out.month,
    day: +out.day,
    hour: +out.hour % 24,
    minute: +out.minute,
    weekday: WEEKDAYS.indexOf(out.weekday.toLowerCase()),
  };
}

/** Wall-clock time in `tz` -> absolute minutes. */
export function zonedToMin(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi) / 60_000;
  let min = guess;
  // Two passes handle DST edges well enough for a dinner planner.
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(min, tz);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) / 60_000;
    min -= asUtc - guess;
  }
  return Math.round(min);
}

export function fmtClock(min: number, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' })
    .format(fromMin(min))
    .replace(/ /g, ' ');
}

/** "6 PM" when the minutes are zero: what a person would actually say. */
export function sayClock(min: number, tz: string): string {
  const p = zonedParts(min, tz);
  const h12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  const suffix = p.hour >= 12 ? 'PM' : 'AM';
  return p.minute === 0 ? `${h12} ${suffix}` : `${h12}:${String(p.minute).padStart(2, '0')} ${suffix}`;
}

export function fmtWeekday(min: number, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(fromMin(min));
}

export function fmtDate(min: number, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' }).format(
    fromMin(min),
  );
}

/** Whole calendar days between two instants, as seen in `tz`. */
export function dayDiff(fromM: number, toM: number, tz: string): number {
  const a = zonedParts(fromM, tz);
  const b = zonedParts(toM, tz);
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000);
}

export function sayDuration(mins: number): string {
  const m = Math.round(Math.abs(mins));
  if (m < 1) return 'less than a minute';
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  const hs = `${h} hour${h === 1 ? '' : 's'}`;
  return r === 0 ? hs : `${hs} ${r} minute${r === 1 ? '' : 's'}`;
}

export function humanList(items: string[], conj = 'and'): string {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} ${conj} ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, ${conj} ${items[items.length - 1]}`;
}

export interface ParseWhenOptions {
  nowMin: number;
  tz: string;
  /** The answer must fall after this instant (defaults to now). */
  after?: number;
  /** When "6" could be AM or PM, prefer this one. */
  prefer?: 'am' | 'pm';
}

const DAY_WORDS: Record<string, number> = Object.fromEntries(WEEKDAYS.map((d, i) => [d, i]));

/** The fourth Thursday of November in `year` as [month, day]. */
function thanksgiving(year: number): [number, number] {
  const first = new Date(Date.UTC(year, 10, 1)).getUTCDay();
  const firstThu = 1 + ((4 - first + 7) % 7);
  return [11, firstThu + 21];
}

/**
 * Lenient parser for the times people (and language models) actually produce:
 * "6pm", "6:30 PM", "18:00", "noon", "tomorrow at 5", "Thursday 4:30pm",
 * "thanksgiving at 5", or a full ISO timestamp. Returns absolute minutes or null.
 */
export function parseWhen(input: string, opts: ParseWhenOptions): number | null {
  const text = input.trim().toLowerCase();
  if (!text) return null;
  const { nowMin, tz } = opts;
  const after = opts.after ?? nowMin;

  // Full ISO timestamp.
  if (/^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}/.test(text)) {
    if (/(z|[+-]\d{2}:?\d{2})$/.test(text)) {
      const ms = Date.parse(input.trim());
      return Number.isNaN(ms) ? null : toMin(ms);
    }
    const m = /^(\d{4})-(\d{2})-(\d{2})t(\d{2}):(\d{2})/.exec(text)!;
    return zonedToMin(+m[1], +m[2], +m[3], +m[4], +m[5], tz);
  }
  // Date only "2026-11-26 6pm"
  let explicitDate: { y: number; mo: number; d: number } | null = null;
  const dm = /(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (dm) explicitDate = { y: +dm[1], mo: +dm[2], d: +dm[3] };

  // Time of day.
  let hour: number | null = null;
  let minute = 0;
  let meridiem: 'am' | 'pm' | null = null;
  if (/\bnoon\b/.test(text)) {
    hour = 12;
    meridiem = 'pm';
  } else if (/\bmidnight\b/.test(text)) {
    hour = 12;
    meridiem = 'am';
  } else {
    const stripped = text.replace(/\d{4}-\d{2}-\d{2}/, ' ');
    const tm = /(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?![\d])/.exec(stripped);
    if (tm) {
      hour = +tm[1];
      minute = tm[2] ? +tm[2] : 0;
      if (tm[3]) meridiem = tm[3].startsWith('a') ? 'am' : 'pm';
    }
  }
  if (hour === null || minute > 59 || hour > 24) return null;

  const cands: number[] = [];
  if (meridiem) cands.push((hour % 12) + (meridiem === 'pm' ? 12 : 0));
  else if (hour > 12 || hour === 0) cands.push(hour % 24);
  else if (hour === 12) cands.push(12);
  else {
    const am = hour;
    const pm = hour + 12;
    cands.push(...(opts.prefer === 'am' ? [am, pm] : [pm, am]));
  }

  // Which day?
  const nowParts = zonedParts(nowMin, tz);
  let dayOffset: number | null = null;
  let dateOverride = explicitDate;
  if (/\btomorrow\b/.test(text)) dayOffset = 1;
  else if (/\b(today|tonight|this evening|this afternoon|this morning)\b/.test(text)) dayOffset = 0;
  else if (/\bthanksgiving\b/.test(text)) {
    let year = nowParts.year;
    let [mo, d] = thanksgiving(year);
    if (zonedToMin(year, mo, d, 23, 59, tz) < nowMin) [mo, d] = thanksgiving(++year);
    dateOverride = { y: year, mo, d };
  } else if (/\b(christmas eve|christmas|new year'?s eve|new year'?s day|valentine'?s day|halloween)\b/.test(text)) {
    const named =
      /christmas eve/.test(text)
        ? [12, 24]
        : /christmas/.test(text)
          ? [12, 25]
          : /new year'?s eve/.test(text)
            ? [12, 31]
            : /new year'?s day/.test(text)
              ? [1, 1]
              : /valentine/.test(text)
                ? [2, 14]
                : [10, 31];
    let year = nowParts.year;
    if (zonedToMin(year, named[0], named[1], 23, 59, tz) < nowMin) year += 1;
    dateOverride = { y: year, mo: named[0], d: named[1] };
  } else {
    for (const [name, idx] of Object.entries(DAY_WORDS)) {
      if (new RegExp(`\\b${name}\\b`).test(text)) {
        dayOffset = (idx - nowParts.weekday + 7) % 7;
        break;
      }
    }
  }

  const build = (h: number, extraDays: number): number => {
    if (dateOverride) return zonedToMin(dateOverride.y, dateOverride.mo, dateOverride.d, h, minute, tz);
    const base = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day + (dayOffset ?? 0) + extraDays));
    return zonedToMin(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), h, minute, tz);
  };

  for (let extra = 0; extra < 8; extra++) {
    for (const h of cands) {
      const m = build(h, extra);
      if (m > after) return m;
    }
    if (dayOffset !== null || dateOverride) {
      // An explicit day that is already past: an explicit date never rolls forward.
      if (dateOverride) return build(cands[0], 0);
      if (extra >= 1) break;
    }
  }
  return null;
}
