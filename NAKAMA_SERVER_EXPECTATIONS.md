# Nakama Server Expectations — Punchline Politics: KO Edition

This document specifies **exactly what the Nakama game server must implement** for the Punchline Politics multiplayer system to function. Use this as a requirements checklist when setting up or testing the server at `nakama.quicksol.ca`.

---

## 1. Server Requirements Overview

| Requirement | Status | Notes |
|---|---|---|---|
| Nakama server v3.x running | Required | Hosted at `nakama.quicksol.ca` |
| SSL/TLS enabled | Required | `wss://` for WebSocket, `https://` for REST (port 443) |
| Server key: `69efdfd89977da508991899985a8a01fee457ab8bedaae6b983c282ea9b2e2ce` | Required | Must match `AppConstants.nakamaServerKey` |
| Custom authentication enabled | Required | Firebase UID exchanged via `authenticateCustom()` |
| WebSocket support | Required | NakamaWebsocketClient connection on port 443 |
| Matchmaker configured | Required | `minCount: 2, maxCount: 2` |
| Authoritative match handler: `punchline_match` | Required | Server-side match relay |
| Leaderboard: `mmr_global` | Required | Global MMR ranking (descending, best) |
| Storage collection: `player_data` | Required | Player state persistence |
| Storage collection: `player_profile` | Required | Player profile data |

---

## 2. Client Connection Flow

```
┌─────────────┐     ┌──────────────┐     ┌───────────────┐
│  Game Client │────▶│  Nakama SDK  │────▶│  Nakama Server│
└─────────────┘     └──────────────┘     └───────────────┘
       │                    │                     │
│ 1. authenticate    │                     │
│   Custom(firebaseUid) │─────────────────▶│
       │                    │                     │ Create session
       │ 2. Session token   │◀────────────────────│
       │                    │                     │
       │ 3. WebSocket       │                     │
       │   connect(token)   │────────────────────▶│
       │                    │                     │
       │ 4. addMatchmaker() │────────────────────▶│
       │   (minCount:2)     │                     │ Queue ticket
       │                    │                     │
       │ 5. onMatchmakerMatched ◀─────────────────│ Match found
       │                    │                     │
       │ 6. joinMatch()     │────────────────────▶│
       │                    │                     │ Join authoritative match
       │ 7. sendMatchData() │────────────────────▶│ Relay to opponent
       │                    │                     │
       │ 8. onMatchData ◀────────────────────────│ Opponent's action
```

---

## 3. Server-Side Module: `punchline_match`

### 3.1 Match Registration

```typescript
initializer.registerMatch('punchline_match', {
    matchInit: initMatch,
    matchJoinAttempt: matchJoinAttempt,
    matchLoop: matchLoop,
    matchTerminate: matchTerminate,
    matchSignal: matchSignal,
});
```

### 3.2 `matchInit` — Match Initialization

**Purpose:** Create initial match state when a match is created.

**Expected behavior:**
- Accept a `mode` parameter (`casual`, `ranked`, `private`)
- Set tick rate to 30 ticks/second (for responsive gameplay)
- Initialize state with:
  - `players`: empty object (filled as players join)
  - `round`: 0
  - `startTime`: `Date.now()`
  - `preset`: the game mode from params
- Return label `"Punch-Line Match: {mode}"`

**Required state shape:**
```typescript
{
    players: {
        [userId: string]: {
            username: string,
            characterId: string,
            mmr: number,
            wins: number,
            health: number,
            stamina: number,
        }
    },
    round: number,
    startTime: number,
    preset: 'casual' | 'ranked' | 'private',
    winnerId: string | null,
    roundActive: boolean,
}
```

### 3.3 `matchJoinAttempt` — Player Join Validation

**Purpose:** Accept or reject player join attempts.

**Expected behavior:**
- Accept all join attempts if fewer than 2 players are in the match
- Store player metadata (character ID, MMR) from the join metadata
- Reject if match already has 2 players
- Reject if match is already in progress (past round 0)

### 3.4 `matchLoop` — Game Tick Handler

**Purpose:** Process all incoming match messages every tick. This is the core gameplay relay.

**Expected behavior:**

**OpCode 1 — Fight Action:**
```
Client sends: { actionType, timestamp, data: { move, comboCount, meterLevel } }
Server: broadcasts to all OTHER players (not sender)
```

