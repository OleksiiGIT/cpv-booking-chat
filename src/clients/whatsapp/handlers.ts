/**
 * WhatsApp conversation flow — mirrors src/clients/telegram/handlers.ts but
 * adapted for the WhatsApp Cloud API message format.
 *
 * Key differences from Telegram:
 *  - No slash commands: keywords (hi, cancel, profile, …) trigger flows.
 *  - No "inline keyboard edit": each interaction sends a fresh message.
 *  - Date picker uses two paginated list messages (week 0 / week 1) because
 *    WhatsApp list messages are capped at 10 rows total.
 *  - UserId format: "whatsapp#<phoneNumber>"
 */
import { DateTime } from 'luxon';
import { clearSession, getSession, setSession } from '../../services/session.service';
import { deleteProfile, getProfile, saveProfile } from '../../services/user.service';
import { addToWatchlist, clearWatchlist } from '../../services/watchlist.service';
import { createAppointment, getAvailableSlots } from '../../services/booking.service';
import {
    clearBookingRecords,
    getUserBookingRecords,
    saveBookingRecord,
} from '../../services/booking-record.service';
import { profileToCustomer } from '../../services/profile.service';
import { ConversationSession, UserProfile } from '../../types';
import { BOOKINGS_CONFIG } from '../../config/bookings.config';
import { isDateBeyondWindow } from '../../utils/date.utils';
import { ButtonOption, ListRow, ListSection, sendButtons, sendList, sendText } from './bot';

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

/**
 * Sends a paginated date-picker list.
 *
 * WhatsApp list messages are hard-capped at 10 rows across all sections.
 * We split 15 dates (today + 14) across two "pages":
 *   week=0 → days 0–6  (7 rows) + "Next week →" + "Enter manually" = 9 rows ✓
 *   week=1 → days 7–14 (8 rows) + "← Prev week" + "Enter manually" = 10 rows ✓
 */
async function replyWithDatePicker(to: string, userId: string, week = 0): Promise<void> {
    await setSession(userId, { step: 'awaiting_date' });

    const today = DateTime.now().startOf('day');
    const totalDays = BOOKINGS_CONFIG.maxAdvanceDays + 1; // 15
    const startDay = week * 7;
    const endDay = Math.min(startDay + 7, totalDays);

    const dateRows = Array.from({ length: endDay - startDay }, (_, i) => {
        const dayIndex = startDay + i;
        const date = today.plus({ days: dayIndex });
        const label =
            dayIndex === 0
                ? `Today · ${date.toFormat('d MMM')}`
                : dayIndex === 1
                  ? `Tomorrow · ${date.toFormat('d MMM')}`
                  : date.toFormat('EEE d MMM');
        return { id: `date:${date.toFormat('yyyy-MM-dd')}`, title: cap(label, 24) };
    });

    const optionRows: ListRow[] = [];
    if (week === 0 && totalDays > 7) optionRows.push({ id: 'date:week:1', title: 'Next week →' });
    if (week === 1) optionRows.push({ id: 'date:week:0', title: '← Previous week' });
    optionRows.push({ id: 'date:manual', title: '📅 Enter manually' });

    const sections: ListSection[] = [
        { title: 'Available dates', rows: dateRows },
        { title: 'Options', rows: optionRows },
    ];

    await sendList(to, '📅 Which date would you like to book?', 'Select date', sections);
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
            await replyWithDatePicker(from, userId);
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

        default:
            await sendText(from, 'Please use the menu options, or type *cancel* to start over.');
    }
}

// ─── Action handler ───────────────────────────────────────────────────────────

