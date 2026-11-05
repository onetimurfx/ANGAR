/* Runs every e2e suite in order; exits non-zero if any fails. */
const { spawnSync } = require('node:child_process')
const path = require('node:path')
let failed = 0
for (const f of ['smoke.cjs', 'phase3.cjs']) {
  console.log(`\n===== ${f} =====`)
  const r = spawnSync('node', [path.join(__dirname, f)], { stdio: 'inherit', env: process.env })
  if (r.status !== 0) failed++
}
console.log(failed ? `\n${failed} suite(s) FAILED` : '\nALL SUITES PASSED')
process.exit(failed ? 1 : 0)
