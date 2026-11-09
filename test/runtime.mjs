import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import path from "node:path";

const execute = promisify(execFile);

export async function scratchDirectory(prefix) {
  const root = new URL("../tmp/", import.meta.url);
  await fs.mkdir(root, { recursive: true });
  return fs.mkdtemp(new URL(prefix, root));
}

export async function isolatedCore(directory) {
  const env = { ...process.env, HC_SESSION: "loupe-test", HC_SOCKET: path.join(directory, "core.sock"),
    XDG_CONFIG_HOME: path.join(directory, "config"), XDG_STATE_HOME: path.join(directory, "state") };
  const run = async (command, args, options = {}) => {
    try {
      const result = await execute(command, args, { env, timeout: 30000, maxBuffer: 8 * 1024 * 1024, ...options });
      return { code: 0, ...result };
    } catch (error) {
      if (typeof error.code !== "number") throw error;
      return { code: error.code, stdout: error.stdout, stderr: error.stderr };
    }
  };
  const hc = (args) => run("hc", args);
  const json = async (args) => {
    const result = await hc(["--json", ...args]);
    if (result.code !== 0) throw new Error(result.stderr);
    return JSON.parse(result.stdout);
  };
  await fs.mkdir(directory, { recursive: true });
  await json(["server", "start"]);
  return { env, run, hc, json, close: () => json(["server", "stop"]) };
}

export async function until(check, description, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}
