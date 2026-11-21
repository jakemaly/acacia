import assert from "node:assert/strict";
import test from "node:test";
import {
  endermanPillarTuckPosition,
  endermanUmbrellaCells,
  isEndermanPillarTuckPosition,
  huntEndermenUnderUmbrellaInputSchema,
  huntEndermenUnderUmbrellaResultSchema,
} from "./contract.js";

test("Enderman shelter request defaults are bounded and reject unrelated options", () => {
  assert.deepEqual(huntEndermenUnderUmbrellaInputSchema.parse({}), {
    block_name: "cobblestone",
    absence_window_ms: 5_000,
    time_limit_ms: 180_000,
  });
  assert.throws(() => huntEndermenUnderUmbrellaInputSchema.parse({ time_limit_ms: 10 }));
  assert.throws(() => huntEndermenUnderUmbrellaInputSchema.parse({ ignore_endermen: true }), /Unrecognized key/);
});

test("the shelter is one three-block pillar and a 5x1 canopy aligned on either axis", () => {
  const pillar = { x: -4, y: 63, z: 12 };
  for (const axis of ["x", "z"] as const) {
    const cells = endermanUmbrellaCells(pillar, "cobblestone", axis);
    assert.equal(cells.length, 7);
    assert.equal(new Set(cells.map(({ x, y, z }) => [x, y, z].join(","))).size, 7);
    assert.deepEqual(cells.filter(({ x, z }) => x === pillar.x && z === pillar.z).map(({ y }) => y), [63, 64, 65]);
    const canopy = cells.filter(({ y }) => y === 65);
    assert.equal(canopy.length, 5);
    assert.ok(canopy.every(({ z }) => axis === "x" ? z === pillar.z : true));
    assert.ok(canopy.every(({ x }) => axis === "z" ? x === pillar.x : true));
    assert.equal(new Set(canopy.map(({ x, z }) => axis === "x" ? x : z)).size, 5);
  }
});

test("the tuck point stays under the 5x1 canopy on the two legal hitbox boundaries", () => {
  const pillar = { x: 10, y: 64, z: -7 };
  const cases = [
    { axis: "x" as const, side: { x: 1 as const, z: 0 as const }, station: { x: 9, y: 64, z: -7 }, expected: { x: 9.55, y: 64, z: -6.5 } },
    { axis: "x" as const, side: { x: -1 as const, z: 0 as const }, station: { x: 11, y: 64, z: -7 }, expected: { x: 11.45, y: 64, z: -6.5 } },
    { axis: "z" as const, side: { x: 0 as const, z: 1 as const }, station: { x: 10, y: 64, z: -6 }, expected: { x: 10.5, y: 64, z: -7.45 } },
    { axis: "z" as const, side: { x: 0 as const, z: -1 as const }, station: { x: 10, y: 64, z: -8 }, expected: { x: 10.5, y: 64, z: -5.55 } },
  ];
  for (const { axis, side, station, expected } of cases) {
    assert.deepEqual(endermanPillarTuckPosition(pillar, station, side), expected);
    assert.equal(isEndermanPillarTuckPosition(expected, pillar, axis), true);
    const wrongAxis = axis === "x" ? "z" : "x";
    assert.equal(isEndermanPillarTuckPosition(expected, pillar, wrongAxis), false);
  }

  assert.equal(isEndermanPillarTuckPosition({ x: pillar.x + 0.5, y: pillar.y, z: pillar.z + 0.5 }, pillar, "x"), false);
  assert.equal(isEndermanPillarTuckPosition({ x: pillar.x + 1.45, y: pillar.y, z: pillar.z + 0.39 }, pillar, "x"), true);
  assert.equal(isEndermanPillarTuckPosition({ x: pillar.x + 1.45, y: pillar.y, z: pillar.z + 0.33 }, pillar, "x"), false);
  assert.equal(isEndermanPillarTuckPosition({ x: pillar.x + 1.54, y: pillar.y, z: pillar.z + 0.5 }, pillar, "x"), true);
  assert.equal(isEndermanPillarTuckPosition({ x: pillar.x + 1.66, y: pillar.y, z: pillar.z + 0.5 }, pillar, "x"), false);
  assert.equal(isEndermanPillarTuckPosition({ x: pillar.x - 0.45, y: pillar.y + 1, z: pillar.z + 0.5 }, pillar, "x"), false);
  assert.equal(isEndermanPillarTuckPosition({ x: pillar.x + 0.5, y: pillar.y, z: pillar.z - 0.45 }, pillar, "z"), true);
  assert.equal(isEndermanPillarTuckPosition({ x: pillar.x + 0.5, y: pillar.y, z: pillar.z + 0.3 }, pillar, "z"), false);
});

test("the settled result reports position, structure, combat, and termination evidence", () => {
  const result = huntEndermenUnderUmbrellaResultSchema.parse({
    status: "succeeded",
    structure: {
      dimension: "overworld",
      cells: 7,
      correct: 7,
      placed: 7,
      dug: 0,
      wrong: 0,
      left: [],
      missing: [],
      passes: 1,
      complete: true,
    },
    pillar: { x: 1, y: 64, z: 2 },
    station: { x: 0.7, y: 64, z: 2.5 },
    finalPosition: { x: 0.7, y: 64, z: 3.5 },
    relativePosition: { x: -0.3, z: 1.5, withinPillarBounds: false },
    leftShelter: true,
    combat: { engagements: 1, killsObserved: 1, attacks: 3, styles: ["melee"], weapons: ["iron_sword"] },
    remaining: [],
    termination: "threats_gone",
  });
  assert.equal(result.status, "succeeded");
});
