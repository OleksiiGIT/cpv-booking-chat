/**
 * WhatsApp Cloud API (Meta) — outbound message helpers.
 *
 * All functions read WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID from
 * process.env at call time so that the Lambda cold-start can inject them
 * from Secrets Manager before any message is sent.
 */
import axios from 'axios';

const GRAPH_API_BASE = 'https://graph.facebook.com/v20.0';

function getPhoneNumberId(): string {
    const id = process.env.WHATSAPP_PHONE_ID;
    if (!id) throw new Error('WHATSAPP_PHONE_ID environment variable is not set.');
    return id;
}

function getToken(): string {
    const token = process.env.WHATSAPP_ACCESS_TOKEN;
    if (!token) throw new Error('WHATSAPP_ACCESS_TOKEN environment variable is not set.');
    return token;
}

async function sendRequest(payload: object): Promise<void> {
    const url = `${GRAPH_API_BASE}/${getPhoneNumberId()}/messages`;
    await axios.post(url, payload, {
        headers: {
            Authorization: `Bearer ${getToken()}`,
            'Content-Type': 'application/json',
        },
    });
}

// ─── Text ─────────────────────────────────────────────────────────────────────

export async function sendText(to: string, text: string): Promise<void> {
    await sendRequest({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: text },
    });
}

// ─── Interactive: buttons ─────────────────────────────────────────────────────

export type ButtonOption = { id: string; title: string };

/**
 * Send an interactive reply-button message.
 * The Meta API accepts 1–3 buttons; titles are capped at 20 characters.
 */
export async function sendButtons(
    to: string,
    body: string,
    buttons: [ButtonOption, ...ButtonOption[]],
): Promise<void> {
    await sendRequest({
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
            type: 'button',
            body: { text: body },
            action: {
                buttons: buttons.slice(0, 3).map((b) => ({
                    type: 'reply',
                    reply: {
                        id: b.id,
                        // Button titles are capped at 20 chars by the Meta API.
                        title: b.title.slice(0, 20),
                    },
                })),
            },
        },
    });
}

// ─── Interactive: list ────────────────────────────────────────────────────────

export type ListRow = { id: string; title: string; description?: string };
export type ListSection = { title: string; rows: ListRow[] };

/**
 * Send an interactive list message.
 * Total rows across ALL sections must not exceed 10 (Meta API hard limit).
 * Row titles ≤ 24 chars; section titles ≤ 24 chars; button label ≤ 20 chars.
 */
export async function sendList(
    to: string,
    body: string,
    buttonLabel: string,
    sections: ListSection[],
): Promise<void> {
    await sendRequest({
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
            type: 'list',
            body: { text: body },
            action: {
                button: buttonLabel.slice(0, 20),
                sections,
            },
        },
    });
}
