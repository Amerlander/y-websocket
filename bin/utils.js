/**
 * Y-WebSocket Server Utilities
 * Simplified implementation for document synchronization
 */

import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import * as map from 'lib0/map'
import debounce from 'lodash.debounce'

import { callbackHandler, isCallbackSet } from './callback.js'
import { verifyPassword, hashPassword } from './room-auth.js'

// Constants
const CALLBACK_DEBOUNCE_WAIT = parseInt(process.env.CALLBACK_DEBOUNCE_WAIT || '2000')
const CALLBACK_DEBOUNCE_MAXWAIT = parseInt(process.env.CALLBACK_DEBOUNCE_MAXWAIT || '10000')
const WS_READY_STATE_OPEN = 1
const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1
const PING_TIMEOUT = 30000
const PASSWORD_AUTH_TIMEOUT = 5000

// GC enabled by default
const gcEnabled = process.env.GC !== 'false' && process.env.GC !== '0'

// Persistence setup
const persistenceDir = process.env.YPERSISTENCE
/** @type {{bindState: function(string,WSSharedDoc):void, writeState:function(string,WSSharedDoc):Promise<any>, provider: any}|null} */
let persistence = null

if (typeof persistenceDir === 'string') {
  console.info(`📦 Persisting documents to "${persistenceDir}"`)
  const { LeveldbPersistence } = await import('y-leveldb')
  const ldb = new LeveldbPersistence(persistenceDir)
  
  persistence = {
    provider: ldb,
    bindState: async (docName, ydoc) => {
      const persistedYdoc = await ldb.getYDoc(docName)
      const newUpdates = Y.encodeStateAsUpdate(ydoc)
      ldb.storeUpdate(docName, newUpdates)
      Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(persistedYdoc))
      console.log(`✅ [${docName}] Loaded persisted state`)
      
      // Read password hash from persisted roomSettings if exists
      readPasswordFromDoc(ydoc)
      
      ydoc.on('update', update => {
        ldb.storeUpdate(docName, update)
      })
    },
    writeState: async (_docName, _ydoc) => {}
  }
}

/** @param {{bindState: function(string,WSSharedDoc):void, writeState:function(string,WSSharedDoc):Promise<any>,provider:any}|null} p */
export const setPersistence = p => { persistence = p }

export const getPersistence = () => persistence

/** @type {Map<string,WSSharedDoc>} */
export const docs = new Map()

/**
 * Read password hash from YJS document's roomSettings map.
 * This is called when loading a room from persistence.
 * @param {WSSharedDoc} ydoc
 */
function readPasswordFromDoc(ydoc) {
  try {
    const roomSettingsMap = ydoc.getMap('roomSettings')
    const storedPasswordHash = roomSettingsMap?.get('passwordHash')
    if (storedPasswordHash && typeof storedPasswordHash === 'string') {
      ydoc.passwordHash = storedPasswordHash
      console.log(`🔒 [${ydoc.name}] Password protection loaded from document`)
    }
    
    // Also listen for password hash changes
    roomSettingsMap.observe((event) => {
      if (event.keysChanged.has('passwordHash')) {
        const newHash = roomSettingsMap.get('passwordHash')
        if (newHash && typeof newHash === 'string') {
          ydoc.passwordHash = newHash
          console.log(`🔒 [${ydoc.name}] Password hash updated`)
        } else if (!newHash) {
          ydoc.passwordHash = null
          console.log(`🔓 [${ydoc.name}] Password protection removed`)
        }
      }
    })
  } catch (e) {
    console.warn(`⚠️ [${ydoc.name}] Could not read password from document:`, e.message)
  }
}

/**
 * Persist password hash to YJS document's roomSettings map.
 * This ensures the password survives server restarts.
 * @param {WSSharedDoc} ydoc
 * @param {string|null} passwordHash
 */
function persistPasswordHashToDoc(ydoc, passwordHash) {
  try {
    const roomSettingsMap = ydoc.getMap('roomSettings')
    if (passwordHash) {
      roomSettingsMap.set('passwordHash', passwordHash)
      console.log(`💾 [${ydoc.name}] Password hash persisted to document`)
    } else {
      roomSettingsMap.delete('passwordHash')
      console.log(`💾 [${ydoc.name}] Password hash removed from document`)
    }
  } catch (e) {
    console.error(`❌ [${ydoc.name}] Failed to persist password hash:`, e.message)
  }
}

/**
 * Shared YJS document with awareness and connection tracking
 */
