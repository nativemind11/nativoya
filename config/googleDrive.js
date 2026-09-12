const { google } = require("googleapis");
const { pool } = require("../db/pool");

const ROOT_FOLDER_NAME = "Nativoya — Task Submissions";
const SCOPES = ["https://www.googleapis.com/auth/drive.file"];

function makeOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

// Step 1 of the connect flow: where we send the head_leader's browser
function getAuthUrl() {
  const client = makeOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline", // required to get a refresh_token back
    prompt: "consent",       // forces a refresh_token even on repeat connects
    scope: SCOPES,
  });
}

// Step 2: exchange the ?code=... Google sent back for real tokens, and save
// them — there's only ever one row, so we just wipe and re-insert.
async function saveTokensFromCode(code) {
  const client = makeOAuthClient();
  const { tokens } = await client.getToken(code);

  client.setCredentials(tokens);
  const oauth2 = google.oauth2({ version: "v2", auth: client });
  const { data: profile } = await oauth2.userinfo.get();

  await pool.query("DELETE FROM google_auth");
  await pool.query(
    `INSERT INTO google_auth (account_email, access_token, refresh_token, expiry_date)
     VALUES ($1, $2, $3, $4)`,
    [profile.email, tokens.access_token, tokens.refresh_token, tokens.expiry_date]
  );

  return profile.email;
}

// Loads the saved tokens and returns a ready-to-use, auto-refreshing client.
// Throws a clear error if nobody has connected an account yet.
async function getAuthorizedClient() {
  const result = await pool.query("SELECT * FROM google_auth LIMIT 1");
  if (!result.rows.length) {
    const err = new Error("Google Drive isn't connected yet — a head_leader needs to connect it from the admin dashboard first.");
    err.code = "DRIVE_NOT_CONNECTED";
    throw err;
  }
  const row = result.rows[0];

  const client = makeOAuthClient();
  client.setCredentials({
    access_token: row.access_token,
    refresh_token: row.refresh_token,
    expiry_date: row.expiry_date ? Number(row.expiry_date) : undefined,
  });

  // googleapis refreshes the access_token automatically when it's near
  // expiry; persist the new one so we don't burn refresh attempts.
  client.on("tokens", async (tokens) => {
    if (tokens.access_token) {
      await pool.query(
        "UPDATE google_auth SET access_token = $1, expiry_date = $2, updated_at = now() WHERE id = $3",
        [tokens.access_token, tokens.expiry_date || null, row.id]
      ).catch((e) => console.error("Failed to persist refreshed Google token:", e));
    }
  });

  return client;
}

async function getOrCreateRootFolder(drive) {
  const existing = await pool.query("SELECT root_folder_id FROM google_auth LIMIT 1");
  const cached = existing.rows[0]?.root_folder_id;
  if (cached) return cached;

  const folder = await drive.files.create({
    requestBody: {
      name: ROOT_FOLDER_NAME,
      mimeType: "application/vnd.google-apps.folder",
    },
    fields: "id",
  });

  await pool.query("UPDATE google_auth SET root_folder_id = $1", [folder.data.id]);
  return folder.data.id;
}

// One folder per task (not per language/group) — everything submitted
// against that task, from any group, lands in the same place.
async function createTaskFolder(taskTitle, taskId) {
  const client = await getAuthorizedClient();
  const drive = google.drive({ version: "v3", auth: client });
  const rootId = await getOrCreateRootFolder(drive);

  const folder = await drive.files.create({
    requestBody: {
      name: `${taskTitle} (${taskId.slice(0, 8)})`,
      mimeType: "application/vnd.google-apps.folder",
      parents: [rootId],
    },
    fields: "id",
  });

  return folder.data.id;
}

// Uploads one submitted file into its task's folder and returns a link the
// leader can open to review it.
async function uploadSubmissionFile(folderId, filename, mimeType, buffer) {
  const { Readable } = require("stream");
  const client = await getAuthorizedClient();
  const drive = google.drive({ version: "v3", auth: client });

  const file = await drive.files.create({
    requestBody: { name: filename, parents: [folderId] },
    media: { mimeType, body: Readable.from(buffer) },
    fields: "id, webViewLink",
  });

  return { id: file.data.id, webViewLink: file.data.webViewLink };
}

async function isConnected() {
  const result = await pool.query("SELECT account_email FROM google_auth LIMIT 1");
  return result.rows[0]?.account_email || null;
}

module.exports = {
  getAuthUrl,
  saveTokensFromCode,
  createTaskFolder,
  uploadSubmissionFile,
  isConnected,
};
