import 'dotenv/config';
import { DateTime } from 'luxon';
import { getOrCreateProfile, profileToCustomer } from './profile';
import {
    isDateBeyondWindow,
    promptDate,
    promptSlot,
    promptWatchlistOrExit,
    promptWatchlistTime,
} from './prompts';
import { addToWatchlist, processPendingWatchlist } from './watchlist';
import { createAppointment, getAvailableSlots } from '../../services/booking.service';

async function main() {
    // 1. Load or collect user profile
    const profile = getOrCreateProfile();

    // 2. Check watchlist on every run — auto-book any slots now within the 2-week window
    const watchlistCustomer = profileToCustomer(profile);
    await processPendingWatchlist(watchlistCustomer);

    // 3. Ask for a date
    const date = promptDate();
    if (!date) process.exit(1);

    // 4. If date is beyond the booking window, offer watchlist instead
    if (isDateBeyondWindow(date)) {
        const action = promptWatchlistOrExit(date);
        if (action === 'watchlist') {
            const time = promptWatchlistTime();
            addToWatchlist(date.toFormat('yyyy-MM-dd'), time);
        }
        process.exit(0);
    }

    // 5. Fetch available slots
    console.log(`\nFetching slots for ${date.toFormat('dd MMM yyyy')}...\n`);
    const slots = await getAvailableSlots(date);

    if (slots.length === 0) {
        console.log('No available slots for this date.');
        process.exit(0);
    }

    console.log(`Found ${slots.length} available slot(s) for ${date.toFormat('dd MMM yyyy')}:`);

    // 6. Let user pick a slot
    const selectedSlot = promptSlot(slots);
    if (!selectedSlot) process.exit(1);

    // 7. Fetch user profile
    const customer = profileToCustomer(profile);

    // 8. Book the appointment
    console.log('\nBooking appointment...');
    const { appointment, staffIndex } = await createAppointment(selectedSlot, customer);

    const bookedStart = DateTime.fromISO(appointment.startTime.dateTime).toFormat(
        'dd MMM yyyy, HH:mm',
    );
    const bookedEnd = DateTime.fromISO(appointment.endTime.dateTime).toFormat('HH:mm');

    console.log('\n✅ Booking confirmed!');
    console.log(`   ID:    ${appointment.id}`);
    console.log(`   Time:  ${bookedStart} – ${bookedEnd}`);
    console.log(`   ${appointment.serviceName}: ${staffIndex}`);

    process.exit(0);
}

main().catch((error) => {
    console.error('\n❌ Unhandled error:', error);
    process.exit(1);
});
