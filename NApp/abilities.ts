/**
 * Abilities the App provides on its own behalf, exposed over the ORDINARY request path
 * (`{kind:'ability', target:'NApp.introduce'}`). Registered through the standard register port at assembly
 * time; registration is last-write-wins like any map.
 */

import type { NApp } from './NApp.ts'
import type { AbilityProcessorHandler } from './types.ts'

/** Ask a peer for its full capability declaration (refresh path; register already exchanges one). */
export const INTRODUCE = 'NApp.introduce'

/** Built once per assembly, closing over the ref. */
export function appAbilities(napp: NApp): AbilityProcessorHandler[] {
  return [
    {
      name: INTRODUCE,
      description: "Return this App's full capability declaration (events + abilities).",
      execute: () => napp.buildDecl(),
    },
  ]
}
