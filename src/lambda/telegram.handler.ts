import 'dotenv/config';
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { bot } from '../clients/telegram/bot';

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

        const update = JSON.parse(rawBody);
        await bot.handleUpdate(update);
    } catch (err) {
        // Log to CloudWatch but swallow the error — surfacing it as a non-200
        // would make Telegram retry the update indefinitely.
        console.error('[TelegramHandler] Failed to process update:', err);
    }

    return { statusCode: 200, body: '' };
};
