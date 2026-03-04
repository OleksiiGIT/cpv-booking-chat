import {Context, Markup, Telegraf} from 'telegraf';
import {message} from 'telegraf/filters';
import {DateTime} from 'luxon';
import {clearSession, getSession, setSession} from '../../services/session.service';
import {deleteProfile, getProfile, saveProfile} from '../../services/user.service';
import {addToWatchlist, clearWatchlist} from '../../services/watchlist.service';
import {createAppointment, getAvailableSlots} from '../../services/booking.service';
import {profileToCustomer} from '../../services/profile.service';
import {ConversationSession, UserProfile} from '../../types';
import {BOOKINGS_CONFIG} from '../../config/bookings.config';
import {isDateBeyondWindow} from '../../utils/date.utils';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Returns the stable userId string for the current Telegram user. */
function uid(ctx: Context): string {
    return `telegram#${ctx.from!.id}`;
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
            '👋 *Welcome to CPV Booking Bot!*\n\nLet\'s set up your profile first.\n\nWhat\'s your full name?',
            {parse_mode: 'Markdown'},
        );
        await setSession(id, {step: 'onboarding_name'});
    } else {
        await ctx.reply(
            `👋 Welcome back, *${profile.name}*!\n\nWhich date would you like to book? _(DD/MM/YYYY)_`,
            {parse_mode: 'Markdown'},
        );
        await setSession(id, {step: 'awaiting_date'});
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
            ...Markup.inlineKeyboard([[Markup.button.callback('✏️ Update profile', 'profile:update')]]),
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
            await setSession(id, {step: 'onboarding_email', onboardingName: text});
            await ctx.reply('📧 What\'s your email address?');
            break;

        case 'onboarding_email':
            await setSession(id, {...session, step: 'onboarding_phone', onboardingEmail: text});
            await ctx.reply('📱 What\'s your phone number?');
            break;

        case 'onboarding_phone':
            await setSession(id, {...session, step: 'onboarding_membership', onboardingPhone: text});
            await ctx.reply('🏷 What\'s your membership number?');
            break;

        case 'onboarding_membership':
            await setSession(id, {...session, step: 'onboarding_address', onboardingMembership: text});
            await ctx.reply('🏠 What\'s your street address?');
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
                    address: {street: text, type: 'Other'},
                },
            };
            await saveProfile(id, profile);
            await setSession(id, {step: 'awaiting_date'});
            await ctx.reply(
                '✅ Profile saved!\n\nWhich date would you like to book? _(DD/MM/YYYY)_',
                {parse_mode: 'Markdown'},
            );
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
                {parse_mode: 'Markdown'},
            );
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
        await setSession(id, {step: 'awaiting_date', selectedDate: date.toFormat('yyyy-MM-dd')});
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

    await ctx.reply(
        `🔍 Fetching available slots for *${date.toFormat('dd MMM yyyy')}*...`,
        {parse_mode: 'Markdown'},
    );

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
                slots.map((slot, i) => [Markup.button.callback(slot.toFormat('HH:mm'), `slot:${i}`)]),
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

    await setSession(id, {...session, step: 'confirming', selectedSlot});

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
        const {appointment, staffIndex} = await createAppointment(slot, profileToCustomer(profile));

        const bookedStart = DateTime.fromISO(appointment.startTime.dateTime).toFormat('dd MMM yyyy, HH:mm');
        const bookedEnd = DateTime.fromISO(appointment.endTime.dateTime).toFormat('HH:mm');

        await clearSession(id);
        await ctx.reply(
            [
                '✅ *Booking Confirmed!*',
                '',
                `📅 ${bookedStart} – ${bookedEnd}`,
                `🎾 Court ${staffIndex}`,
                `🔖 ID: \`${appointment.id}\``,
            ].join('\n'),
            {parse_mode: 'Markdown'},
        );
    } catch (err) {
        console.error('[TelegramBot] createAppointment error:', err);
        await ctx.reply('⚠️ Booking failed. Please try again or contact support.');
    }
}

// ─── registerHandlers ─────────────────────────────────────────────────────────

export function registerHandlers(bot: Telegraf): void {
    // Commands
    bot.start(handleStart);
    bot.command('cancel', handleCancel);
    bot.command('profile', handleProfileCommand);
    bot.command('delete', handleDelete);

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
        await setSession(id, {...session, step: 'awaiting_watchlist_time'});
        await ctx.reply(
            '⏰ What time would you prefer? _(HH:mm, e.g. 10:00)_',
            {parse_mode: 'Markdown'},
        );
    });

    bot.action('watchlist:no', async (ctx) => {
        await ctx.answerCbQuery();
        await clearSession(uid(ctx));
        await ctx.reply('Cancelled. Type /start to choose a different date.');
    });

    // Retry date after no slots found
    bot.action('retry:date', async (ctx) => {
        await ctx.answerCbQuery();
        await setSession(uid(ctx), {step: 'awaiting_date'});
        await ctx.reply(
            'Which date would you like to book? _(DD/MM/YYYY)_',
            {parse_mode: 'Markdown'},
        );
    });

    // Profile update — re-runs onboarding
    bot.action('profile:update', async (ctx) => {
        await ctx.answerCbQuery();
        await setSession(uid(ctx), {step: 'onboarding_name'});
        await ctx.reply(
            "Let's update your profile.\n\n*What's your full name?*",
            {parse_mode: 'Markdown'},
        );
    });

    // GDPR delete
    bot.action('delete:confirm', async (ctx) => {
        await ctx.answerCbQuery();
        const id = uid(ctx);
        await Promise.all([deleteProfile(id), clearWatchlist(id), clearSession(id)]);
        await ctx.reply('🗑 All your data has been deleted. Type /start to begin again.');
    });

    bot.action('delete:cancel', async (ctx) => {
        await ctx.answerCbQuery();
        await ctx.reply('Cancelled. Your data is safe. ✅');
    });

    // Catch-all text handler (must be registered last)
    bot.on(message('text'), handleText);
}
