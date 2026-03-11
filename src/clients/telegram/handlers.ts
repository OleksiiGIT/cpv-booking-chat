import { Context, Markup, Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Returns the stable userId string for the current Telegram user. */
function uid(ctx: Context): string {
    return `telegram#${ctx.from!.id}`;
}

/**
 * Renders an inline keyboard with one button per available day in the booking
 * window (today → today + maxAdvanceDays), grouped into rows of 3, plus a
 * "Enter date manually" fallback button at the bottom.
 */
function buildDatePickerKeyboard() {
    const today = DateTime.now().startOf('day');
    const dayButtons = Array.from({ length: BOOKINGS_CONFIG.maxAdvanceDays + 1 }, (_, i) => {
        const date = today.plus({ days: i });
        const label =
            i === 0
                ? `Today · ${date.toFormat('d MMM')}`
                : i === 1
                  ? `Tomorrow · ${date.toFormat('d MMM')}`
                  : date.toFormat('EEE d MMM');
        return Markup.button.callback(label, `date:${date.toFormat('yyyy-MM-dd')}`);
    });

    // 3 buttons per row
    const rows: ReturnType<typeof Markup.button.callback>[][] = [];
    for (let i = 0; i < dayButtons.length; i += 3) {
        rows.push(dayButtons.slice(i, i + 3));
    }
    rows.push([Markup.button.callback('📅 Enter date manually', 'date:manual')]);

    return Markup.inlineKeyboard(rows);
}

async function replyWithDatePicker(ctx: Context, id: string): Promise<void> {
    await setSession(id, { step: 'awaiting_date' });
    await ctx.reply('📅 *Which date would you like to book?*', {
        parse_mode: 'Markdown',
        ...buildDatePickerKeyboard(),
    });
}

// ─── Command handlers ─────────────────────────────────────────────────────────

/**
 * /start — welcome new users (onboarding) or returning users (jump straight to date).
 */
export async function handleStart(ctx: Context): Promise<void> {
    const id = uid(ctx);
    const profile = await getProfile(id);

    if (!profile) {
        await ctx.reply(
            "👋 *Welcome to CPV Booking Bot!*\n\nLet's set up your profile first.\n\nWhat's your full name?",
            { parse_mode: 'Markdown' },
        );
        await setSession(id, { step: 'onboarding_name' });
    } else {
        await ctx.reply(`👋 Welcome back, *${profile.name}*!`, { parse_mode: 'Markdown' });
        await replyWithDatePicker(ctx, id);
    }
}

/** /cancel — abandon the current flow and clear session state. */
export async function handleCancel(ctx: Context): Promise<void> {
    await clearSession(uid(ctx));
    await ctx.reply('❌ Cancelled. Type /start to begin a new booking.');
}

/** /profile — show the stored profile with an option to update it. */
export async function handleProfileCommand(ctx: Context): Promise<void> {
    const profile = await getProfile(uid(ctx));
    if (!profile) {
        await ctx.reply('No profile found. Type /start to set one up.');
        return;
    }

    await ctx.reply(
        [
            '👤 *Your Profile*',
            '',
            `*Name:* ${profile.name}`,
            `*Email:* ${profile.emailAddress}`,
            `*Phone:* ${profile.phone}`,
            `*Membership №:* ${profile.membershipNumber}`,
            `*Address:* ${profile.location.displayName}`,
        ].join('\n'),
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('✏️ Update profile', 'profile:update')],
            ]),
        },
    );
}

/** /delete — ask for GDPR confirmation before wiping all user data. */
export async function handleDelete(ctx: Context): Promise<void> {
    await ctx.reply(
        '⚠️ This will permanently delete your *profile and watchlist*. This cannot be undone.',
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('🗑 Yes, delete everything', 'delete:confirm')],
                [Markup.button.callback('❌ No, keep my data', 'delete:cancel')],
            ]),
        },
    );
}

/** /help — list all available commands. */
export async function handleHelp(ctx: Context): Promise<void> {
    await ctx.reply(
        [
            '🤖 *CPV Booking Bot — Commands*',
            '',
            '📅 *Booking*',
            '/start — pick a date and book a court',
            '/instantbook — book one or more slots in a single message',
            '/mybookings — view your upcoming bookings',
            '/cancel — cancel the current flow',
            '',
            '👤 *Account*',
            '/profile — view or update your profile',
            '/delete — permanently delete your profile, bookings & watchlist',
            '',
            '❓ *Help*',
            '/help — show this message',
        ].join('\n'),
        { parse_mode: 'Markdown' },
    );
}

