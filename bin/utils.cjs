const Y = require('yjs')
const syncProtocol = require('y-protocols/sync')
const awarenessProtocol = require('y-protocols/awareness')

const encoding = require('lib0/encoding')
const decoding = require('lib0/decoding')
const map = require('lib0/map')

const debounce = require('lodash.debounce')

const callbackHandler = require('./callback.cjs').callbackHandler
const isCallbackSet = require('./callback.cjs').isCallbackSet
const { isPersistentRoom, getCleanupInterval, getMaxInactiveAge } = require('./persistent-rooms.cjs')
const { parseRoomConnection, verifyPassword } = require('./room-auth.cjs')

const CALLBACK_DEBOUNCE_WAIT = parseInt(process.env.CALLBACK_DEBOUNCE_WAIT || '2000')
const CALLBACK_DEBOUNCE_MAXWAIT = parseInt(process.env.CALLBACK_DEBOUNCE_MAXWAIT || '10000')

const wsReadyStateConnecting = 0
const wsReadyStateOpen = 1

// disable gc when using snapshots!
const gcEnabled = process.env.GC !== 'false' && process.env.GC !== '0'
const persistenceDir = process.env.YPERSISTENCE
/**
 * @type {{bindState: function(string,WSSharedDoc):void, writeState:function(string,WSSharedDoc):Promise<any>, provider: any}|null}
 */
let persistence = null
if (typeof persistenceDir === 'string') {
  console.info('Persisting documents to "' + persistenceDir + '"')
  // @ts-ignore
  const LeveldbPersistence = require('y-leveldb').LeveldbPersistence
  const ldb = new LeveldbPersistence(persistenceDir)
  persistence = {
    provider: ldb,
    bindState: async (docName, ydoc) => {
      const persistedYdoc = await ldb.getYDoc(docName)
      const newUpdates = Y.encodeStateAsUpdate(ydoc)
      ldb.storeUpdate(docName, newUpdates)
      Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(persistedYdoc))
      ydoc.on('update', update => {
        ldb.storeUpdate(docName, update)
      })
    },
    writeState: async (_docName, _ydoc) => {}
  }
}

/**
 * @param {{bindState: function(string,WSSharedDoc):void,
 * writeState:function(string,WSSharedDoc):Promise<any>,provider:any}|null} persistence_
 */
exports.setPersistence = persistence_ => {
  persistence = persistence_
}

/**
 * @return {null|{bindState: function(string,WSSharedDoc):void,
  * writeState:function(string,WSSharedDoc):Promise<any>}|null} used persistence layer
  */
exports.getPersistence = () => persistence

/**
 * @type {Map<string,WSSharedDoc>}
 */
const docs = new Map()
// exporting docs so that others can use it
exports.docs = docs

const messageSync = 0
const messageAwareness = 1

/**
 * @param {Uint8Array} update
 * @param {any} _origin
 * @param {WSSharedDoc} doc
 * @param {any} _tr
 */
const updateHandler = (update, _origin, doc, _tr) => {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, messageSync)
  syncProtocol.writeUpdate(encoder, update)
  const message = encoding.toUint8Array(encoder)
  doc.conns.forEach((_, conn) => send(doc, conn, message))
}

/**
 * @type {(ydoc: Y.Doc) => Promise<void>}
 */
let contentInitializor = _ydoc => Promise.resolve()

/**
 * This function is called once every time a Yjs document is created. You can
 * use it to pull data from an external source or initialize content.
 *
 * @param {(ydoc: Y.Doc) => Promise<void>} f
 */
exports.setContentInitializor = (f) => {
  contentInitializor = f
}

