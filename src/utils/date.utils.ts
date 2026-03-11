import { DateTime } from 'luxon';
import { BOOKINGS_CONFIG } from '../config/bookings.config';

const DATE_FORMAT = 'dd/MM/yyyy';
const TIME_REGEX = /^\d{2}:\d{2}$/;

/**
 * Returns true if the given date is further ahead than the Microsoft Bookings
 * maximum advance booking window (configured in BOOKINGS_CONFIG.maxAdvanceDays).
 */
export function isDateBeyondWindow(date: DateTime): boolean {
    return date.diff(DateTime.now(), 'days').days > BOOKINGS_CONFIG.maxAdvanceDays;
}

/**
 * Parses a free-text instant booking string of the form:
 *   "DD/MM/YYYY HH:mm[, HH:mm …]"
 *
 * Returns a normalised `{ date, times }` object where:
 *   - `date`  is an ISO calendar string  "YYYY-MM-DD"
 *   - `times` is an array of "HH:mm" strings (preserves order, rejects duplicates)
 *
 * Throws a descriptive `Error` for any invalid input so callers can forward
 * the message directly to the user.
 *
 * @example
 *   parseInstantBookingInput("01/04/2026 14:00, 15:00")
 *   // → { date: "2026-04-01", times: ["14:00", "15:00"] }
 */
export function parseInstantBookingInput(raw: string): { date: string; times: string[] } {
    const trimmed = raw.trim();

    const spaceIdx = trimmed.indexOf(' ');
    if (spaceIdx === -1) {
        throw new Error(
            'Invalid format. Expected: DD/MM/YYYY HH:mm[, HH:mm …]\n' +
                'Example: 01/04/2026 14:00, 15:00',
        );
    }

    const datePart = trimmed.slice(0, spaceIdx).trim();
    const timesPart = trimmed.slice(spaceIdx + 1).trim();

    // ── Validate & parse date ─────────────────────────────────────────────────

    if (!/^\d{2}\/\d{2}\/\d{4}$/.test(datePart)) {
        throw new Error(
            `Invalid date format "${datePart}". Expected DD/MM/YYYY (e.g. 01/04/2026).`,
        );
    }

    const parsed = DateTime.fromFormat(datePart, DATE_FORMAT);
    if (!parsed.isValid) {
        throw new Error(
            `Invalid date "${datePart}": ${parsed.invalidExplanation}. ` +
                'Please provide a real calendar date in DD/MM/YYYY format.',
        );
    }

    if (parsed.startOf('day') < DateTime.now().startOf('day')) {
        throw new Error(
            `Date "${datePart}" is in the past. Please provide today's date or a future date.`,
        );
    }

    // ── Validate & parse times ────────────────────────────────────────────────

    const rawTimes = timesPart
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);

    if (rawTimes.length === 0) {
        throw new Error(
            'At least one time must be provided.\n' +
                'Expected format: DD/MM/YYYY HH:mm[, HH:mm …]',
        );
    }

    const seen = new Set<string>();

    for (const t of rawTimes) {
        if (!TIME_REGEX.test(t)) {
            throw new Error(`Invalid time "${t}". Expected HH:mm in 24-hour format (e.g. 14:00).`);
        }

        const [h, m] = t.split(':').map(Number);
        if (h > 23 || m > 59) {
            throw new Error(`Invalid time "${t}". Hours must be 00–23 and minutes 00–59.`);
        }

        if (seen.has(t)) {
            throw new Error(`Duplicate time "${t}". Each requested time must be unique.`);
        }

        seen.add(t);
    }

    return {
        date: parsed.toFormat('yyyy-MM-dd'),
        times: [...seen],
    };
}
