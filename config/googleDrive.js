const { google } = require("googleapis");
const { pool } = require("../db/pool");

const ROOT_FOLDER_NAME = "Nativoya — Task Submissions";
const SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/userinfo.email",
];

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

  let email = "غير معروف";
  try {
    const oauth2 = google.oauth2({ version: "v2", auth: client });
    const { data: profile } = await oauth2.userinfo.get();
    email = profile.email || email;
  } catch (err) {
    console.warn("Could not fetch connected account's email (non-fatal):", err.message);
  }

  await pool.query("DELETE FROM google_auth");
  await pool.query(
    `INSERT INTO google_auth (account_email, access_token, refresh_token, expiry_date)
     VALUES ($1, $2, $3, $4)`,
    [email, tokens.access_token, tokens.refresh_token, tokens.expiry_date]
  );

  return email;
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

// Files/folders created via the Drive API are private to the connected
// account by default — anyone else opening the link gets Google's "request
// access" wall. Everything here is meant to be openable by any member or
// leader who has the link, so we explicitly grant "anyone with the link can
// view" right after creating it. Folder-level sharing normally covers files
// added to it later too, but we set it at every level (root, task folder,
// leader subfolder, and each uploaded file) so nothing slips through
// regardless of Drive's inheritance timing.
async function shareWithAnyone(drive, fileId) {
  try {
    await drive.permissions.create({
      fileId,
      requestBody: { role: "reader", type: "anyone" },
    });
  } catch (err) {
    console.error("[googleDrive] Could not set link-sharing on", fileId, err.message);
  }
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
  await shareWithAnyone(drive, folder.data.id);

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
  await shareWithAnyone(drive, folder.data.id);

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
  await shareWithAnyone(drive, file.data.id);

  return { id: file.data.id, webViewLink: file.data.webViewLink };
}

// A member in a LEADER's group has their work reviewed by that leader before
// it counts — so inside the task's folder, we give each leader their own
// clearly-named subfolder (created once, reused after) instead of dumping
// every group's files together. Members in a base (leaderless) group upload
// straight into the task's root folder, same as before.
async function getOrCreateLeaderFolder(taskFolderId, leaderLabel) {
  const client = await getAuthorizedClient();
  const drive = google.drive({ version: "v3", auth: client });

  const safeLabel = leaderLabel.replace(/'/g, "\\'");
  const existing = await drive.files.list({
    q: `'${taskFolderId}' in parents and name = '${safeLabel}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: "files(id)",
  });
  if (existing.data.files && existing.data.files.length) {
    return existing.data.files[0].id;
  }

  const folder = await drive.files.create({
    requestBody: {
      name: leaderLabel,
      mimeType: "application/vnd.google-apps.folder",
      parents: [taskFolderId],
    },
    fields: "id",
  });
  await shareWithAnyone(drive, folder.data.id);
  return folder.data.id;
}

// Step 1 of a direct-to-Drive upload: ask Drive to open a resumable upload
// session and hand back its one-time URL. The actual file bytes are PUT to
// that URL straight from the browser — never relayed through our own
// server — which is what lets recordings bigger than our host's request
// body limit (a few MB on Vercel) upload successfully.
//
// Google only allows a browser to PUT to the resulting session URL from an
// origin that was declared on THIS initiating request — so we pass the
// browser's actual Origin header through here (it must match exactly what
// the browser sends on the follow-up PUT, or Drive blocks it as CORS).
async function initResumableUpload(folderId, filename, mimeType, origin) {
  const client = await getAuthorizedClient();
  const headers = {
    "Content-Type": "application/json; charset=UTF-8",
    "X-Upload-Content-Type": mimeType || "application/octet-stream",
  };
  if (origin) headers["Origin"] = origin;
  const response = await client.request({
    url: "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable",
    method: "POST",
    headers,
    data: { name: filename, parents: [folderId] },
  });
  const uploadUrl = response.headers["location"] || response.headers["Location"];
  if (!uploadUrl) throw new Error("Drive did not return a resumable upload URL");
  return uploadUrl;
}

// Step 2, after the browser's own PUT to that URL finished: make the newly
// created file link-viewable and return its link to store on the submission.
async function shareFileWithAnyone(fileId) {
  const client = await getAuthorizedClient();
  const drive = google.drive({ version: "v3", auth: client });
  await shareWithAnyone(drive, fileId);
  const meta = await drive.files.get({ fileId, fields: "webViewLink" });
  return meta.data.webViewLink;
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
  getOrCreateLeaderFolder,
  initResumableUpload,
  shareFileWithAnyone,
  isConnected,
};
