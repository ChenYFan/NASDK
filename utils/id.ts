/**
 * NASDK id generation — shared across NACEB / NACP / NACT / NApp.
 */

/** RFC4122 v4 uuid. */
export const uuid = (): string =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })

/** Prefixed id, e.g. uid('task') → 'task_<uuid>'. */
export const uid = (prefix: string): string => `${prefix}_${uuid()}`
