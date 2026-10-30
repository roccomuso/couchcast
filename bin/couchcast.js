#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { parseIntFlag, serve } from '../src/commands/serve.js'
import { CouchcastError, ErrorCode } from '../src/errors.js'
import { VERSION } from '../src/version.js'

const HELP = `couchcast ${VERSION}
Stream the videos in a folder to VLC and smart TVs over your LAN (DLNA).

Usage
  couchcast [serve] [options]

Options
  -d, --dir <path>          Folder to serve (default: current directory)
  -n, --name <name>         Server name shown on clients (default: "couchcast on <hostname>")
  -p, --port <port>         HTTP port (default: 8200, falls back to a free port)
  -i, --interface <if|ip>   Network interface or IPv4 address (default: auto)
      --no-ui               Plain log output instead of the dashboard
      --no-keep-awake       Let the computer sleep while streaming
      --grace <seconds>     Stay awake this long after the last stream ends (default: 120)
      --no-ffprobe          Skip ffprobe even if installed (built-in readers still run)
      --no-watch            Don't watch the folder for changes
  -v, --verbose             Debug logs
  -h, --help                Show this help
      --version             Show the version

Keys (dashboard)
  q quit · v toggle verbose logs · r rescan folder
`

/** @param {string[]} argv */
async function main (argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    allowNegative: true,
    options: {
      dir: { type: 'string', short: 'd' },
      name: { type: 'string', short: 'n' },
      port: { type: 'string', short: 'p' },
      interface: { type: 'string', short: 'i' },
      ui: { type: 'boolean', default: true },
      'keep-awake': { type: 'boolean', default: true },
      grace: { type: 'string' },
      ffprobe: { type: 'boolean', default: true },
      watch: { type: 'boolean', default: true },
      verbose: { type: 'boolean', short: 'v', default: false },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean' },
    },
  })

  if (values.help) {
    process.stdout.write(HELP)
    return
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`)
    return
  }

  const [command = 'serve', ...extra] = positionals
  switch (command) {
    case 'serve': {
      if (extra.length) throw new CouchcastError(ErrorCode.INVALID_ARG, `Unexpected argument: ${extra[0]} (use --dir)`)
      const interactive = Boolean(process.stdout.isTTY && process.stdin.isTTY)
      return serve({
        dir: values.dir,
        name: values.name,
        port: parseIntFlag(values.port, '--port', { min: 0, max: 65535 }),
        interface: values.interface,
        ui: values.ui && interactive,
        keepAwake: values['keep-awake'],
        graceSeconds: parseIntFlag(values.grace, '--grace', { min: 0, max: 86_400 }) ?? 120,
        ffprobe: values.ffprobe,
        watch: values.watch,
        verbose: values.verbose,
      })
    }
    case 'play':
      throw new CouchcastError(ErrorCode.NOT_IMPLEMENTED, '`couchcast play` is on the roadmap, not in this release')
    default:
      throw new CouchcastError(ErrorCode.INVALID_ARG, `Unknown command: ${command}. See couchcast --help`)
  }
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code ?? 0 },
  (err) => {
    const usage = err?.code === ErrorCode.INVALID_ARG || String(err?.code).startsWith('ERR_PARSE_ARGS')
    const known = usage || err instanceof CouchcastError
    process.stderr.write(`couchcast: ${known ? err.message : err?.stack ?? err}\n`)
    process.exitCode = usage ? 2 : 1
  }
)
