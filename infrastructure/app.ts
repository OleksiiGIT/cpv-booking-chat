#!/usr/bin/env node
import 'dotenv/config';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

/**
 * MVP stack — single-table DynamoDB, Telegram + WhatsApp webhook Lambdas, HTTP API, and Secrets Manager.
 *
 * After `cdk deploy`:
 *  1. Populate cpv-booking/bot in Secrets Manager with real values (if not done already):
 *       pnpm setup:secrets
 *  2. Register the Telegram webhook:
 *       curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" -d "url=<WebhookUrl output>"
 *  3. Register the WhatsApp webhook in the Meta Developer Console:
 *       Webhook URL  → <WhatsAppWebhookUrl output>
 *       Verify Token → value of WHATSAPP_VERIFY_TOKEN in .env
 */
export class BookingBotStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        // ── DynamoDB single table (sessions + profiles + watchlist) ───────────
        const table = new dynamodb.TableV2(this, 'BookingTable', {
            tableName: 'cpv-booking',
            partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
            sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
            billing: dynamodb.Billing.onDemand(),
            timeToLiveAttribute: 'ttl',
            // RETAIN so a stack teardown never wipes real booking / profile data.
            removalPolicy: cdk.RemovalPolicy.RETAIN,
        });

        // ── Secrets Manager ───────────────────────────────────────────────────
        // The secret VALUE is managed externally — never set secretObjectValue here.
        // Setting it would cause every `cdk deploy` to overwrite real values back
        // to placeholders. Populate once (and rotate) with:
        //   pnpm setup:secrets
        // Required keys: TELEGRAM_BOT_TOKEN, WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID,
        //                WHATSAPP_VERIFY_TOKEN, BOOKING_COOKIE, X_OWA_CANARY, BOOKING_REMOTE_URL
        const botSecret = new secretsmanager.Secret(this, 'BotSecrets', {
            secretName: 'cpv-booking/bot',
            description:
                'Bot tokens (Telegram + WhatsApp), OWA session cookie (BOOKING_COOKIE), ' +
                'OWA canary header (X_OWA_CANARY), Bookings API URL, and WhatsApp verify token. ' +
                'Value is managed externally via pnpm setup:secrets.',
        });

        // ── Lambda: TelegramHandler ───────────────────────────────────────────
        const telegramHandler = new NodejsFunction(this, 'TelegramHandler', {
            // Path relative to this file: ../../src/lambda/telegram.handler.ts
            entry: path.join(__dirname, '../src/lambda/telegram.handler.ts'),
            handler: 'handler',
            runtime: lambda.Runtime.NODEJS_22_X,
            // API Gateway HTTP API hard-caps at 30 s; stay 1 s under to guarantee
            // a clean Lambda response before the gateway times out.
            timeout: cdk.Duration.seconds(29),
            memorySize: 256,
            environment: {
                DYNAMODB_TABLE_NAME: table.tableName,
                SECRET_NAME: botSecret.secretName,
                AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
                NODE_OPTIONS: '--enable-source-maps',
            },
            bundling: {
                // esbuild bundles everything; AWS SDK v3 is pre-installed on the
                // Node 22 runtime so we exclude it to keep the zip small.
                minify: true,
                sourceMap: true,
                externalModules: ['@aws-sdk/*'],
            },
        });

        // Grant the Lambda least-privilege access to both resources.
        table.grantReadWriteData(telegramHandler);
        botSecret.grantRead(telegramHandler);

        // ── Lambda: WhatsAppHandler ───────────────────────────────────────────
        const whatsappHandler = new NodejsFunction(this, 'WhatsAppHandler', {
            entry: path.join(__dirname, '../src/lambda/whatsapp.handler.ts'),
            handler: 'handler',
            runtime: lambda.Runtime.NODEJS_22_X,
            timeout: cdk.Duration.seconds(29),
            memorySize: 256,
            environment: {
                DYNAMODB_TABLE_NAME: table.tableName,
                SECRET_NAME: botSecret.secretName,
                AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
                NODE_OPTIONS: '--enable-source-maps',
            },
            bundling: {
                minify: true,
                sourceMap: true,
                externalModules: ['@aws-sdk/*'],
            },
        });

        table.grantReadWriteData(whatsappHandler);
        botSecret.grantRead(whatsappHandler);

        // ── API Gateway HTTP API ──────────────────────────────────────────────
        const httpApi = new apigatewayv2.HttpApi(this, 'BookingBotApi', {
            apiName: 'cpv-booking-bot-api',
            description: 'Webhook endpoints for the CPV Booking Telegram + WhatsApp bots',
        });

        httpApi.addRoutes({
            path: '/telegram',
            methods: [apigatewayv2.HttpMethod.POST],
            integration: new HttpLambdaIntegration('TelegramIntegration', telegramHandler),
        });

        // GET /whatsapp — Meta webhook verification handshake
        // POST /whatsapp — Incoming messages from Meta Cloud API
        httpApi.addRoutes({
            path: '/whatsapp',
            methods: [apigatewayv2.HttpMethod.GET, apigatewayv2.HttpMethod.POST],
            integration: new HttpLambdaIntegration('WhatsAppIntegration', whatsappHandler),
        });

        // ── Stack outputs ─────────────────────────────────────────────────────
        new cdk.CfnOutput(this, 'WebhookUrl', {
            value: `${httpApi.apiEndpoint}/telegram`,
            description: 'Use this URL with Telegram setWebhook after populating secrets',
        });

        new cdk.CfnOutput(this, 'WhatsAppWebhookUrl', {
            value: `${httpApi.apiEndpoint}/whatsapp`,
            description:
                'Register this URL in the Meta Developer Console as the WhatsApp webhook. ' +
                'Set Verify Token to the value of WHATSAPP_VERIFY_TOKEN in your secret.',
        });

        new cdk.CfnOutput(this, 'TableName', {
            value: table.tableName,
            description: 'DynamoDB table name — set as DYNAMODB_TABLE_NAME in local .env',
        });

        new cdk.CfnOutput(this, 'SecretArn', {
            value: botSecret.secretArn,
            description:
                'Secrets Manager ARN — populate BOOKING_COOKIE, X_OWA_CANARY, TELEGRAM_BOT_TOKEN, BOOKING_REMOTE_URL',
        });
    }
}

// ── CDK App ───────────────────────────────────────────────────────────────────
const app = new cdk.App();

new BookingBotStack(app, 'CpvBookingBotStack', {
    env: {
        // Fall back to eu-west-2 (London) — matches the DynamoDB region in dynamo.ts.
        account: process.env.CDK_DEFAULT_ACCOUNT,
        region: process.env.CDK_DEFAULT_REGION ?? 'eu-west-2',
    },
    description: 'CPV Booking Bot — Telegram + WhatsApp Lambdas, HTTP API, DynamoDB, Secrets',
});