// ─── Instant booking helpers ──────────────────────────────────────────────────

/**
 * Formats an `InstantBookingResult[]` into a Markdown summary message,
 * one line per requested slot.
 */
function formatInstantBookSummary(date: string, results: InstantBookingResult[]): string {
    const dateLabel = DateTime.fromISO(date).toFormat('dd MMM yyyy');
    const lines = [`📋 *Instant Booking — ${dateLabel}*`, ''];

    for (const r of results) {
        if (r.status === 'booked') {
            lines.push(`✅  *${r.time}*  →  booked`);
            lines.push(`      🔖 \`${r.appointmentId}\``);
        } else if (r.status === 'unavailable') {
            lines.push(`⚠️  *${r.time}*  →  unavailable`);
        } else {
            lines.push(`❌  *${r.time}*  →  failed`);
            if (r.error) lines.push(`      _${r.error}_`);
        }
    }

    return lines.join('\n');
}

/**
 * /instantbook — sets the session to `instant_book` and asks for a date/times
 * string. Requires a profile to already exist.
 */
export async function handleInstantBookCommand(ctx: Context): Promise<void> {
    const id = uid(ctx);
    const profile = await getProfile(id);

    if (!profile) {
        await ctx.reply('No profile found. Type /start to set one up first.');
        return;
    }

    await setSession(id, { step: 'instant_book' });
    await ctx.reply(
        '⚡ *Instant Booking*\n\nSend the date and times you want to book:\n`DD/MM/YYYY HH:mm[, HH:mm …]`\n\nExample: `01/04/2026 14:00, 15:00`',
        { parse_mode: 'Markdown' },
    );
}

// ─── Text message handler ─────────────────────────────────────────────────────

/**
 * Handles all plain-text messages from the user.
 * Routes to the correct onboarding / booking sub-flow based on session step.
 */
export async function handleText(ctx: Context): Promise<void> {
    if (!ctx.message || !('text' in ctx.message)) return;

    const id = uid(ctx);
    const text = ctx.message.text.trim();
    const session = await getSession(id);

    if (!session) {
        await ctx.reply('Type /start to begin a booking.');
        return;
    }

    switch (session.step) {
        // ── Onboarding ──────────────────────────────────────────────────────
        case 'onboarding_name':
            await setSession(id, { step: 'onboarding_email', onboardingName: text });
            await ctx.reply("📧 What's your email address?");
            break;

        case 'onboarding_email':
            await setSession(id, { ...session, step: 'onboarding_phone', onboardingEmail: text });
            await ctx.reply("📱 What's your phone number?");
            break;

        case 'onboarding_phone':
            await setSession(id, {
                ...session,
                step: 'onboarding_membership',
                onboardingPhone: text,
            });
            await ctx.reply("🏷 What's your membership number?");
            break;

        case 'onboarding_membership':
            await setSession(id, {
                ...session,
                step: 'onboarding_address',
                onboardingMembership: text,
            });
            await ctx.reply("🏠 What's your street address?");
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
            await saveProfile(id, profile);
            await ctx.reply('✅ Profile saved!', { parse_mode: 'Markdown' });
            await replyWithDatePicker(ctx, id);
            break;
        }

        // ── Booking flow ─────────────────────────────────────────────────────
        case 'awaiting_date':
            await handleDateInput(ctx, id, text);
            break;

        case 'awaiting_watchlist_time': {
            if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(text)) {
                await ctx.reply('⚠️ Invalid time. Please use HH:mm format (e.g. 10:00).');
                break;
            }
            await addToWatchlist(id, session.selectedDate!, text);
            await clearSession(id);
            await ctx.reply(
                `✅ Added to watchlist!\n\n📅 ${session.selectedDate} at *${text}*\n\nI'll auto-book it as soon as it enters the 2-week booking window.`,
                { parse_mode: 'Markdown' },
            );
            break;
        }

        // ── Instant booking ──────────────────────────────────────────────────
        case 'instant_book': {
            let parsed: { date: string; times: string[] };
            try {
                parsed = parseInstantBookingInput(text);
            } catch (err) {
                await ctx.reply(
                    `⚠️ ${(err as Error).message}\n\nPlease try again or type /cancel to stop.`,
                );
                break; // stay in instant_book step
            }

            const date = DateTime.fromISO(parsed.date);

            // Date is outside the booking window — offer watchlist for all times
            if (isDateBeyondWindow(date)) {
                await setSession(id, {
                    step: 'instant_book',
                    selectedDate: parsed.date,
                    instantBookTimes: parsed.times,
                });
                await ctx.reply(
                    `⚠️ *${date.toFormat('dd MMM yyyy')}* is more than ${BOOKINGS_CONFIG.maxAdvanceDays} days away — outside the booking window.\n\nAdd *${parsed.times.join(', ')}* to your watchlist instead?`,
                    {
                        parse_mode: 'Markdown',
                        ...Markup.inlineKeyboard([
                            [
                                Markup.button.callback(
                                    '📋 Add all to watchlist',
                                    'instantbook:watchlist:yes',
                                ),
                            ],
                            [
                                Markup.button.callback(
                                    '❌ Enter a different date',
                                    'instantbook:watchlist:no',
                                ),
                            ],
                        ]),
                    },
                );
                break;
            }

            // Within window — book all requested slots
            const profile = await getProfile(id);
            if (!profile) {
                await ctx.reply('Profile not found. Type /start to set up your profile.');
                break;
            }

            await ctx.reply(
                `⏳ Booking ${parsed.times.length} slot(s) on ${date.toFormat('dd MMM yyyy')}…`,
            );

            let results: InstantBookingResult[];
            try {
                results = await instantBook(parsed.date, parsed.times, profileToCustomer(profile));
            } catch (err) {
                console.error('[TelegramBot] instantBook error:', err);
                await ctx.reply('⚠️ Could not complete bookings. Please try again later.');
                break;
            }

            await clearSession(id);
            await ctx.reply(formatInstantBookSummary(parsed.date, results), {
                parse_mode: 'Markdown',
            });

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
                    await saveBookingRecord(id, {
                        appointmentId: r.appointmentId!,
                        startTime: startDt.toISO()!,
                        endTime: endDt.toISO()!,
                        court: courtLabel,
                        createdAt: DateTime.now().toISO()!,
                    });
                } catch (saveErr) {
                    console.error(
                        '[TelegramBot] saveBookingRecord failed for instant book:',
                        saveErr,
                    );
                }
            }
            break;
        }

        default:
            await ctx.reply('Please use the buttons above, or type /cancel to start over.');
    }
}

