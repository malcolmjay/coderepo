import {createInterface} from 'node:readline/promises';
import {Writable} from 'node:stream';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parseWelcomeConfig} from '../functions/lib/welcome-config.js';

const args = process.argv.slice(2);
const project = args[args.indexOf('--project') + 1];
if (!args.includes('--project') || !/^[a-z][a-z0-9-]{4,29}$/.test(project ?? '')) {
  console.error('Usage: node scripts/configure-welcome-email.mjs --project camera-hacks [--disable]');
  process.exit(1);
}
let config = {enabled: false};
if (!args.includes('--disable')) {
  if (!process.stdin.isTTY) throw new Error('Run this setup in an interactive terminal. Never put credentials in command arguments.');
  console.log('Enter the SMTP settings from your email provider. This saves a Firebase secret; it does not send email or deploy.');
  let muted = false;
  const output = new Writable({write(chunk, _encoding, callback) {if (!muted) process.stdout.write(chunk); callback();}});
  const prompt = createInterface({input: process.stdin, output, terminal: true});
  const ask = async (label, secret = false) => {
    if (!secret) return (await prompt.question(label)).trim();
    process.stdout.write(label); muted = true;
    try {return await prompt.question('');} finally {muted = false; process.stdout.write('\n');}
  };
  prompt.on('SIGINT', () => {muted = false; prompt.close(); process.stdout.write('\nCancelled.\n'); process.exit(1);});
  try {
    config = {
      host: await ask('SMTP hostname: '),
      port: Number(await ask('SMTP port (465, 587, or 2525): ')),
      user: await ask('SMTP username: '),
      password: await ask('SMTP password / API key (hidden): ', true),
      from: await ask('Verified sender email address: '),
      replyTo: await ask('Reply-to email (optional; press Enter to omit): '),
    };
    parseWelcomeConfig(JSON.stringify(config));
  } finally {prompt.close();}
}
const cli = fileURLToPath(new URL('../node_modules/firebase-tools/lib/bin/firebase.js', import.meta.url));
const result = spawnSync(process.execPath, [cli, 'functions:secrets:set', 'WELCOME_EMAIL_CONFIG',
  '--project', project, '--data-file', '-', '--format', 'json', '--non-interactive'],
  {input: JSON.stringify(config), stdio: ['pipe', 'inherit', 'inherit']});
if (result.error || result.status !== 0) {
  console.error('Could not save the sender settings. Check Firebase authentication and Secret Manager permissions.');
  process.exit(1);
}
console.log(`Settings saved. Activate them by deploying Functions and Hosting to ${project}.`);
