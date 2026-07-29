const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (useColor ? `[${code}m${s}[0m` : String(s));

export const dim = c('2');
export const bold = c('1');
export const cyan = c('36');
export const green = c('32');
export const yellow = c('33');
export const red = c('31');
export const magenta = c('35');

export const log = (...a) => console.log(...a);
export const step = (label, msg) => console.log(`${cyan(`[${label}]`)} ${msg}`);
export const ok = (msg) => console.log(`${green('  ✓')} ${msg}`);
export const warn = (msg) => console.log(`${yellow('  !')} ${msg}`);
export const fail = (msg) => console.log(`${red('  ✗')} ${msg}`);
export const info = (msg) => console.log(`${dim('  ·')} ${dim(msg)}`);

export function banner(text) {
  console.log('');
  console.log(bold(magenta(`  ${text}`)));
  console.log(dim(`  ${'─'.repeat(Math.max(text.length, 24))}`));
}

/** Human-readable duration. */
export function ms(n) {
  return n < 1000 ? `${n}ms` : `${(n / 1000).toFixed(1)}s`;
}
