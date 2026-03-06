/**
 * Pushes secret values from .env into AWS Secrets Manager.
 *
 * Usage:
 *   pnpm setup:secrets
 *
 * The script reads the four required keys from .env, serialises them as a
 * JSON object, then either CREATES the secret (first run) or UPDATES it if
 * it already exists.  Safe to re-run at any time.
 *
 * Required keys in .env:
 *   TELEGRAM_BOT_TOKEN, BOOKING_COOKIE, X_OWA_CANARY, BOOKING_REMOTE_URL
 *
 * AWS targeting (must match the region where the CDK stack was deployed):
 *   AWS_PROFILE  — defaults to "oleksii-personal"  (same as cdk:deploy)
 *   AWS_REGION   — defaults to "eu-west-2"
 *
 * WHY we delete the local fake credentials before building the client:
 *   .env sets AWS_ACCESS_KEY_ID=local / AWS_SECRET_ACCESS_KEY=local for the
 *   local DynamoDB emulator.  Those env vars rank ABOVE AWS_PROFILE in the
 *   SDK credential chain.  Deleting them here (after dotenv has already
 *   populated the app-level env vars we actually need) forces the SDK to fall
 *   through to the named CLI profile, which holds the real credentials.
 */

import * as dotenv from 'dotenv';
dotenv.config();

// ── Strip local-only credential env vars BEFORE the SDK client is created ────
// Must happen after dotenv.config() so the other .env values are still loaded.
delete process.env['AWS_ACCESS_KEY_ID'];
delete process.env['AWS_SECRET_ACCESS_KEY'];
delete process.env['AWS_SESSION_TOKEN'];

import {
    CreateSecretCommand,
    PutSecretValueCommand,
    ResourceExistsException,
    ResourceNotFoundException,
    SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

// ── Constants ─────────────────────────────────────────────────────────────────
const SECRET_NAME = 'cpv-booking/bot';
const AWS_PROFILE = process.env.AWS_PROFILE ?? 'oleksii-personal';
const AWS_REGION = process.env.AWS_REGION ?? 'eu-west-2';

const REQUIRED_KEYS = [
    'TELEGRAM_BOT_TOKEN',
    'BOOKING_COOKIE',
    'X_OWA_CANARY',
    'BOOKING_REMOTE_URL',
] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────
function buildSecretPayload(): string {
    const missing: string[] = [];
    const payload: Record<string, string> = {};

    for (const key of REQUIRED_KEYS) {
        const value = process.env[key];
        if (!value) {
            missing.push(key);
        } else {
            payload[key] = value;
        }
    }

    if (missing.length > 0) {
        console.error(`❌ Missing required env vars: ${missing.join(', ')}`);
        console.error('   Make sure they are set in your .env file.');
        process.exit(1);
    }

    return JSON.stringify(payload, null, 2);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function setupSecrets(): Promise<void> {
    console.log('🔐 AWS Secrets Manager — push secrets');
    console.log(`   Secret  : ${SECRET_NAME}`);
    console.log(`   Region  : ${AWS_REGION}`);
    console.log(`   Profile : ${AWS_PROFILE}`);
    console.log('');

    // AWS_PROFILE is already in process.env; the SDK picks it up automatically
    // now that the fake ACCESS_KEY_ID / SECRET_ACCESS_KEY have been removed.
    const client = new SecretsManagerClient({ region: AWS_REGION });

    const secretString = buildSecretPayload();

    // ── Try CREATE first ──────────────────────────────────────────────────────
    try {
        await client.send(
            new CreateSecretCommand({
                Name: SECRET_NAME,
                Description:
                    'Telegram bot token, OWA session cookie (BOOKING_COOKIE), ' +
                    'OWA canary header (X_OWA_CANARY), and Bookings API URL. ' +
                    'Managed via pnpm setup:secrets.',
                SecretString: secretString,
            }),
        );
        console.log(`✅ Secret "${SECRET_NAME}" created successfully.`);
        return;
    } catch (err) {
        if (!(err instanceof ResourceExistsException)) {
            throw err;
        }
        console.log(`ℹ️  Secret already exists — updating value…`);
    }

    // ── Secret exists → UPDATE ────────────────────────────────────────────────
    try {
        await client.send(
            new PutSecretValueCommand({
                SecretId: SECRET_NAME,
                SecretString: secretString,
            }),
        );
        console.log(`✅ Secret "${SECRET_NAME}" updated successfully.`);
    } catch (err) {
        if (err instanceof ResourceNotFoundException) {
            console.error(
                `❌ Secret "${SECRET_NAME}" not found in region "${AWS_REGION}".\n` +
                    `   Deploy the CDK stack first ("pnpm cdk:deploy"), then re-run this script.\n` +
                    `   Also verify AWS_REGION in .env matches where the stack was deployed.`,
            );
            process.exit(1);
        }
        throw err;
    }
}

setupSecrets().catch((err) => {
    console.error('❌ secrets-setup failed:', err);
    process.exit(1);
});
