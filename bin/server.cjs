#!/usr/bin/env node

const cluster = require('cluster')
const os = require('os')
const WebSocket = require('ws')
const http = require('http')
const number = require('lib0/number')
const wss = new WebSocket.Server({ noServer: true })
const setupWSConnection = require('./utils.cjs').setupWSConnection
const docs = require('./utils.cjs').docs
const getPersistence = require('./utils.cjs').getPersistence
const { initCleanupScheduler } = require('./cleanup-scheduler.cjs')

const host = process.env.HOST || 'localhost'
const port = number.parseInt(process.env.PORT || '1234')

// Clustering configuration
const ENABLE_CLUSTER = process.env.ENABLE_CLUSTER === 'true'
const numCPUs = os.cpus().length
const workerCount = number.parseInt(process.env.WORKER_COUNT || String(Math.min(numCPUs, 4)))

// Rate limiting configuration
const RATE_LIMIT_ENABLED = process.env.RATE_LIMIT !== 'false'
const RATE_LIMIT_WINDOW_MS = number.parseInt(process.env.RATE_LIMIT_WINDOW_MS || '1000') // 1 second
const RATE_LIMIT_MAX_CONNECTIONS = number.parseInt(process.env.RATE_LIMIT_MAX_CONNECTIONS || '10')

// Connection tracking for rate limiting
const connectionAttempts = new Map() // IP -> { count, resetTime }

/**
 * Check if an IP should be rate limited
 * @param {string} ip - The client IP address
 * @returns {boolean} - True if the connection should be rejected
 */
function isRateLimited(ip) {
  if (!RATE_LIMIT_ENABLED) return false
  
  const now = Date.now()
  const record = connectionAttempts.get(ip)
  
  if (!record || now > record.resetTime) {
    // New window or expired window
    connectionAttempts.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS })
    return false
  }
  
  record.count++
  
  if (record.count > RATE_LIMIT_MAX_CONNECTIONS) {
    console.warn(`⚠️  Rate limit exceeded for IP: ${ip} (${record.count} attempts)`)
    return true
  }
  
  return false
}

// Clean up old rate limit records periodically
setInterval(() => {
  const now = Date.now()
  for (const [ip, record] of connectionAttempts.entries()) {
    if (now > record.resetTime + RATE_LIMIT_WINDOW_MS * 10) {
      connectionAttempts.delete(ip)
    }
  }
}, 60000) // Clean up every minute

/**
 * Get client IP from request (handles proxies)
 * @param {http.IncomingMessage} request
 * @returns {string}
 */
function getClientIP(request) {
  const forwarded = request.headers['x-forwarded-for']
  if (forwarded) {
    return forwarded.split(',')[0].trim()
  }
  return request.socket?.remoteAddress || 'unknown'
}

