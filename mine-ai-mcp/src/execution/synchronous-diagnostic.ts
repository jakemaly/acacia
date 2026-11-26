import { writeSync } from "node:fs";

// The supervisor owns this private pipe. An ordinary, unsupervised process
// does not pay for stack capture or require any diagnostic infrastructure.
let descriptor: number | null = null;
if (process.env.MINE_AI_DIAGNOSTIC_FD === "4" && process.versions.bun &&
    (process.platform === "linux" || process.platform === "darwin")) {
  try {
    // Bun provides this built-in at runtime; Node installations may not have its types.
    const ffiModule: string = "bun:ffi";
    const { dlopen, FFIType } = await import(ffiModule);
    const libc = dlopen(process.platform === "linux" ? "libc.so.6" : "/usr/lib/libSystem.B.dylib", {
      fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    });
    try {
      const flags = libc.symbols.fcntl(4, 3, 0); // F_GETFL
      const nonblocking = process.platform === "linux" ? 0x800 : 0x4;
      if (flags >= 0 && libc.symbols.fcntl(4, 4, flags | nonblocking) === 0) descriptor = 4; // F_SETFL
    } finally {
      libc.close();
    }
  } catch {
    // Fail closed when a nonblocking channel cannot be established.
  }
}
let sequence = 0;
let omitted = 0;
if (descriptor !== null) {
  try {
    writeSync(descriptor, Buffer.from(`${JSON.stringify({
      id: 0, state: "returned", operation: "diagnostic", phase: "channel_ready", at: Date.now(), omitted: 0,
    })}\n`));
  } catch {
    omitted++;
  }
}

/** Record an entry before synchronous work can prevent the runtime from sending IPC. */
export function synchronousDiagnostic<T>(operation: string, phase: string, effect: () => T): T {
  if (descriptor === null) return effect();
  const id = ++sequence;
  const send = (state: "entered" | "returned") => {
    // Bound each record; partial writes are counted and rejected by the reader.
    const record = JSON.stringify({ id, state, operation, phase, at: Date.now(), omitted,
      ...(state === "entered" ? { stack: String(new Error().stack ?? "").slice(0, 2000) } : {}),
    }) + "\n";
    try {
      const bytes = Buffer.from(record);
      if (bytes.length > 3800 || writeSync(descriptor, bytes) !== bytes.length) omitted++;
      else omitted = 0;
    } catch {
      // A full or closed diagnostic channel must never break gameplay.
      omitted++;
    }
  };
  send("entered");
  try {
    return effect();
  } finally {
    send("returned");
  }
}