class WSSharedDoc extends Y.Doc {
  /**
   * @param {string} name
   */
  constructor (name) {
    super({ gc: gcEnabled })
    this.name = name
    /**
     * Maps from conn to set of controlled user ids. Delete all user ids from awareness when this conn is closed
     * @type {Map<Object, Set<number>>}
     */
    this.conns = new Map()
    /**
     * @type {awarenessProtocol.Awareness}
     */
    this.awareness = new awarenessProtocol.Awareness(this)
    this.awareness.setLocalState(null)
    /**
     * Timestamp of last access to this room
     * @type {number}
     */
    this.lastAccessed = Date.now()
    /**
     * Whether this is a persistent room (should not be deleted when empty)
     * @type {boolean}
     */
    this.isPersistent = isPersistentRoom(name)
    /**
     * Password hash for persistent rooms (set by admin on first connection)
     * @type {string|null}
     */
    this.passwordHash = null
    /**
     * @param {{ added: Array<number>, updated: Array<number>, removed: Array<number> }} changes
     * @param {Object | null} conn Origin is the connection that made the change
     */
    const awarenessChangeHandler = ({ added, updated, removed }, conn) => {
      const changedClients = added.concat(updated, removed)
      if (conn !== null) {
        const connControlledIDs = /** @type {Set<number>} */ (this.conns.get(conn))
        if (connControlledIDs !== undefined) {
          added.forEach(clientID => { connControlledIDs.add(clientID) })
          removed.forEach(clientID => { connControlledIDs.delete(clientID) })
        }
      }
      // broadcast awareness update
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, messageAwareness)
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients))
      const buff = encoding.toUint8Array(encoder)
      this.conns.forEach((_, c) => {
        send(this, c, buff)
      })
    }
    this.awareness.on('update', awarenessChangeHandler)
    this.on('update', /** @type {any} */ (updateHandler))
    if (isCallbackSet) {
      this.on('update', /** @type {any} */ (debounce(
        callbackHandler,
        CALLBACK_DEBOUNCE_WAIT,
        { maxWait: CALLBACK_DEBOUNCE_MAXWAIT }
      )))
    }
    this.whenInitialized = contentInitializor(this)
  }
}

exports.WSSharedDoc = WSSharedDoc

/**
 * Gets a Y.Doc by name, whether in memory or on disk
 *
 * @param {string} docname - the name of the Y.Doc to find or create
 * @param {boolean} gc - whether to allow gc on the doc (applies only when created)
 * @return {WSSharedDoc}
 */
const getYDoc = (docname, gc = true) => map.setIfUndefined(docs, docname, () => {
  const doc = new WSSharedDoc(docname)
  doc.gc = gc
  if (persistence !== null) {
    persistence.bindState(docname, doc)
  }
  docs.set(docname, doc)
  return doc
})

exports.getYDoc = getYDoc

