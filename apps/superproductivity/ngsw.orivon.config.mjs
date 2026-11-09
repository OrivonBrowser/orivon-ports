// Runs after upstream's own `ng build`, in the clone (the executor's cwd), with the build
// output as its argument. Sets the service worker manifest's timestamp, the one value the
// build takes from the clock, to the pinned commit's date (src/build/ngsw-kit.mjs), so a
// rebuild of this pin is the same bytes. README.md, Design notes, says why.
import { pinNgswTimestamp } from '../../src/build/ngsw-kit.mjs'

const timestamp = await pinNgswTimestamp(process.argv[2])
process.stdout.write(`ngsw.json timestamp pinned to the commit date, ${new Date(timestamp).toISOString()}\n`)
