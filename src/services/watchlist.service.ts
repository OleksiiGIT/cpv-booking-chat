import {
    DeleteCommand,
    GetCommand,
    PutCommand,
    QueryCommand,
    UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { DateTime } from 'luxon';
import { AppointmentCustomer, WatchlistEntry } from '../types';
import { BOOKINGS_CONFIG } from '../config/bookings.config';
import { createAppointment, getAvailableSlots } from './booking.service';
import { docClient, TABLE_NAME } from '../db/dynamo';

const pk = (userId: string) => `watchlist#${userId}`;
const sk = (wantedDate: string, wantedTime: string) => `${wantedDate}#${wantedTime}`;

export async function getWatchlist(userId: string): Promise<WatchlistEntry[]> {
    const { Items } = await docClient.send(
        new QueryCommand({
            TableName: TABLE_NAME,
            KeyConditionExpression: 'pk = :pk',
            ExpressionAttributeValues: { ':pk': pk(userId) },
        }),
    );
    return (Items ?? []) as WatchlistEntry[];
}

export async function addToWatchlist(
    userId: string,
    wantedDate: string,
    wantedTime: string,
): Promise<void> {
    const existing = await docClient.send(
        new GetCommand({
            TableName: TABLE_NAME,
            Key: { pk: pk(userId), sk: sk(wantedDate, wantedTime) },
        }),
    );

    if (existing.Item?.status === 'pending') {
        console.log(`⚠️  Already on watchlist: ${wantedDate} at ${wantedTime}`);
        return;
    }

    await docClient.send(
        new PutCommand({
            TableName: TABLE_NAME,
            Item: {
                pk: pk(userId),
                sk: sk(wantedDate, wantedTime),
                wantedDate,
                wantedTime,
                addedAt: DateTime.now().toISO()!,
                status: 'pending' satisfies WatchlistEntry['status'],
            },
        }),
    );
}

export async function removeFromWatchlist(
    userId: string,
    wantedDate: string,
    wantedTime: string,
): Promise<void> {
    await docClient.send(
        new DeleteCommand({
            TableName: TABLE_NAME,
            Key: { pk: pk(userId), sk: sk(wantedDate, wantedTime) },
        }),
    );
}

/**
 * Removes every watchlist entry for a user. Used for GDPR data deletion.
 */
export async function clearWatchlist(userId: string): Promise<void> {
    const entries = await getWatchlist(userId);
    await Promise.all(
        entries.map((entry) => removeFromWatchlist(userId, entry.wantedDate, entry.wantedTime)),
    );
}

/**
 * Checks all pending watchlist entries for a user and attempts to
 * auto-book any that have entered the 2-week booking window.
 */
export async function processPendingWatchlist(
    userId: string,
    customer: AppointmentCustomer,
): Promise<void> {
    const allEntries = await getWatchlist(userId);
    const pending = allEntries.filter((e) => e.status === 'pending');

    if (pending.length === 0) return;

    console.log(`\n🔍 Checking ${pending.length} watchlist entry(ies)...\n`);

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
                console.log(`  ❌ ${entry.wantedTime} on ${entry.wantedDate} is not available`);
                continue;
            }

            const { appointment } = await createAppointment(match, customer);

            await docClient.send(
                new UpdateCommand({
                    TableName: TABLE_NAME,
                    Key: { pk: pk(userId), sk: sk(entry.wantedDate, entry.wantedTime) },
                    UpdateExpression: 'SET #status = :status',
                    ExpressionAttributeNames: { '#status': 'status' },
                    ExpressionAttributeValues: {
                        ':status': 'booked' satisfies WatchlistEntry['status'],
                    },
                }),
            );

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
}
