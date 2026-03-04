import 'dotenv/config';
import { bot } from './bot';

// Long-polling mode — for local development only.
// In production the Lambda handler (src/lambda/telegram.handler.ts) is used instead.
bot.launch({ dropPendingUpdates: true });

console.log('🤖 Telegram bot is running in polling mode. Press Ctrl+C to stop.');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
