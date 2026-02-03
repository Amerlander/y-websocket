#!/usr/bin/env node

/**
 * Y-WebSocket Server
 * Simple WebSocket server for Y.js document synchronization
 */

import { WebSocketServer } from 'ws'
import http from 'http'
import * as number from 'lib0/number'
import { setupWSConnection, docs, getPersistence, getYDoc } from './utils.js'
import { initCleanupScheduler } from './cleanup-scheduler.js'
import { hashPassword, verifyPassword } from './room-auth.js'
import { verifyJWT, getKeyFingerprint } from './admin-auth.js'

const wss = new WebSocketServer({ noServer: true })
const host = process.env.HOST || 'localhost'
const port = number.parseInt(process.env.PORT || '1234')

// Rate limiting
const RATE_LIMIT_ENABLED = process.env.RATE_LIMIT !== 'false'
const RATE_LIMIT_WINDOW_MS = number.parseInt(process.env.RATE_LIMIT_WINDOW_MS || '1000')
const RATE_LIMIT_MAX = number.parseInt(process.env.RATE_LIMIT_MAX_CONNECTIONS || '10')

/** @type {Map<string, {count: number, resetTime: number}>} */
const connectionAttempts = new Map()

/**
 * Check if IP is rate limited
 * @param {string} ip
 * @returns {boolean}
 */
function isRateLimited(ip) {
  if (!RATE_LIMIT_ENABLED) return false
  
  const now = Date.now()
  const record = connectionAttempts.get(ip)
  
  if (!record || now > record.resetTime) {
    connectionAttempts.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS })
    return false
  }
  
  record.count++
  if (record.count > RATE_LIMIT_MAX) {
    console.warn(`⚠️ Rate limit exceeded: ${ip}`)
    return true
  }
  return false
}

// Cleanup old rate limit records
setInterval(() => {
  const now = Date.now()
  for (const [ip, record] of connectionAttempts.entries()) {
    if (now > record.resetTime + RATE_LIMIT_WINDOW_MS * 10) {
      connectionAttempts.delete(ip)
    }
  }
}, 60000)

/**
 * Get client IP
 * @param {http.IncomingMessage} req
 * @returns {string}
 */
function getClientIP(req) {
  const forwarded = req.headers['x-forwarded-for']
  if (forwarded) return String(forwarded).split(',')[0].trim()
  return req.socket?.remoteAddress || 'unknown'
}

