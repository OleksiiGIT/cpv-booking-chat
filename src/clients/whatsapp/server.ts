/**
 * Local development server for the WhatsApp webhook.
 *
 * WhatsApp (Meta Cloud API) does not support long-polling — it only sends
 * messages via webhooks.  For local testing, expose this server with ngrok:
 *
 *   pnpm dev:WhatsApp # starts the server on PORT (default 3001)
 *   npx ngrok http 3001        # exposes it at https://<random>.ngrok.io
 *
 * Then register the ngrok URL as your webhook in the Meta Developer Console:
 *   Webhook URL:   https://<random>.ngrok.io/whatsapp
 *   Verify token:  value of WHATSAPP_VERIFY_TOKEN in .env
 */
import 'dotenv/config';
import http from 'http';
import { APIGatewayProxyEventV2 } from 'aws-lambda';
import { handler } from '../../lambda/whatsapp.handler';

const PORT = parseInt(process.env.PORT ?? '3001', 10);

const server = http.createServer((req, res) => {
    const urlObj = new URL(req.url ?? '/', `http://localhost:${PORT}`);
    const chunks: Buffer[] = [];

    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', async () => {
        const body = Buffer.concat(chunks).toString('utf-8');

        // Build a minimal fake APIGatewayProxyEventV2 so the shared handler works.
        const fakeEvent = {
            requestContext: { http: { method: req.method ?? 'GET' } },
            queryStringParameters: Object.fromEntries(urlObj.searchParams.entries()),
            body: body || '{}',
            isBase64Encoded: false,
        } as unknown as APIGatewayProxyEventV2;

        try {
            const result = await handler(fakeEvent);
            const statusCode =
                result && typeof result === 'object' && 'statusCode' in result
                    ? (result as { statusCode: number }).statusCode
                    : 200;
            const responseBody =
                result && typeof result === 'object' && 'body' in result
                    ? ((result as { body: string }).body ?? '')
                    : '';

            res.writeHead(statusCode, { 'Content-Type': 'text/plain' });
            res.end(responseBody);
        } catch (err) {
            console.error('[WhatsAppServer] Unhandled error:', err);
            res.writeHead(500);
            res.end('Internal Server Error');
        }
    });
});

server.listen(PORT, () => {
    console.log(`🤖 WhatsApp webhook server running on http://localhost:${PORT}/whatsapp`);
    console.log(`   Expose with: npx ngrok http ${PORT}`);
    console.log('   Then register https://<ngrok-id>.ngrok.io/whatsapp in the Meta Console.');
});

process.once('SIGINT', () => server.close());
process.once('SIGTERM', () => server.close());