/**
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
      case messageSync:
        // SECURITY: Only allow sync if authenticated (or no password required)
        if (conn._roomAuth && conn._roomAuth.authenticated) {
          encoding.writeVarUint(encoder, messageSync)
          syncProtocol.readSyncMessage(decoder, encoder, doc, conn)

          // Only send reply if there's actual content (length > 1 means more than just message type)
          if (encoding.length(encoder) > 1) {
            send(doc, conn, encoding.toUint8Array(encoder))
          }
        } else {
          console.warn(`❌ Sync attempt from unauthenticated connection to room "${doc.name}"`)
        }
        break
      case messageAwareness: {
        const awarenessUpdate = decoding.readVarUint8Array(decoder)
        
        // ====================================================================
        // SECURITY: ROOM CREATION AUTHORIZATION
        // For persistent password-protected rooms that don't exist yet,
        // we must verify the user's type before deciding to create or reject
        // ====================================================================
        if (conn._roomAuth && conn._roomAuth.pendingRoomCreation) {
          const decodedAwareness = awarenessProtocol.decodeAwarenessUpdate(awarenessUpdate)
          const clients = decodedAwareness.clients
          
          // Extract user type and password from awareness state
          let userType = null
          let userPassword = null
          
          for (const [clientID, state] of Object.entries(clients)) {
            if (state && state.user) {
              userType = state.user.type // 'admin' or 'user'
              userPassword = state._roomPassword
              break
            }
          }
          
          // ADMIN PATH: Create the room
          if (userType === 'admin') {
            console.log(`✅ Admin creating password-protected room "${conn._roomAuth.roomName}"`)
            
            // Create the actual persistent document
            const actualDoc = getYDoc(conn._roomAuth.roomName, doc.gc)
            actualDoc.passwordHash = conn._roomAuth.passwordHash
            
            // Transfer connection from temp doc to actual doc
            doc.conns.delete(conn)
            actualDoc.conns.set(conn, new Set())
            
            // Update auth state
            conn._roomAuth.pendingRoomCreation = false
            conn._roomAuth.authenticated = false // Will be set after password verification
            
            // Apply awareness to the real doc
            awarenessProtocol.applyAwarenessUpdate(actualDoc.awareness, awarenessUpdate, conn)
            
            console.log(`✅ Room "${conn._roomAuth.roomName}" created with password protection`)
            
            // Verify the admin's password
            if (userPassword && actualDoc.passwordHash) {
              if (verifyPassword(userPassword, actualDoc.passwordHash)) {
                conn._roomAuth.authenticated = true
                conn._roomAuth.passwordVerified = true
                console.log(`✅ Admin authenticated for room "${actualDoc.name}"`)
              } else {
                console.warn(`❌ Invalid password from admin for room "${actualDoc.name}"`)
                conn.close(4002, 'Invalid password for this room.')
                return
              }
            }
            
            return
          } 
          
          // USER PATH: Reject (room doesn't exist = probably wrong password)
          else {
            console.warn(`❌ User attempted to access non-existent room "${conn._roomAuth.roomName}"`)
            conn.close(4001, 'This password-protected room does not exist. You may have the wrong password, or an admin needs to create this room first.')
            return
          }
        }
        
        // ====================================================================
        // SECURITY: PASSWORD VERIFICATION FOR EXISTING ROOMS
        // Verify password if room requires it and connection not yet authenticated
        // ====================================================================
        if (doc.passwordHash && conn._roomAuth && !conn._roomAuth.authenticated) {
          const decodedAwareness = awarenessProtocol.decodeAwarenessUpdate(awarenessUpdate)
          const clients = decodedAwareness.clients
          
          // Check if awareness contains password
          let passwordVerified = false
          for (const [clientID, state] of Object.entries(clients)) {
            if (state && state._roomPassword) {
              // Verify password using constant-time comparison
              if (verifyPassword(state._roomPassword, doc.passwordHash)) {
                conn._roomAuth.authenticated = true
                conn._roomAuth.passwordVerified = true
                passwordVerified = true
                console.log(`✅ Connection authenticated for room "${doc.name}"`)
                break
              } else {
                console.warn(`❌ Invalid password attempt for room "${doc.name}"`)
                conn.close(4002, 'Invalid password for this room.')
                return
              }
            }
          }
          
          // Reject if still not authenticated after awareness update
          if (!passwordVerified) {
            console.warn(`❌ Awareness update without password for protected room "${doc.name}"`)
            return
          }
        }
        
        // Apply awareness update (only if authenticated or no password required)
        if (!doc.passwordHash || (conn._roomAuth && conn._roomAuth.authenticated)) {
          awarenessProtocol.applyAwarenessUpdate(doc.awareness, awarenessUpdate, conn)
        }
        break
      }
    }
  } catch (err) {
    console.error(err)
    // @ts-ignore
    doc.emit('error', [err])
  }
}

/**
 * Closes a connection and cleans up the document if no connections remain
 * 
 * PERSISTENT ROOMS: Kept in memory, persisted to disk
 * NON-PERSISTENT ROOMS: Destroyed when last connection closes
 * 
 * @param {WSSharedDoc} doc
 * @param {any} conn
 */
