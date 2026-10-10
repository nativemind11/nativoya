// Starts a throw-away S3-compatible server (s3rver) and points studioBlob at it.
const S3rver = require("s3rver");
const fs = require("fs");
const os = require("os");
const path = require("path");

async function startS3() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "s3rver-"));
  const server = new S3rver({ port: 0, address: "127.0.0.1", silent: true, directory: dir, configureBuckets: [{ name: "test-bucket" }] });
  const port = await new Promise((resolve, reject) => server.run((err, addr) => (err ? reject(err) : resolve(addr.port))));
  Object.assign(process.env, {
    R2_ENDPOINT: `http://127.0.0.1:${port}`, R2_BUCKET: "test-bucket", R2_ACCESS_KEY_ID: "S3RVER", R2_SECRET_ACCESS_KEY: "S3RVER",
  });
  return { stop: () => new Promise((r) => server.close(() => { fs.rmSync(dir, { recursive: true, force: true }); r(); })) };
}
function stopEnv() { for (const k of ["R2_ENDPOINT", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_ACCOUNT_ID"]) delete process.env[k]; }
module.exports = { startS3, stopEnv };
