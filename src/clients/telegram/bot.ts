import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { registerHandlers } from './handlers';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN environment variable is not set.');
}

export const bot = new Telegraf(token);

registerHandlers(bot);
