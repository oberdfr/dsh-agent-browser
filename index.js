// DSH Host entry: the bundle patch in cordis.patch.yml mounts this row, and apply() registers the single
// `browser` tool per Agent plus the four authenticated transport routes. It never starts a browser process.
export { apply, inject, Config } from './lib/apply.js'