// Cluster mode
if (ENABLE_CLUSTER && cluster.isMaster) {
  console.log(`\n${'='.repeat(60)}`)
  console.log(`🚀 Y-WebSocket Server (Cluster Master)`)
  console.log(`${'='.repeat(60)}`)
  console.log(`📍 Address: ${host}:${port}`)
  console.log(`👷 Workers: ${workerCount}`)
  console.log(`${'='.repeat(60)}\n`)
  
  // Fork workers
  for (let i = 0; i < workerCount; i++) {
    cluster.fork()
  }
  
  cluster.on('exit', (worker, code, signal) => {
    console.log(`⚠️  Worker ${worker.process.pid} died (${signal || code}). Restarting...`)
    cluster.fork()
  })
  
} else {
  // Worker or single process mode
  const { hashPassword } = require('./room-auth.cjs')
  
  const server = http.createServer((request, response) => {
    // Enable CORS for API requests
    response.setHeader('Access-Control-Allow-Origin', '*')
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    
    // Handle preflight requests
    if (request.method === 'OPTIONS') {
      response.writeHead(204)
      response.end()
      return
    }
    
    const url = new URL(request.url || '', `http://${host}:${port}`)
    
    // DELETE /room/:roomName - Delete a room permanently
    if (request.method === 'DELETE' && url.pathname.startsWith('/room/')) {
      const roomName = decodeURIComponent(url.pathname.slice(6)) // Remove '/room/'
      
      if (!roomName) {
        response.writeHead(400, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: 'Room name required' }))
        return
      }
      
      // Get password from Authorization header
      const authHeader = request.headers.authorization
      let providedPassword = null
      
      if (authHeader && authHeader.startsWith('Bearer ')) {
        providedPassword = authHeader.slice(7)
      }
      
      const doc = docs.get(roomName)
      
      if (!doc) {
        response.writeHead(404, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: 'Room not found' }))
        return
      }
      
      // Verify password if room is password-protected
      if (doc.passwordHash) {
        if (!providedPassword) {
          response.writeHead(401, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify({ error: 'Password required' }))
          return
        }
        
        const providedHash = hashPassword(providedPassword)
        if (providedHash !== doc.passwordHash) {
          response.writeHead(403, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify({ error: 'Invalid password' }))
          return
        }
      }
      
      // Close all connections to the room
      doc.conns.forEach((_, conn) => {
        try {
          conn.close(4010, 'Room is being deleted')
        } catch (e) {
          console.error('Error closing connection:', e)
        }
      })
      doc.conns.clear()
      
      // Remove from memory
      docs.delete(roomName)
      
      // Remove from persistence if available
      const persistence = getPersistence()
      if (persistence && persistence.provider && persistence.provider.clearDocument) {
        persistence.provider.clearDocument(roomName).then(() => {
          console.log(`🗑️  Room "${roomName}" deleted from persistence`)
        }).catch(err => {
          console.error(`Error deleting room "${roomName}" from persistence:`, err)
        })
      }
      
      console.log(`🗑️  Room "${roomName}" deleted`)
      
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ success: true, message: 'Room deleted' }))
      return
    }
    
    // GET /room/:roomName/info - Get room metadata (for password-protected room verification)
    if (request.method === 'GET' && url.pathname.startsWith('/room/') && url.pathname.endsWith('/info')) {
      const roomName = decodeURIComponent(url.pathname.slice(6, -5)) // Remove '/room/' and '/info'
      
      const doc = docs.get(roomName)
      
      if (!doc) {
        response.writeHead(404, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ 
          exists: false,
          message: 'Room not found or not yet created'
        }))
        return
      }
      
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({
        exists: true,
        isPersistent: doc.isPersistent,
        hasPassword: !!doc.passwordHash,
        connectionCount: doc.conns.size,
        lastAccessed: doc.lastAccessed
      }))
      return
    }
    
    // POST /room/:roomName/verify-password - Verify password for a room
    if (request.method === 'POST' && url.pathname.startsWith('/room/') && url.pathname.endsWith('/verify-password')) {
      const roomName = decodeURIComponent(url.pathname.slice(6, -16)) // Remove '/room/' and '/verify-password'
      
      let body = ''
      request.on('data', chunk => { body += chunk })
      request.on('end', () => {
        try {
          const { password } = JSON.parse(body)
          
          if (!password) {
            response.writeHead(400, { 'Content-Type': 'application/json' })
            response.end(JSON.stringify({ error: 'Password required' }))
            return
          }
          
          const doc = docs.get(roomName)
          
          if (!doc) {
            response.writeHead(404, { 'Content-Type': 'application/json' })
            response.end(JSON.stringify({ 
              valid: false,
              error: 'Room not found'
            }))
            return
          }
          
          if (!doc.passwordHash) {
            // Room has no password
            response.writeHead(200, { 'Content-Type': 'application/json' })
            response.end(JSON.stringify({ valid: true, noPasswordRequired: true }))
            return
          }
          
          const providedHash = hashPassword(password)
          const isValid = providedHash === doc.passwordHash
          
          response.writeHead(200, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify({ valid: isValid }))
        } catch (e) {
          response.writeHead(400, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify({ error: 'Invalid request body' }))
        }
      })
      return
    }
    
    // Default response
    response.writeHead(200, { 'Content-Type': 'text/plain' })
    response.end('okay')
  })

  wss.on('connection', setupWSConnection)

  server.on('upgrade', (request, socket, head) => {
    const clientIP = getClientIP(request)
    
    // Rate limiting check
    if (isRateLimited(clientIP)) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n')
      socket.destroy()
      return
    }
    
    // You may check auth of request here..
    // Call `wss.HandleUpgrade` *after* you checked whether the client has access
    // (e.g. by checking cookies, or url parameters).
    // See https://github.com/websockets/ws#client-authentication
    wss.handleUpgrade(request, socket, head, /** @param {any} ws */ ws => {
      wss.emit('connection', ws, request)
    })
  })

  server.listen(port, host, () => {
    const workerInfo = ENABLE_CLUSTER ? ` (Worker ${process.pid})` : ''
    console.log(`\n${'='.repeat(60)}`)
    console.log(`🚀 Y-WebSocket Server started${workerInfo}`)
    console.log(`${'='.repeat(60)}`)
    console.log(`📍 Address: ${host}:${port}`)
    
    // Initialize the cleanup scheduler for persistent rooms
    const persistence = getPersistence()
    
    if (persistence) {
      console.log(`✅ Persistence: ENABLED`)
      console.log(`📁 Storage: ${process.env.YPERSISTENCE || 'default'}`)
    } else {
      console.log(`⚠️  Persistence: DISABLED`)
      console.log(`💡 Tip: Set YPERSISTENCE environment variable to enable`)
    }
    
    if (RATE_LIMIT_ENABLED) {
      console.log(`🛡️  Rate Limiting: ENABLED (${RATE_LIMIT_MAX_CONNECTIONS} req/${RATE_LIMIT_WINDOW_MS}ms)`)
    } else {
      console.log(`⚠️  Rate Limiting: DISABLED`)
    }
    
    // Only initialize cleanup scheduler on first worker or single process
    if (!ENABLE_CLUSTER || cluster.worker?.id === 1) {
      const cleanupScheduler = initCleanupScheduler(docs, persistence)
      console.log(`🧹 Cleanup scheduler: STARTED`)
    }
    
    console.log(`${'='.repeat(60)}\n`)
  })
}