export class WSSharedDoc extends Y.Doc {
  /** @param {string} name */
  constructor(name) {
    super({ gc: gcEnabled })
    this.name = name
    /** @type {Map<Object, Set<number>>} */
    this.conns = new Map()
    this.awareness = new awarenessProtocol.Awareness(this)
    this.awareness.setLocalState(null)
    /** @type {number} */
    this.lastAccessed = Date.now()
    /** @type {string|null} */
    this.passwordHash = null
    /** @type {Promise<void>|null} Promise that resolves when state is loaded from persistence */
    this._stateLoading = null

    // Awareness change handler
    this.awareness.on('update', /** @param {{ added: number[], updated: number[], removed: number[] }} changes @param {any} conn */ ({ added, updated, removed }, conn) => {
      const changedClients = [...added, ...updated, ...removed]
      if (conn !== null) {
        const controlledIDs = this.conns.get(conn)
        if (controlledIDs) {
          added.forEach(id => controlledIDs.add(id))
          removed.forEach(id => controlledIDs.delete(id))
        }
      }
      // Broadcast awareness update
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients))
      const buff = encoding.toUint8Array(encoder)
      this.conns.forEach((_, c) => send(this, c, buff))
    })

    // Document update handler
    this.on('update', /** @type {any} */ (update, _origin, doc) => {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, MESSAGE_SYNC)
      syncProtocol.writeUpdate(encoder, update)
      const message = encoding.toUint8Array(encoder)
      doc.conns.forEach((_, conn) => send(doc, conn, message))
    })

    // Optional callback handler
    if (isCallbackSet) {
      this.on('update', /** @type {any} */ debounce(callbackHandler, CALLBACK_DEBOUNCE_WAIT, { maxWait: CALLBACK_DEBOUNCE_MAXWAIT }))
    }
  }
}

/**
 * Get or create a document
 * @param {string} docname
 * @param {boolean} gc
 * @returns {WSSharedDoc}
 */
export const getYDoc = (docname, gc = true) => map.setIfUndefined(docs, docname, () => {
  const doc = new WSSharedDoc(docname)
  doc.gc = gc
  /** @type {Promise<void>|null} */
  doc._stateLoading = null
  console.log(`📄 [${docname}] Document created`)
  
  if (persistence) {
    // Store the promise so connections can wait for it
    doc._stateLoading = persistence.bindState(docname, doc)
  }
  
  docs.set(docname, doc)
  return doc
})

/**
 * Send message to connection
 * @param {WSSharedDoc} doc
 * @param {import('ws').WebSocket} conn
 * @param {Uint8Array} message
 */
const send = (doc, conn, message) => {
  if (conn.readyState !== WS_READY_STATE_OPEN) {
    closeConn(doc, conn)
    return
  }
  try {
    conn.send(message, {}, err => { if (err) closeConn(doc, conn) })
  } catch (e) {
    closeConn(doc, conn)
  }
}

/**
 * Close connection and cleanup
 * @param {WSSharedDoc} doc
 * @param {any} conn
 */
const closeConn = (doc, conn) => {
  if (doc.conns.has(conn)) {
    const controlledIds = doc.conns.get(conn)
    doc.conns.delete(conn)
    awarenessProtocol.removeAwarenessStates(doc.awareness, Array.from(controlledIds || []), null)
    
    if (doc.conns.size === 0) {
      doc.lastAccessed = Date.now()
      if (persistence) {
        persistence.writeState(doc.name, doc).catch(err => {
          console.error(`Error persisting document ${doc.name}:`, err)
        })
      }
      console.log(`💾 [${doc.name}] Persisted (no connections)`)
    }
  }
  try { conn.close() } catch (e) { /* ignore */ }
}

/**
 * Handle incoming messages
 * @param {any} conn
 * @param {WSSharedDoc} doc
 * @param {Uint8Array} message
 */
