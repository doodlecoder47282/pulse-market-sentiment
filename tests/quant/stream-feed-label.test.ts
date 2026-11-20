import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { streamFeedLabel, isStreamNotEntitled, STREAM_NOT_ENTITLED_NOTE } from "../../shared/streamFeed";

const ERR = "userPreference error: Schwab 401 on trader/v1/userPreference: the Schwab app is not enabled for the Trader API (Accounts and Trading Production), so streaming is off; REST market data still works";

test("a refused streaming sign-in reads as streaming off with the cause in full, not as an unverified feed", () => {
  const f = streamFeedLabel(true, { mode: "down", lastError: ERR });
  assert.equal(f.label, "Read by request, streaming off");
  assert.equal(f.note, STREAM_NOT_ENTITLED_NOTE);
  assert.match(f.note!, /Accounts and Trading Production/);
  assert.match(f.note!, /Only the app's owner can add it/);
});

test("the wording the server throws is the wording the label recognises", () => {
  const srv = readFileSync("server/schwab.ts", "utf8");
  const thrown = /throw new Error\("(Schwab 401 on trader\/v1\/userPreference[^"]*)"\)/.exec(srv);
  assert.ok(thrown, "server/schwab.ts still throws the 401 userPreference error");
  const stream = readFileSync("server/schwabStream.ts", "utf8");
  assert.match(stream, /this\.fail\(`userPreference error: \$\{e\?\.message/);
  assert.ok(isStreamNotEntitled(`userPreference error: ${thrown![1]}`));
});

test("other failures keep their own words; live and disconnected are unchanged", () => {
  assert.deepEqual(streamFeedLabel(false, undefined).label, "Unavailable");
  const other = streamFeedLabel(true, { mode: "down", lastError: "socket closed 1006" });
  assert.equal(other.label, "Feed not verified");
  assert.equal(other.detail, "socket closed 1006");
  assert.equal(other.note, undefined);
  assert.equal(isStreamNotEntitled("Schwab 401 on quotes"), false);
  const live = streamFeedLabel(true, { mode: "live", lastMessageAgeMs: 2000, perService: { LEVELONE_EQUITIES: { lastDataAgeMs: 1500, keys: 3 } } });
  assert.equal(live.label, "Streaming live");
  // A stale error from an earlier attempt does not override a live stream.
  assert.equal(streamFeedLabel(true, { mode: "live", lastMessageAgeMs: 2000, lastError: ERR, perService: { LEVELONE_EQUITIES: { lastDataAgeMs: 1500, keys: 3 } } }).label, "Streaming live");
});

test("wiring: the settings panel uses the shared label and shows the note", () => {
  const ui = readFileSync("client/src/components/SchwabSettings.tsx", "utf8");
  assert.match(ui, /from "@shared\/streamFeed"/);
  assert.match(ui, /schwab-stream-note/);
});
