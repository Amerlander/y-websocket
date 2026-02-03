/**
 * Room cleanup configuration
 * All rooms are persistent and stored on server.
 */

/**
 * Get the cleanup interval in milliseconds
 * Default: check every 24 hours
 * @returns {number}
 */
export const getCleanupInterval = () => {
  const hours = parseInt(process.env.CLEANUP_INTERVAL_HOURS || '24')
  return hours * 60 * 60 * 1000
}

/**
 * Get the max age for inactive rooms in memory before unloading
 * Default: 3 days (rooms unloaded from memory but kept on disk)
 * @returns {number}
 */
export const getMemoryUnloadAge = () => {
  const days = parseInt(process.env.MEMORY_UNLOAD_DAYS || '3')
  return days * 24 * 60 * 60 * 1000
}

/**
 * Get the max age for inactive rooms before permanent deletion from disk
 * Default: 30 days
 * @returns {number}
 */
export const getMaxInactiveAge = () => {
  const days = parseInt(process.env.MAX_INACTIVE_DAYS || '30')
  return days * 24 * 60 * 60 * 1000
}