const closeConn = (doc, conn) => {
  if (doc.conns.has(conn)) {
    // Remove awareness states controlled by this connection
    const controlledIds = /** @type {Set<number>} */ (doc.conns.get(conn))
    doc.conns.delete(conn)
    awarenessProtocol.removeAwarenessStates(doc.awareness, Array.from(controlledIds), null)
    
    // Handle cleanup if no connections remain
    if (doc.conns.size === 0) {
      doc.lastAccessed = Date.now()
      
      if (doc.isPersistent) {
        // PERSISTENT ROOM: Keep in memory, persist to disk
        if (persistence !== null) {
          persistence.writeState(doc.name, doc).catch(err => {
            console.error('Error persisting document:', err)
          })
        }
        console.log(`💾 Persistent room "${doc.name}" persisted (last accessed: ${new Date(doc.lastAccessed).toISOString()})`)
      } else {
        // NON-PERSISTENT ROOM: Destroy and remove from memory
        if (persistence !== null) {
          persistence.writeState(doc.name, doc).then(() => {
            doc.destroy()
          })
          docs.delete(doc.name)
        }
      }
    }
  }
  conn.close()
}

/**
 * @param {WSSharedDoc} doc
 * @param {import('ws').WebSocket} conn
 * @param {Uint8Array} m
 */
const send = (doc, conn, m) => {
  if (conn.readyState !== wsReadyStateConnecting && conn.readyState !== wsReadyStateOpen) {
    closeConn(doc, conn)
  }
  try {
    conn.send(m, {}, err => { err != null && closeConn(doc, conn) })
  } catch (e) {
    closeConn(doc, conn)
  }
}

const pingTimeout = 30000

/**
 * Sets up a WebSocket connection for collaborative editing
 * 
 * FLOW:
 * 1. Parse room name and password hash from URL
 * 2. For new password-protected rooms: Wait for user type verification (admin vs user)
 * 3. For existing rooms: Verify password in awareness
 * 4. Setup ping/pong for connection health
 * 5. Send initial sync
 * 
 * @param {import('ws').WebSocket} conn
 * @param {import('http').IncomingMessage} req
 * @param {any} opts
 */