**OpCode 2 — Character Select:**
```
Client sends: { characterId: string }
Server: Stores characterId in player state, broadcasts to all players
```

**OpCode 3 — Match End:**
```
Client sends: { winnerId: string, result: 'ko'|'tko'|'decision'|'draw' }
Server: Sets winnerId in state, broadcasts to all players
```

**OpCode 4 — Enhancement Loadout:**
```
Client sends: { enhancements: [] }
Server: broadcasts to all OTHER players (not sender)
```

**Relay logic per tick:**
```typescript
for (const message of messages) {
    // All opCodes: relay to all OTHER players (not sender)
    dispatcher.broadcastMessage(message.opCode, message.data, null, message.sender);
}
return { state: state };
```

### 3.5 `matchTerminate` — Cleanup on Match End

**Purpose:** Clean up match state when match ends.

**Expected behavior:**
- Log match results (winner, duration, players)
- Return the final state

### 3.6 `matchSignal` — Handle Match Signals

**Purpose:** Handle signals sent to the match (e.g., admin commands).

**Expected behavior:**
- Accept `"stop"` signal to force-end a match
- Return current state for `"status"` signal

---

## 4. Matchmaker Hook: `matchmakerMatched`

**Purpose:** Called when the Nakama matchmaker finds a compatible pair of players.

**Expected behavior:**
- Create a new authoritative match using `nk.matchCreate('punchline_match', {mode: 'casual'|'ranked'})`
- Invite both players to the match
- Log the pairing

```typescript
const matchmakerMatched: nkr.MatchmakerMatchedFunction = 
function(ctx, logger, db, nk, matches) {
    const match = matches[0];
    logger.info('Match found: %s', match.presence.map(p => p.username).join(' vs '));
    
    // Determine mode from string properties
    const mode = match.stringProperties?.mode || 'casual';
    
    // Create authoritative match
    const matchId = nk.matchCreate('punchline_match', {mode: mode});
    
    return matchId;
};
```

---

## 5. RPC Endpoints

### 5.1 `get_leaderboard`

**Purpose:** Fetch the top 100 players by MMR.

**Request:** Empty payload or `{ "limit": 100 }`

**Response:**
```json
{
    "records": [
        {
            "username": "player_abc",
            "mmr": 2450,
            "rank": "Legend",
            "wins": 142,
            "userId": "user-id-here"
        }
    ]
}
```

**Implementation:**
```typescript
const getLeaderboard: nkr.RpcFunction = function(ctx, logger, nk, payload) {
    const data = JSON.parse(payload || '{}');
    const limit = data.limit || 100;
    const records = nk.leaderboardRecordsList('mmr_global', [], limit, '', 0);
    return JSON.stringify(records);
};
```

### 5.2 `report_match_result`

