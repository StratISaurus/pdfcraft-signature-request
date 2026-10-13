import { startRelay } from './relay.js';

try {
  const relay = await startRelay({ bootstrapToken: process.env.RELAY_BOOTSTRAP_TOKEN, port: Number(process.env.PORT ?? 8787) });
  delete process.env.RELAY_BOOTSTRAP_TOKEN;
  console.log(`Experimental local relay listening at ${relay.url}; volatile storage; no PDF signing.`);
  const stop = async () => { await relay.close(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
} catch {
  // Never print configuration, headers, request bodies, tokens or exception details.
  console.error('Relay startup failed. Supply RELAY_BOOTSTRAP_TOKEN (32 random bytes, base64url) and a valid PORT.');
  process.exitCode = 1;
}