// ─── Date input helper ────────────────────────────────────────────────────────

async function handleDateInput(ctx: Context, id: string, text: string): Promise<void> {
    const date = DateTime.fromFormat(text, 'dd/MM/yyyy');

    if (!date.isValid) {
        await ctx.reply('⚠️ Invalid date. Please use DD/MM/YYYY format (e.g. 15/03/2026).');
        return;
    }

    if (date < DateTime.now().startOf('day')) {
        await ctx.reply('⚠️ That date is in the past. Please enter a future date.');
        return;
    }

    if (isDateBeyondWindow(date)) {
        // Store the date so we can use it if they confirm "add to watchlist"
        await setSession(id, { step: 'awaiting_date', selectedDate: date.toFormat('yyyy-MM-dd') });
        await ctx.reply(
            `⚠️ *${date.toFormat('dd MMM yyyy')}* is more than ${BOOKINGS_CONFIG.maxAdvanceDays} days away — outside the booking window.\n\nWould you like to add it to your watchlist instead?`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('📋 Add to watchlist', 'watchlist:yes')],
                    [Markup.button.callback('❌ Choose another date', 'watchlist:no')],
                ]),
            },
        );
        return;
    }

    await ctx.reply(`🔍 Fetching available slots for *${date.toFormat('dd MMM yyyy')}*...`, {
        parse_mode: 'Markdown',
    });

    let slots: DateTime[];
    try {
        slots = await getAvailableSlots(date);
    } catch (err) {
        console.error('[TelegramBot] getAvailableSlots error:', err);
        await ctx.reply('⚠️ Could not fetch slots. Please try again later.');
        return;
    }

    if (slots.length === 0) {
        await ctx.reply(
            `No available slots on ${date.toFormat('dd MMM yyyy')}.`,
            Markup.inlineKeyboard([[Markup.button.callback('🔄 Try another date', 'retry:date')]]),
        );
        return;
    }

    await setSession(id, {
        step: 'awaiting_slot',
        selectedDate: date.toFormat('yyyy-MM-dd'),
        availableSlots: slots.map((s) => s.toISO()!),
    });

    await ctx.reply(
        `📅 *${date.toFormat('dd MMM yyyy')}* — ${slots.length} slot(s) available:\n\nSelect a time:`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard(
                slots.map((slot, i) => [
                    Markup.button.callback(slot.toFormat('HH:mm'), `slot:${i}`),
                ]),
            ),
        },
    );
}

