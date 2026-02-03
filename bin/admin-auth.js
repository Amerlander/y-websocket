/**
 * Admin Authentication Module
 * 
 * Uses PGP for initial authentication, JWT for session management.
 * 
 * Flow:
 * 1. Admin connects with publicKey
 * 2. Server generates challenge (nonce)
 * 3. Admin signs challenge with private key
 * 4. Server verifies signature with stored/provided publicKey
 * 5. Server issues JWT for the session
 * 6. Admin includes JWT in protected operations
 */

import * as openpgp from 'openpgp'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'

// JWT secret - in production, use environment variable
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(64).toString('hex')
const JWT_EXPIRY = process.env.JWT_EXPIRY || '2h'

// Message types for auth protocol
export const AUTH_MESSAGE_TYPES = {
  // Server → Client
  CHALLENGE: 'auth:challenge',
  AUTH_SUCCESS: 'auth:success',
  AUTH_FAILURE: 'auth:failure',
  // Client → Server
  AUTH_REQUEST: 'auth:request',
  AUTH_RESPONSE: 'auth:response'
}

// Store pending challenges (connectionId → challenge)
const pendingChallenges = new Map()

/**
 * Generate a cryptographic challenge for authentication
 * @param {string} connectionId - Unique identifier for the connection
 * @returns {{ challenge: string, timestamp: number }}
 */
export function generateChallenge(connectionId) {
  const challenge = crypto.randomBytes(32).toString('base64')
  const timestamp = Date.now()
  
  // Store challenge with expiry (30 seconds)
  pendingChallenges.set(connectionId, { challenge, timestamp, expiresAt: timestamp + 30000 })
  
  // Clean up expired challenges periodically
  setTimeout(() => {
    const stored = pendingChallenges.get(connectionId)
    if (stored && Date.now() > stored.expiresAt) {
      pendingChallenges.delete(connectionId)
    }
  }, 35000)
  
  return { challenge, timestamp }
}

/**
 * Verify a PGP signature against a challenge
 * @param {string} connectionId - Connection identifier
 * @param {string} signature - Armored PGP signature
 * @param {string} publicKeyArmored - Armored PGP public key
 * @returns {Promise<boolean>}
 */
export async function verifySignature(connectionId, signature, publicKeyArmored) {
  const stored = pendingChallenges.get(connectionId)
  
  if (!stored) {
    console.warn(`⚠️ No pending challenge for connection ${connectionId}`)
    return false
  }
  
  if (Date.now() > stored.expiresAt) {
    pendingChallenges.delete(connectionId)
    console.warn(`⚠️ Challenge expired for connection ${connectionId}`)
    return false
  }
  
  try {
    // Parse the public key
    const publicKey = await openpgp.readKey({ armoredKey: publicKeyArmored })
    
    // Parse the signature (it should be a clearsigned message containing the challenge)
    const message = await openpgp.readCleartextMessage({ cleartextMessage: signature })
    
    // Verify the signature
    const verificationResult = await openpgp.verify({
      message,
      verificationKeys: publicKey
    })
    
    const { verified, signature: sig } = verificationResult.signatures[0]
    
    try {
      await verified
    } catch (e) {
      console.warn(`⚠️ Signature verification failed:`, e.message)
      return false
    }
    
    // Check that the signed message matches our challenge
    const signedText = message.getText().trim()
    if (signedText !== stored.challenge) {
      console.warn(`⚠️ Signed message doesn't match challenge`)
      return false
    }
    
    // Success - remove the challenge
    pendingChallenges.delete(connectionId)
    return true
    
  } catch (error) {
    console.error(`❌ Error verifying signature:`, error)
    return false
  }
}

/**
 * Generate a JWT token for an authenticated admin
 * @param {object} claims
 * @param {string} claims.publicKey - Admin's public key (fingerprint or full key)
 * @param {string} claims.roomName - Room the admin is authenticated for
 * @param {string} claims.userId - Admin's user ID
 * @param {string} claims.role - 'master' or 'sub-admin'
 * @returns {string} JWT token
 */
