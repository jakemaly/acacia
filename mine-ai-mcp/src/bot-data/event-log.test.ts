import assert from "node:assert/strict";
import test from "node:test";
import { readRecentEvents } from "../actions/read-recent-events/read-recent-events.js";
import { persistentBotData, temporaryBotData } from "../test-support/bot-data.js";
import { readNotificationSummary, recordEvent, type BotEventInput } from "./event-log.js";

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

test("notification policy hides legacy chat for every bot", (t) => {
  const data = temporaryBotData({ closeAfter: t });
  recordEvent(data, "collector", playerMessage("private spectator text"));
  recordEvent(data, "builder", playerMessage("other private text", "OtherPlayer"));
  recordEvent(data, "collector", playerMessage("outgoing", "collector", "outgoing"));
  assert.deepEqual(readNotificationSummary(data, "collector"), { unreadCount: 0 });
  assert.deepEqual(readNotificationSummary(data, "builder"), { unreadCount: 0 });
});

function gameplayEvent(summary: string): BotEventInput {
  return { type: "player_dimension_change", observedAt: "2026-08-23T00:00:00.000Z", summary,
    payload: { from: "overworld", to: "the_nether", position: { x: 0, y: 64, z: 0 } } };
}

/** A store on disk that this test writes, closes, and reopens under the same identity. */
test("events and their cursors survive a restart", (t) => {
  const storage = persistentBotData(t);
  const open = () => storage.open("world");
  const first = open();
  recordEvent(first, "collector", gameplayEvent("persisted"));
  readRecentEvents(first, "collector", 50);
  first.close();

  const reopened = open();
  assert.deepEqual(readNotificationSummary(reopened, "collector"), { unreadCount: 0 });
  const next = recordEvent(reopened, "collector", gameplayEvent("after restart"));
  assert.equal(next.eventId, 2, "event ids continue rather than restart");
  assert.deepEqual(readNotificationSummary(reopened, "collector").recentPreview, ["after restart"]);
  reopened.close();
});
