import { DeleteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { DateTime } from 'luxon';
import { docClient, TABLE_NAME } from '../db/dynamo';
import { UserProfile } from '../types';

const pk = (userId: string) => `profile#${userId}`;
const SK = 'PROFILE';

export async function getProfile(userId: string): Promise<UserProfile | null> {
    const { Item } = await docClient.send(
        new GetCommand({ TableName: TABLE_NAME, Key: { pk: pk(userId), sk: SK } }),
    );
    if (!Item) return null;

    const { pk: _pk, sk: _sk, createdAt: _c, updatedAt: _u, ...profile } = Item;
    return profile as UserProfile;
}

export async function saveProfile(userId: string, profile: UserProfile): Promise<void> {
    const now = DateTime.now().toISO()!;

    // Preserve createdAt if the profile already exists
    const existing = await docClient.send(
        new GetCommand({ TableName: TABLE_NAME, Key: { pk: pk(userId), sk: SK } }),
    );

    await docClient.send(
        new PutCommand({
            TableName: TABLE_NAME,
            Item: {
                pk: pk(userId),
                sk: SK,
                ...profile,
                createdAt: existing.Item?.createdAt ?? now,
                updatedAt: now,
            },
        }),
    );
}

export async function deleteProfile(userId: string): Promise<void> {
    await docClient.send(
        new DeleteCommand({ TableName: TABLE_NAME, Key: { pk: pk(userId), sk: SK } }),
    );
}
