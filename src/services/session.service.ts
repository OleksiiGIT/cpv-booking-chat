import { DeleteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAME } from '../db/dynamo';
import { ConversationSession } from '../types';

/** Sessions expire after 30 minutes of inactivity. */
const TTL_SECONDS = 30 * 60;

const pk = (userId: string) => `session#${userId}`;
const SK = 'SESSION';

/**
 * Returns the active conversation session for a user, or `null` if none exists
 * (expired or never started).
 */
export async function getSession(userId: string): Promise<ConversationSession | null> {
    const { Item } = await docClient.send(
        new GetCommand({ TableName: TABLE_NAME, Key: { pk: pk(userId), sk: SK } }),
    );

    if (!Item) return null;

    const { pk: _pk, sk: _sk, ttl: _ttl, ...session } = Item;
    return session as ConversationSession;
}

/**
 * Persists the conversation session for a user and resets the TTL to 30 minutes
 * from now. Overwrites any existing session.
 */
export async function setSession(userId: string, session: ConversationSession): Promise<void> {
    const ttl = Math.floor(Date.now() / 1000) + TTL_SECONDS;

    await docClient.send(
        new PutCommand({
            TableName: TABLE_NAME,
            Item: {
                pk: pk(userId),
                sk: SK,
                ...session,
                ttl,
            },
        }),
    );
}

/**
 * Removes the conversation session for a user. Call this when the flow reaches
 * a terminal state (booking confirmed, cancelled, or errored out).
 */
export async function clearSession(userId: string): Promise<void> {
    await docClient.send(
        new DeleteCommand({ TableName: TABLE_NAME, Key: { pk: pk(userId), sk: SK } }),
    );
}
