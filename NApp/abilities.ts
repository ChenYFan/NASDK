/**
 * Abilities the App provides on its own behalf.
 *
 * They expose an NApp's internals over the ORDINARY request path: a peer asks with
 * `{kind:'ability', target:'NApp.introduce'}` and gets a normal response back. No new message type, no extra kind,
 * no side channel — introspection reuses the pipe that already exists.
 *
 * They are ordinary abilities in every respect. NApp registers them through the standard
 * `AbilityProcessor.register` port at assembly time, into the same table a user's abilities go into. There is
 * no reserved prefix, no privileged tier, no bypass, and nothing for a processor to special-case: the
 * processor cannot tell these apart from any other registration, and "the App provides this one" is a fact
 * about the App, not about the processor.
 *
 * Consequences, all deliberate:
 *   - NACP is not involved. It never builds these and never hands them anywhere; it stays a layer that only
 *     READS a processor's list and PUSHES requests into it.
 *   - A user-supplied AbilityProcessor gets them too, because registration goes through the contract rather
 *     than anything NACAB-specific.
 *   - Nothing defends these names. Registration is last-write-wins, like any map: an ability registered AFTER
 *     bindProcessor overrides the App's, while one passed to a processor's constructor BEFORE bindProcessor
 *     gets overridden by it. These are conveniences the App offers, not protocol guarantees.
 *
 * `execute` reaches App state by CLOSURE over the App itself, which is why the item can stay pure data.
 *
 * Adding `NApp.stat` / `NApp.peers` / `NApp.subs` later is one more entry here and nothing anywhere else.
 */

import type { NApp } from './NApp.ts'
import type { AbilityProcessorHandler } from './types.ts'

/** Ask a peer for its full capability declaration. register already exchanges one; this is the REFRESH path.
 *  The `NApp.` prefix is plain namespacing, NOT a reserved marker: nothing checks it, nothing protects it,
 *  and a same-named registration made later simply wins. */
export const INTRODUCE = 'NApp.introduce'

/** Built once per assembly, closing over the ref. The processor sees only name/description/execute. */
export function appAbilities(napp: NApp): AbilityProcessorHandler[] {
  return [
    {
      name: INTRODUCE,
      description: "Return this App's full capability declaration (events + abilities).",
      // buildDecl() is recomputed on every call, so an ability registered a moment ago is already included.
      execute: () => napp.buildDecl(),
    },
  ]
}