// ─── Callback action helpers ──────────────────────────────────────────────────

async function handleSlotSelected(ctx: Context, slotIndex: number): Promise<void> {
    const id = uid(ctx);
    const session = await getSession(id);

    if (!session || session.step !== 'awaiting_slot' || !session.availableSlots) {
        await ctx.reply('⚠️ Session expired. Type /start to begin again.');
        return;
    }

    if (slotIndex < 0 || slotIndex >= session.availableSlots.length) {
        await ctx.reply('Invalid selection. Please try again.');
        return;
    }

    const selectedSlot = session.availableSlots[slotIndex];
    const slotTime = DateTime.fromISO(selectedSlot);
    const date = DateTime.fromFormat(session.selectedDate!, 'yyyy-MM-dd');

    await setSession(id, { ...session, step: 'confirming', selectedSlot });

    await ctx.reply(
        [
            '📋 *Booking Summary*',
            '',
            `📅 *Date:* ${date.toFormat('dd MMM yyyy')}`,
            `⏰ *Time:* ${slotTime.toFormat('HH:mm')}`,
            '',
            'Confirm this booking?',
        ].join('\n'),
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [
                    Markup.button.callback('✅ Confirm', 'confirm:yes'),
                    Markup.button.callback('❌ Cancel', 'confirm:no'),
                ],
            ]),
        },
    );
}

async function handleConfirmYes(ctx: Context, session: ConversationSession): Promise<void> {
    const id = uid(ctx);
    const profile = await getProfile(id);

    if (!profile) {
        await ctx.reply('Profile not found. Type /start to set up your profile.');
        return;
    }

    await ctx.reply('⏳ Booking your court...');

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

        await clearSession(id);
        await ctx.reply(
            [
                '✅ *Booking Confirmed!*',
                '',
                `📅 ${bookedStart} – ${bookedEnd}`,
                `🎾 ${courtLabel}`,
                `🔖 ID: \`${appointment.id}\``,
            ].join('\n'),
            { parse_mode: 'Markdown' },
        );

        // Save AFTER the reply — a DynamoDB failure must never hide a successful booking.
        try {
            await saveBookingRecord(id, {
                appointmentId: appointment.id,
                startTime: appointment.startTime.dateTime,
                endTime: appointment.endTime.dateTime,
                court: courtLabel,
                createdAt: DateTime.now().toISO()!,
            });
        } catch (saveErr) {
            console.error('[TelegramBot] saveBookingRecord failed (booking was created):', saveErr);
        }
    } catch (err) {
        console.error('[TelegramBot] createAppointment error:', err);
        await ctx.reply('⚠️ Booking failed. Please try again or contact support.');
    }
}

