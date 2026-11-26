import { synchronousDiagnostic } from "../execution/synchronous-diagnostic.js";

// The parent intentionally does not read the pipe; gameplay must still finish.
for (let i = 0; i < 10_000; i++) synchronousDiagnostic("fixture", "flood", () => {});
process.stdout.write("finished\n");
