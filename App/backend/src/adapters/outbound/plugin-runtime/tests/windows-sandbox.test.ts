import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
// Native tests exercise the packaged helper, not a fake spawn or a generated policy string.
describe.runIf(process.platform === "win32")("Windows AppContainer", () => {
  it("allows approved files while denying private files, writes, loopback and descendant escapes", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "memmy-win-sandbox-"))); roots.push(root);
    const allowed = join(root, "allowed"), denied = join(root, "private");
    await mkdir(allowed); await mkdir(denied); await writeFile(join(denied, "secret.txt"), "private");
    const server = createServer(socket => socket.end("forbidden"));
    await new Promise<void>(ok => server.listen(0, "127.0.0.1", ok));
    try {
      const port = (server.address() as { port: number }).port;
      const code = `const fs=require('fs'),net=require('net'),cp=require('child_process');
        let read=false,write=false; try{fs.readFileSync(${JSON.stringify(join(denied, "secret.txt"))});read=true}catch{}
        try{fs.writeFileSync(${JSON.stringify(join(denied, "escape.txt"))},'escape');write=true}catch{}
        fs.writeFileSync(${JSON.stringify(join(allowed, "ok.txt"))},'ok');
        const descendant=cp.spawnSync(process.execPath,['-e',${JSON.stringify(`try{require('fs').readFileSync(${JSON.stringify(join(denied, "secret.txt"))});process.exit(9)}catch{process.exit(0)}`)}]);
        const socket=net.connect(${port},'127.0.0.1');let done=false;const finish=network=>{if(done)return;done=true;socket.destroy();console.log(JSON.stringify({read,write,network,descendant:descendant.status}));};
        socket.on('connect',()=>finish(true));socket.on('error',()=>finish(false));setTimeout(()=>finish(false),1500);`;
      await writeFile(join(allowed, "test.cjs"), code);
      const plan = { profile: `memmy.plugin.test.${Date.now()}`, command: process.execPath, args: [join(allowed, "test.cjs")], cwd: allowed, readRoots: [await realpath(dirname(process.execPath))], writeRoots: [allowed] };
      const result = await launch(plan);
      expect(result.code, result.errors).toBe(0);
      expect(JSON.parse(result.output)).toEqual({ read: false, write: false, network: false, descendant: 0 });
    } finally { await new Promise<void>(ok => server.close(() => ok())); }
  }, 60000);
  it("kills the plugin and its descendants when the Host cancels the launcher", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "memmy-win-job-"))); roots.push(root);
    const tick = join(root, "tick.txt");
    const childCode = `setInterval(()=>require('fs').writeFileSync(${JSON.stringify(tick)},String(Date.now())),100)`;
    const parentCode = `const child=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'});console.log(child.pid);setInterval(()=>{},1000);`;
    const plan = { profile: `memmy.plugin.job.${Date.now()}`, command: process.execPath, args: ["-e", parentCode], cwd: root, readRoots: [await realpath(dirname(process.execPath))], writeRoots: [root] };
    const child = spawnLauncher(plan); let errors = "";
    child.stderr.on("data", b => { errors += b; });
    try {
      const pid = await new Promise<number>((ok, reject) => {
        const timer = setTimeout(() => reject(new Error(`No descendant started: ${errors}`)), 30000);
        child.stdout.once("data", b => { clearTimeout(timer); ok(Number(String(b).trim())); });
        child.once("error", error => { clearTimeout(timer); reject(error); });
        child.once("exit", code => { clearTimeout(timer); reject(new Error(`Launcher exited ${code}: ${errors}`)); });
      });
      expect(pid).toBeGreaterThan(0);
      await new Promise(ok => setTimeout(ok, 600));
      expect(await readFile(tick, "utf8")).toMatch(/^\d+$/);
      child.kill();
      await new Promise(ok => setTimeout(ok, 1000));
      const stopped = await readFile(tick, "utf8");
      await new Promise(ok => setTimeout(ok, 500));
      expect(await readFile(tick, "utf8")).toBe(stopped);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally { child.kill(); }
  }, 60000);
});
async function launch(plan: unknown) {
  return await new Promise<{code: number | null; output: string; errors: string}>((ok, reject) => {
    const child = spawnLauncher(plan);
    let output = "", errors = ""; child.stdout.on("data", b => { output += b; }); child.stderr.on("data", b => { errors += b; });
    child.once("error", reject); child.once("close", code => ok({code, output, errors})); child.stdin.end();
  });
}

function spawnLauncher(plan: unknown) {
  const helper = fileURLToPath(new URL("../windows/launch.ps1", import.meta.url));
  return spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper, "-Plan", Buffer.from(JSON.stringify(plan)).toString("base64")], { stdio: ["pipe", "pipe", "pipe"], env: {
    SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
    MEMMY_SANDBOX_CHILD_ENV: Buffer.from(JSON.stringify({ SystemRoot: process.env.SystemRoot ?? "C:\\Windows", TEMP: tmpdir(), TMP: tmpdir(), ELECTRON_RUN_AS_NODE: "1" })).toString("base64")
  } });
}