exports.setupWSConnection = (conn, req, { docName = (req.url || '').slice(1).split('?')[0], gc = true } = {}) => {
  conn.binaryType = 'arraybuffer'
  
  // ====================================================================
  // STEP 1: PARSE CONNECTION INFO
  // ====================================================================
  const { roomName, passwordHash } = parseRoomConnection(docName)
  const existingDoc = docs.get(roomName)
  const isPersistent = isPersistentRoom(roomName)
  
  // ====================================================================
  // STEP 2: HANDLE NON-EXISTENT PASSWORD-PROTECTED ROOMS
  // Wait for user type to decide: admin creates, user gets rejected
  // ====================================================================
  if (isPersistent && passwordHash && !existingDoc) {
    console.log(`⏳ Password-protected room "${roomName}" pending user verification`)
    
    conn._roomAuth = {
      authenticated: false,
      passwordVerified: false,
      pendingRoomCreation: true,
      roomName: roomName,
      passwordHash: passwordHash
    }
    
    // Create temporary doc to receive awareness
    const tempDoc = new WSSharedDoc(roomName)
    tempDoc.gc = gc
    tempDoc.conns.set(conn, new Set())
    
    // Handle messages (will check user type in messageListener)
    conn.on('message', /** @param {ArrayBuffer} message */ message => {
      if (conn._roomAuth && conn._roomAuth.pendingRoomCreation) {
        messageListener(conn, tempDoc, new Uint8Array(message))
      } else {
        const actualDoc = docs.get(roomName)
        if (actualDoc) {
          messageListener(conn, actualDoc, new Uint8Array(message))
        }
      }
    })
    
    // Setup connection health monitoring
    let pongReceived = true
    const pingInterval = setInterval(() => {
      if (!pongReceived) {
        const actualDoc = docs.get(roomName) || tempDoc
        closeConn(actualDoc, conn)
        clearInterval(pingInterval)
      } else {
        const actualDoc = docs.get(roomName)
        if (tempDoc.conns.has(conn) || (actualDoc && actualDoc.conns.has(conn))) {
          pongReceived = false
          try {
            conn.ping()
          } catch (e) {
            closeConn(actualDoc || tempDoc, conn)
            clearInterval(pingInterval)
          }
        }
      }
    }, pingTimeout)
    
    conn.on('close', () => {
      closeConn(docs.get(roomName) || tempDoc, conn)
      clearInterval(pingInterval)
    })
    
    conn.on('pong', () => {
      pongReceived = true
    })
    
    // Send initial sync
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, messageSync)
    syncProtocol.writeSyncStep1(encoder, tempDoc)
    send(tempDoc, conn, encoding.toUint8Array(encoder))
    
    return
  }
  
  // ====================================================================
  // STEP 3: GET OR CREATE DOCUMENT
  // ====================================================================
  const doc = getYDoc(roomName, gc)
  
  // ====================================================================
  // STEP 4: PASSWORD HASH SECURITY
  // Password can only be set on room creation, never changed (immutable)
  // ====================================================================
  if (doc.isPersistent && passwordHash) {
    if (!doc.passwordHash) {
      // New room: Set password hash
      const isNewRoom = doc.conns.size === 0
      
      if (isNewRoom) {
        doc.passwordHash = passwordHash
        console.log(`🔒 Room "${roomName}" initialized with password protection`)
      } else {
        console.warn(`❌ Attempt to add password to existing room "${roomName}"`)
        conn.close(4003, 'Cannot add password to existing room.')
        return
      }
    } else if (doc.passwordHash !== passwordHash) {
      // Password hash mismatch
      console.warn(`❌ Password hash mismatch for room "${roomName}"`)
      conn.close(4004, 'Password hash mismatch - room was created with different password.')
      return
    }
  }
  
  // ====================================================================
  // STEP 5: SETUP CONNECTION
  // ====================================================================
  conn._roomAuth = {
    authenticated: !doc.passwordHash, // Auto-auth if no password
    passwordVerified: false
  }
  
  doc.lastAccessed = Date.now()
  doc.conns.set(conn, new Set())
  
  // Message handling
  conn.on('message', /** @param {ArrayBuffer} message */ message => 
    messageListener(conn, doc, new Uint8Array(message))
  )

  // Connection health monitoring
  let pongReceived = true
  const pingInterval = setInterval(() => {
    if (!pongReceived) {
      if (doc.conns.has(conn)) {
        closeConn(doc, conn)
      }
      clearInterval(pingInterval)
    } else if (doc.conns.has(conn)) {
      pongReceived = false
      try {
        conn.ping()
      } catch (e) {
        closeConn(doc, conn)
        clearInterval(pingInterval)
      }
    }
  }, pingTimeout)
  
  conn.on('close', () => {
    closeConn(doc, conn)
    clearInterval(pingInterval)
  })
  
  conn.on('pong', () => {
    pongReceived = true
  })
  
  // ====================================================================
  // STEP 6: SEND INITIAL STATE
  // ====================================================================
  {
    // Send sync step 1
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, messageSync)
    syncProtocol.writeSyncStep1(encoder, doc)
    send(doc, conn, encoding.toUint8Array(encoder))
    
    // Send awareness states
    const awarenessStates = doc.awareness.getStates()
    if (awarenessStates.size > 0) {
      const encoder = encoding.createEncoder()
      encoding.writeVarUint(encoder, messageAwareness)
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(
        doc.awareness, 
        Array.from(awarenessStates.keys())
      ))
      send(doc, conn, encoding.toUint8Array(encoder))
    }
  }
}
