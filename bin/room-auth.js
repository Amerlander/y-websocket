/**
 * Password authentication for rooms
 */

import crypto from 'crypto'

/**
 * Hash a password using SHA-256
 * @param {string} password
 * @returns {string} Hex hash
 */
export function hashPassword(password) {
  return crypto.createHash('sha256').update(password, 'utf8').digest('hex')
}

/**
 * Verify if a plain password matches a hash (constant-time comparison)
 * @param {string} plainPassword
 * @param {string} passwordHash
 * @returns {boolean}
 */
export function verifyPassword(plainPassword, passwordHash) {
  if (!passwordHash) return true
  if (!plainPassword) return false
  
  const providedHash = hashPassword(plainPassword)
  return crypto.timingSafeEqual(Buffer.from(providedHash), Buffer.from(passwordHash))
}
