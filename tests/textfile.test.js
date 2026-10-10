const test = require("node:test");
const assert = require("node:assert");
const { readLines } = require("../config/textFile");

test("plain UTF-8 lines, blank lines and CRLF are cleaned", () => {
  assert.deepStrictEqual(readLines(Buffer.from("one\r\n\r\n two \ntres\n", "utf-8")), ["one", "two", "tres"]);
});
test("UTF-8 BOM is not glued to the first sentence", () => {
  assert.deepStrictEqual(readLines(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("مرحبا\nأهلا")])), ["مرحبا", "أهلا"]);
});
test("UTF-16LE file saved by Windows Notepad is decoded (no NUL characters)", () => {
  const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("مرحبا\r\nأهلا\r\n", "utf16le")]);
  const lines = readLines(buf);
  assert.deepStrictEqual(lines, ["مرحبا", "أهلا"]);
  assert.ok(lines.every((l) => !l.includes("\u0000")));
});
test("UTF-16BE is decoded too", () => {
  const le = Buffer.from("hello\nworld", "utf16le"); le.swap16();
  assert.deepStrictEqual(readLines(Buffer.concat([Buffer.from([0xfe, 0xff]), le])), ["hello", "world"]);
});
