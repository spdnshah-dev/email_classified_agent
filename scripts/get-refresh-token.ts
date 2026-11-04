/**
 * One-time local OAuth flow. Prints a refresh token for GOOGLE_REFRESH_TOKEN.
 *
 * Expects an OAuth client of type "Desktop app" (loopback redirect) and reads
 * GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET from .env or the environment.
 * Never writes the token anywhere; copy it from stdout into your secrets store.
 */
import 'dotenv/config';
import { createServer } from 'node:http';
import { google } from 'googleapis';
import { GMAIL_SCOPE } from '../lib/gmail.js';

const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
const port = Number(process.env.OAUTH_PORT ?? 53682);

if (!clientId || !clientSecret) {
  console.error(
    'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set (in .env or the environment).',
  );
  process.exit(1);
}

const redirectUri = `http://127.0.0.1:${port}`;
const oauth2 = new google.auth.OAuth2({ clientId, clientSecret, redirectUri });

const authUrl = oauth2.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: [GMAIL_SCOPE],
});

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', redirectUri);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  if (error) {
    res.writeHead(400, { 'Content-Type': 'text/plain' }).end(`OAuth error: ${error}`);
    console.error(`OAuth error: ${error}`);
    server.close();
    process.exit(1);
  }
  if (!code) {
    res.writeHead(404).end();
    return;
  }
  try {
    const { tokens } = await oauth2.getToken(code);
    res
      .writeHead(200, { 'Content-Type': 'text/plain' })
      .end('Authorised. You can close this tab and return to the terminal.');
    if (!tokens.refresh_token) {
      console.error(
        'No refresh_token in the response. Revoke the app at https://myaccount.google.com/permissions and run again (prompt=consent is already set).',
      );
      process.exit(1);
    }
    console.log('\nGOOGLE_REFRESH_TOKEN=' + tokens.refresh_token + '\n');
    console.log(
      'Store this in Vercel (Project → Settings → Environment Variables) and in your local .env.',
    );
    console.log('Do NOT commit it.');
  } catch (err) {
    res
      .writeHead(500, { 'Content-Type': 'text/plain' })
      .end('Token exchange failed; see terminal.');
    console.error('Token exchange failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Listening on ${redirectUri} for the OAuth redirect.`);
  console.log(
    '\nOpen this URL in your browser and approve access for the Gmail account to triage:\n',
  );
  console.log(authUrl + '\n');
  console.log(
    '(If Google shows "This app isn\'t verified", click Advanced → Go to <app> (unsafe).)',
  );
});
