// The Studio's Google Drive folder structure. Reuses the SAME connected
// account as the main site (config/googleDrive.js handles the OAuth
// connect/refresh flow — there's only ever one Drive account connected),
// just rooted under its own top-level folder so nothing mixes with regular
// task submissions.
//
// This file only builds out the ROOT folder for now (Phase 1). Per-task and
// per-leader-code subfolders (QA / Approved Male / Approved Female) get
// created when a task is published (Phase 2) and used during QA review
// (Phase 4) — see studio_drive_folders in db/migration_studio.sql for where
// those ids are cached once created.
const { google } = require("googleapis");
const { pool } = require("../db/pool");
const { getAuthorizedClient, shareWithAnyone } = require("./googleDrive");

const STUDIO_ROOT_FOLDER_NAME = "Nativoya Studio — Recordings";

async function getOrCreateStudioRootFolder() {
  const existing = await pool.query("SELECT studio_root_folder_id FROM google_auth LIMIT 1");
  const cached = existing.rows[0]?.studio_root_folder_id;
  if (cached) return cached;

  const client = await getAuthorizedClient();
  const drive = google.drive({ version: "v3", auth: client });

  const folder = await drive.files.create({
    requestBody: { name: STUDIO_ROOT_FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" },
    fields: "id",
  });
  await shareWithAnyone(drive, folder.data.id);

  await pool.query("UPDATE google_auth SET studio_root_folder_id = $1", [folder.data.id]);
  return folder.data.id;
}

// A small helper reused by later phases: one subfolder under a given
// parent, created once and reused after (never creates a duplicate for the
// same name+parent).
async function getOrCreateSubfolder(drive, parentId, name) {
  const existing = await drive.files.list({
    q: `'${parentId}' in parents and name = '${name.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: "files(id)",
  });
  if (existing.data.files.length) return existing.data.files[0].id;

  const folder = await drive.files.create({
    requestBody: { name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] },
    fields: "id",
  });
  await shareWithAnyone(drive, folder.data.id);
  return folder.data.id;
}

module.exports = { getOrCreateStudioRootFolder, getOrCreateSubfolder };
