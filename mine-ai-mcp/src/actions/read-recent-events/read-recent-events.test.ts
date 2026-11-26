import assert from "node:assert/strict";
import test from "node:test";
import { readNotificationSummary, recordEvent, type BotEventInput } from "../../bot-data/index.js";
import { temporaryBotData } from "../../test-support/bot-data.js";
import { formatReadRecentEventsResult, parseReadRecentEventsRequest, readRecentBotEvents, readRecentEvents } from "./index.js";

function playerMessage(
  summary: string,
  username = "Alex",
  direction: "incoming" | "outgoing" = "incoming",
): BotEventInput {
  return {
    type: "player_message",
    observedAt: "2026-08-23T00:00:00.000Z",
    summary,
    payload: { username, channel: "chat", direction, message: summary, addressed: false },
  };
}

function gameplayEvent(summary: string): BotEventInput {
  return { type: "player_dimension_change", observedAt: "2026-08-23T00:00:00.000Z", summary,
    payload: { from: "overworld", to: "the_nether", position: { x: 0, y: 64, z: 0 } } };
}

test("legacy chat is hidden while gameplay events remain readable", (t) => {
  assert.deepEqual(parseReadRecentEventsRequest(undefined), { limit: 50 });
  assert.deepEqual(parseReadRecentEventsRequest({ limit: 2 }), { limit: 2 });
  assert.throws(() => parseReadRecentEventsRequest({ limit: 0 }));
  assert.throws(() => parseReadRecentEventsRequest({ limit: 101 }));
  const data = temporaryBotData({ closeAfter: t });
  recordEvent(data, "MineAI", playerMessage("private", "aycelol"));
  recordEvent(data, "MineAI", gameplayEvent("arrived"));
  const result = readRecentBotEvents(data, "MineAI", { limit: 50 });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.events.map((event) => event.summary), ["arrived"]);
  assert.doesNotMatch(JSON.stringify(result), /private|aycelol/);
  assert.match(formatReadRecentEventsResult(result), /dimension change/);
});

test("gameplay pages skip legacy chat and advance the cursor atomically", (t) => {
  const data = temporaryBotData({ closeAfter: t });
  recordEvent(data, "collector", playerMessage("private", "aycelol"));
  recordEvent(data, "collector", gameplayEvent("first"));
  recordEvent(data, "collector", gameplayEvent("second"));
  recordEvent(data, "collector", gameplayEvent("third"));
  const first = readRecentEvents(data, "collector", 2);
  assert.deepEqual(first.events.map((event) => event.summary), ["first", "second"]);
  assert.equal(first.readThroughEventId, 3);
  assert.equal(first.remainingEventCount, 1);
  assert.deepEqual(readNotificationSummary(data, "collector").recentPreview, ["third"]);
  data.transaction((database) => database.exec(`CREATE TRIGGER refuse_event_cursor BEFORE UPDATE ON event_read_state BEGIN SELECT RAISE(ABORT, 'cursor refused'); END`));
  assert.throws(() => readRecentEvents(data, "collector", 1), /cursor refused/);
  assert.deepEqual(readNotificationSummary(data, "collector").recentPreview, ["third"]);
  data.transaction((database) => database.exec("DROP TRIGGER refuse_event_cursor"));
  const last = readRecentEvents(data, "collector", 100);
  assert.deepEqual(last.events.map((event) => event.summary), ["third"]);
  assert.equal(last.readThroughEventId, 4);
  assert.equal(last.remainingEventCount, 0);
  assert.deepEqual(readNotificationSummary(data, "collector"), { unreadCount: 0 });
});


test("returns and formats a player death lifecycle event through the existing event page", (t) => {
  const data = temporaryBotData({ closeAfter: t });
  recordEvent(data, "MineAI", {
    type: "player_death",
    observedAt: "2026-08-30T01:02:03.000Z",
    summary: "MineAI died at 12.5, 64, -3.25 in overworld.",
    payload: { dimension: "overworld", position: { x: 12.5, y: 64, z: -3.25 }, cause: null },
  });

  const result = readRecentBotEvents(data, "MineAI", { limit: 50 });
  assert.equal(result.events[0]?.type, "player_death");
  const markdown = formatReadRecentEventsResult(result);
  assert.match(markdown, /Event 1: player death/);
  assert.match(markdown, /Observed: 2026-08-30T01:02:03.000Z/);
  assert.match(markdown, /Dimension: `overworld`/);
  assert.match(markdown, /Position: `12.5, 64, -3.25`/);
});
