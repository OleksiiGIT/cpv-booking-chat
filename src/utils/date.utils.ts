import { DateTime } from 'luxon';
import { BOOKINGS_CONFIG } from '../config/bookings.config';

/**
 * Returns true if the given date is further ahead than the Microsoft Bookings
 * maximum advance booking window (configured in BOOKINGS_CONFIG.maxAdvanceDays).
 */
export function isDateBeyondWindow(date: DateTime): boolean {
    return date.diff(DateTime.now(), 'days').days > BOOKINGS_CONFIG.maxAdvanceDays;
}
