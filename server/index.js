import { openDatabase } from './database.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT || 4310);
const host = process.env.HOST || '127.0.0.1';
const database = await openDatabase();
const app = await createApp({
  database,
  logger: true,
  origin: process.env.APP_ORIGIN || `http://localhost:${port}`,
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await app.close();
  await database.close();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

try {
  await app.listen({ port, host });
  app.log.info(`Database: ${database.mode}. Webhook Lab local MVP is ready.`);
} catch (error) {
  app.log.error(error);
  await shutdown();
  process.exitCode = 1;
}
