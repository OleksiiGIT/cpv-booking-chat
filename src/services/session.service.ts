import { DeleteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAME } from '../db/dynamo';
import { ConversationSession } from '../types';

/** Sessions expire after 30 minutes of inactivity. */
const TTL_SECONDS = 30 * 60;

const pk = (userId: string) => `session#${userId}`;
const SK = 'SESSION';

// ─── Session schema reference ─────────────────────────────────────────────────
//
// Every active session stored in DynamoDB looks like:
//
//   PK  "session#<userId>"   SK  "SESSION"   ttl  <unix epoch + 30 min>
//   { step, ...stepFields }
//
// Step                  | Populated fields
// ──────────────────────┼──────────────────────────────────────────────────────
// onboarding_name       | —
// onboarding_email      | onboardingName
// onboarding_phone      | onboardingName, onboardingEmail
// onboarding_membership | onboardingName, onboardingEmail, onboardingPhone
// onboarding_address    | onboardingName, onboardingEmail, onboardingPhone,
//                       |   onboardingMembership
// ──────────────────────┼──────────────────────────────────────────────────────
// awaiting_date         | (selectedDate — set when a beyond-window date is
//                       |   entered so the watchlist offer can reference it)
// awaiting_slot         | selectedDate, availableSlots, slotPage
// awaiting_watchlist_time| selectedDate
// confirming            | selectedDate, selectedSlot
// ──────────────────────┼──────────────────────────────────────────────────────
// instant_book          | Bot is waiting for a single free-text message in the
//                       | form "DD/MM/YYYY HH:mm[, HH:mm …]".
//                       |
//                       | Sub-states within this step:
//                       |   • Awaiting input   → { step: 'instant_book' }
//                       |   • Beyond-window    → { step: 'instant_book',
//                       |       selectedDate, instantBookTimes }
//                       |     The bot has shown a watchlist-offer prompt and is
//                       |     waiting for the user to confirm or reject it.
//                       |     instantBookTimes holds the HH:mm strings to add.
// ──────────────────────┼──────────────────────────────────────────────────────
// done                  | (terminal — cleared immediately after use)
//
// ─────────────────────────────────────────────────────────────────────────────

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