**Purpose:** Submit post-match results (called by winner's client).

**Request:**
```json
{
    "winnerId": "user-id-1",
    "loserId": "user-id-2",
    "winnerMmr": 1245,
    "loserMmr": 1180,
    "winnerCoins": 150,
    "loserCoins": 50
}
```

**Response:**
```json
{ "success": true }
```

**Implementation:**
```typescript
const reportMatchResult: nkr.RpcFunction = function(ctx, logger, nk, payload) {
    const data = JSON.parse(payload);
    // Write leaderboard records
    nk.leaderboardRecordWrite('mmr_global', data.winnerId, '', data.winnerMmr, 0);
    nk.leaderboardRecordWrite('mmr_global', data.loserId, '', data.loserMmr, 0);
    // Update storage
    nk.storageWrite([
        { collection: 'player_data', key: data.winnerId, value: {
            coins: data.winnerCoins.toString(),
            mmr: data.winnerMmr.toString()
        }, permissionRead: 0, permissionWrite: 1 },
        { collection: 'player_data', key: data.loserId, value: {
            coins: data.loserCoins.toString(),
            mmr: data.loserMmr.toString()
        }, permissionRead: 0, permissionWrite: 1 },
    ]);
    return JSON.stringify({ success: true });
};
```

### 5.3 `update_player_mmr`

**Purpose:** Update a single player's MMR (used during initial placement).

**Request:**
```json
{
    "userId": "user-id-1",
    "mmr": 1050
}
```

**Response:**
```json
{ "success": true, "mmr": 1050 }
```

---

## 6. Leaderboard Configuration

| Property | Value |
|---|---|
| **ID** | `mmr_global` |
| **Sort Order** | Descending (highest MMR first) |
| **Operator** | Best (cumulative) |
| **Reset Schedule** | None (never resets) |
| **Authoritative** | Yes (updated via RPC) |

---

## 7. Storage Collections

### `player_data`

| Field | Type | Description |
|---|---|---|
| `userId` (key) | string | Nakama user ID |
| `coins` | string | Current coin balance (stored as string due to Nakama storage) |
| `mmr` | string | Current MMR rating |
| `character_wins` | string (JSON) | Per-character win counts: `{"rally":5,"vox":2}` |

**Permissions:** Read: 0 (public), Write: 1 (owner only)

---

## 8. Testing Checklist

### 8.1 Server Connectivity

```bash
# Test basic health
curl https://nakama.quicksol.ca:443/healthcheck
# Expected: {} (HTTP 200)

# Test with verbose output
curl -v https://nakama.quicksol.ca:443/healthcheck
# Expected: HTTP/2 200, content-type: application/json
```

### 8.2 Authentication Test

```bash
# Simulate custom auth (Firebase UID)
curl -X POST "https://nakama.quicksol.ca:443/v2/account/authenticate/custom" \
  -H "Content-Type: application/json" \
  -d '{"id": "firebase_test_uid_001", "username": "test_player"}'
# Expected: HTTP 200, returns { token, user_id, ... }
```

### 8.3 Matchmaker Test

1. Open two game clients (device + emulator, or two emulators)
2. Both tap PLAY → both enter matchmaking
3. **Expected:** Within 5-10 seconds, both see "OPPONENT FOUND!"
4. Fight screen loads with both players appearing
5. During fight: actions (jab, hook, block) should sync between devices
6. Match ends: both players see the victory/defeat screen

### 8.4 Module Load Test

Check Nakama server logs on startup:
```
INFO Punch-Line Politics server module loaded
INFO Registering match: punchline_match
INFO Registering RPC: get_leaderboard
INFO Registering RPC: report_match_result
INFO Registering RPC: update_player_mmr
```

### 8.5 RPC Test

```bash
# Test leaderboard RPC
curl -X POST "https://nakama.quicksol.ca:443/v2/rpc/get_leaderboard" \
  -H "Authorization: Bearer YOUR_SESSION_TOKEN"
# Expected: HTTP 200, returns leaderboard records array
```

---

## 9. Common Issues

| Symptom | Likely Cause | Fix |
|---|---|---|
| `Connection failed` in game | Server unreachable or wrong host | Verify `nakama.quicksol.ca:443` is accessible |
| `Matchmaking failed` | No `matchmakerMatched` hook registered | Deploy `main.js` module with hook |
| Match never found | Only 1 player in queue | Requires 2 concurrent players |
| `Authentication failed` | Server key mismatch | Ensure both sides use `69efdfd8...` key |
| Module doesn't load | JS syntax error in `main.js` | Check Nakama logs for errors |
| SSL errors in development | Self-signed certificate | Set `_ssl = false` for local testing |
| Messages not relaying | `matchLoop` not broadcasting | Check `broadcastMessage` logic excludes sender |
| Leaderboard empty | No records written | Play a match to generate records |

---

## 10. Quick Deploy Checklist

```bash
# The module is at modules/main.js (plain JS, no compilation needed)

# Deploy with docker-compose:
docker compose up -d --build

# Check logs for successful module load:
docker compose logs nakama | grep -i "punchline"
# Expected:
#   Punch-Line Politics server module loaded
#   Created leaderboard: mmr_global
#   Registering match: punchline_match
#   Registering matchmaker matched hook
#   Registering RPC: get_leaderboard
#   Registering RPC: report_match_result
#   Registering RPC: update_player_mmr
```

---

## 11. Client-Side Reference Files

| File | Purpose |
|---|---|---|
| `lib/services/nakama_service.dart` | Nakama client, auth, matchmaking, RPCs, WebSocket relay |
| `lib/services/auth_service.dart` | Firebase → Nakama token exchange |
| `lib/providers/auth_provider.dart` | Riverpod state for auth |
| `lib/core/constants/app_constants.dart` | Host (`nakama.quicksol.ca`), port (`443`), server key config |

---

*See [Nakama Server Framework docs](https://heroiclabs.com/docs/nakama/server-framework/) for detailed API reference.*
