// Standalone Node runner: Windows cannot deliver POSIX signals gracefully.
// Parent-only IPC asks DSH to dispose plugins, sessions and managed child services.
import {pathToFileURL} from 'node:url';
const entry = process.argv[2];
if (!entry || !process.send) throw Error('DSH backend runner requires a parent IPC channel');
process.argv.splice(1, 1);
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  if (!process.emit('SIGTERM')) process.exit(0);
}
process.on('message', message => { if (message?.type === 'dsh-desktop-shutdown') shutdown(); });
process.on('disconnect', shutdown);
const {runCli} = await import(pathToFileURL(entry).href);
if (!stopping) await runCli();
