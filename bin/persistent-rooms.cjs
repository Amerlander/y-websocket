/**
 * Persistent room utilities
 * All rooms are now persistent (stored on server).
 * Password-protected rooms have their first word from this special list.
 */

// List of words that identify password-protected rooms
// This should match the frontend's persistent_room_words list
const passwordProtectedRoomWords = [
  "zimmerpflanze",
  "sonnenaufgang",
  "kinderwagen",
  "sauberkeit",
  "freiluftkino",
  "stadtteil",
  "sonnenbrille",
  "fernblick",
  "spielplatz",
  "kuppel",
  "bucht",
  "nische",
  "mosaik",
  "sprosse",
  "tau",
  "brise",
  "scheune",
  "schemel",
  "zunder",
  "holzbank",
  "gartenzaun",
  "bachlauf",
  "strandgut",
  "strandkorb",
  "segelboot",
  "leuchtturm",
  "moor",
  "feldrand",
  "sandbank",
  "promenade",
  "laubwald",
  "hasenpfad",
  "gartentor",
  "sonnensee",
  "sandinsel",
  "feldhaus",
  "laubgarten",
  "moosweg",
  "stromtal",
  "steinpfad",
  "quellrand",
  "bachquelle",
  "dornhain",
  "heideweg",
  "horstplatz",
  "rehweide",
  "fuchsweg",
  "eichenhain"
]

// Keep backward compatibility alias
const persistentRoomWords = passwordProtectedRoomWords

/**
 * Check if a room name indicates it requires a password.
 * Password-protected rooms have the first word from passwordProtectedRoomWords.
 * @param {string} roomName - The name of the room
 * @returns {boolean} True if the room requires a password
 */
const isPasswordProtectedRoom = (roomName) => {
  if (!roomName || typeof roomName !== 'string') {
    return false
  }

  // Split the room name by dashes or spaces to get individual words
  const words = roomName.toLowerCase().split(/[-\s]+/)
  
  // Check if the first word is in the password-protected room words list
  if (words.length > 0) {
    return passwordProtectedRoomWords.includes(words[0])
  }
  
  return false
}

/**
 * All rooms are now persistent.
 * @param {string} roomName - The name of the room
 * @returns {boolean} Always returns true - all rooms are persistent
 */
const isPersistentRoom = (roomName) => {
  // All rooms are now persistent
  return true
}

/**
 * Get the cleanup interval in milliseconds
 * Default: check every 24 hours
 * @returns {number} Interval in milliseconds
 */
const getCleanupInterval = () => {
  const interval = parseInt(process.env.CLEANUP_INTERVAL_HOURS || '24')
  return interval * 60 * 60 * 1000 // hours to milliseconds
}

/**
 * Get the max age for inactive rooms in memory before unloading
 * Default: 3 days (rooms unloaded from memory but kept on disk)
 * @returns {number} Max age in milliseconds
 */
const getMemoryUnloadAge = () => {
  const days = parseInt(process.env.MEMORY_UNLOAD_DAYS || '3')
  return days * 24 * 60 * 60 * 1000 // days to milliseconds
}

/**
 * Get the max age for inactive rooms before permanent deletion from disk
 * Default: 90 days (3 months)
 * @returns {number} Max age in milliseconds
 */
const getMaxInactiveAge = () => {
  const days = parseInt(process.env.MAX_INACTIVE_DAYS || '90')
  return days * 24 * 60 * 60 * 1000 // days to milliseconds
}

module.exports = {
  isPersistentRoom,
  isPasswordProtectedRoom,
  getCleanupInterval,
  getMemoryUnloadAge,
  getMaxInactiveAge,
  persistentRoomWords,
  passwordProtectedRoomWords
}
