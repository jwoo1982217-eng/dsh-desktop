// Tests resolve shared SDK imports through the pinned desktop installation.
// This creates no dependency links in the source tree or production profile.
import { registerHooks, createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const runtime = createRequire(new URL('../desktop-runtime/package.json', import.meta.url));
const parents = [new URL('../desktop-runtime/package.json', import.meta.url).href];
for (const name of ['@deepseek-ai/dsh', 'dsh-codearts-auth', 'dsh-peer']) {
  parents.push(pathToFileURL(runtime.resolve(name + '/package.json')).href);
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.includes(':') || error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
      for (const parentURL of parents) {
        try { return nextResolve(specifier, { ...context, parentURL }); }
        catch (candidate) { if (!['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED'].includes(candidate.code)) throw candidate; }
      }
      throw error;
    }
  },
});
