/**
 * Room cleanup scheduler
 * Periodically cleans up inactive persistent rooms:
 * 1. Compact document state to reduce storage (removes edit history)
 * 2. Unload from memory after MEMORY_UNLOAD_DAYS (default: 3 days)
 * 3. Delete from disk after MAX_INACTIVE_DAYS (default: 30 days)
 */

import * as Y from '@y/y'
import { getCleanupInterval, getMemoryUnloadAge, getMaxInactiveAge } from './persistent-rooms.js'

/**
 * Compact a YJS document by encoding and re-applying its current state
 * This removes the edit history, significantly reducing storage size
 * @param {string} docName - The document name
 * @param {any} doc - The YJS document
 * @param {any} persistence - The persistence layer (LevelDB)
 * @returns {Promise<{oldSize: number, newSize: number}>}
 */
const compactDocument = async (docName, doc, persistence) => {
  if (!persistence || !persistence.provider) return { oldSize: 0, newSize: 0 }
  
  try {
    // Get current full state as a single update
    const currentState = Y.encodeStateAsUpdate(doc)
    const oldSize = currentState.length
    
    // Clear old incremental updates and store fresh compacted state
    // LevelDB's flushDocument clears all updates for a doc
    if (persistence.provider.flushDocument) {
      await persistence.provider.flushDocument(docName)
    }
    
    // Store the compacted state
    await persistence.provider.storeUpdate(docName, currentState)
    
    const newSize = currentState.length
    console.log(`📦 Compacted "${docName}": ${(oldSize / 1024).toFixed(1)}KB → ${(newSize / 1024).toFixed(1)}KB`)
    
    return { oldSize, newSize }
  } catch (err) {
    console.error(`Error compacting document "${docName}":`, err)
    return { oldSize: 0, newSize: 0 }
  }
}

/**
 * Initialize the cleanup scheduler
 * @param {Map<string, any>} docs - The map of all documents
 * @param {any} persistence - The persistence layer
 */
export const initCleanupScheduler = (docs, persistence) => {
  const cleanupInterval = getCleanupInterval()
  const memoryUnloadAge = getMemoryUnloadAge()
  const maxInactiveAge = getMaxInactiveAge()
  
  console.log(`Room cleanup scheduler initialized:`)
  console.log(`  - Cleanup runs every ${cleanupInterval / (1000 * 60 * 60)} hours`)
  console.log(`  - Rooms compacted & unloaded from memory after ${memoryUnloadAge / (1000 * 60 * 60 * 24)} days of inactivity`)
  console.log(`  - Rooms deleted from disk after ${maxInactiveAge / (1000 * 60 * 60 * 24)} days of inactivity`)

  /**
   * Perform cleanup of inactive rooms
   */
  const performCleanup = async () => {
    const now = Date.now()
    const memoryCutoffTime = now - memoryUnloadAge
    const diskCutoffTime = now - maxInactiveAge
    let unloadedCount = 0
    let deletedCount = 0
    let compactedCount = 0
    let checkedCount = 0
    
    console.log(`\n🧹 Starting room cleanup at ${new Date(now).toISOString()}`)
    
    // Iterate through all documents in memory
    for (const [docName, doc] of docs.entries()) {
      checkedCount++
      
      // Only process persistent rooms
      if (doc.isPersistent && doc.conns.size === 0) {
        const inactiveDays = Math.floor((now - doc.lastAccessed) / (1000 * 60 * 60 * 24))
        
        // Check if room should be deleted from disk (oldest threshold)
        if (doc.lastAccessed < diskCutoffTime) {
          console.log(`🗑️  Deleting persistent room from disk: "${docName}" (last accessed ${inactiveDays} days ago)`)
          
          // Delete from disk if persistence is enabled
          if (persistence !== null) {
            persistence.provider.clearDocument(docName)
              .then(() => {
                console.log(`✅ Successfully deleted room "${docName}" from disk`)
              })
              .catch(err => {
                console.error(`❌ Error deleting room "${docName}" from disk:`, err)
              })
          }
          
          // Remove from memory
          doc.destroy()
          docs.delete(docName)
          deletedCount++
        }
        // Check if room should be unloaded from memory (but kept on disk)
        else if (doc.lastAccessed < memoryCutoffTime) {
          console.log(`💾 Compacting & unloading: "${docName}" (last accessed ${inactiveDays} days ago)`)
          
          // Compact the document before unloading to save disk space
          if (persistence !== null) {
            try {
              await compactDocument(docName, doc, persistence)
              compactedCount++
              
              await persistence.writeState(docName, doc)
              doc.destroy()
              docs.delete(docName)
              unloadedCount++
              console.log(`✅ Successfully compacted and unloaded room "${docName}"`)
            } catch (err) {
              console.error(`❌ Error processing room "${docName}":`, err)
              // Unload anyway even if compaction/persistence fails
              doc.destroy()
              docs.delete(docName)
              unloadedCount++
            }
          } else {
            // No persistence, just remove from memory
            doc.destroy()
            docs.delete(docName)
            unloadedCount++
          }
        }
      }
    }
    
    console.log(`✅ Cleanup completed: checked ${checkedCount} rooms, compacted ${compactedCount}, unloaded ${unloadedCount} from memory, deleted ${deletedCount} from disk\n`)
  }

  // Run cleanup immediately on startup (to clean up any leftover rooms from previous runs)
  setTimeout(performCleanup, 60000) // Wait 1 minute after startup

  // Schedule periodic cleanup
  const intervalId = setInterval(performCleanup, cleanupInterval)
  
  // Return cleanup function and interval ID for testing/shutdown
  return {
    performCleanup,
    compactDocument,
    intervalId,
    stop: () => clearInterval(intervalId)
  }
}
