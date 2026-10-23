import { spawn } from 'node:child_process';
import { constants, accessSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { computerUseAgentEnvironment } from './memmy-screen-permission.js';

/** A permission change requires a fresh native TCC process before restarting Memmy. */
export async function stopComputerUseAgentForPermissionRestart(
  packaged: boolean,
  resourcesPath: string,
  developmentBinary?: string,
): Promise<void> {
  const candidate = packaged
    ? join(resourcesPath, 'app.asar.unpacked/dist/runtime/memmy-agent/dist/native-computer-use/Memmy Computer Use.app/Contents/MacOS/MemmyComputerUse')
    : developmentBinary;
  if (!candidate || !isAbsolute(candidate) || basename(candidate) !== 'MemmyComputerUse') return;
  let binary: string;
  try {
    accessSync(candidate, constants.X_OK);
    binary = realpathSync(candidate);
  } catch { return; }
  const app = dirname(dirname(dirname(binary)));
  if (!['Memmy Computer Use.app', 'Memmy Computer Use (Dev).app'].includes(basename(app))) return;
  const stopAgent = (env: NodeJS.ProcessEnv) => new Promise<void>((resolve) => {
    const child = spawn(binary, ['__memmy-history', '--stop-agent'], {
      stdio: 'ignore', windowsHide: true, env,
    });
    let settled = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (detached = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      child.removeListener('error', onError);
      child.removeListener('close', onClose);
      if (detached) {
        // A failed kill may report an asynchronous error even after our deadline.
        // Keep only a harmless error sink until close, never the waiting promise.
        const ignoreError = () => {};
        child.on('error', ignoreError);
        child.once('close', () => child.removeListener('error', ignoreError));
        child.unref();
      }
      resolve();
    };
    const onError = () => finish(true);
    const onClose = () => finish();
    const timer = setTimeout(() => {
      try {
        if (!child.kill('SIGTERM')) { finish(true); return; }
      } catch { finish(true); return; }
      if (settled) return;
      graceTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); }
        catch { /* Best effort: cleanup must still have a hard deadline. */ }
        finally { finish(true); }
      }, 250);
    }, 4_000);
    child.once('error', onError);
    child.once('close', onClose);
  });
  // The previous release used the default socket from the desktop process;
  // stop it once during migration as well as the app-scoped socket used now.
  const legacyEnvironment = { ...process.env };
  delete legacyEnvironment.OPEN_COMPUTER_USE_AGENT_SOCKET_NAMESPACE;
  await Promise.all([stopAgent(computerUseAgentEnvironment(binary)), stopAgent(legacyEnvironment)]);
}
