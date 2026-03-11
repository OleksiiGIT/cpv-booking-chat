/**
 * WhatsApp conversation flow — mirrors src/clients/telegram/handlers.ts but
 * adapted for the WhatsApp Cloud API message format.
 *
 * Key differences from Telegram:
 *  - No slash commands: keywords (hi, cancel, profile, …) trigger flows.
 *  - No "inline keyboard edit": each interaction sends a fresh message.
 *  - Booking date/time uses a 3-step picker (week → day → time period → slot)
 *    because WhatsApp list messages are hard-capped at 10 rows total.
 *  - UserId format: "WhatsApp#<phoneNumber>"
 */
import { DateTime } from 'luxon';
import { clearSession, getSession, setSession } from '../../services/session.service';
import { deleteProfile, getProfile, saveProfile } from '../../services/user.service';
import { addToWatchlist, clearWatchlist } from '../../services/watchlist.service';
import { createAppointment, getAvailableSlots, instantBook } from '../../services/booking.service';
import {
    clearBookingRecords,
    getUserBookingRecords,
    saveBookingRecord,
} from '../../services/booking-record.service';
import { profileToCustomer } from '../../services/profile.service';
import { ConversationSession, InstantBookingResult, UserProfile } from '../../types';
import { BOOKINGS_CONFIG } from '../../config/bookings.config';
import { isDateBeyondWindow, parseInstantBookingInput } from '../../utils/date.utils';
import { ButtonOption, ListRow, sendButtons, sendList, sendText } from './bot';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Message object extracted from the Meta Cloud API webhook payload. */
export type WhatsAppMessage = {
    id: string;
    from: string;
    timestamp: string;
    type: 'text' | 'interactive' | string;
    text?: { body: string };
    interactive?: {
        type: 'button_reply' | 'list_reply';
        button_reply?: { id: string; title: string };
        list_reply?: { id: string; title: string };
    };
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function uid(from: string): string {
    return `whatsapp#${from}`;
}

/** Clamp a string to `max` characters, appending "…" if truncated. */
function cap(str: string, max: number): string {
    return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

// ─── Time period definitions ──────────────────────────────────────────────────

const TIME_PERIODS = [
    { key: 'morning', label: 'Morning', range: '06:00–12:00', start: 6, end: 12 },
    { key: 'afternoon', label: 'Afternoon', range: '12:00–17:00', start: 12, end: 17 },
    { key: 'evening', label: 'Evening', range: '17:00–21:00', start: 17, end: 21 },
    { key: 'night', label: 'Night', range: '21:00–22:00', start: 21, end: 22 },
] as const;

type PeriodKey = (typeof TIME_PERIODS)[number]['key'];

// ─── Step 1 — Week picker ─────────────────────────────────────────────────────

/**
 * Sends a list of ISO week ranges (Mon–Sun) that fall within the 14-day
 * booking window.  The first row always starts from *today* (not the
 * preceding Monday).  Each week occupies one row, so we stay well under the
 * 10-row hard cap.  A "Enter date manually" row is appended for watchlist use.
 */
async function replyWithWeekPicker(to: string, userId: string): Promise<void> {
    await setSession(userId, { step: 'awaiting_week' });

    const today = DateTime.now().startOf('day');
    const windowEnd = today.plus({ days: BOOKINGS_CONFIG.maxAdvanceDays });

    const rows: ListRow[] = [];
    let cursor = today;

    while (cursor <= windowEnd) {
        // end of the ISO week containing `cursor` (always a Sunday)
        const endOfWeek = cursor.endOf('week').startOf('day');
        const weekEnd = endOfWeek <= windowEnd ? endOfWeek : windowEnd;

        // Row title: "11–15 Mar" (same month) or "28 Mar–3 Apr" (cross-month)
        const label =
            cursor.month === weekEnd.month
                ? `${cursor.toFormat('d')}–${weekEnd.toFormat('d MMM')}`
                : `${cursor.toFormat('d MMM')}–${weekEnd.toFormat('d MMM')}`;

        rows.push({
            id: `week:${cursor.toFormat('yyyy-MM-dd')}`,
            title: cap(label, 24),
            description: `${cursor.toFormat('EEE d')} – ${weekEnd.toFormat('EEE d MMM')}`,
        });

        cursor = endOfWeek.plus({ days: 1 }); // jump to next Monday
    }

    rows.push({ id: 'date:manual', title: '📅 Enter date manually' });

    await sendList(to, '📅 Select a week:', 'Choose week', [{ title: 'Available weeks', rows }]);
}

// ─── Step 2 — Day picker within a week ───────────────────────────────────────

/**
 * Given the ISO start date of a week, sends a list of individual dates within
 * that week (clamped to the booking window).  Max 7 rows — always fits.
 */
async function replyWithDayPicker(to: string, userId: string, weekStart: string): Promise<void> {
    const today = DateTime.now().startOf('day');
    const windowEnd = today.plus({ days: BOOKINGS_CONFIG.maxAdvanceDays });
    const start = DateTime.fromISO(weekStart);
    const endOfWeek = start.endOf('week').startOf('day'); // Sunday
    const lastDay = endOfWeek <= windowEnd ? endOfWeek : windowEnd;

    const rows: ListRow[] = [];
    let cursor = start;

    while (cursor <= lastDay) {
        const isToday = cursor.hasSame(today, 'day');
        const isTomorrow = cursor.hasSame(today.plus({ days: 1 }), 'day');
        const label = isToday
            ? `Today · ${cursor.toFormat('d MMM')}`
            : isTomorrow
              ? `Tomorrow · ${cursor.toFormat('d MMM')}`
              : cursor.toFormat('EEE, d MMM');

        rows.push({ id: `date:${cursor.toFormat('yyyy-MM-dd')}`, title: cap(label, 24) });
        cursor = cursor.plus({ days: 1 });
    }

    await setSession(userId, { step: 'awaiting_date' });
    await sendList(to, '📅 Select a date:', 'Choose date', [{ title: 'Select date', rows }]);
}

// ─── Step 3 — Time period picker ─────────────────────────────────────────────

/**
 * Once slots are fetched for a date, groups them into up to 4 named time
 * periods and lets the user pick a band.  Empty periods are hidden.
 */
async function replyWithPeriodPicker(
    to: string,
    allSlots: string[],
    dateLabel: string,
): Promise<void> {
    const rows: ListRow[] = TIME_PERIODS.map((p) => {
        const count = allSlots.filter((iso) => {
            const h = DateTime.fromISO(iso).hour;
            return h >= p.start && h < p.end;
        }).length;
        return count > 0
            ? ({
                  id: `period:${p.key}`,
                  title: cap(`${p.label} · ${p.range}`, 24),
                  description: `${count} slot${count !== 1 ? 's' : ''} available`,
              } as ListRow)
            : null;
    }).filter((r) => r !== null);

    if (rows.length === 0) {
        await sendText(to, 'No slots available. Please choose another date.');
        return;
    }

    await sendList(to, `📅 *${dateLabel}*\n\nSelect a time period:`, 'Choose period', [
        { title: 'Time periods', rows },
    ]);
}

// ─── Step 4 — Slot picker for a period ───────────────────────────────────────

/**
 * Filters `allSlots` to those belonging to `periodKey` and renders them as a
 * list.  Uses the global slot indices so `slot:N` IDs stay consistent with
 * the full `availableSlots` array stored in the session.
 */
async function replyWithSlotsForPeriod(
    from: string,
    allSlots: string[],
    periodKey: string,
    dateLabel: string,
): Promise<void> {
    const period = TIME_PERIODS.find((p) => p.key === periodKey);
    if (!period) {
        await sendText(from, '⚠️ Unknown time period. Please try again.');
        return;
    }

    const rows: ListRow[] = allSlots
        .map((iso, idx) => {
            const h = DateTime.fromISO(iso).hour;
            return h >= period.start && h < period.end
                ? { id: `slot:${idx}`, title: DateTime.fromISO(iso).toFormat('HH:mm') }
                : null;
        })
        .filter((r): r is ListRow => r !== null);

    if (rows.length === 0) {
        await sendText(from, 'No slots in this period. Please choose another period.');
        return;
    }

    await sendList(
        from,
        `📅 *${dateLabel}* · ${period.label} (${period.range})\n\nSelect a time:`,
        'Choose time',
        [{ title: 'Available times', rows }],
    );
}

// ─── Main dispatcher ──────────────────────────────────────────────────────────

/**
 * Entry point called by the Lambda handler for each incoming WhatsApp message.
 */
export async function handleIncomingMessage(message: WhatsAppMessage): Promise<void> {
    const { from } = message;
    const userId = uid(from);

    if (message.type === 'text' && message.text) {
        await handleText(from, userId, message.text.body.trim());
        return;
    }

    if (message.type === 'interactive' && message.interactive) {
        const actionId =
            message.interactive.type === 'button_reply'
                ? message.interactive.button_reply?.id
                : message.interactive.list_reply?.id;
        if (actionId) await handleAction(from, userId, actionId);
        return;
    }

    // Unsupported message type (image, audio, …) — gentle nudge
    await sendText(from, 'Please send text or use the menu. Type *hi* to start a booking.');
}

// ─── Text handler ─────────────────────────────────────────────────────────────

async function handleText(from: string, userId: string, text: string): Promise<void> {
    const lower = text.toLowerCase();

    // ── Keyword shortcuts (work regardless of session state) ─────────────────
    if (['hi', 'hello', 'start'].includes(lower)) {
        await clearSession(userId);
        await handleStart(from, userId);
        return;
    }
    if (lower === 'cancel') {
        await clearSession(userId);
        await sendText(from, '❌ Cancelled. Type *hi* to start a new booking.');
        return;
    }
    if (lower === 'profile') {
        await handleProfileCommand(from, userId);
        return;
    }
    if (lower === 'delete' || lower === 'gdpr') {
        await handleDeleteCommand(from, userId);
        return;
    }
    if (lower === 'bookings' || lower === 'my bookings') {
        await handleMyBookings(from, userId);
        return;
    }
    if (lower === 'help') {
        await handleHelp(from);
        return;
    }
    if (lower === 'instantbook' || lower === 'instant book') {
        await handleInstantBookCommand(from, userId);
        return;
    }

    const session = await getSession(userId);

    if (!session) {
        // Any unknown first message → start the flow
        await handleStart(from, userId);
        return;
    }

    switch (session.step) {
        // ── Onboarding ───────────────────────────────────────────────────────
        case 'onboarding_name':
            await setSession(userId, { step: 'onboarding_email', onboardingName: text });
            await sendText(from, "📧 What's your email address?");
            break;

        case 'onboarding_email':
            await setSession(userId, {
                ...session,
                step: 'onboarding_phone',
                onboardingEmail: text,
            });
            await sendText(from, "📱 What's your phone number?");
            break;

        case 'onboarding_phone':
            await setSession(userId, {
                ...session,
                step: 'onboarding_membership',
                onboardingPhone: text,
            });
            await sendText(from, "🏷 What's your membership number?");
            break;

        case 'onboarding_membership':
            await setSession(userId, {
                ...session,
                step: 'onboarding_address',
                onboardingMembership: text,
            });
            await sendText(from, "🏠 What's your street address?");
            break;

        case 'onboarding_address': {
            const profile: UserProfile = {
                name: session.onboardingName!,
                emailAddress: session.onboardingEmail!,
                phone: session.onboardingPhone!,
                membershipNumber: session.onboardingMembership!,
                timeZone: BOOKINGS_CONFIG.timeZone,
                location: {
                    displayName: text,
                    address: { street: text, type: 'Other' },
                },
            };
            await saveProfile(userId, profile);
            await sendText(from, "✅ Profile saved! Let's book your first session.");
            await replyWithWeekPicker(from, userId);
            break;
        }

        // ── Booking flow ─────────────────────────────────────────────────────
        case 'awaiting_date':
            await handleDateInput(from, userId, text);
            break;

        case 'awaiting_watchlist_time': {
            if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(text)) {
                await sendText(from, '⚠️ Invalid time. Please use HH:mm format (e.g. 10:00).');
                break;
            }
            await addToWatchlist(userId, session.selectedDate!, text);
            await clearSession(userId);
            await sendText(
                from,
                `✅ Added to watchlist!\n\n📅 ${session.selectedDate} at *${text}*\n\nI'll auto-book it as soon as it enters the 2-week booking window.`,
            );
            break;
        }

        // ── Instant booking ───────────────────────────────────────────────────
        case 'instant_book': {
            let parsed: { date: string; times: string[] };
            try {
                parsed = parseInstantBookingInput(text);
            } catch (err) {
                await sendText(
                    from,
                    `⚠️ ${(err as Error).message}\n\nPlease try again or type *cancel* to stop.`,
                );
                break; // stay in instant_book step
            }

            const date = DateTime.fromISO(parsed.date);

            // Date is outside the booking window — offer watchlist for all times
            if (isDateBeyondWindow(date)) {
                await setSession(userId, {
                    step: 'instant_book',
                    selectedDate: parsed.date,
                    instantBookTimes: parsed.times,
                });
                const buttons: [ButtonOption, ButtonOption] = [
                    { id: 'instantbook:watchlist:yes', title: '📋 Add all to watchlist' },
                    { id: 'instantbook:watchlist:no', title: '❌ Enter different date' },
                ];
                await sendButtons(
                    from,
                    `⚠️ ${date.toFormat('dd MMM yyyy')} is more than ${BOOKINGS_CONFIG.maxAdvanceDays} days away.\n\nAdd ${parsed.times.join(', ')} to your watchlist instead?`,
                    buttons,
                );
                break;
            }

            // Within window — book all requested slots
            const profile = await getProfile(userId);
            if (!profile) {
                await sendText(from, 'Profile not found. Type *hi* to set up your profile.');
                break;
            }

            await sendText(
                from,
                `⏳ Booking ${parsed.times.length} slot(s) on ${date.toFormat('dd MMM yyyy')}…`,
            );

            let results: InstantBookingResult[];
            try {
                results = await instantBook(parsed.date, parsed.times, profileToCustomer(profile));
            } catch (err) {
                console.error('[WhatsAppBot] instantBook error:', err);
                await sendText(from, '⚠️ Could not complete bookings. Please try again later.');
                break;
            }

            await clearSession(userId);
            await sendText(from, formatInstantBookSummary(parsed.date, results));

            // Persist booking records — a DynamoDB failure must never hide a successful booking
            for (const r of results.filter((r) => r.status === 'booked')) {
                const [, m] = r.time.split(':').map(Number);
                const startDt = DateTime.fromISO(`${parsed.date}T${r.time}:00`);
                const endDt = startDt.plus({
                    minutes: BOOKINGS_CONFIG.appointmentDurationMinutes,
                });
                const staffIdx = BOOKINGS_CONFIG.staffIndexByMinute[m] ?? 2;
                const courtLabel =
                    staffIdx === 1 ? 'Court 1' : staffIdx === 2 ? 'Court 2' : 'Court';
                try {
                    await saveBookingRecord(userId, {
                        appointmentId: r.appointmentId!,
                        startTime: startDt.toISO()!,
                        endTime: endDt.toISO()!,
                        court: courtLabel,
                        createdAt: DateTime.now().toISO()!,
                    });
                } catch (saveErr) {
                    console.error(
                        '[WhatsAppBot] saveBookingRecord failed for instant book:',
                        saveErr,
                    );
                }
            }
            break;
        }

        default:
            await sendText(from, 'Please use the menu options, or type *cancel* to start over.');
    }
}

// ─── Action handler ───────────────────────────────────────────────────────────

async function handleAction(from: string, userId: string, actionId: string): Promise<void> {
    // ── Step 1 → 2: week selected → show individual days ─────────────────────
    if (/^week:\d{4}-\d{2}-\d{2}$/.test(actionId)) {
        await replyWithDayPicker(from, userId, actionId.slice(5));
        return;
    }

    // ── Step 2 → 3: date selected → fetch slots → show time periods ──────────
    if (/^date:\d{4}-\d{2}-\d{2}$/.test(actionId)) {
        const date = DateTime.fromFormat(actionId.slice(5), 'yyyy-MM-dd');
        await handleDateInput(from, userId, date.toFormat('dd/MM/yyyy'));
        return;
    }

    // ── Step 3 → 4: period selected → show slots for that period ─────────────
    if (/^period:(morning|afternoon|evening|night)$/.test(actionId)) {
        const periodKey = actionId.slice(7) as PeriodKey;
        const session = await getSession(userId);
        if (!session?.availableSlots || !session?.selectedDate) {
            await sendText(from, '⚠️ Session expired. Type *hi* to start again.');
            return;
        }
        const dateLabel = DateTime.fromISO(session.selectedDate).toFormat('dd MMM yyyy');
        // Advance step so handleSlotSelected finds awaiting_slot
        await setSession(userId, { ...session, step: 'awaiting_slot' });
        await replyWithSlotsForPeriod(from, session.availableSlots, periodKey, dateLabel);
        return;
    }

    // ── Step 4: slot selected ─────────────────────────────────────────────────
    if (/^slot:\d+$/.test(actionId)) {
        await handleSlotSelected(from, userId, parseInt(actionId.slice(5), 10));
        return;
    }

    switch (actionId) {
        // ── Manual date entry (watchlist escape hatch) ────────────────────────
        case 'date:manual':
            await setSession(userId, { step: 'awaiting_date' });
            await sendText(from, '📅 Enter a date (DD/MM/YYYY, e.g. 15/03/2026):');
            break;

        // ── Booking confirmation ──────────────────────────────────────────────
        case 'confirm:yes': {
            const session = await getSession(userId);
            if (!session || session.step !== 'confirming' || !session.selectedSlot) {
                await sendText(from, '⚠️ Session expired. Type *hi* to start again.');
                return;
            }
            await handleConfirmYes(from, userId, session);
            break;
        }
        case 'confirm:no':
            await clearSession(userId);
            await sendText(from, '❌ Booking cancelled. Type *hi* to start over.');
            break;

        // ── Watchlist offer ───────────────────────────────────────────────────
        case 'watchlist:yes': {
            const session = await getSession(userId);
            if (!session?.selectedDate) {
                await sendText(from, '⚠️ Session expired. Type *hi* to start again.');
                return;
            }
            await setSession(userId, { ...session, step: 'awaiting_watchlist_time' });
            await sendText(from, '⏰ What time would you prefer? (HH:mm, e.g. 10:00)');
            break;
        }
        case 'watchlist:no':
            await replyWithWeekPicker(from, userId);
            break;

        // ── Retry after no slots ──────────────────────────────────────────────
        case 'retry:date':
            await replyWithWeekPicker(from, userId);
            break;

        // ── Profile ───────────────────────────────────────────────────────────
        case 'profile:update':
            await setSession(userId, { step: 'onboarding_name' });
            await sendText(from, "Let's update your profile.\n\nWhat's your full name?");
            break;

        // ── GDPR delete ───────────────────────────────────────────────────────
        case 'delete:confirm':
            await Promise.all([
                deleteProfile(userId),
                clearWatchlist(userId),
                clearBookingRecords(userId),
                clearSession(userId),
            ]);
            await sendText(from, '🗑 All your data has been deleted. Type *hi* to start again.');
            break;
        case 'delete:cancel':
            await sendText(from, '✅ Cancelled. Your data is safe.');
            break;

        // ── Instant booking — watchlist offer for out-of-window dates ─────────
        case 'instantbook:watchlist:yes': {
            const session = await getSession(userId);
            if (!session?.selectedDate || !session?.instantBookTimes?.length) {
                await sendText(from, '⚠️ Session expired. Type *instantbook* to begin again.');
                break;
            }
            for (const time of session.instantBookTimes) {
                await addToWatchlist(userId, session.selectedDate, time);
            }
            await clearSession(userId);
            await sendText(
                from,
                `✅ Added to watchlist!\n\n📅 *${session.selectedDate}* at *${session.instantBookTimes.join(', ')}*\n\nI'll auto-book as soon as they enter the 2-week booking window.`,
            );
            break;
        }
        case 'instantbook:watchlist:no':
            await setSession(userId, { step: 'instant_book' });
            await sendText(
                from,
                '📅 Send a new date and times:\nDD/MM/YYYY HH:mm[, HH:mm …]\n\nExample: 01/04/2026 14:00, 15:00',
            );
            break;

        default:
            await sendText(from, 'Unknown action. Type *hi* to continue.');
    }
}

// ─── Flows ────────────────────────────────────────────────────────────────────

async function handleStart(from: string, userId: string): Promise<void> {
    const profile = await getProfile(userId);
    if (!profile) {
        await sendText(
            from,
            "👋 *Welcome to CPV Booking Bot!*\n\nLet's set up your profile first.\n\nWhat's your full name?",
        );
        await setSession(userId, { step: 'onboarding_name' });
    } else {
        await sendText(from, `👋 Welcome back, *${profile.name}*!`);
        await replyWithWeekPicker(from, userId);
    }
}

async function handleProfileCommand(from: string, userId: string): Promise<void> {
    const profile = await getProfile(userId);
    if (!profile) {
        await sendText(from, 'No profile found. Type *hi* to set one up.');
        return;
    }

    await sendText(
        from,
        [
            '👤 *Your Profile*',
            '',
            `*Name:* ${profile.name}`,
            `*Email:* ${profile.emailAddress}`,
            `*Phone:* ${profile.phone}`,
            `*Membership №:* ${profile.membershipNumber}`,
            `*Address:* ${profile.location.displayName}`,
        ].join('\n'),
    );

    const buttons: [ButtonOption, ButtonOption] = [
        { id: 'profile:update', title: '✏️ Update profile' },
        { id: 'retry:date', title: '📅 Book a date' },
    ];
    await sendButtons(from, 'What would you like to do?', buttons);
}

async function handleDeleteCommand(from: string, userId: string): Promise<void> {
    // Persist a step so confirm/cancel buttons remain meaningful after 30 min
    await setSession(userId, { step: 'awaiting_week' });
    const buttons: [ButtonOption, ButtonOption] = [
        { id: 'delete:confirm', title: '🗑 Delete everything' },
        { id: 'delete:cancel', title: '❌ Keep my data' },
    ];
    await sendButtons(
        from,
        '⚠️ This will permanently delete your *profile, bookings and watchlist*. Cannot be undone.',
        buttons,
    );
}

async function handleMyBookings(from: string, userId: string): Promise<void> {
    let records: Awaited<ReturnType<typeof getUserBookingRecords>>;
    try {
        records = await getUserBookingRecords(userId);
    } catch (err) {
        console.error('[WhatsAppBot] getUserBookingRecords error:', err);
        await sendText(from, '⚠️ Could not fetch bookings. Please try again later.');
        return;
    }

    if (records.length === 0) {
        await sendText(from, '📭 You have no upcoming bookings.');
        return;
    }

    const lines: string[] = [`📋 *Your Upcoming Bookings* (${records.length})`, ''];
    for (const record of records) {
        const start = DateTime.fromISO(record.startTime);
        const end = DateTime.fromISO(record.endTime);
        lines.push(
            `📅 *${start.toFormat('EEE d MMM yyyy')}*  ${start.toFormat('HH:mm')}–${end.toFormat('HH:mm')}`,
            `🎾 ${record.court}`,
            '',
        );
    }

    await sendText(from, lines.join('\n'));
}

async function handleHelp(from: string): Promise<void> {
    await sendText(
        from,
        [
            '🤖 *CPV Booking Bot — Commands*',
            '',
            '📅 *Booking*',
            '*hi* — pick a date and book a court',
            '*instantbook* — book one or more slots in a single message',
            '*bookings* — view your upcoming bookings',
            '*cancel* — cancel the current flow',
            '',
            '👤 *Account*',
            '*profile* — view or update your profile',
            '*delete* — permanently delete your profile & watchlist',
            '',
            '❓ *Help*',
            '*help* — show this message',
        ].join('\n'),
    );
}

// ─── Instant booking helpers ──────────────────────────────────────────────────

/** Formats an InstantBookingResult[] into a plain-text summary for WhatsApp. */
function formatInstantBookSummary(date: string, results: InstantBookingResult[]): string {
    const dateLabel = DateTime.fromISO(date).toFormat('dd MMM yyyy');
    const lines = [`📋 *Instant Booking — ${dateLabel}*`, ''];

    for (const r of results) {
        if (r.status === 'booked') {
            lines.push(`✅  *${r.time}*  →  booked`);
            lines.push(`      🔖 ${r.appointmentId}`);
        } else if (r.status === 'unavailable') {
            lines.push(`⚠️  *${r.time}*  →  unavailable`);
        } else {
            lines.push(`❌  *${r.time}*  →  failed`);
            if (r.error) lines.push(`      ${r.error}`);
        }
    }

    const booked = results.filter((r) => r.status === 'booked').length;
    const unavailable = results.filter((r) => r.status === 'unavailable').length;
    const failed = results.filter((r) => r.status === 'failed').length;

    lines.push('');
    if (booked === 0) {
        const reason =
            unavailable === results.length
                ? 'none of the requested slots were available'
                : 'all booking attempts failed';
        lines.push(`❌ *No appointments were made* — ${reason}.`);
    } else if (unavailable > 0 || failed > 0) {
        const parts = [
            `${booked} booked`,
            unavailable > 0 ? `${unavailable} unavailable` : '',
            failed > 0 ? `${failed} failed` : '',
        ].filter(Boolean);
        lines.push(`📊 ${parts.join(' · ')}`);
    }

    return lines.join('\n');
}

async function handleInstantBookCommand(from: string, userId: string): Promise<void> {
    const profile = await getProfile(userId);
    if (!profile) {
        await sendText(from, 'No profile found. Type *hi* to set one up first.');
        return;
    }

    await setSession(userId, { step: 'instant_book' });
    await sendText(
        from,
        '⚡ *Instant Booking*\n\nSend the date and times you want to book:\nDD/MM/YYYY HH:mm[, HH:mm …]\n\nExample: 01/04/2026 14:00, 15:00',
    );
}

// ─── Date input helper ────────────────────────────────────────────────────────

async function handleDateInput(from: string, userId: string, text: string): Promise<void> {
    const date = DateTime.fromFormat(text, 'dd/MM/yyyy');

    if (!date.isValid) {
        await sendText(from, '⚠️ Invalid date. Please use DD/MM/YYYY format (e.g. 15/03/2026).');
        return;
    }

    if (date < DateTime.now().startOf('day')) {
        await sendText(from, '⚠️ That date is in the past. Please enter a future date.');
        return;
    }

    if (isDateBeyondWindow(date)) {
        await setSession(userId, {
            step: 'awaiting_date',
            selectedDate: date.toFormat('yyyy-MM-dd'),
        });
        const buttons: [ButtonOption, ButtonOption] = [
            { id: 'watchlist:yes', title: '📋 Add to watchlist' },
            { id: 'watchlist:no', title: '❌ Choose another date' },
        ];
        await sendButtons(
            from,
            `⚠️ ${date.toFormat('dd MMM yyyy')} is more than ${BOOKINGS_CONFIG.maxAdvanceDays} days away — outside the booking window.\n\nWould you like to add it to your watchlist instead?`,
            buttons,
        );
        return;
    }

    await sendText(from, `🔍 Fetching available slots for ${date.toFormat('dd MMM yyyy')}…`);

    let slots: DateTime[];
    try {
        slots = await getAvailableSlots(date);
    } catch (err) {
        console.error('[WhatsAppBot] getAvailableSlots error:', err);
        await sendText(from, '⚠️ Could not fetch slots. Please try again later.');
        return;
    }

    if (slots.length === 0) {
        await setSession(userId, { step: 'awaiting_week' });
        const buttons: [ButtonOption] = [{ id: 'retry:date', title: '🔄 Try another date' }];
        await sendButtons(from, `No available slots on ${date.toFormat('dd MMM yyyy')}.`, buttons);
        return;
    }

    const allSlotsISO = slots.map((s) => s.toISO()!);
    const dateLabel = date.toFormat('dd MMM yyyy');

    await setSession(userId, {
        step: 'awaiting_period',
        selectedDate: date.toFormat('yyyy-MM-dd'),
        availableSlots: allSlotsISO,
    });

    await replyWithPeriodPicker(from, allSlotsISO, dateLabel);
}

// ─── Slot selection ───────────────────────────────────────────────────────────

async function handleSlotSelected(from: string, userId: string, slotIndex: number): Promise<void> {
    const session = await getSession(userId);

    if (!session || session.step !== 'awaiting_slot' || !session.availableSlots) {
        await sendText(from, '⚠️ Session expired. Type *hi* to start again.');
        return;
    }

    if (slotIndex < 0 || slotIndex >= session.availableSlots.length) {
        await sendText(from, '⚠️ Invalid selection. Please try again.');
        return;
    }

    const selectedSlot = session.availableSlots[slotIndex];
    const slotTime = DateTime.fromISO(selectedSlot);
    const date = DateTime.fromFormat(session.selectedDate!, 'yyyy-MM-dd');

    await setSession(userId, { ...session, step: 'confirming', selectedSlot });

    const buttons: [ButtonOption, ButtonOption] = [
        { id: 'confirm:yes', title: '✅ Confirm' },
        { id: 'confirm:no', title: '❌ Cancel' },
    ];
    await sendButtons(
        from,
        [
            '📋 *Booking Summary*',
            '',
            `📅 *Date:* ${date.toFormat('dd MMM yyyy')}`,
            `⏰ *Time:* ${slotTime.toFormat('HH:mm')}`,
            '',
            'Confirm this booking?',
        ].join('\n'),
        buttons,
    );
}

// ─── Booking confirmation ─────────────────────────────────────────────────────

async function handleConfirmYes(
    from: string,
    userId: string,
    session: ConversationSession,
): Promise<void> {
    const profile = await getProfile(userId);
    if (!profile) {
        await sendText(from, 'Profile not found. Type *hi* to set up your profile.');
        return;
    }

    await sendText(from, '⏳ Booking your court…');

    try {
        const slot = DateTime.fromISO(session.selectedSlot!);
        const { appointment, staffIndex } = await createAppointment(
            slot,
            profileToCustomer(profile),
        );

        if (!appointment?.id) {
            throw new Error('Booking API returned a success status but no appointment ID.');
        }

        const bookedStart = DateTime.fromISO(appointment.startTime.dateTime).toFormat(
            'dd MMM yyyy, HH:mm',
        );
        const bookedEnd = DateTime.fromISO(appointment.endTime.dateTime).toFormat('HH:mm');
        const courtLabel = staffIndex === 1 ? 'Court 1' : staffIndex === 2 ? 'Court 2' : 'Court';

        await clearSession(userId);
        await sendText(
            from,
            [
                '✅ *Booking Confirmed!*',
                '',
                `📅 ${bookedStart} – ${bookedEnd}`,
                `🎾 ${courtLabel}`,
                `🔖 ID: ${appointment.id}`,
            ].join('\n'),
        );

        // Save AFTER the reply — a DynamoDB failure must never hide a successful booking.
        try {
            await saveBookingRecord(userId, {
                appointmentId: appointment.id,
                startTime: appointment.startTime.dateTime,
                endTime: appointment.endTime.dateTime,
                court: courtLabel,
                createdAt: DateTime.now().toISO()!,
            });
        } catch (saveErr) {
            console.error('[WhatsAppBot] saveBookingRecord failed (booking was created):', saveErr);
        }
    } catch (err) {
        console.error('[WhatsAppBot] createAppointment error:', err);
        await sendText(from, '⚠️ Booking failed. Please try again or contact support.');
    }
}
