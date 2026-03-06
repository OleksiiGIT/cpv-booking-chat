import { DeleteCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { DateTime } from 'luxon';
import { docClient, TABLE_NAME } from '../db/dynamo';
import { BookingRecord } from '../types';

/**
 * DynamoDB layout for booking records:
 *   pk  = booking#<userId>
 *   sk  = <startTime ISO>#<appointmentId>   ← ISO prefix keeps items in date order
 */
const pk = (userId: string) => `booking#${userId}`;
const sk = (startTime: string, appointmentId: string) => `${startTime}#${appointmentId}`;

export async function saveBookingRecord(userId: string, record: BookingRecord): Promise<void> {
    await docClient.send(
        new PutCommand({
            TableName: TABLE_NAME,
            Item: {
                pk: pk(userId),
                sk: sk(record.startTime, record.appointmentId),
                ...record,
            },
        }),
    );
}

/**
 * Returns all upcoming booking records for a user, sorted chronologically.
 * Only bookings whose start time is today or later are returned.
 */
export async function getUserBookingRecords(userId: string): Promise<BookingRecord[]> {
    const todayIso = DateTime.now().startOf('day').toISO()!;

    const { Items } = await docClient.send(
        new QueryCommand({
            TableName: TABLE_NAME,
            KeyConditionExpression: 'pk = :pk AND sk >= :from',
            ExpressionAttributeValues: {
                ':pk': pk(userId),
                ':from': todayIso,
            },
        }),
    );

    return (Items ?? []) as BookingRecord[];
}

/**
 * Deletes every booking record for a user. Used for GDPR data deletion.
 */
export async function clearBookingRecords(userId: string): Promise<void> {
    const { Items } = await docClient.send(
        new QueryCommand({
            TableName: TABLE_NAME,
            KeyConditionExpression: 'pk = :pk',
            ExpressionAttributeValues: { ':pk': pk(userId) },
            ProjectionExpression: 'sk',
        }),
    );

    if (!Items || Items.length === 0) return;

    await Promise.all(
        Items.map((item) =>
            docClient.send(
                new DeleteCommand({
                    TableName: TABLE_NAME,
                    Key: { pk: pk(userId), sk: item['sk'] },
                }),
            ),
        ),
    );
}
