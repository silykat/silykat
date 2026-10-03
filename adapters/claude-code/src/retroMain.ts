import { runRetroCli } from './retroCli';

// Entry point of `lr-retro`, on Claude's PATH with the plugin.
runRetroCli(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  out: (text) => process.stdout.write(text + '\n'),
  err: (text) => process.stderr.write(text + '\n'),
}).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`lr-retro: ${String(err)}\n`);
    process.exitCode = 1;
  },
);
