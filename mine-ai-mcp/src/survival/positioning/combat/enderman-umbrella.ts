import { Vec3 } from "vec3";

export type EndermanUmbrellaAxis = "x" | "z";
export type EndermanPillarSide = { readonly x: -1 | 0 | 1; readonly z: -1 | 0 | 1 };

// Keep enough clearance for the player's 0.6-block body even when steering settles a little off-center.
export const ENDERMAN_TUCK_OFFSET = 0.45;
export const ENDERMAN_TUCK_FACE_TOLERANCE = 0.1;
export const ENDERMAN_TUCK_LANE_TOLERANCE = 0.12;

/** Seven unique cells: a three-block support and a five-block line at its top. */
export function endermanUmbrellaPositions(pillar: Vec3, axis: EndermanUmbrellaAxis): Vec3[] {
  const cells = [pillar, pillar.offset(0, 1, 0), pillar.offset(0, 2, 0)];
  for (let offset = -2; offset <= 2; offset += 1) {
    if (offset === 0) continue;
    cells.push(pillar.offset(axis === "x" ? offset : 0, 2, axis === "z" ? offset : 0));
  }
  return cells;
}

/** Stand on the protected side of the pillar, beneath the five-block roof line. */
export function endermanPillarTuckPosition(
  pillar: { readonly x: number; readonly y: number; readonly z: number },
  stationCell: { readonly x: number; readonly y: number; readonly z: number },
  side: EndermanPillarSide,
) {
  return {
    x: side.x === 1
      ? pillar.x - ENDERMAN_TUCK_OFFSET
      : side.x === -1
        ? pillar.x + 1 + ENDERMAN_TUCK_OFFSET
        : stationCell.x + 0.5,
    y: stationCell.y,
    z: side.z === 1
      ? pillar.z - ENDERMAN_TUCK_OFFSET
      : side.z === -1
        ? pillar.z + 1 + ENDERMAN_TUCK_OFFSET
        : stationCell.z + 0.5,
  };
}

/** The bot is tucked only on the protected face along the canopy's axis. */
export function isEndermanPillarTuckPosition(
  position: { readonly x: number; readonly y: number; readonly z: number },
  pillar: { readonly x: number; readonly y: number; readonly z: number },
  axis: EndermanUmbrellaAxis,
): boolean {
  const x = position.x - pillar.x;
  const z = position.z - pillar.z;
  const onSafeFace = (value: number) =>
    (value >= -0.65 && value <= -0.35) || (value >= 1.35 && value <= 1.65);
  return Math.abs(position.y - pillar.y) <= 0.15 &&
    (axis === "x"
      ? onSafeFace(x) && Math.abs(z - 0.5) <= ENDERMAN_TUCK_LANE_TOLERANCE
      : Math.abs(x - 0.5) <= ENDERMAN_TUCK_LANE_TOLERANCE && onSafeFace(z));
}

/** Verify that a complete 5x1 roof protects the bot, even if the Enderman teleports around it. */
export function isUnderEndermanUmbrella(
  position: Vec3,
  full: (cell: Vec3) => boolean,
): boolean {
  const feet = position.floored();
  return [
    { side: new Vec3(1, 0, 0), axis: "x" as const },
    { side: new Vec3(-1, 0, 0), axis: "x" as const },
    { side: new Vec3(0, 0, 1), axis: "z" as const },
    { side: new Vec3(0, 0, -1), axis: "z" as const },
  ].some(({ side, axis }) => {
    const pillar = feet.plus(side);
    return isEndermanPillarTuckPosition(position, pillar, axis) &&
      endermanUmbrellaPositions(pillar, axis).every(full);
  });
}
