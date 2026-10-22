/** Trusted CI fixtures only. No user documents, no production runtime changes. */
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, copyFile, mkdir, mkdtemp, open, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildWindowsConverter } from "../plugins/office/scripts/build-windows-converter.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

// Persist file-backed stdio without excerpting or deleting diagnostics. The
// AppContainer launcher assigns descendants to its kill-on-close Job object.
async function capture(command, args, cwd, env, prefix, timeout, input = "") {
  const handles = [];
  let timer;
  const started = Date.now();
  let timedOut = false;
  try {
    await writeFile(`${prefix}.stdin`, input);
    for (const [file, mode] of [[`${prefix}.stdin`, "r"], [`${prefix}.stdout`, "w"], [`${prefix}.stderr`, "w"]]) handles.push(await open(file, mode));
    await writeFile(`${prefix}.command.json`, JSON.stringify({ command, args, cwd, timeout }, null, 2));
    const child = spawn(command, args, { cwd, env, windowsHide: true, shell: false, stdio: handles.map(h => h.fd) });
    const result = await new Promise((ok, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => ok({ code, signal }));
      timer = setTimeout(() => {
        timedOut = true;
        // Kill only this owned diagnostic process tree, including a converter
        // running outside the sandbox. Never leave a timed-out renderer alive.
        try { execFileSync(join(process.env.SystemRoot, "System32/taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", timeout: 15000 }); }
        catch { child.kill("SIGKILL"); }
      }, timeout);
    });
    return { ...result, timedOut, durationMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
    await Promise.all(handles.map(h => h.close()));
  }
}

async function main() {
  if (process.platform !== "win32") throw new Error("Remote Windows CI only; do not run rendering locally");
  const root = await mkdtemp(join(process.env.RUNNER_TEMP, "pptx-"));
  const evidence = resolve(process.env.OFFICE_PPTX_DIAGNOSTICS);
  await mkdir(evidence, { recursive: true });
  const report = { commit: process.env.GITHUB_SHA, root, node: process.version, platform: process.platform, cases: [] };
  const save = () => writeFile(join(evidence, "report.json"), JSON.stringify(report, null, 2));
  await save();
  try {
    const runtime = join(root, "rt");
    const program = join(runtime, "LibreOffice/program");
    await cp(join(process.env.ProgramFiles, "LibreOffice"), join(runtime, "LibreOffice"), { recursive: true, dereference: true });
    await buildWindowsConverter(program);
    for (const dll of ["msvcp140.dll", "msvcp140_1.dll", "msvcp140_2.dll", "vcruntime140.dll", "vcruntime140_1.dll", "concrt140.dll"]) {
      await copyFile(join(process.env.SystemRoot, "System32", dll), join(program, dll));
    }
    const executable = join(program, "memmy-office-convert.exe");
    report.converterSha256 = hash(await readFile(executable));
    const data = join(root, "data"); await mkdir(data);
    const fixtureEnv = { ...process.env, MEMMY_PLUGIN_DATA_DIR: data };
    async function plugin(id, input) {
      const prefix = join(evidence, id);
      const result = await capture(process.execPath, [join(repo, "plugins/office/src/main.mjs")], repo, fixtureEnv, prefix, 60000, JSON.stringify({ capabilityId: id, input }) + "\n");
      const events = (await readFile(`${prefix}.stdout`, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      const output = events.find(event => event.type === "result")?.output;
      if (result.code !== 0 || !output) throw new Error(`Fixture ${id} failed; see full logs`);
      return output;
    }
    const original = await plugin("office_create", { format: "pptx", name: "sample.pptx", slides: [{ title: "Office integration", body: ["Independent plugin", "Actual page rendering"], notes: "Preserved speaker notes" }] });
    const edited = await plugin("office_edit", { taskId: original.taskId, file: original.file, name: "edited.pptx", replacements: [{ from: "Office integration", to: "Office delivery verified" }] });
    for (const [variant, document] of [["original", original], ["edited", edited]]) {
      const bytes = await readFile(join(data, "tasks", document.taskId, document.file));
      await writeFile(join(evidence, `${variant}.pptx`), bytes);
      for (const mode of ["native", "appcontainer"]) {
        const id = `${variant}-${mode}`;
        const work = join(root, id); await mkdir(work);
        const source = join(work, "source.pptx"), out = join(work, "out"), profile = join(work, "profile");
        await writeFile(source, bytes); await mkdir(out); await mkdir(join(profile, "user"), { recursive: true });
        await writeFile(join(profile, "user/registrymodifications.xcu"), '<?xml version="1.0" encoding="UTF-8"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item><item oor:path="/org.openoffice.Office.Calc/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>0</value></prop></item></oor:items>');
        const env = {};
        for (const key of ["SystemRoot", "WINDIR", "PATH", "LOCALAPPDATA", "APPDATA", "USERPROFILE"]) if (process.env[key]) env[key] = process.env[key];
        Object.assign(env, { MEMMY_OFFICE_TRACE: "1", TEMP: work, TMP: work, TMPDIR: work, HOME: work, XDG_CONFIG_HOME: join(work, "config"), XDG_CACHE_HOME: join(work, "cache") });
        const args = [`-env:UserInstallation=${pathToFileURL(profile).href}`, "-env:OSL_SOCKET_PATH=.", "--headless", "--norestore", "--nodefault", "--nolockcheck", "--convert-to", "pdf", "--outdir", out, source];
        const item = { id, sourceSha256: hash(bytes), state: "running" };
        report.cases.push(item); await save();
        console.log(`PPTX diagnostic ${id} started`);
        try {
          let command = executable, argv = args, hostEnv = env;
          if (mode === "appcontainer") {
            const plan = { profile: `memmy.plugin.office.pptx-${randomUUID()}`, command: executable, args, cwd: work, readRoots: [runtime], writeRoots: [work] };
            await writeFile(join(evidence, `${id}.plan.json`), JSON.stringify(plan, null, 2));
            command = join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
            argv = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(repo, "App/backend/src/adapters/outbound/plugin-runtime/windows/launch.ps1"), "-Plan", Buffer.from(JSON.stringify(plan)).toString("base64")];
            hostEnv = { ...env, MEMMY_SANDBOX_TRACE: "1", MEMMY_SANDBOX_CHILD_ENV: Buffer.from(JSON.stringify(env)).toString("base64") };
          }
          // Allow identical engine time plus a separate launcher allowance.
          Object.assign(item, await capture(command, argv, work, hostEnv, join(evidence, id), mode === "native" ? 120000 : 150000));
          try {
            const pdf = await readFile(join(out, "source.pdf"));
            item.validPdf = pdf.subarray(0, 5).equals(Buffer.from("%PDF-"));
            await writeFile(join(evidence, `${id}.pdf`), pdf);
          } catch { item.validPdf = false; }
          item.state = item.code === 0 && !item.timedOut && item.validPdf ? "passed" : "failed";
        } catch (error) { item.state = "failed"; item.error = String(error.stack ?? error); }
        await save(); console.log(`PPTX diagnostic ${id}: ${JSON.stringify(item)}`);
      }
    }
    if (report.cases.some(item => item.state !== "passed")) process.exitCode = 1;
  } catch (error) { report.setupError = String(error.stack ?? error); process.exitCode = 1; }
  finally { await save(); console.log(`Full diagnostic evidence: ${evidence}`); }
}
await main();
