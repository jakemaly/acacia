import type { Bot } from "mineflayer";

/** Keep passenger positions usable when the server moves only their vehicle. */
export function trackMountedEntities(bot: Bot): Disposable {
  const passengers = new Map<number, Set<number>>();

  const movePassengers = (vehicleId: number, visited = new Set<number>()): void => {
    if (visited.has(vehicleId)) return;
    visited.add(vehicleId);
    const vehicle = bot.entities[vehicleId];
    if (!vehicle?.isValid || !vehicle.position) return;
    for (const id of passengers.get(vehicleId) ?? []) {
      const rider = bot.entities[id];
      if (!rider?.isValid || !rider.position || id === bot.entity.id) continue;
      // The protocol does not send seat offsets. Half the vehicle's height is
      // a conservative approximation; vanilla's chicken seat is exactly this.
      rider.position.set(vehicle.position.x, vehicle.position.y + (vehicle.height || 0) / 2, vehicle.position.z);
      movePassengers(id, visited);
    }
  };
  const mount = (raw: unknown): void => {
    if (!raw || typeof raw !== "object") return;
    const packet = raw as { entityId?: unknown; passengers?: unknown };
    if (typeof packet.entityId !== "number" || !Array.isArray(packet.passengers) ||
        !packet.passengers.every((id: unknown) => typeof id === "number")) return;
    const vehicleId = packet.entityId;
    const next = new Set<number>(packet.passengers);
    const vehicle = bot.entities[vehicleId];
    for (const [otherId, ids] of passengers) {
      if (otherId === vehicleId) continue;
      for (const id of next) ids.delete(id);
    }
    for (const id of passengers.get(vehicleId) ?? []) {
      if (next.has(id)) continue;
      const rider = bot.entities[id];
      // Mineflayer retains vehicle on passengers omitted from set_passengers.
      if (rider?.vehicle?.id === vehicleId) rider.vehicle = null as never;
      if (vehicle?.passengers) vehicle.passengers = vehicle.passengers.filter((entry) => entry.id !== id);
    }
    passengers.set(vehicleId, next);
    movePassengers(vehicleId);
  };
  const moved = (entity: { id: number }) => movePassengers(entity.id);
  const gone = (entity: { id: number }) => {
    passengers.delete(entity.id);
    for (const ids of passengers.values()) ids.delete(entity.id);
  };
  const clear = () => passengers.clear();
  bot._client.on("set_passengers", mount);
  bot.on("entityMoved", moved);
  bot.on("entityGone", gone);
  bot.on("respawn", clear);
  return { [Symbol.dispose]() {
    bot._client.off("set_passengers", mount);
    bot.off("entityMoved", moved);
    bot.off("entityGone", gone);
    bot.off("respawn", clear);
  } };
}
