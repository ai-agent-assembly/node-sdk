'use strict'
/* c8 ignore file */

const fs = require('node:fs')
const path = require('node:path')

// napi triple for each supported `<platform>-<arch>`. The published package
// bundles one `index.<triple>.node` per platform (e.g. `index.linux-x64-gnu.node`),
// so the loader must pick THIS platform's triple. Selecting the first `.node`
// found via `readdirSync` loads a wrong-arch binary and crashes when all three
// are bundled together (AAASM-4467).
//
// win32 is intentionally absent: the governance core is Unix-only and no win32
// `.node` is built, so a Windows process falls through to the generic
// "unsupported platform" error below rather than resolving a phantom
// `index.win32-x64-msvc.node` that is never shipped (AAASM-4467).
const PLATFORM_TRIPLES = {
  'darwin-arm64': 'darwin-arm64',
  'darwin-x64': 'darwin-x64',
  'linux-x64': 'linux-x64-gnu'
}

const directPath = path.join(__dirname, 'index.node')
if (fs.existsSync(directPath)) {
  module.exports = require(directPath)
} else {
  const platformTriple = PLATFORM_TRIPLES[`${process.platform}-${process.arch}`]

  if (!platformTriple) {
    throw new Error(
      `Unsupported platform ${process.platform}-${process.arch}: ` +
        'no native addon binary in native/aa-ffi-node'
    )
  }

  const triplePath = path.join(__dirname, `index.${platformTriple}.node`)

  if (!fs.existsSync(triplePath)) {
    throw new Error(
      `No native addon binary (index.${platformTriple}.node) found in native/aa-ffi-node`
    )
  }

  module.exports = require(triplePath)
}
