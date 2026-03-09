/**
 * AWS Lambda entry point for the WhatsApp webhook (Meta Cloud API).
 *
 * API Gateway forwards both GET and POST /whatsapp requests here:
 *
 *   GET  /whatsapp — Meta webhook verification handshake (one-time setup).
 *                    Returns hub.challenge when hub.verify_token matches.
 *
 *   POST /whatsapp — Incoming messages from Meta.
 *                    Always returns HTTP 200; non-2xx triggers Meta retries.
 *
 * Secrets are loaded from Secrets Manager on the first (cold-start) invocation
 * and injected into process.env before any handler module is imported, so that
 * WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID are available to bot.ts.
 */
import 'dotenv/config';
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { WhatsAppMessage } from '../clients/whatsapp/handlers';

const secretsClient = new SecretsManagerClient({});

// Cached across warm invocations — loaded exactly once per container lifetime.
let secretsLoaded = false;

async function loadSecrets(): Promise<void> {
    if (secretsLoaded) return;

    const secretName = process.env.SECRET_NAME;
    if (!secretName) {
        console.warn('[WhatsAppHandler] SECRET_NAME env var not set — skipping secrets load');
        secretsLoaded = true;
        return;
    }

    console.log('[WhatsAppHandler] Cold start — loading secrets from Secrets Manager');
    const res = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretName }));

    if (!res.SecretString && res.SecretBinary) {
        throw new Error(
            `Secret "${secretName}" was stored as binary; re-run "pnpm setup:secrets" to push JSON.`,
        );
    }

    let secrets: Record<string, string>;
    try {
        secrets = JSON.parse(res.SecretString ?? '{}') as Record<string, string>;
    } catch {
        throw new Error(
            `Secret "${secretName}" is not valid JSON. Expected keys: ` +
                'WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_VERIFY_TOKEN, ' +
                'TELEGRAM_BOT_TOKEN, BOOKING_COOKIE, X_OWA_CANARY, BOOKING_REMOTE_URL. ' +
                'Re-run "pnpm setup:secrets" to push the correct format.',
        );
    }

    for (const [key, value] of Object.entries(secrets)) {
        process.env[key] = value;
    }
    console.log('[WhatsAppHandler] Secrets loaded:', Object.keys(secrets).join(', '));
    secretsLoaded = true;
}

// ─── Lambda handler ───────────────────────────────────────────────────────────

const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
    const method = event.requestContext.http.method.toUpperCase();

    // Load secrets first for every request — WHATSAPP_VERIFY_TOKEN is needed
    // by the GET verification handshake and is stored in Secrets Manager.
    // Results are cached after the first (cold-start) invocation.
    try {
        await loadSecrets();
    } catch (err) {
        console.error('[WhatsAppHandler] Failed to load secrets:', err);
        return { statusCode: 500, body: 'Internal Server Error' };
    }

    // ── GET: Meta webhook verification ────────────────────────────────────────
    if (method === 'GET') {
        const params = event.queryStringParameters ?? {};
        const mode = params['hub.mode'];
        const token = params['hub.verify_token'];
        const challenge = params['hub.challenge'] ?? '';
        const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;

        if (mode === 'subscribe' && token && token === verifyToken) {
            console.log('[WhatsAppHandler] Webhook verified successfully');
            return { statusCode: 200, body: challenge };
        }

        console.warn('[WhatsAppHandler] Webhook verification failed', { mode, token });
        return { statusCode: 403, body: 'Forbidden' };
    }

    // ── POST: Incoming message ─────────────────────────────────────────────────
    try {
        const rawBody = event.isBase64Encoded
            ? Buffer.from(event.body ?? '', 'base64').toString('utf-8')
            : (event.body ?? '{}');

        const payload = JSON.parse(rawBody) as Record<string, unknown>;

        // Navigate the Meta Cloud API payload envelope:
        // payload.entry[0].changes[0].value.messages[]
        const entry = (payload.entry as Array<Record<string, unknown>> | undefined)?.[0];
        const change = (entry?.changes as Array<Record<string, unknown>> | undefined)?.[0];
        const value = change?.value as Record<string, unknown> | undefined;
        const messages = value?.messages as WhatsAppMessage[] | undefined;

        if (!messages || messages.length === 0) {
            // Delivery receipts and read notifications — no action needed.
            return { statusCode: 200, body: '' };
        }

        // Dynamic import ensures bot.ts is evaluated AFTER secrets are in process.env.
        const { handleIncomingMessage } = await import('../clients/whatsapp/handlers');

        for (const message of messages) {
            console.log(
                `[WhatsAppHandler] Processing message from ${message.from}, type=${message.type}`,
            );
            try {
                await handleIncomingMessage(message);
            } catch (err) {
                console.error(
                    `[WhatsAppHandler] Error handling message from ${message.from}:`,
                    err,
                );
            }
        }
    } catch (err) {
        // Log but swallow — surfacing a non-200 makes Meta retry indefinitely.
        console.error('[WhatsAppHandler] Unhandled error:', err);
    }

    return { statusCode: 200, body: '' };
};
export { handler };
