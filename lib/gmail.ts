import { google } from "googleapis";

/**
 * Read scope for the inboxes we poll.
 *
 * gmail.send is NOT here on purpose: every restaurant that connects an inbox
 * grants these scopes, and none of them should be granting us the ability to
 * send as them. The outbound leg uses its own grant - see SEND_SCOPES.
 */
const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

/**
 * Send scope, for the single PFD sending identity (info@pfdworks.com).
 * Separate consent, separate stored token, so read access and send access are
 * never bundled into one grant a restaurant is asked to approve.
 */
export const SEND_SCOPES = ["https://www.googleapis.com/auth/gmail.send"];

/**
 * Marks an OAuth callback as a sender grant rather than an inbox connection.
 * Lives here rather than in the route: a Next.js route file may only export
 * its handlers and a fixed set of config fields, and exporting anything else
 * fails the BUILD rather than typecheck.
 */
export const SENDER_STATE = "pfd-sender";

export function getGoogleSendAuthUrl(state: string) {
  const client = getOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SEND_SCOPES,
    state,
  });
}

export function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI // e.g. https://your-app.vercel.app/api/auth/callback/google
  );
}

/** Builds the URL the restaurant is sent to in order to grant PFD access to their inbox. */
export function getGoogleAuthUrl(state: string) {
  const client = getOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline", // required to get a refresh_token
    prompt: "consent", // force refresh_token on every connect, not just the first time
    scope: SCOPES,
    state,
  });
}

/** Exchanges the one-time ?code= from Google's redirect for tokens. */
export async function exchangeCodeForTokens(code: string) {
  const client = getOAuthClient();
  const { tokens } = await client.getToken(code);
  return tokens; // { access_token, refresh_token, expiry_date, ... }
}

/** Returns a Gmail API client authenticated as the given restaurant's monitored inbox. */
export function getGmailClient(refreshToken: string) {
  const client = getOAuthClient();
  client.setCredentials({ refresh_token: refreshToken });
  return google.gmail({ version: "v1", auth: client });
}

/**
 * Searches a mailbox for unread order emails from the configured sender,
 * newer than `afterEpochSeconds`. Uses Gmail search syntax, which is far
 * cheaper than paging through history for an MVP polling job.
 */
export async function listOrderMessageIds(
  refreshToken: string,
  senderFilter: string,
  afterEpochSeconds: number
) {
  const gmail = getGmailClient(refreshToken);
  // Spam is included deliberately. Gmail sometimes misclassifies automated
  // order emails, and the API omits spam unless asked - so an order silently
  // vanishes, which is precisely the failure a restaurant cannot notice. The
  // sender + subject filters are narrow enough to make this safe. Trash stays
  // excluded: a deleted message is a deliberate act.
  const q = `from:(${senderFilter}) after:${afterEpochSeconds} -in:trash`;
  const res = await gmail.users.messages.list({
    userId: "me",
    q,
    maxResults: 25,
    includeSpamTrash: true,
  });
  return (res.data.messages || []).map((m) => m.id!).filter(Boolean);
}

/** Fetches a single message and returns its subject + HTML body. */
export async function getMessageContent(refreshToken: string, messageId: string) {
  const gmail = getGmailClient(refreshToken);
  const res = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });

  const payload = res.data.payload;
  const headers = payload?.headers || [];
  const subject = headers.find((h) => h.name === "Subject")?.value || "";
  const from = headers.find((h) => h.name === "From")?.value || "";
  const dateHeader = headers.find((h) => h.name === "Date")?.value || "";

  const html = extractHtmlPart(payload) || "";

  return { subject, from, dateHeader, html, messageId };
}

function extractHtmlPart(part: any): string | null {
  if (!part) return null;
  if (part.mimeType === "text/html" && part.body?.data) {
    return Buffer.from(part.body.data, "base64").toString("utf-8");
  }
  if (part.parts) {
    for (const p of part.parts) {
      const found = extractHtmlPart(p);
      if (found) return found;
    }
  }
  return null;
}