// HTTP Server with REST API
const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }
  
  const url = new URL(req.url || '', `http://${host}:${port}`)
  
  // DELETE /room/:roomName - Delete a room
  if (req.method === 'DELETE' && url.pathname.startsWith('/room/')) {
    const roomName = decodeURIComponent(url.pathname.slice(6))
    if (!roomName) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Room name required' }))
      return
    }
    
    const doc = docs.get(roomName)
    if (!doc) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Room not found' }))
      return
    }
    
    // Verify password if protected
    if (doc.passwordHash) {
      const authHeader = req.headers.authorization
      const providedPassword = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null
      
      if (!providedPassword || hashPassword(providedPassword) !== doc.passwordHash) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Invalid or missing password' }))
        return
      }
    }
    
    // Close connections and delete
    doc.conns.forEach((_, conn) => {
      try { conn.close(4010, 'Room deleted') } catch (e) { /* ignore */ }
    })
    doc.conns.clear()
    docs.delete(roomName)
    
    const persistence = getPersistence()
    if (persistence?.provider?.clearDocument) {
      persistence.provider.clearDocument(roomName).catch(console.error)
    }
    
    console.log(`🗑️ Room "${roomName}" deleted`)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ success: true }))
    return
  }
  
  // GET /room/:roomName/info - Get room info
  if (req.method === 'GET' && url.pathname.startsWith('/room/') && url.pathname.endsWith('/info')) {
    const roomName = decodeURIComponent(url.pathname.slice(6, -5))
    
    // First check if room exists in memory
    let doc = docs.get(roomName)
    
    // If not in memory, check if it exists in persistence (WITHOUT creating it)
    if (!doc) {
      const persistence = getPersistence()
      if (persistence?.provider) {
        try {
          // Use getAllDocNames to check if document exists
          // This is more reliable than getStateVector which returns a minimal vector even for non-existent docs
          const allDocNames = await persistence.provider.getAllDocNames()
          const docExists = allDocNames.includes(roomName)
          
          if (!docExists) {
            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ exists: false }))
            return
          }
          
          // Room exists in persistence - now we can safely load it
          doc = getYDoc(roomName)
          if (doc._stateLoading) {
            await doc._stateLoading
          }
        } catch (e) {
          // If persistence check fails, room doesn't exist
          console.error('Error checking room existence:', e)
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ exists: false }))
          return
        }
      } else {
        // No persistence, room doesn't exist
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ exists: false }))
        return
      }
    }
    
    // Wait for state to be loaded from persistence (including password hash)
    if (doc._stateLoading) {
      try {
        await doc._stateLoading
      } catch (e) {
        console.error(`Error loading document state for ${roomName}:`, e)
      }
    }
    
    // Get admin public key from roomClaim if exists
    let adminPublicKey = null
    try {
      const roomClaimMap = doc.getMap('roomClaim')
      adminPublicKey = roomClaimMap?.get('roomPublicKey') || null
    } catch (e) { /* ignore */ }
    
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      exists: true,
      isPersistent: true, // All rooms are persistent
      hasPassword: !!doc.passwordHash,
      connectionCount: doc.conns.size,
      lastAccessed: doc.lastAccessed,
      adminPublicKey
    }))
    return
  }
  
  // POST /room/:roomName/admin-reset-password - Admin reset password using public key
  if (req.method === 'POST' && url.pathname.startsWith('/room/') && url.pathname.endsWith('/admin-reset-password')) {
    const roomName = decodeURIComponent(url.pathname.slice(6, -21))
    
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', async () => {
      try {
        const { newPassword, adminPublicKey: providedKey } = JSON.parse(body)
        
        if (!newPassword || newPassword.length < 4) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Password must be at least 4 characters' }))
          return
        }
        
        if (!providedKey) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Admin public key required' }))
          return
        }
        
        // First check if room exists in memory
        let doc = docs.get(roomName)
        
        // If not in memory, try to load from persistence
        if (!doc) {
          const persistence = getPersistence()
          if (persistence?.provider) {
            try {
              // Use getAllDocNames to check if document exists
              const allDocNames = await persistence.provider.getAllDocNames()
              if (allDocNames.includes(roomName)) {
                doc = getYDoc(roomName)
                if (doc._stateLoading) {
                  await doc._stateLoading
                }
              }
            } catch (e) {
              // Room doesn't exist
            }
          }
        }
        
        if (!doc) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Room not found' }))
          return
        }
        
        // Wait for state to be loaded
        if (doc._stateLoading) {
          await doc._stateLoading
        }
        
        // Get stored admin public key from roomClaim
        let storedAdminKey = null
        try {
          const roomClaimMap = doc.getMap('roomClaim')
          storedAdminKey = roomClaimMap?.get('roomPublicKey') || null
        } catch (e) { /* ignore */ }
        
        if (!storedAdminKey) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Room has no admin key configured' }))
          return
        }
        
        // Normalize and compare keys
        const normalizeKey = (key) => key.replace(/\\s+/g, '')
        if (normalizeKey(providedKey) !== normalizeKey(storedAdminKey)) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Invalid admin key' }))
          return
        }
        
        // Admin verified - update password hash
        const newHash = hashPassword(newPassword)
        doc.passwordHash = newHash
        
        // Also update in roomSettings map so it persists
        const roomSettingsMap = doc.getMap('roomSettings')
        roomSettingsMap.set('passwordHash', newHash)
        
        console.log(`🔑 Admin reset password for room "${roomName}"`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true }))
      } catch (e) {
        console.error('Error resetting password:', e)
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Invalid request' }))
      }
    })
    return
  }
  
  // POST /room/:roomName/verify-password - Verify password
  if (req.method === 'POST' && url.pathname.startsWith('/room/') && url.pathname.endsWith('/verify-password')) {
    const roomName = decodeURIComponent(url.pathname.slice(6, -16))
    
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', async () => {
      try {
        const { password } = JSON.parse(body)
        
        // First check if room exists in memory
        let doc = docs.get(roomName)
        
        // If not in memory, check if it exists in persistence and load it
        if (!doc) {
          const persistence = getPersistence()
          if (persistence?.provider) {
            try {
              // Use getAllDocNames to check if document exists
              const allDocNames = await persistence.provider.getAllDocNames()
              if (allDocNames.includes(roomName)) {
                // Load the room into memory
                doc = getYDoc(roomName)
                if (doc._stateLoading) {
                  await doc._stateLoading
                }
              }
            } catch (e) {
              // Room doesn't exist in persistence
            }
          }
        }
        
        if (!doc) {
          res.writeHead(404, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ valid: false, error: 'Room not found' }))
          return
        }
        
        // Wait for state to be loaded (including password hash)
        if (doc._stateLoading) {
          await doc._stateLoading
        }
        
        if (!doc.passwordHash) {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ valid: true, noPasswordRequired: true }))
          return
        }
        
        const isValid = verifyPassword(password, doc.passwordHash)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ valid: isValid }))
      } catch (e) {
        console.error('Error verifying password:', e)
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Invalid request' }))
      }
    })
    return
  }
  
  // ============================================
  // ADMIN API ENDPOINTS (JWT Protected)
  // ============================================
  
  /**
   * Helper: Verify JWT from Authorization header and check room access
   * @param {http.IncomingMessage} req
   * @param {string} roomName
   * @returns {{ valid: boolean, payload?: any, error?: string }}
   */
  function verifyAdminAuth(req, roomName) {
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      return { valid: false, error: 'Missing authorization header' }
    }
    
    const token = authHeader.slice(7)
    const result = verifyJWT(token)
    
    if (!result.valid) {
      return { valid: false, error: result.error }
    }
    
    // Check room matches
    if (result.payload.room !== roomName) {
      return { valid: false, error: 'Token not valid for this room' }
    }
    
    return { valid: true, payload: result.payload }
  }
  
  /**
   * Helper: Read JSON body from request
   * @param {http.IncomingMessage} req
   * @returns {Promise<any>}
   */
  function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        try {
          resolve(JSON.parse(body || '{}'))
        } catch (e) {
          reject(new Error('Invalid JSON'))
        }
      })
      req.on('error', reject)
    })
  }
  
  /**
   * Helper: Get or load room document
   * @param {string} roomName
   * @returns {Promise<any>}
   */
  async function getOrLoadRoom(roomName) {
    let doc = docs.get(roomName)
    
    if (!doc) {
      const persistence = getPersistence()
      if (persistence?.provider) {
        try {
          // Use getAllDocNames to check if document exists
          // This is more reliable than getStateVector which returns data even for non-existent docs
          const allDocNames = await persistence.provider.getAllDocNames()
          if (allDocNames.includes(roomName)) {
            doc = getYDoc(roomName)
            if (doc._stateLoading) {
              await doc._stateLoading
            }
          }
        } catch (e) {
          // Room doesn't exist
        }
      }
    }
    
    if (doc?._stateLoading) {
      await doc._stateLoading
    }
    
    return doc
  }
  
  // POST /api/admin/room/:roomName/claim - Initialize room claim (create room as admin)
  if (req.method === 'POST' && url.pathname.match(/^\/api\/admin\/room\/[^/]+\/claim$/)) {
    const roomName = decodeURIComponent(url.pathname.split('/')[4])
    
    try {
      const body = await readJsonBody(req)
      const { publicKey, adminId, adminRole, password } = body
      
      if (!publicKey || !adminId) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'publicKey and adminId required' }))
        return
      }
      
      // Check if room already exists
      let doc = await getOrLoadRoom(roomName)
      
      if (doc) {
        // Room exists - check if it already has a claim
        const roomClaimMap = doc.getMap('roomClaim')
        const existingPublicKey = roomClaimMap.get('roomPublicKey') || roomClaimMap.get('publicKey')
        
        if (existingPublicKey) {
          res.writeHead(409, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Room already claimed' }))
          return
        }
      } else {
        // Create new room
        doc = getYDoc(roomName)
        if (doc._stateLoading) {
          await doc._stateLoading
        }
      }
      
      // Set up room claim
      const roomClaimMap = doc.getMap('roomClaim')
      const now = Date.now()
      
      roomClaimMap.set('roomPublicKey', publicKey)
      roomClaimMap.set('createdAt', now)
      roomClaimMap.set('authorizedAdmins', [{
        id: adminId,
        visitorId: adminId,
        publicKey: publicKey,
        role: adminRole || 'master',
        addedAt: now,
        addedBy: adminId
      }])
      roomClaimMap.set('activeSessions', [])
      
      // Set password if provided
      if (password) {
        const passwordHash = hashPassword(password)
        doc.passwordHash = passwordHash
        const roomSettingsMap = doc.getMap('roomSettings')
        roomSettingsMap.set('passwordHash', passwordHash)
      }
      
      console.log(`✅ Room "${roomName}" claimed by admin ${adminId}`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true, roomName }))
    } catch (e) {
      console.error('Error claiming room:', e)
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: e.message || 'Invalid request' }))
    }
    return
  }
  
  // POST /api/admin/room/:roomName/authorize-admin - Add sub-admin (JWT protected)
  if (req.method === 'POST' && url.pathname.match(/^\/api\/admin\/room\/[^/]+\/authorize-admin$/)) {
    const roomName = decodeURIComponent(url.pathname.split('/')[4])
    
    const authResult = verifyAdminAuth(req, roomName)
    if (!authResult.valid) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: authResult.error }))
      return
    }
    
    try {
      const body = await readJsonBody(req)
      const { newAdminId, newAdminPublicKey, role } = body
      
      if (!newAdminId || !newAdminPublicKey) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'newAdminId and newAdminPublicKey required' }))
        return
      }
      
      const doc = await getOrLoadRoom(roomName)
      if (!doc) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Room not found' }))
        return
      }
      
      const roomClaimMap = doc.getMap('roomClaim')
      const authorizedAdmins = roomClaimMap.get('authorizedAdmins') || []
      
      // Check if already authorized
      if (authorizedAdmins.some(a => a.id === newAdminId || a.visitorId === newAdminId)) {
        res.writeHead(409, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Admin already authorized' }))
        return
      }
      
      // Add new admin
      const newAdmin = {
        id: newAdminId,
        visitorId: newAdminId,
        publicKey: newAdminPublicKey,
        role: role || 'sub-admin',
        addedAt: Date.now(),
        addedBy: authResult.payload.sub
      }
      
      roomClaimMap.set('authorizedAdmins', [...authorizedAdmins, newAdmin])
      
      console.log(`✅ [${roomName}] Sub-admin ${newAdminId} added by ${authResult.payload.sub}`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true, admin: newAdmin }))
    } catch (e) {
      console.error('Error adding sub-admin:', e)
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: e.message || 'Invalid request' }))
    }
    return
  }
  
  // DELETE /api/admin/room/:roomName/authorize-admin/:adminId - Remove admin (JWT protected)
  if (req.method === 'DELETE' && url.pathname.match(/^\/api\/admin\/room\/[^/]+\/authorize-admin\/[^/]+$/)) {
    const parts = url.pathname.split('/')
    const roomName = decodeURIComponent(parts[4])
    const adminIdToRemove = decodeURIComponent(parts[6])
    
    const authResult = verifyAdminAuth(req, roomName)
    if (!authResult.valid) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: authResult.error }))
      return
    }
    
    try {
      const doc = await getOrLoadRoom(roomName)
      if (!doc) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Room not found' }))
        return
      }
      
      const roomClaimMap = doc.getMap('roomClaim')
      const authorizedAdmins = roomClaimMap.get('authorizedAdmins') || []
      
      // Can't remove master admin
      const adminToRemove = authorizedAdmins.find(a => a.id === adminIdToRemove || a.visitorId === adminIdToRemove)
      if (adminToRemove?.role === 'master') {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Cannot remove master admin' }))
        return
      }
      
      const filtered = authorizedAdmins.filter(a => a.id !== adminIdToRemove && a.visitorId !== adminIdToRemove)
      roomClaimMap.set('authorizedAdmins', filtered)
      
      console.log(`✅ [${roomName}] Admin ${adminIdToRemove} removed by ${authResult.payload.sub}`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true }))
    } catch (e) {
      console.error('Error removing admin:', e)
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: e.message || 'Invalid request' }))
    }
    return
  }
  
  // POST /api/admin/room/:roomName/user/:userId/approve - Approve user (JWT protected)
  if (req.method === 'POST' && url.pathname.match(/^\/api\/admin\/room\/[^/]+\/user\/[^/]+\/approve$/)) {
    const parts = url.pathname.split('/')
    const roomName = decodeURIComponent(parts[4])
    const userId = decodeURIComponent(parts[6])
    
    const authResult = verifyAdminAuth(req, roomName)
    if (!authResult.valid) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: authResult.error }))
      return
    }
    
    try {
      const doc = await getOrLoadRoom(roomName)
      if (!doc) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Room not found' }))
        return
      }
      
      // Update availableUsers in YJS
      const rootMap = doc.getMap('root')
      let availableUsers = rootMap.get('availableUsers') || {}
      
      if (!availableUsers.approved) availableUsers.approved = {}
      if (!availableUsers.blocked) availableUsers.blocked = {}
      
      // Move from blocked to approved if needed
      if (availableUsers.blocked[userId]) {
        delete availableUsers.blocked[userId]
      }
      
      availableUsers.approved[userId] = {
        id: userId,
        approvedAt: Date.now(),
        approvedBy: authResult.payload.sub
      }
      
      rootMap.set('availableUsers', availableUsers)
      
      console.log(`✅ [${roomName}] User ${userId} approved by ${authResult.payload.sub}`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true }))
    } catch (e) {
      console.error('Error approving user:', e)
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: e.message || 'Invalid request' }))
    }
    return
  }
  
  // POST /api/admin/room/:roomName/user/:userId/block - Block user (JWT protected)
  if (req.method === 'POST' && url.pathname.match(/^\/api\/admin\/room\/[^/]+\/user\/[^/]+\/block$/)) {
    const parts = url.pathname.split('/')
    const roomName = decodeURIComponent(parts[4])
    const userId = decodeURIComponent(parts[6])
    
    const authResult = verifyAdminAuth(req, roomName)
    if (!authResult.valid) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: authResult.error }))
      return
    }
    
    try {
      const doc = await getOrLoadRoom(roomName)
      if (!doc) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Room not found' }))
        return
      }
      
      // Update availableUsers in YJS
      const rootMap = doc.getMap('root')
      let availableUsers = rootMap.get('availableUsers') || {}
      
      if (!availableUsers.approved) availableUsers.approved = {}
      if (!availableUsers.blocked) availableUsers.blocked = {}
      
      // Move from approved to blocked
      if (availableUsers.approved[userId]) {
        delete availableUsers.approved[userId]
      }
      
      availableUsers.blocked[userId] = {
        id: userId,
        blockedAt: Date.now(),
        blockedBy: authResult.payload.sub
      }
      
      rootMap.set('availableUsers', availableUsers)
      
      console.log(`🚫 [${roomName}] User ${userId} blocked by ${authResult.payload.sub}`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true }))
    } catch (e) {
      console.error('Error blocking user:', e)
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: e.message || 'Invalid request' }))
    }
    return
  }
  
  // POST /api/admin/room/:roomName/settings - Update room settings (JWT protected)
  if (req.method === 'POST' && url.pathname.match(/^\/api\/admin\/room\/[^/]+\/settings$/)) {
    const roomName = decodeURIComponent(url.pathname.split('/')[4])
    
    const authResult = verifyAdminAuth(req, roomName)
    if (!authResult.valid) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: authResult.error }))
      return
    }
    
    try {
      const body = await readJsonBody(req)
      
      const doc = await getOrLoadRoom(roomName)
      if (!doc) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Room not found' }))
        return
      }
      
      const roomSettingsMap = doc.getMap('roomSettings')
      
      // Update allowed settings
      const allowedSettings = ['roomName', 'approvalMode', 'hideUserNames', 'allowChat', 'theme']
      for (const key of allowedSettings) {
        if (body[key] !== undefined) {
          roomSettingsMap.set(key, body[key])
        }
      }
      
      // Handle password change specially
      if (body.password !== undefined) {
        if (body.password) {
          const passwordHash = hashPassword(body.password)
          doc.passwordHash = passwordHash
          roomSettingsMap.set('passwordHash', passwordHash)
        } else {
          doc.passwordHash = null
          roomSettingsMap.delete('passwordHash')
        }
      }
      
      console.log(`⚙️ [${roomName}] Settings updated by ${authResult.payload.sub}`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ success: true }))
    } catch (e) {
      console.error('Error updating settings:', e)
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: e.message || 'Invalid request' }))
    }
    return
  }
  
  // Default
  res.writeHead(200, { 'Content-Type': 'text/plain' })
  res.end('Y-WebSocket Server')
})