/** /mybookings — list all upcoming bookings stored in DynamoDB for this user. */
export async function handleMyBookings(ctx: Context): Promise<void> {
    const id = uid(ctx);

    let records: Awaited<ReturnType<typeof getUserBookingRecords>>;
    try {
        records = await getUserBookingRecords(id);
    } catch (err) {
        console.error('[TelegramBot] getUserBookingRecords error:', err);
        await ctx.reply('⚠️ Could not fetch bookings. Please try again later.');
        return;
    }

    if (records.length === 0) {
        await ctx.reply('📭 You have no upcoming bookings.');
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

    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' });
}

// ─── registerHandlers ─────────────────────────────────────────────────────────

export function registerHandlers(bot: Telegraf): void {
    // Commands
    bot.start(handleStart);
    bot.command('help', handleHelp);
    bot.command('cancel', handleCancel);
    bot.command('profile', handleProfileCommand);
    bot.command('mybookings', handleMyBookings);
    bot.command('delete', handleDelete);
    bot.command('instantbook', handleInstantBookCommand);

    // Date picker — tapping a day button
    bot.action(/^date:(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
        await ctx.answerCbQuery();
        const date = DateTime.fromFormat(ctx.match[1], 'yyyy-MM-dd');
        await handleDateInput(ctx, uid(ctx), date.toFormat('dd/MM/yyyy'));
    });

    // Date picker — manual text entry fallback
    bot.action('date:manual', async (ctx) => {
        await ctx.answerCbQuery();
        await setSession(uid(ctx), { step: 'awaiting_date' });
        await ctx.reply('📅 Enter a date _(DD/MM/YYYY, e.g. 15/03/2026)_:', {
            parse_mode: 'Markdown',
        });
    });

    // Slot selection — slot:0, slot:1, …
    bot.action(/^slot:(\d+)$/, async (ctx) => {
        await ctx.answerCbQuery();
        await handleSlotSelected(ctx, parseInt(ctx.match[1], 10));
    });

    // Booking confirmation
    bot.action('confirm:yes', async (ctx) => {
        await ctx.answerCbQuery();
        const session = await getSession(uid(ctx));
        if (!session || session.step !== 'confirming' || !session.selectedSlot) {
            await ctx.reply('⚠️ Session expired. Type /start to begin again.');
            return;
        }
        await handleConfirmYes(ctx, session);
    });

    bot.action('confirm:no', async (ctx) => {
        await ctx.answerCbQuery();
        const session = await getSession(uid(ctx));
        if (!session || session.step !== 'confirming' || !session.selectedSlot) {
            await ctx.reply('⚠️ Session expired. Type /start to begin again.');
            return;
        }
        await clearSession(uid(ctx));
        await ctx.reply('❌ Booking cancelled. Type /start to start over.');
    });

    // Watchlist offer
    bot.action('watchlist:yes', async (ctx) => {
        await ctx.answerCbQuery();
        const id = uid(ctx);
        const session = await getSession(id);
        if (!session?.selectedDate) {
            await ctx.reply('⚠️ Session expired. Type /start to begin again.');
            return;
        }
        await setSession(id, { ...session, step: 'awaiting_watchlist_time' });
        await ctx.reply('⏰ What time would you prefer? _(HH:mm, e.g. 10:00)_', {
            parse_mode: 'Markdown',
        });
    });

    bot.action('watchlist:no', async (ctx) => {
        await ctx.answerCbQuery();
        await replyWithDatePicker(ctx, uid(ctx));
    });

    // Retry date after no slots found
    bot.action('retry:date', async (ctx) => {
        await ctx.answerCbQuery();
        await replyWithDatePicker(ctx, uid(ctx));
    });

    // Profile update — re-runs onboarding
    bot.action('profile:update', async (ctx) => {
        await ctx.answerCbQuery();
        await setSession(uid(ctx), { step: 'onboarding_name' });
        await ctx.reply("Let's update your profile.\n\n*What's your full name?*", {
            parse_mode: 'Markdown',
        });
    });

    // GDPR delete
    bot.action('delete:confirm', async (ctx) => {
        await ctx.answerCbQuery();
        const id = uid(ctx);
        await Promise.all([
            deleteProfile(id),
            clearWatchlist(id),
            clearBookingRecords(id),
            clearSession(id),
        ]);
        await ctx.reply('🗑 All your data has been deleted. Type /start to begin again.');
    });

    bot.action('delete:cancel', async (ctx) => {
        await ctx.answerCbQuery();
        await ctx.reply('Cancelled. Your data is safe. ✅');
    });

    // Instant booking — watchlist offer for out-of-window dates
    bot.action('instantbook:watchlist:yes', async (ctx) => {
        await ctx.answerCbQuery();
        const id = uid(ctx);
        const session = await getSession(id);
        if (!session?.selectedDate || !session?.instantBookTimes?.length) {
            await ctx.reply('⚠️ Session expired. Type /instantbook to begin again.');
            return;
        }
        for (const time of session.instantBookTimes) {
            await addToWatchlist(id, session.selectedDate, time);
        }
        await clearSession(id);
        await ctx.reply(
            `✅ Added to watchlist!\n\n📅 *${session.selectedDate}* at *${session.instantBookTimes.join(', ')}*\n\nI'll auto-book as soon as they enter the 2-week booking window.`,
            { parse_mode: 'Markdown' },
        );
    });

    bot.action('instantbook:watchlist:no', async (ctx) => {
        await ctx.answerCbQuery();
        await setSession(uid(ctx), { step: 'instant_book' });
        await ctx.reply(
            '📅 Send a new date and times:\n`DD/MM/YYYY HH:mm[, HH:mm …]`\n\nExample: `01/04/2026 14:00, 15:00`',
            { parse_mode: 'Markdown' },
        );
    });

    // Catch-all text handler (must be registered last)
    bot.on(message('text'), handleText);
}
