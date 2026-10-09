/**
 * Drive-backed storage for the delivery step. This is the ONLY file that
 * knows ZIPs live on Google Drive: when storage moves (e.g. to Supabase
 * Storage / R2 for high volume) only openSessionZip + uploadStream change —
 * the grouping, claiming, rollback and Excel logic in studioDelivery.js stay.
 */
const { google } = require("googleapis");
const { getAuthorizedClient, shareWithAnyone } = require("./googleDrive");
const { getOrCreateStudioRootFolder, getOrCreateSubfolder } = require("./studioDrive");
const { createArchiveStorage } = require("./studioDelivery");

function fileIdFromUrl(url) {
  const m = String(url || "").match(/\/file\/d\/([^/?#]+)/) || String(url || "").match(/[-\w]{25,}/);
  if (!m) throw new Error("رابط ملف الـ ZIP غير صالح");
  return m[1] || m[0];
}

async function driveClient() {
  const auth = await getAuthorizedClient();
  return google.drive({ version: "v3", auth });
}

// Streams one session's ZIP down from Drive (never buffered in memory).
async function openSessionZip(session) {
  const drive = await driveClient();
  const res = await drive.files.get({ fileId: fileIdFromUrl(session.zip_file_url), alt: "media" }, { responseType: "stream" });
  return res.data;
}

// Streams the merged archive straight up to  <task folder>/Delivered/.
async function uploadStream({ task, fileName, stream }) {
  const drive = await driveClient();
  const root = await getOrCreateStudioRootFolder();
  const taskFolder = await getOrCreateSubfolder(drive, root, `${task.title} — ${task.id.slice(0, 8)}`);
  const deliveredFolder = await getOrCreateSubfolder(drive, taskFolder, "Delivered");
  const file = await drive.files.create({
    requestBody: { name: fileName, parents: [deliveredFolder] },
    media: { mimeType: "application/zip", body: stream },
    fields: "id, webViewLink, size",
  });
  await shareWithAnyone(drive, file.data.id);
  return {
    url: file.data.webViewLink || `https://drive.google.com/file/d/${file.data.id}/view`,
    size: file.data.size ? Number(file.data.size) : null,
  };
}

module.exports = {
  driveStorage: createArchiveStorage({ openSessionZip, uploadStream }),
  fileIdFromUrl,
};
