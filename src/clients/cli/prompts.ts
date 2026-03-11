import promptSync from 'prompt-sync';
import { DateTime } from 'luxon';
import { InstantBookingResult, UserProfile } from '../../types';
import { BOOKINGS_CONFIG } from '../../config/bookings.config';
import { parseInstantBookingInput } from '../../utils/date.utils';

const prompt = promptSync();

export function promptMainMenu(): 'book' | 'instantbook' {
    console.log('\n📅 How would you like to book?');
    console.log('   (1) Step-by-step');
    console.log('   (2) Instant book  (e.g. 01/04/2026 14:00, 15:00)');
    const input = prompt('Select (1 or 2): ').trim();
    return input === '2' ? 'instantbook' : 'book';
}

/**
 * Prompts for a free-text instant-booking string and retries until the input is
 * valid or the user submits an empty line (returns null → caller should exit).
 */
export function promptInstantBook(): { date: string; times: string[] } | null {
    for (;;) {
        const raw = prompt('Enter date and times (e.g. 01/04/2026 14:00, 15:00): ');
        if (raw === null || raw.trim() === '') return null;
        try {
            return parseInstantBookingInput(raw.trim());
        } catch (err) {
            console.error(`\n⚠️  ${(err as Error).message}\n`);
        }
    }
}

/** Prints a per-slot summary table for instant-booking results. */
export function printInstantBookSummary(date: string, results: InstantBookingResult[]): void {
    const dateLabel = DateTime.fromISO(date).toFormat('dd MMM yyyy');
    console.log(`\n📋 Booking results for ${dateLabel}:\n`);
    for (const r of results) {
        if (r.status === 'booked') {
            console.log(`  ✅  ${r.time}  →  booked        ID: ${r.appointmentId}`);
        } else if (r.status === 'unavailable') {
            console.log(`  ⚠️   ${r.time}  →  unavailable`);
        } else {
            console.log(`  ❌  ${r.time}  →  failed        ${r.error ?? ''}`);
        }
    }
    console.log('');
}

export function promptOnboarding(): UserProfile {
    console.log('\n👋 Welcome! Please set up your profile first.\n');
    const name = prompt('Full name: ').trim();
    const emailAddress = prompt('Email address: ').trim();
    const phone = prompt('Phone number: ').trim();
    const membershipNumber = prompt('Membership number: ').trim();
    const street = prompt('Address (street): ').trim();
    return {
        name,
        emailAddress,
        phone,
        membershipNumber,
        timeZone: BOOKINGS_CONFIG.timeZone,
        location: {
            displayName: street,
            address: { street, type: 'Other' },
        },
    };
}

export function promptDate(): DateTime | null {
    const input = prompt('Enter date (YYYY-MM-DD): ').trim();
    const date = DateTime.fromFormat(input, 'yyyy-MM-dd');
    if (!date.isValid) {
        console.error(`Invalid date: ${date.invalidExplanation}`);
        return null;
    }
    return date;
}

export function promptSlot(slots: DateTime[]): DateTime | null {
    console.log('');
    slots.forEach((slot, index) => {
        console.log(`  (${index + 1}) ${slot.toFormat('HH:mm')}`);
    });
    console.log('');

    const input = prompt(`Select slot (1-${slots.length}): `).trim();
    const index = Number(input) - 1;

    if (isNaN(index) || index < 0 || index >= slots.length) {
        console.error('Invalid selection.');
        return null;
    }

    return slots[index];
}

export function promptWatchlistTime(): string {
    return prompt('Enter preferred time (HH:mm): ').trim();
}

export function promptWatchlistOrExit(date: DateTime): 'watchlist' | 'exit' {
    console.log(
        `\n⚠️  ${date.toFormat('dd MMM yyyy')} is more than ${BOOKINGS_CONFIG.maxAdvanceDays} days away.`,
    );
    console.log('   Microsoft Bookings only allows bookings within 2 weeks.\n');
    const choice = prompt('   Add to watchlist to auto-book when available? (y/n): ')
        .trim()
        .toLowerCase();
    return choice === 'y' ? 'watchlist' : 'exit';
}
