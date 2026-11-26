import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { Vec3 } from "vec3";
import { botFixture } from "../test-support/bot.js";
import { trackMountedEntities } from "./mounted-entities.js";

test("passengers follow their vehicle, detach, and can board a different vehicle", () => {
  const rider = { id: 7, isValid: true, position: new Vec3(20, 70, 0), vehicle: null };
  const chicken = { id: 8, isValid: true, position: new Vec3(20, 64, 0), height: 0.7, passengers: [] };
  const other = { id: 9, isValid: true, position: new Vec3(30, 64, 0), height: 0.7, passengers: [] };
  const bot = botFixture({ entities: { 7: rider, 8: chicken, 9: other } }, { _client: new EventEmitter() });
  const tracking = trackMountedEntities(bot);
  bot._client.emit("set_passengers", { entityId: 8, passengers: [7] });
  chicken.position.set(1, 64, 2);
  bot.emit("entityMoved", chicken as never);
  assert.deepEqual([rider.position.x, rider.position.y, rider.position.z], [1, 64.35, 2]);
  bot._client.emit("set_passengers", { entityId: 9, passengers: [7] });
  chicken.position.x = 100;
  bot.emit("entityMoved", chicken as never);
  assert.equal(rider.position.x, 30, "the former vehicle cannot move a reassigned rider");
  bot._client.emit("set_passengers", { entityId: 9, passengers: [] });
  other.position.x = 40;
  bot.emit("entityMoved", other as never);
  assert.equal(rider.position.x, 30, "a dismounted rider keeps its own position");
  tracking[Symbol.dispose]();
});
