import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DateTime } from 'luxon';
import { AppointmentCustomer, WatchlistEntry } from '../../types';
import { BOOKINGS_CONFIG } from '../../config/bookings.config';
import { getAvailableSlots, createAppointment } from '../../services/booking.service';

const WATCHLIST_DIR = path.join(os.homedir(), '.cpv-booking');
const WATCHLIST_PATH = path.join(WATCHLIST_DIR, 'watchlist.json');

export function loadWatchlist(): WatchlistEntry[] {
    if (!fs.existsSync(WATCHLIST_PATH)) return [];
    return JSON.parse(fs.readFileSync(WATCHLIST_PATH, 'utf-8')) as WatchlistEntry[];
}

export function saveWatchlist(entries: WatchlistEntry[]): void {
    fs.mkdirSync(WATCHLIST_DIR, { recursive: true });
    fs.writeFileSync(WATCHLIST_PATH, JSON.stringify(entries, null, 2), 'utf-8');
}

export function addToWatchlist(wantedDate: string, wantedTime: string): void {
    const entries = loadWatchlist();
    const alreadyPending = entries.some(
        (e) => e.wantedDate === wantedDate && e.wantedTime === wantedTime && e.status === 'pending',
    );

    if (alreadyPending) {
        console.log(`⚠️  Already on watchlist: ${wantedDate} at ${wantedTime}`);
        return;
    }

    entries.push({
        wantedDate,
        wantedTime,
        addedAt: DateTime.now().toISO()!,
        status: 'pending',
    });

    saveWatchlist(entries);
    console.log(`\n✅ Added to watchlist: ${wantedDate} at ${wantedTime}`);
    console.log('   You will be notified when the slot is auto-booked on next run.\n');
}

/**
 * Checks all pending watchlist entries and attempts to auto-book any
 * that have entered the 2-week booking window.
 */
export async function processPendingWatchlist(customer: AppointmentCustomer): Promise<void> {
    const entries = loadWatchlist();
    const pending = entries.filter((e) => e.status === 'pending');

    if (pending.length === 0) return;

    console.log(`\n🔍 Checking ${pending.length} watchlist entry(ies)...\n`);

    let changed = false;

    for (const entry of pending) {
        const wantedDate = DateTime.fromFormat(entry.wantedDate, 'yyyy-MM-dd');
        const daysUntil = wantedDate.diff(DateTime.now(), 'days').days;

        if (daysUntil > BOOKINGS_CONFIG.maxAdvanceDays) {
            console.log(
                `  ⏳ ${entry.wantedDate} ${entry.wantedTime} — not yet bookable (${Math.floor(daysUntil)} day(s) away)`,
            );
            continue;
        }

        console.log(
            `  📅 ${entry.wantedDate} ${entry.wantedTime} — within booking window, checking availability...`,
        );

        try {
            const slots = await getAvailableSlots(wantedDate);
            const match = slots.find((s) => s.toFormat('HH:mm') === entry.wantedTime);

            if (!match) {
                console.log(
                    `  ❌ Slot ${entry.wantedTime} on ${entry.wantedDate} is not available`,
                );
                continue;
            }

            const appointment = await createAppointment(match, customer);
            entry.status = 'booked';
            changed = true;

            const bookedStart = DateTime.fromISO(appointment.startTime.dateTime).toFormat(
                'dd MMM yyyy, HH:mm',
            );
            const bookedEnd = DateTime.fromISO(appointment.endTime.dateTime).toFormat('HH:mm');
            console.log(`  ✅ Auto-booked from watchlist!`);
            console.log(`     ID:   ${appointment.id}`);
            console.log(`     Time: ${bookedStart} – ${bookedEnd}\n`);
        } catch (err) {
            console.error(
                `  ⚠️  Failed to auto-book ${entry.wantedDate} ${entry.wantedTime}:`,
                err,
            );
        }
    }

    if (changed) saveWatchlist(entries);
}
