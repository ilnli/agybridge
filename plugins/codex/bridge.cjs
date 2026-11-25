const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
if (process.argv[2] === 'hook' && !process.env.AGYBRIDGE_HOOK_STARTED_AT) process.env.AGYBRIDGE_HOOK_STARTED_AT = String(performance.timeOrigin);
const filename = path.join(__dirname, 'runtime.json');
const bundled = path.resolve(__dirname, '../../agybridge.mjs');
const runtime = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : { node: process.execPath, entry: fs.existsSync(bundled) ? bundled : path.resolve(__dirname, '../../dist/cli.js') };
if (runtime.home) process.env.AGYBRIDGE_HOME = runtime.home;
if (runtime.launcher) { require(runtime.launcher); } else {
const native = file => { const value = fs.realpathSync.native(file); return process.platform === 'win32' ? value.toLowerCase() : value; };
const command = process.argv[2], dedicated = path.join(path.dirname(runtime.entry), command + '-entry.mjs'), entry = ['mcp', 'hook'].includes(command) && fs.existsSync(dedicated) ? dedicated : runtime.entry;
if (native(runtime.node) === native(process.execPath)) {
  import(pathToFileURL(entry).href).catch(error => { process.stderr.write(String(error) + '\n'); process.exitCode = 1; });
} else {
const child = spawn(runtime.node, ['--no-warnings', entry, ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true, shell: false, env: { ...process.env, ...(runtime.home ? { AGYBRIDGE_HOME: runtime.home } : {}) } });
child.on('error', error => { process.stderr.write(String(error) + '\n'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
}
}