export function generateJWT(claims) {
  const payload = {
    sub: claims.userId,
    publicKeyFingerprint: getKeyFingerprint(claims.publicKey),
    room: claims.roomName,
    role: claims.role || 'admin',
    iat: Math.floor(Date.now() / 1000)
  }
  
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY })
}

/**
 * Verify and decode a JWT token
 * @param {string} token - JWT token
 * @returns {{ valid: boolean, payload?: object, error?: string }}
 */
export function verifyJWT(token) {
  try {
    const payload = jwt.verify(token, JWT_SECRET)
    return { valid: true, payload }
  } catch (error) {
    return { valid: false, error: error.message }
  }
}

/**
 * Get a fingerprint/hash of a public key for comparison
 * @param {string} publicKey - Armored public key
 * @returns {string} SHA-256 hash of the key
 */
export function getKeyFingerprint(publicKey) {
  // Normalize the key by removing whitespace variations
  const normalized = publicKey.replace(/\s+/g, '')
  return crypto.createHash('sha256').update(normalized).digest('hex').substring(0, 32)
}

/**
 * Check if a JWT authorizes an action for a specific room
 * @param {string} token - JWT token
 * @param {string} roomName - Room name to check
 * @param {string} publicKey - Public key of the requester
 * @returns {{ authorized: boolean, payload?: object, error?: string }}
 */
export function checkAuthorization(token, roomName, publicKey) {
  const result = verifyJWT(token)
  
  if (!result.valid) {
    return { authorized: false, error: result.error }
  }
  
  const { payload } = result
  
  // Check room matches
  if (payload.room !== roomName) {
    return { authorized: false, error: 'Token not valid for this room' }
  }
  
  // Check public key matches
  const requestFingerprint = getKeyFingerprint(publicKey)
  if (payload.publicKeyFingerprint !== requestFingerprint) {
    return { authorized: false, error: 'Public key mismatch' }
  }
  
  return { authorized: true, payload }
}

/**
 * Create the challenge message to send to client
 * @param {string} connectionId 
 * @returns {object} Message object to send
 */
export function createChallengeMessage(connectionId) {
  const { challenge, timestamp } = generateChallenge(connectionId)
  return {
    type: AUTH_MESSAGE_TYPES.CHALLENGE,
    challenge,
    timestamp
  }
}

/**
 * Process an auth response from client
 * @param {string} connectionId 
 * @param {object} message - The auth response message
 * @param {string} message.signature - PGP signed challenge
 * @param {string} message.publicKey - Client's public key
 * @param {string} message.roomName - Room being authenticated for
 * @param {string} message.userId - Client's user ID
 * @param {string} message.role - 'master' or 'sub-admin'
 * @returns {Promise<{ success: boolean, token?: string, error?: string }>}
 */
export async function processAuthResponse(connectionId, message) {
  const { signature, publicKey, roomName, userId, role } = message
  
  if (!signature || !publicKey || !roomName || !userId) {
    return { success: false, error: 'Missing required fields' }
  }
  
  const isValid = await verifySignature(connectionId, signature, publicKey)
  
  if (!isValid) {
    return { success: false, error: 'Signature verification failed' }
  }
  
  // Generate JWT for this session
  const token = generateJWT({ publicKey, roomName, userId, role })
  
  console.log(`✅ Admin authenticated: ${userId} for room ${roomName}`)
  
  return { success: true, token }
}

/**
 * Check if a Y.js update targets protected data (roomClaim)
 * This is a simplified check - in production you'd need to decode the update
 * @param {Uint8Array} update - Y.js update
 * @param {import('yjs').Doc} ydoc - The Y.js document
 * @returns {boolean}
 */
export function isProtectedUpdate(update, ydoc) {
  // For now, we'll handle this at a higher level by checking
  // if the roomClaim map was modified after applying the update
  return false // Placeholder - actual implementation needs Y.js update parsing
}

export default {
  AUTH_MESSAGE_TYPES,
  generateChallenge,
  verifySignature,
  generateJWT,
  verifyJWT,
  getKeyFingerprint,
  checkAuthorization,
  createChallengeMessage,
  processAuthResponse
}