const messageListener = (conn, doc, message) => {
  try {
    const encoder = encoding.createEncoder()
    const decoder = decoding.createDecoder(message)
    const messageType = decoding.readVarUint(decoder)

    switch (messageType) {
      case MESSAGE_SYNC:
        // Only sync if authenticated
        if (conn._auth?.authenticated) {
          encoding.writeVarUint(encoder, MESSAGE_SYNC)
          syncProtocol.readSyncMessage(decoder, encoder, doc, conn)
          if (encoding.length(encoder) > 1) {
            send(doc, conn, encoding.toUint8Array(encoder))
          }
        }
        break

      case MESSAGE_AWARENESS: {
        const awarenessUpdate = decoding.readVarUint8Array(decoder)
        
        // Helper to extract states from awareness update without applying to main awareness
        const extractAwarenessStates = (update) => {
          // Create a temporary awareness to decode the update
          const tempDoc = new Y.Doc()
          const tempAwareness = new awarenessProtocol.Awareness(tempDoc)
          awarenessProtocol.applyAwarenessUpdate(tempAwareness, update, null)
          const states = tempAwareness.getStates()
          tempDoc.destroy()
          return states
        }
        
        // Password verification for protected rooms
        if (doc.passwordHash && conn._auth && !conn._auth.authenticated) {
          const states = extractAwarenessStates(awarenessUpdate)
          
          for (const [, state] of states.entries()) {
            if (state?._roomPassword) {
              if (verifyPassword(state._roomPassword, doc.passwordHash)) {
                conn._auth.authenticated = true
                clearTimeout(conn._auth.timeout)
                console.log(`✅ [${doc.name}] Connection authenticated`)
                
                // Send initial sync after authentication
                sendInitialSync(doc, conn)
                break
              } else {
                console.warn(`❌ [${doc.name}] Invalid password`)
                conn.close(4002, 'Invalid password')
                return
              }
            }
          }
          
          // If still not authenticated, check for admin creating room with password
          if (!conn._auth.authenticated) {
            for (const [, state] of states.entries()) {
              if (state?.user?.type === 'admin' && state?._roomPassword) {
                // Admin setting password for new room
                const newPasswordHash = hashPassword(state._roomPassword)
                doc.passwordHash = newPasswordHash
                
                // Persist password hash to YJS document so it survives server restarts
                persistPasswordHashToDoc(doc, newPasswordHash)
                
                conn._auth.authenticated = true
                clearTimeout(conn._auth.timeout)
                console.log(`🔒 [${doc.name}] Room password set by admin and persisted`)
                sendInitialSync(doc, conn)
                break
              }
            }
          }
          
          if (!conn._auth.authenticated) {
            return // Wait for password
          }
        }
        
        // Apply awareness if authenticated
        if (!doc.passwordHash || conn._auth?.authenticated) {
          // First apply the awareness update to get the full state
          awarenessProtocol.applyAwarenessUpdate(doc.awareness, awarenessUpdate, conn)
          
          // Check if an authenticated admin is setting/updating the password
          // We need to check the FULL awareness state, not just the update
          // because setLocalStateField only sends the changed field
          if (conn._auth?.authenticated) {
            const fullStates = doc.awareness.getStates()
            // Get the client IDs controlled by this connection
            const controlledIds = doc.conns.get(conn)
            
            for (const clientId of controlledIds || []) {
              const state = fullStates.get(clientId)
              if (state?.user?.type === 'admin' && state?._roomPassword) {
                const newPasswordHash = hashPassword(state._roomPassword)
                // Only update if password changed
                if (newPasswordHash !== doc.passwordHash) {
                  doc.passwordHash = newPasswordHash
                  persistPasswordHashToDoc(doc, newPasswordHash)
                  console.log(`🔒 [${doc.name}] Password updated by authenticated admin`)
                }
              }
            }
          }
        }
        break
      }
    }
  } catch (err) {
    console.error('Message handling error:', err)
    // @ts-ignore
    doc.emit('error', [err])
  }
}

/**
 * Send initial sync state to connection
 * @param {WSSharedDoc} doc
 * @param {any} conn
 */
const sendInitialSync = (doc, conn) => {
  // Send sync step 1
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_SYNC)
  syncProtocol.writeSyncStep1(encoder, doc)
  send(doc, conn, encoding.toUint8Array(encoder))
  
  // Send awareness states
  const awarenessStates = doc.awareness.getStates()
  if (awarenessStates.size > 0) {
    const awarenessEncoder = encoding.createEncoder()
    encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS)
    encoding.writeVarUint8Array(awarenessEncoder, awarenessProtocol.encodeAwarenessUpdate(
      doc.awareness,
      Array.from(awarenessStates.keys())
    ))
    send(doc, conn, encoding.toUint8Array(awarenessEncoder))
  }
}

/**
 * Setup WebSocket connection
 * @param {import('ws').WebSocket} conn
 * @param {import('http').IncomingMessage} req
 * @param {any} opts
 */
export const setupWSConnection = async (conn, req, { docName = (req.url || '').slice(1).split('?')[0], gc = true } = {}) => {
  conn.binaryType = 'arraybuffer'
  
  const roomName = docName
  const doc = getYDoc(roomName, gc)
  doc.lastAccessed = Date.now()
  
  // Wait for document state to be loaded from persistence (including password hash)
  if (doc._stateLoading) {
    try {
      await doc._stateLoading
    } catch (e) {
      console.error(`Error loading document state for ${roomName}:`, e)
    }
  }
  
  // Setup authentication state - AFTER state is loaded so passwordHash is correct
  const requiresPassword = !!doc.passwordHash
  conn._auth = {
    authenticated: !requiresPassword,
    timeout: null
  }
  
  // Password timeout for protected rooms
  if (requiresPassword) {
    conn._auth.timeout = setTimeout(() => {
      if (!conn._auth.authenticated) {
        console.warn(`⏰ [${roomName}] Auth timeout`)
        conn.close(4002, 'Password required')
      }
    }, PASSWORD_AUTH_TIMEOUT)
  }
  
  doc.conns.set(conn, new Set())
  
  // Message handler
  conn.on('message', /** @param {ArrayBuffer} message */ message => {
    messageListener(conn, doc, new Uint8Array(message))
  })

  // Ping/pong for connection health
  let pongReceived = true
  const pingInterval = setInterval(() => {
    if (!pongReceived) {
      closeConn(doc, conn)
      clearInterval(pingInterval)
    } else if (doc.conns.has(conn)) {
      pongReceived = false
      try { conn.ping() } catch (e) {
        closeConn(doc, conn)
        clearInterval(pingInterval)
      }
    }
  }, PING_TIMEOUT)
  
  conn.on('close', () => {
    closeConn(doc, conn)
    clearInterval(pingInterval)
    if (conn._auth?.timeout) clearTimeout(conn._auth.timeout)
  })
  
  conn.on('pong', () => { pongReceived = true })
  
  // Send initial state if already authenticated
  if (conn._auth.authenticated) {
    sendInitialSync(doc, conn)
  }
}
