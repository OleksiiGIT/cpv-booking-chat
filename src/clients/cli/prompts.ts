import promptSync from 'prompt-sync';
import { DateTime } from 'luxon';
import { UserProfile } from '../../types';
import { BOOKINGS_CONFIG } from '../../config/bookings.config';

const prompt = promptSync();

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
