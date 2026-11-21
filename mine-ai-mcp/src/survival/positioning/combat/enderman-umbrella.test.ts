import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { endermanUmbrellaPositions, isUnderEndermanUmbrella } from "./enderman-umbrella.js";

function shelter(pillar: Vec3, axis: "x" | "z"): Set<string> {
  return new Set(endermanUmbrellaPositions(pillar, axis).map((cell) => cell.toString()));
}

test("a complete 5x1 umbrella protects a tucked bot after the Enderman teleports around it", () => {
  for (const axis of ["x", "z"] as const) {
    const cases = axis === "x"
      ? [
          { pillar: new Vec3(1, 64, 1), position: new Vec3(0.483, 64, 1.423) },
          { pillar: new Vec3(0, 64, 1), position: new Vec3(1.517, 64, 1.423) },
        ]
      : [
          { pillar: new Vec3(1, 64, 1), position: new Vec3(1.423, 64, 0.483) },
          { pillar: new Vec3(1, 64, 0), position: new Vec3(1.423, 64, 1.517) },
        ];

    for (const { pillar, position } of cases) {
      const fullCells = shelter(pillar, axis);
      const full = (cell: Vec3) => fullCells.has(cell.toString());
      assert.equal(isUnderEndermanUmbrella(position, full), true);
    }
  }
});

test("an incomplete umbrella or a position outside its protected lane is not accepted", () => {
  const pillar = new Vec3(1, 64, 1);
  const fullCells = shelter(pillar, "x");
  const full = (cell: Vec3) => fullCells.has(cell.toString());
  const missingRoofBlock = new Vec3(3, 66, 1).toString();

  assert.equal(isUnderEndermanUmbrella(new Vec3(0.483, 64, 1.423), (cell) => full(cell) && cell.toString() !== missingRoofBlock), false);
  assert.equal(isUnderEndermanUmbrella(new Vec3(0.483, 64, 1.7), full), false);
});
