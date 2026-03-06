import 'dotenv/config';
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { Telegraf } from 'telegraf';

const secretsClient = new SecretsManagerClient({});

// Cached across warm invocations — initialised once per container lifetime.
let bot: Telegraf | null = null;

/**
 * Cold-start bootstrap:
 *  1. Fetch the JSON secret from Secrets Manager.
 *  2. Spread every key into process.env so that booking.service.ts (which reads
 *     BOOKING_COOKIE / X_OWA_CANARY / BOOKING_REMOTE_URL as module-level consts)
 *     picks up real values on its first import.
 *  3. Dynamically import bot.ts — module caching means this only executes once.
 */
async function getBot(): Promise<Telegraf> {
    if (bot) return bot;

    console.log('[TelegramHandler] Cold start — loading secrets from Secrets Manager');
    const secretName = process.env.SECRET_NAME;
    if (secretName) {
        const res = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretName }));

        // SecretBinary means the secret was stored as binary — we can't use it.
        if (!res.SecretString && res.SecretBinary) {
            throw new Error(
                `Secret "${secretName}" was stored as binary, but a JSON string is required. ` +
                    `Re-run "pnpm setup:secrets" to push the correct format.`,
            );
        }

        let secrets: Record<string, string>;
        try {
            secrets = JSON.parse(res.SecretString ?? '{}') as Record<string, string>;
        } catch {
            // SecretString exists but is not valid JSON — the secret was probably
            // stored as a plain string instead of a JSON object.
            throw new Error(
                `Secret "${secretName}" is not valid JSON. ` +
                    `Expected: {"TELEGRAM_BOT_TOKEN":"...","BOOKING_COOKIE":"...","X_OWA_CANARY":"...","BOOKING_REMOTE_URL":"..."}. ` +
                    `Re-run "pnpm setup:secrets" to push the correct format.`,
            );
        }

        // Inject every secret key as an env var before any dependent module loads.
        for (const [key, value] of Object.entries(secrets)) {
            process.env[key] = value;
        }
        console.log('[TelegramHandler] Secrets loaded:', Object.keys(secrets).join(', '));
    } else {
        console.warn('[TelegramHandler] SECRET_NAME env var is not set — skipping secrets load');
    }

    // Dynamic import ensures booking.service.ts and bot.ts are evaluated AFTER
    // the env vars above are set, so their module-level constants are correct.
    const { bot: initialised } = await import('../clients/telegram/bot');
    bot = initialised;
    console.log('[TelegramHandler] Bot initialised');
    return bot;
}

/** Extracts a human-readable label from any Telegram Update for logging. */
function describeUpdate(update: Record<string, unknown>): string {
    if (update.message) {
        const msg = update.message as Record<string, unknown>;
        const from = msg.from as Record<string, unknown> | undefined;
        const text = typeof msg.text === 'string' ? `"${msg.text.slice(0, 40)}"` : '(no text)';
        return `message from ${from?.username ?? from?.id ?? 'unknown'} — ${text}`;
    }
    if (update.callback_query) {
        const cq = update.callback_query as Record<string, unknown>;
        const from = cq.from as Record<string, unknown> | undefined;
        return `callback_query from ${from?.username ?? from?.id ?? 'unknown'} — data="${cq.data}"`;
    }
    const type = Object.keys(update).find((k) => k !== 'update_id') ?? 'unknown';
    return `update type: ${type}`;
}

/**
 * AWS Lambda entry point for the Telegram webhook.
 *
 * API Gateway (HTTP API) forwards every POST /telegram request here.
 * Telegraf's handleUpdate processes the incoming Update and dispatches
 * it to the registered handlers in src/clients/telegram/handlers.ts.
 *
 * Important: always return HTTP 200 to Telegram — a non-2xx response
 * causes Telegram to retry the same update repeatedly.
 */
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
    try {
        const rawBody = event.isBase64Encoded
            ? Buffer.from(event.body ?? '', 'base64').toString('utf-8')
            : (event.body ?? '{}');

        const update = JSON.parse(rawBody) as Record<string, unknown>;
        console.log(`[TelegramHandler] Received ${describeUpdate(update)}`);

        const resolvedBot = await getBot();
        await resolvedBot.handleUpdate(
            update as unknown as Parameters<typeof resolvedBot.handleUpdate>[0],
        );

        console.log('[TelegramHandler] Update handled successfully');
    } catch (err) {
        // Log to CloudWatch but swallow the error — surfacing it as a non-200
        // would make Telegram retry the update indefinitely.
        console.error('[TelegramHandler] Failed to process update:', err);
    }

    return { statusCode: 200, body: '' };
};
