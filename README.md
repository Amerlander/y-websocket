# Calliope Campus WebSocket Server

Custom y-websocket server for Calliope Campus real-time collaboration.

## Overview

This server handles real-time synchronization for collaborative coding rooms using YJS. It provides:

- **Room persistence**: Rooms are stored in LevelDB for durability
- **Password protection**: Persistent rooms can require passwords
- **Room management API**: REST endpoints for room operations
- **Admin key verification**: Validates room ownership via PGP public keys

## Quick Start

### Development

```bash
# From the project root
cd scripts/server/y-websocket-dev

# Start the server
node bin/server.cjs
```

Or use Docker:

```bash
cd scripts/server
docker-compose up
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HOST` | `localhost` | Server host |
| `PORT` | `1234` | Server port |
| `YPERSISTENCE` | `./yjs-data` | LevelDB persistence directory |
| `GC` | `true` | Enable garbage collection |

## API Endpoints

### GET `/room/:roomName/info`

Get room metadata including existence, password status, and admin public key.

**Response:**
```json
{
  "exists": true,
  "isPersistent": true,
  "hasPassword": true,
  "connectionCount": 5,
  "adminPublicKey": "-----BEGIN PGP PUBLIC KEY..."
}
```

### POST `/room/:roomName/verify-password`

Verify a password for a room.

**Request:**
```json
{
  "password": "secret123"
}
```

**Response:**
```json
{
  "valid": true
}
```

### DELETE `/room/:roomName`

Delete a room (requires password if room is password-protected).

**Request:**
```json
{
  "password": "secret123"
}
```

## WebSocket Protocol

The server uses the standard y-websocket protocol with extensions:

### Connection URL Format

```
ws://localhost:1234/roomName?type=admin&userId=xxx&persistent=true
```

**Query Parameters:**
- `type`: User type (`admin` or `user`)
- `userId`: Unique user identifier
- `persistent`: Whether this is a persistent room

### Close Codes

| Code | Meaning |
|------|---------|
| `4001` | Invalid password |
| `4010` | Room is being deleted |
| `4403` | Access denied |

## Room Types

### Regular Rooms
- 4-word room names from german_words
- No persistence after all users leave
- No password protection

### Persistent Rooms
- 4-5 word room names (first word from special_room_words)
- Data persisted in LevelDB
- Optional password protection
- Admin ownership tracked via `roomClaim`

## Architecture

```
┌─────────────────────────────────────────┐
│           WebSocket Server              │
│  ┌─────────────────────────────────────┐│
│  │    REST API (room management)      ││
│  └─────────────────────────────────────┘│
│  ┌─────────────────────────────────────┐│
│  │    WebSocket Handler (y-websocket) ││
│  └─────────────────────────────────────┘│
│  ┌─────────────────────────────────────┐│
│  │    LevelDB Persistence             ││
│  └─────────────────────────────────────┘│
└─────────────────────────────────────────┘
```

## Security

### Room Ownership (roomClaim)

When an admin creates a room, their PGP public key is stored in the room's `roomClaim`. This prevents other keys (that might hash to the same room URL) from taking over the room.

### Password Hashing

Room passwords are hashed using SHA-256 before comparison. The hash is stored in memory and in the persisted room data.

## Development

### File Structure

```
bin/
├── server.cjs          # Main HTTP + WebSocket server
├── utils.cjs           # YJS document handling
├── room-auth.cjs       # Password hashing/verification
├── persistent-rooms.cjs # Room persistence logic
└── callback.cjs        # Optional webhook callbacks
```

### Adding New Endpoints

Add new routes in `server.cjs` in the HTTP request handler section.

## Based On

This server is based on [y-websocket](https://github.com/yjs/y-websocket) with custom extensions for Calliope Campus.

## License

[The MIT License](./LICENSE) © Kevin Jahns