async function handleAction(from: string, userId: string, actionId: string): Promise<void> {
    // Date picker — specific date selected (date:yyyy-MM-dd)
    if (/^date:\d{4}-\d{2}-\d{2}$/.test(actionId)) {
        const date = DateTime.fromFormat(actionId.slice(5), 'yyyy-MM-dd');
        await handleDateInput(from, userId, date.toFormat('dd/MM/yyyy'));
        return;
    }

    // Slot selection — slot:<index>
    if (/^slot:\d+$/.test(actionId)) {
        await handleSlotSelected(from, userId, parseInt(actionId.slice(5), 10));
        return;
    }

    // Slot pagination — slot:page:<pageIndex>
    if (/^slot:page:\d+$/.test(actionId)) {
        const page = parseInt(actionId.split(':')[2], 10);
        const session = await getSession(userId);
        if (!session?.availableSlots || !session?.selectedDate) {
            await sendText(from, '⚠️ Session expired. Type *hi* to start again.');
            return;
        }
        const date = DateTime.fromFormat(session.selectedDate, 'yyyy-MM-dd');
        await setSession(userId, { ...session, step: 'awaiting_slot', slotPage: page });
        await replyWithSlotPicker(from, session.availableSlots, date.toFormat('dd MMM yyyy'), page);
        return;
    }

    switch (actionId) {
        // ── Date picker navigation ────────────────────────────────────────────
        case 'date:week:0':
            await replyWithDatePicker(from, userId, 0);
            break;
        case 'date:week:1':
            await replyWithDatePicker(from, userId, 1);
            break;
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
            await replyWithDatePicker(from, userId);
            break;

        // ── Retry after no slots ──────────────────────────────────────────────
        case 'retry:date':
            await replyWithDatePicker(from, userId);
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
        await replyWithDatePicker(from, userId);
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
    // Persist the step so confirm/cancel buttons remain meaningful after 30 min
    await setSession(userId, { step: 'awaiting_date' });
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

// ─── Date input helper ────────────────────────────────────────────────────────

/**
 * WhatsApp list messages are capped at 10 rows total.
 * Layout per page:
 *   page 0, no more  → up to 10 slot rows
 *   page 0, has more → 9 slot rows + "View more →"
 *   page n≥1, has more → 8 slot rows + "← Previous" + "View more →"
 *   page n≥1, last    → up to 9 slot rows + "← Previous"
 */
const SLOTS_PAGE0 = 9; // max slots on first page when more exist
const SLOTS_PAGEN = 8; // max slots on subsequent pages (need 2 nav rows)

function slotPageOffset(page: number): number {
    return page === 0 ? 0 : SLOTS_PAGE0 + (page - 1) * SLOTS_PAGEN;
}

async function replyWithSlotPicker(
    from: string,
    allSlots: string[], // full list of ISO strings (already in session)
    dateLabel: string,
    page: number,
): Promise<void> {
    const offset = slotPageOffset(page);
    const hasPrev = page > 0;
    const slotsOnPage = page === 0 ? SLOTS_PAGE0 : SLOTS_PAGEN;
    const pageSlots = allSlots.slice(offset, offset + slotsOnPage);
    const hasMore = offset + slotsOnPage < allSlots.length;

    // If this is the only page, we can safely show up to 10 slots with no nav rows.
    const displaySlots = !hasPrev && !hasMore ? allSlots.slice(0, 10) : pageSlots;

    const slotRows: ListRow[] = displaySlots.map((iso, i) => ({
        id: `slot:${offset + i}`,
        title: DateTime.fromISO(iso).toFormat('HH:mm'),
    }));

    const navRows: ListRow[] = [];
    if (hasPrev) navRows.push({ id: `slot:page:${page - 1}`, title: '← Previous' });
    if (hasMore) navRows.push({ id: `slot:page:${page + 1}`, title: 'View more →' });

    const sections: ListSection[] = [{ title: 'Available times', rows: slotRows }];
    if (navRows.length > 0) sections.push({ title: 'Navigation', rows: navRows });

    const rangeEnd = offset + displaySlots.length;
    const rangeLabel =
        allSlots.length > (hasPrev || hasMore ? slotsOnPage : 10)
            ? ` (${offset + 1}–${rangeEnd} of ${allSlots.length})`
            : '';

    await sendList(
        from,
        `📅 ${dateLabel} — ${allSlots.length} slot(s) available${rangeLabel}:\n\nSelect a time:`,
        'Choose time',
        sections,
    );
}

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
        await setSession(userId, { step: 'awaiting_date' });
        const buttons: [ButtonOption] = [{ id: 'retry:date', title: '🔄 Try another date' }];
        await sendButtons(from, `No available slots on ${date.toFormat('dd MMM yyyy')}.`, buttons);
        return;
    }

    // WhatsApp list rows are capped at 10 total — paginate via replyWithSlotPicker.
    const allSlotsISO = slots.map((s) => s.toISO()!);

    await setSession(userId, {
        step: 'awaiting_slot',
        selectedDate: date.toFormat('yyyy-MM-dd'),
        availableSlots: allSlotsISO,
        slotPage: 0,
    });

    await replyWithSlotPicker(from, allSlotsISO, date.toFormat('dd MMM yyyy'), 0);
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
