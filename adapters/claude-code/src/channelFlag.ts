// How a Claude Code session gets the Local Review channel, and how to tell whether it has it.

/** The channel, as named on Claude Code's command line: the plugin, from its marketplace. */
export const CHANNEL = 'plugin:local-review@local-review';

/** Command to launch Claude Code with the channel on, while channels are a research preview. */
export const LAUNCH_WITH_CHANNEL = `claude --dangerously-load-development-channels ${CHANNEL}`;

const CHANNEL_FLAGS = ['--dangerously-load-development-channels', '--channels'];

/**
 * Whether a `claude` command line turns the Local Review channel on. Claude Code tells a channel
 * server nothing about it: its command line is the only way to know.
 */
export function hasChannel(commandLine: string): boolean {
  const args = commandLine.trim().split(/\s+/);
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i]!.split('=', 2) as [string, string | undefined];
    if (!CHANNEL_FLAGS.includes(flag)) continue;
    // The flag takes one or more channels: inline after "=", or the arguments that follow.
    const values = inline !== undefined ? [inline] : [];
    for (let j = i + 1; inline === undefined && j < args.length && !args[j]!.startsWith('-'); j++)
      values.push(args[j]!);
    if (values.some(isOurChannel)) return true;
  }
  return false;
}

const isOurChannel = (value: string) => value === CHANNEL || /^plugin:local-review@[\w.-]+$/.test(value);
