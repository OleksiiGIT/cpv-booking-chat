import 'dotenv/config';
import { DateTime } from 'luxon';
import {
    printInstantBookSummary,
    promptDate,
    promptInstantBook,
    promptMainMenu,
    promptOnboarding,
    promptSlot,
    promptWatchlistOrExit,
    promptWatchlistTime,
} from './prompts';
import { isDateBeyondWindow } from '../../utils/date.utils';
import { profileToCustomer } from '../../services/profile.service';
import { getProfile, saveProfile } from '../../services/user.service';
import { addToWatchlist, processPendingWatchlist } from '../../services/watchlist.service';
import { createAppointment, getAvailableSlots, instantBook } from '../../services/booking.service';

const USER_ID = 'default';

async function main() {
    // 1. Load or collect user profile
    let profile = await getProfile(USER_ID);
    if (!profile) {
        profile = promptOnboarding();
        await saveProfile(USER_ID, profile);
        console.log('\n✅ Profile saved!\n');
    }

    // 2. Check watchlist on every run — auto-book any slots now within the 2-week window
    await processPendingWatchlist(USER_ID, profileToCustomer(profile));

    // 3. Main menu
    const menuChoice = promptMainMenu();

    // ── Instant booking flow ──────────────────────────────────────────────────
    if (menuChoice === 'instantbook') {
        const parsed = promptInstantBook();
        if (!parsed) process.exit(0);

        const date = DateTime.fromISO(parsed.date);

        if (isDateBeyondWindow(date)) {
            const action = promptWatchlistOrExit(date);
            if (action === 'watchlist') {
                for (const time of parsed.times) {
                    await addToWatchlist(USER_ID, parsed.date, time);
                }
                console.log(
                    `\n📋 Added ${parsed.times.length} time(s) to watchlist for ${date.toFormat('dd MMM yyyy')}.`,
                );
            }
            process.exit(0);
        }

        console.log(`\nBooking ${parsed.times.length} slot(s) on ${date.toFormat('dd MMM yyyy')}…`);
        const results = await instantBook(parsed.date, parsed.times, profileToCustomer(profile));
        printInstantBookSummary(parsed.date, results);
        process.exit(0);
    }

    // ── Step-by-step booking flow ─────────────────────────────────────────────

    // 4. Ask for a date
    const date = promptDate();
    if (!date) process.exit(1);

    // 5. If date is beyond the booking window, offer watchlist instead
    if (isDateBeyondWindow(date)) {
        const action = promptWatchlistOrExit(date);
        if (action === 'watchlist') {
            await addToWatchlist(USER_ID, date.toFormat('yyyy-MM-dd'), promptWatchlistTime());
        }
        process.exit(0);
    }

    // 6. Fetch available slots
    console.log(`\nFetching slots for ${date.toFormat('dd MMM yyyy')}...\n`);
    const slots = await getAvailableSlots(date);

    if (slots.length === 0) {
        console.log('No available slots for this date.');
        process.exit(0);
    }

    console.log(`Found ${slots.length} available slot(s) for ${date.toFormat('dd MMM yyyy')}:`);

    // 7. Pick a slot
    const selectedSlot = promptSlot(slots);
    if (!selectedSlot) process.exit(1);

    // 8. Build customer payload
    const customer = profileToCustomer(profile);

    // 9. Book
    console.log('\nBooking appointment...');
    const { appointment, staffIndex } = await createAppointment(selectedSlot, customer);

    const bookedStart = DateTime.fromISO(appointment.startTime.dateTime).toFormat(
        'dd MMM yyyy, HH:mm',
    );
    const bookedEnd = DateTime.fromISO(appointment.endTime.dateTime).toFormat('HH:mm');

    console.log('\n✅ Booking confirmed!');
    console.log(`   ID:    ${appointment.id}`);
    console.log(`   Time:  ${bookedStart} – ${bookedEnd}`);
    console.log(`   Court: ${appointment.serviceName} (court ${staffIndex})`);

    process.exit(0);
}

main().catch((error) => {
    console.error('\n❌ Unhandled error:', error);
    process.exit(1);
});