// WebSocket upgrade
wss.on('connection', setupWSConnection)

server.on('upgrade', (req, socket, head) => {
  const clientIP = getClientIP(req)
  
  if (isRateLimited(clientIP)) {
    socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n')
    socket.destroy()
    return
  }
  
  wss.handleUpgrade(req, socket, head, ws => {
    wss.emit('connection', ws, req)
  })
})

// Start server
server.listen(port, host, () => {
  console.log(`\n${'='.repeat(50)}`)
  console.log(`🚀 Y-WebSocket Server`)
  console.log(`${'='.repeat(50)}`)
  console.log(`📍 Address: ${host}:${port}`)
  
  const persistence = getPersistence()
  if (persistence) {
    console.log(`✅ Persistence: ENABLED`)
    console.log(`📁 Storage: ${process.env.YPERSISTENCE}`)
  } else {
    console.log(`⚠️ Persistence: DISABLED`)
  }
  
  if (RATE_LIMIT_ENABLED) {
    console.log(`🛡️ Rate Limiting: ${RATE_LIMIT_MAX} req/${RATE_LIMIT_WINDOW_MS}ms`)
  }
  
  initCleanupScheduler(docs, persistence)
  console.log(`🧹 Cleanup scheduler: STARTED`)
  console.log(`${'='.repeat(50)}\n`)
})
