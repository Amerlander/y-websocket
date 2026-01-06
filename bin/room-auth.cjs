/**
 * Password authentication for persistent rooms
 * 
 * Security model:
 * - Password hash is part of the room name (for room identification)
 * - Client sends plain password in metadata during connection
 * - Backend verifies password hash matches before allowing communication
 * - This prevents URL-only access (from logs, cache, etc.)
 */

const crypto = require('crypto')

/**
 * Hash a password using SHA-256 (matches frontend implementation)
 * @param {string} password - Plain text password
 * @returns {string} - Hex string of the hash
 */
function hashPassword(password) {
  return crypto.createHash('sha256').update(password, 'utf8').digest('hex')
}

/**
 * Verify if a plain password matches the room's password hash
 * @param {string} plainPassword - Plain text password from client
 * @param {string} roomPasswordHash - The password hash from room name
 * @returns {boolean} True if password matches
 */
function verifyPassword(plainPassword, roomPasswordHash) {
  if (!roomPasswordHash) {
    // Room has no password protection (non-persistent room)
    return true
  }
  
  if (!plainPassword) {
    // Password required but not provided
    return false
  }
  
  const providedHash = hashPassword(plainPassword)
  
  // Constant-time comparison to prevent timing attacks
  return crypto.timingSafeEqual(
    Buffer.from(providedHash),
    Buffer.from(roomPasswordHash)
  )
}

/**
 * Parse room name and password hash from connection string
 * Format: "roomName:passwordHash" or just "roomName"
 * @param {string} connectionString - The connection string from client
 * @returns {{roomName: string, passwordHash: string|null}}
 */
function parseRoomConnection(connectionString) {
  if (!connectionString) {
    return { roomName: '', passwordHash: null }
  }

  const lastColonIndex = connectionString.lastIndexOf(':')
  
  if (lastColonIndex > 0 && lastColonIndex < connectionString.length - 1) {
    const roomName = connectionString.substring(0, lastColonIndex)
    const passwordHash = connectionString.substring(lastColonIndex + 1)
    
    // Password hash should be 64 hex characters (SHA-256)
    if (passwordHash.length === 64 && /^[a-f0-9]+$/i.test(passwordHash)) {
      return { roomName, passwordHash }
    }
  }
  
  // No password provided or invalid format
  return { roomName: connectionString, passwordHash: null }
}

module.exports = {
  parseRoomConnection,
  verifyPassword,
  hashPassword
}
