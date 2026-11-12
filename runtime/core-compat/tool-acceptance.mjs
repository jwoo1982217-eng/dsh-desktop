// Reuse the exact candidate SDK; copy only the small plugin test inputs.
// Usage: node tool-acceptance.mjs <candidate-runtime> <registered-generated/tool-tests> <receipt-log>
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const [runtimeArg, generatedArg, logArg] = process.argv.slice(2);
if (!runtimeArg || !generatedArg || !logArg) throw Error('runtime, generated/tool-tests and receipt log are required');
const runtime = path.resolve(runtimeArg), generated = path.resolve(generatedArg), log = path.resolve(logArg);
if (!generated.endsWith('/generated/tool-tests')) throw Error('Use this registered task’s generated/tool-tests directory');
const version = JSON.parse(fs.readFileSync(path.join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version;
if (version !== '0.2.2-rc.1') throw Error('This acceptance fixture requires the exact rc.1 SDK');
const repo = fileURLToPath(new URL('../../', import.meta.url));
fs.mkdirSync(path.join(generated, 'peer'), {recursive: true});
const modules = path.join(generated, 'node_modules'), expected = path.join(runtime, 'node_modules');
if (fs.existsSync(modules)) { if (fs.realpathSync(modules) !== fs.realpathSync(expected)) throw Error('Unexpected fixture dependency tree'); }
else fs.symlinkSync(expected, modules);
for (const name of ['on-demand-tools', 'subagent-scheduler', 'legacy-subagent-policy']) fs.cpSync(path.join(repo, 'peer', name), path.join(generated, 'peer', name), {recursive: true});
const replaceOnce = (text, before, after) => { if (text.split(before).length !== 2) throw Error('Acceptance fixture API adapter did not match uniquely: ' + before); return text.replace(before, after); };
for (const name of ['native.test.mjs', 'native-recovery.test.mjs', 'team.test.mjs']) {
  const file = path.join(generated, 'peer/subagent-scheduler', name);
  let text = "import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native';\n" + fs.readFileSync(file, 'utf8');
  text = text.replaceAll('os.tmpdir()', 'process.env.DSH_ACCEPTANCE_ROOT');
  if (name === 'native.test.mjs') {
    text = replaceOnce(text, 'await ctx.plugin(Tools);', 'await ctx.plugin(Tools);await ctx.plugin(NativeExecutor);');
    text = replaceOnce(text, 'modelSelectionSettings:true', 'modelSelection:true');
  } else if (name === 'native-recovery.test.mjs') text = replaceOnce(text, '[Tools,Loop,Subagents,Spawn]', '[Tools,NativeExecutor,Loop,Subagents,Spawn]');
  else {
    text = replaceOnce(text, '[Tools,Loop,Subagents,Spawn,Fork]', '[Tools,NativeExecutor,Loop,Subagents,Spawn,Fork]');
    text = replaceOnce(text, 'modelSelectionSettings:true', 'modelSelection:true');
    text = replaceOnce(text, "const invoke=(name,args,agent=parent,signal=AbortSignal.timeout(10000))=>ctx.tools.execute({callId:'fixture-'+(++callNumber),name,arguments:args,agent,signal});", "const invoke=async(name,args,agent=parent,signal=AbortSignal.timeout(10000))=>(await ctx.tools.execute({calls:[{type:'tool-call',id:'fixture-'+(++callNumber),name,arguments:JSON.stringify(args)}],agent,signal})).results[0].result;");
  }
  fs.writeFileSync(file, text);
}
const home = path.join(generated, 'runner-home'); fs.mkdirSync(home, {recursive: true});
const files = ['peer/on-demand-tools/rc1.acceptance.mjs', 'peer/subagent-scheduler/rc1-lifecycle.acceptance.mjs', 'peer/subagent-scheduler/native.test.mjs', 'peer/subagent-scheduler/native-recovery.test.mjs', 'peer/subagent-scheduler/team.test.mjs'];
const result = spawnSync(process.execPath, ['--test', ...files.map(file => path.join(generated, file))], {
  env: {...process.env, DSH_HOME: home, DSH_ACCEPTANCE_ROOT: generated, DSH_TEAM_TEST_REPORT: path.join(path.dirname(log), 'team-rc1-report.json')},
  encoding: 'utf8', timeout: 60000, maxBuffer: 2 * 1024 * 1024,
});
fs.mkdirSync(path.dirname(log), {recursive: true}); fs.writeFileSync(log, result.stdout + result.stderr);
process.stdout.write(result.stdout); process.stderr.write(result.stderr);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
