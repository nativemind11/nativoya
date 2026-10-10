/**
 * Object storage for the Studio's audio (Cloudflare R2, or any S3-compatible bucket).
 *
 * Why: Google Drive's free 15 GB fills after ~90 talents and every clip cost several
 * Drive API calls. A bucket has no practical limit, no per-call quota, and a private
 * bucket never needs a "share with anyone" link.
 *
 * It is OPT-IN: until R2_BUCKET + keys are set (see docs/R2_SETUP.md) enabled() is false
 * and every caller keeps using Google Drive exactly as before. Files already on Drive
 * keep working: each stored reference says where the file lives —
 *     "r2:<object key>"   -> this bucket
 *     "drive:<id>" / a Drive URL -> Google Drive (legacy)
 * and getStream()/remove() dispatch on that prefix.
 *
 * Environment variables:
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
 *   R2_ENDPOINT   (optional — a custom S3 endpoint; used by the tests)
 */
const {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand,
} = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const { PassThrough } = require("stream");

const PREFIX = "r2:";
let client = null;
let clientKey = "";

function config() {
  const bucket = process.env.R2_BUCKET;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const endpoint = process.env.R2_ENDPOINT || (process.env.R2_ACCOUNT_ID ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : "");
  return { bucket, accessKeyId, secretAccessKey, endpoint };
}

function enabled() {
  const c = config();
  return !!(c.bucket && c.accessKeyId && c.secretAccessKey && c.endpoint);
}

function s3() {
  const c = config();
  if (!enabled()) throw Object.assign(new Error("Object storage is not configured"), { code: "BLOB_NOT_CONFIGURED" });
  const key = `${c.endpoint}|${c.accessKeyId}|${c.bucket}`;
  if (!client || clientKey !== key) {
    client = new S3Client({
      region: "auto",
      endpoint: c.endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey },
      // R2 rejects the newer default checksum headers; only send them when required.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
    clientKey = key;
  }
  return client;
}

const refFor = (key) => PREFIX + key;
const isBlobRef = (ref) => typeof ref === "string" && ref.startsWith(PREFIX);
const keyFromRef = (ref) => String(ref).slice(PREFIX.length);

/** Safe object-key segment (no slashes / odd characters). */
const seg = (s) => String(s).replace(/[^\w.\-]+/g, "_").slice(0, 120) || "x";

async function putBuffer(key, buffer, contentType) {
  await s3().send(new PutObjectCommand({ Bucket: config().bucket, Key: key, Body: buffer, ContentType: contentType || "application/octet-stream" }));
  return { ref: refFor(key), size: buffer.length };
}

/** Streams a (possibly huge) body up with multipart upload; memory stays flat. */
async function putStream(key, stream, contentType) {
  // The SDK only accepts Node core streams; the zip library's streams are a different
  // (readable-stream) flavour, so always go through a PassThrough.
  const body = new PassThrough();
  stream.on("error", (e) => body.destroy(e));
  stream.pipe(body);
  const up = new Upload({
    client: s3(),
    params: { Bucket: config().bucket, Key: key, Body: body, ContentType: contentType || "application/octet-stream" },
    queueSize: 4,
    partSize: 8 * 1024 * 1024,
    leavePartsOnError: false,
  });
  // if the producer dies half-way, abort so no half-written object / orphan parts are left
  body.on("error", () => { up.abort().catch(() => {}); });
  await up.done();
  const head = await s3().send(new HeadObjectCommand({ Bucket: config().bucket, Key: key }));
  return { ref: refFor(key), size: Number(head.ContentLength) || null };
}

/**
 * Opens a stored file for reading. Returns { stream, contentType }.
 * Works for bucket refs and for legacy Google Drive refs.
 */
async function getStream(ref, { drive } = {}) {
  if (isBlobRef(ref)) {
    const out = await s3().send(new GetObjectCommand({ Bucket: config().bucket, Key: keyFromRef(ref) }));
    return { stream: out.Body, contentType: out.ContentType || null };
  }
  const { google } = require("googleapis");
  const { getAuthorizedClient } = require("./googleDrive");
  const { fileIdFromRef } = require("./studioStorage");
  const d = drive || google.drive({ version: "v3", auth: await getAuthorizedClient() });
  const fileId = fileIdFromRef(ref);
  if (!fileId) throw new Error("مرجع الملف غير صالح");
  const meta = await d.files.get({ fileId, fields: "mimeType" });
  const res = await d.files.get({ fileId, alt: "media" }, { responseType: "stream" });
  return { stream: res.data, contentType: (meta.data && meta.data.mimeType) || null };
}

/** Deletes a bucket object. Already-gone counts as success (S3 delete is idempotent). */
async function remove(ref) {
  await s3().send(new DeleteObjectCommand({ Bucket: config().bucket, Key: keyFromRef(ref) }));
  return true;
}

/** Time-limited download link for a private object (the browser downloads straight from the bucket). */
async function presignGet(ref, downloadName, expiresSec = 3600) {
  const params = { Bucket: config().bucket, Key: keyFromRef(ref) };
  if (downloadName) params.ResponseContentDisposition = `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
  return getSignedUrl(s3(), new GetObjectCommand(params), { expiresIn: expiresSec });
}

module.exports = { enabled, refFor, isBlobRef, keyFromRef, seg, putBuffer, putStream, getStream, remove, presignGet };
