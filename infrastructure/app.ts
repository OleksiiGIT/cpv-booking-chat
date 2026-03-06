#!/usr/bin/env node
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
 * MVP stack — single-table DynamoDB, Telegram webhook Lambda, HTTP API, and Secrets Manager.
 *
 * After `cdk deploy`:
 *  1. Populate cpv-booking/bot in Secrets Manager with real values (if not done already).
 *  2. Run: curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" -d "url=<WebhookUrl output>"
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
        //   aws secretsmanager put-secret-value \
        //     --secret-id cpv-booking/bot \
        //     --secret-string '{"TELEGRAM_BOT_TOKEN":"...","BOOKING_COOKIE":"...","X_OWA_CANARY":"...","BOOKING_REMOTE_URL":"..."}'
        const botSecret = new secretsmanager.Secret(this, 'BotSecrets', {
            secretName: 'cpv-booking/bot',
            description:
                'Telegram bot token, OWA session cookie (BOOKING_COOKIE), ' +
                'OWA canary header (X_OWA_CANARY), and Bookings API URL. ' +
                'Value is managed externally via aws secretsmanager put-secret-value.',
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

        // ── API Gateway HTTP API ──────────────────────────────────────────────
        const httpApi = new apigatewayv2.HttpApi(this, 'BookingBotApi', {
            apiName: 'cpv-booking-bot-api',
            description: 'Webhook endpoint for the CPV Booking Telegram bot',
        });

        httpApi.addRoutes({
            path: '/telegram',
            methods: [apigatewayv2.HttpMethod.POST],
            integration: new HttpLambdaIntegration('TelegramIntegration', telegramHandler),
        });

        // ── Stack outputs ─────────────────────────────────────────────────────
        new cdk.CfnOutput(this, 'WebhookUrl', {
            value: `${httpApi.apiEndpoint}/telegram`,
            description: 'Use this URL with Telegram setWebhook after populating secrets',
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
    description: 'CPV Booking Bot — MVP stack (Telegram Lambda + HTTP API + DynamoDB + Secrets)',
});
