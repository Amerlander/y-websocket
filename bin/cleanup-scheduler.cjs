/**
 * Room cleanup scheduler
 * Periodically cleans up inactive persistent rooms:
 * 1. Unload from memory after MEMORY_UNLOAD_DAYS (default: 3 days)
 * 2. Delete from disk after MAX_INACTIVE_DAYS (default: 90 days)
 */

const { getCleanupInterval, getMemoryUnloadAge, getMaxInactiveAge } = require('./persistent-rooms.cjs')

/**
 * Initialize the cleanup scheduler
 * @param {Map<string, any>} docs - The map of all documents
 * @param {any} persistence - The persistence layer
 */
const initCleanupScheduler = (docs, persistence) => {
  const cleanupInterval = getCleanupInterval()
  const memoryUnloadAge = getMemoryUnloadAge()
  const maxInactiveAge = getMaxInactiveAge()
  
  console.log(`Room cleanup scheduler initialized:`)
  console.log(`  - Cleanup runs every ${cleanupInterval / (1000 * 60 * 60)} hours`)
  console.log(`  - Rooms unloaded from memory after ${memoryUnloadAge / (1000 * 60 * 60 * 24)} days of inactivity`)
  console.log(`  - Rooms deleted from disk after ${maxInactiveAge / (1000 * 60 * 60 * 24)} days of inactivity`)

  /**
   * Perform cleanup of inactive rooms
   */
  const performCleanup = () => {
    const now = Date.now()
    const memoryCutoffTime = now - memoryUnloadAge
    const diskCutoffTime = now - maxInactiveAge
    let unloadedCount = 0
    let deletedCount = 0
    let checkedCount = 0
    
    console.log(`Starting room cleanup at ${new Date(now).toISOString()}`)
    
    // Iterate through all documents in memory
    for (const [docName, doc] of docs.entries()) {
      checkedCount++
      
      // Only process persistent rooms
      if (doc.isPersistent && doc.conns.size === 0) {
        const inactiveDays = Math.floor((now - doc.lastAccessed) / (1000 * 60 * 60 * 24))
        
        // Check if room should be deleted from disk (oldest threshold)
        if (doc.lastAccessed < diskCutoffTime) {
          console.log(`Deleting persistent room from disk: "${docName}" (last accessed ${inactiveDays} days ago)`)
          
          // Delete from disk if persistence is enabled
          if (persistence !== null) {
            persistence.provider.clearDocument(docName)
              .then(() => {
                console.log(`Successfully deleted room "${docName}" from disk`)
              })
              .catch(err => {
                console.error(`Error deleting room "${docName}" from disk:`, err)
              })
          }
          
          // Remove from memory
          doc.destroy()
          docs.delete(docName)
          deletedCount++
        }
        // Check if room should be unloaded from memory (but kept on disk)
        else if (doc.lastAccessed < memoryCutoffTime) {
          console.log(`Unloading persistent room from memory: "${docName}" (last accessed ${inactiveDays} days ago, will remain on disk)`)
          
          // Persist to disk one final time before unloading
          if (persistence !== null) {
            persistence.writeState(docName, doc)
              .then(() => {
                doc.destroy()
                docs.delete(docName)
                unloadedCount++
                console.log(`Successfully unloaded room "${docName}" from memory`)
              })
              .catch(err => {
                console.error(`Error persisting room "${docName}" before unload:`, err)
                // Unload anyway even if persistence fails
                doc.destroy()
                docs.delete(docName)
                unloadedCount++
              })
          } else {
            // No persistence, just remove from memory
            doc.destroy()
            docs.delete(docName)
            unloadedCount++
          }
        }
      }
    }
    
    console.log(`Cleanup completed: checked ${checkedCount} rooms, unloaded ${unloadedCount} from memory, deleted ${deletedCount} from disk`)
  }

  // Run cleanup immediately on startup (to clean up any leftover rooms from previous runs)
  setTimeout(performCleanup, 60000) // Wait 1 minute after startup

  // Schedule periodic cleanup
  const intervalId = setInterval(performCleanup, cleanupInterval)
  
  // Return cleanup function and interval ID for testing/shutdown
  return {
    performCleanup,
    intervalId,
    stop: () => clearInterval(intervalId)
  }
}

module.exports = {
  initCleanupScheduler
}
