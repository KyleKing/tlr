/*
 * Not recommended to use mutable contexts like this, but only way for single canonical logs
 * https://github.com/dahlia/logtape/discussions/84#discussioncomment-14346710
 */

import { AsyncLocalStorage } from "node:async_hooks"

export const privateAsyncLocalStorage = new AsyncLocalStorage<{ logContext?: Record<string, unknown> }>()

function getContextLocalStorage() {
  return privateAsyncLocalStorage
}

/**
 * Initialize scope for mutable context
 */
export function initializeContext(callback: () => void | Promise<void>) {
  return getContextLocalStorage().run({ logContext: {} }, async () => {
    await callback()
  })
}

/**
 * Get the current async log context.
 */
export function getLogContext(): Record<string, unknown> {
  const als = getContextLocalStorage()
  if (!als) return {}

  const store = als.getStore()
  return store?.logContext || {}
}

/**
 * Merge new properties into the current async log context.
 * Safe to call anywhere within a initializeContext() scope.
 */
export function extendLogContext(newContext: Record<string, unknown>) {
  const als = getContextLocalStorage()
  if (!als) return

  const store = als.getStore()
  if (!store) return

  const updatedContext = { ...store.logContext, ...newContext }
  store.logContext = updatedContext
}
