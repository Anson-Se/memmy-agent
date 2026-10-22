import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

// File-backed stdio also works in Windows AppContainer with Electron's libuv,
// whose child-process pipes use an unsupported global named-pipe namespace.
export async function runProcess(command, args, { cwd, env, input = "", timeout = 120000, maxOutput = 8 * 1024 * 1024, children }) {
  const directory = await fs.mkdtemp(path.join(cwd, ".office-process-"));
  const handles = [];
  let child, timer, monitor, failure;
  const files = ["input", "output", "errors"].map(name => path.join(directory, name));
  try {
    await fs.writeFile(files[0], input, { flag: "wx" });
    handles.push(await fs.open(files[0], "r"), await fs.open(files[1], "wx"), await fs.open(files[2], "wx"));
    child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: handles.map(handle => handle.fd) });
    children?.add(child);
    const stop = message => { failure ??= new Error(message); child.kill("SIGKILL"); };
    const exit = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    timer = setTimeout(() => stop("Office process timed out"), timeout);
    monitor = setInterval(() => {
      void Promise.all(handles.slice(1).map(handle => handle.stat())).then(stats => {
        if (stats.some(info => info.size > maxOutput)) stop("Tool output exceeded limit");
      }).catch(() => {}); // Handles can close after the process exits.
    }, 100);
    const result = await exit;
    if (failure) throw failure;
    const sizes = await Promise.all(handles.slice(1).map(handle => handle.stat()));
    if (sizes.some(info => info.size > maxOutput)) throw new Error("Tool output exceeded limit");
    return { ...result, stdout: await fs.readFile(files[1], "utf8"), stderr: (await fs.readFile(files[2], "utf8")).slice(0, 8192) };
  } finally {
    clearTimeout(timer); clearInterval(monitor);
    if (child) children?.delete(child);
    await Promise.all(handles.map(handle => handle.close()));
    await fs.rm(directory, { recursive: true, force: true });
  }
}
