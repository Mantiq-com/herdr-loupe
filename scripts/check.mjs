import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

const tests = readdirSync(new URL("../test/", import.meta.url)).filter((name) => name.endsWith(".test.mjs")).sort().map((name) => `test/${name}`);
for (const [command, args] of [[process.execPath, ["--test", ...tests]], ["herdr-app", ["check", "mods/loupe"]]]) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
