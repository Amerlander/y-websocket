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
    
    // If not in memory, check if it exists in persistence
    if (!doc) {
      const persistence = getPersistence()
      if (persistence?.provider) {
        try {
          // Try to load from persistence
          const persistedYdoc = await persistence.provider.getYDoc(roomName)
          const stateVector = await persistence.provider.getStateVector?.(roomName)
          
          // Check if there's any data in the persisted document
          const hasData = stateVector?.length > 0 || persistedYdoc.store.clients.size > 0
          
          if (!hasData) {
            // Room doesn't exist
            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ exists: false }))
            return
          }
          
          // Load the room into memory to get full info (including password hash)
          doc = getYDoc(roomName)
          if (doc._stateLoading) {
            await doc._stateLoading
          }
        } catch (e) {
          // If persistence check fails, room doesn't exist
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
      adminPublicKey = roomClaimMap?.get('publicKey') || null
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
              const persistedYdoc = await persistence.provider.getYDoc(roomName)
              const stateVector = await persistence.provider.getStateVector?.(roomName)
              const hasData = stateVector?.length > 0 || persistedYdoc.store.clients.size > 0
              
              if (hasData) {
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
