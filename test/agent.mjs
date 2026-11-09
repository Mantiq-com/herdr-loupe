import * as fs from "node:fs";

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write("\u001b[?2004h\u001b]7501;state=idle:app=loupe-test\u001b\\Loupe test agent ready.\n");
process.stdin.on("data", (bytes) => {
  fs.appendFileSync(process.argv[2], bytes);
  process.stdout.write("\u001b]7501;state=idle:app=loupe-test\u001b\\");
});
