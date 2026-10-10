// studioBlob against a real S3 protocol server (s3rver): put / stream-put / get / presign / delete.
const test = require("node:test");
const assert = require("node:assert");
const { Readable } = require("node:stream");
const { startS3, stopEnv } = require("./helpers/s3server");
const blob = require("../config/studioBlob");

const read = async (s) => { const c = []; for await (const x of s) c.push(Buffer.from(x)); return Buffer.concat(c); };
let s3;

test("disabled until configured", () => { stopEnv(); assert.strictEqual(blob.enabled(), false); });
test("boot", async () => { s3 = await startS3(); assert.strictEqual(blob.enabled(), true); });

test("putBuffer then getStream round-trips bytes and content type", async () => {
  const { ref } = await blob.putBuffer("studio/t1/clip.wav", Buffer.from("RIFFdata"), "audio/wav");
  assert.strictEqual(ref, "r2:studio/t1/clip.wav");
  assert.ok(blob.isBlobRef(ref));
  const { stream, contentType } = await blob.getStream(ref);
  assert.strictEqual((await read(stream)).toString(), "RIFFdata");
  assert.strictEqual(contentType, "audio/wav");
});

test("putStream uploads a multi-part body and reports its size", async () => {
  const big = Buffer.alloc(20 * 1024 * 1024, 7);                      // > 2 parts of 8 MB
  const { ref, size } = await blob.putStream("studio/t1/big.zip", Readable.from([big]), "application/zip");
  assert.strictEqual(size, big.length);
  const back = await read((await blob.getStream(ref)).stream);
  assert.ok(back.equals(big));
});

test("a failing producer leaves no object behind", async () => {
  const bad = new Readable({ read() { this.push(Buffer.alloc(1024)); setImmediate(() => this.destroy(new Error("boom"))); } });
  await assert.rejects(blob.putStream("studio/t1/broken.zip", bad, "application/zip"));
  await assert.rejects(blob.getStream("r2:studio/t1/broken.zip"));
});

test("presigned link downloads the object with a filename", async () => {
  await blob.putBuffer("studio/t1/d.zip", Buffer.from("ZIPDATA"), "application/zip");
  const url = await blob.presignGet("r2:studio/t1/d.zip", "تسليم 1.zip");
  const res = await fetch(url);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(await res.text(), "ZIPDATA");
  assert.match(res.headers.get("content-disposition") || "", /attachment; filename\*=UTF-8''/);
});

test("remove deletes, and deleting twice is fine", async () => {
  await blob.putBuffer("studio/t1/x.wav", Buffer.from("x"), "audio/wav");
  assert.strictEqual(await blob.remove("r2:studio/t1/x.wav"), true);
  await assert.rejects(blob.getStream("r2:studio/t1/x.wav"));
  assert.strictEqual(await blob.remove("r2:studio/t1/x.wav"), true);
});

test("seg() keeps keys safe", () => assert.strictEqual(blob.seg("a/b c:d"), "a_b_c_d"));
test("shutdown", async () => { await s3.stop(); stopEnv(); });
