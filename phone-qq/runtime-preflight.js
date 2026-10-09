import { PhoneRuntime } from './runtime.js';
const root = process.cwd(), home = process.env.DSH_HOME;
if (!home) throw Error('DSH_HOME required');
const report = await new PhoneRuntime(root, home).apply();
console.log(JSON.stringify({ phoneRuntimePreflight: report }));
