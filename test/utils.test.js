import { describe, it, expect } from 'vitest'
import { findAdminConnectionsToKick } from '../bin/utils.js'

function makeConn(name) {
  return { name }
}

function makeDoc({ fullStates = [], controlled = [], storedKey = null } = {}) {
  const conns = new Map()
  for (const [conn, ids] of controlled) {
    conns.set(conn, new Set(ids))
  }

  return {
    name: 'test-room',
    conns,
    awareness: {
      getStates: () => new Map(fullStates)
    },
    getMap: (name) => ({ get: (k) => storedKey })
  }
}

describe('findAdminConnectionsToKick', () => {
  it('kicks existing admin that has the same publicKey (same key, different client)', () => {
    const connOld = makeConn('old')
    const connNew = makeConn('new')

    const fullStates = [
      [3, { user: { id: 'old-id', type: 'admin', publicKey: 'PUB-ABC' } }],
      [5, { user: { id: 'new-id', type: 'admin', publicKey: 'PUB-ABC' } }],
    ]

    const doc = makeDoc({ fullStates, controlled: [[connOld, [3]], [connNew, [5]]] })

    const updatedStates = new Map([[5, { user: { id: 'new-id', type: 'admin', publicKey: 'PUB-ABC' } }]])

    const result = findAdminConnectionsToKick(doc, updatedStates)
    expect(result).toContain(connOld)
    expect(result).not.toContain(connNew)
  })

  it('kicks existing admin when stored roomClaim matches the incoming key', () => {
    const connOld = makeConn('old2')
    const connNew = makeConn('new2')

    const fullStates = [
      [7, { user: { id: 'old-id-2', type: 'admin', publicKey: 'PUB-OLD' } }],
      [9, { user: { id: 'new-id-2', type: 'admin', publicKey: 'PUB-NEW' } }],
    ]

    const doc = makeDoc({ fullStates, controlled: [[connOld, [7]], [connNew, [9]]], storedKey: 'PUB-NEW' })

    const updatedStates = new Map([[9, { user: { id: 'new-id-2', type: 'admin', publicKey: 'PUB-NEW' } }]])

    const result = findAdminConnectionsToKick(doc, updatedStates)
    expect(result).toContain(connOld)
  })

  it('kicks existing admin when user id matches (resume with same id)', () => {
    const connOld = makeConn('old3')
    const connNew = makeConn('new3')

    const fullStates = [
      [11, { user: { id: 'same-id', type: 'admin', publicKey: 'PUB-OLD' } }],
      [13, { user: { id: 'same-id', type: 'admin', publicKey: 'PUB-NEW' } }],
    ]

    const doc = makeDoc({ fullStates, controlled: [[connOld, [11]], [connNew, [13]]] })

    const updatedStates = new Map([[13, { user: { id: 'same-id', type: 'admin', publicKey: 'PUB-NEW' } }]])

    const result = findAdminConnectionsToKick(doc, updatedStates)
    expect(result).toContain(connOld)
  })

  it('returns empty array if no matches', () => {
    const connOld = makeConn('old4')
    const connNew = makeConn('new4')

    const fullStates = [
      [21, { user: { id: 'other-id', type: 'admin', publicKey: 'PUB-OLD' } }],
      [23, { user: { id: 'new-id-4', type: 'admin', publicKey: 'PUB-NEW' } }],
    ]

    const doc = makeDoc({ fullStates, controlled: [[connOld, [21]], [connNew, [23]]] })

    // incoming uses a key that doesn't match storedKey and doesn't match other keys
    const updatedStates = new Map([[23, { user: { id: 'new-id-4', type: 'admin', publicKey: 'PUB-NEW' } }]])

    const result = findAdminConnectionsToKick(doc, updatedStates)
    expect(result.length).toBe(0)
  })
})
