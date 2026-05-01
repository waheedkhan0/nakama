// Punch-Line Politics — Nakama Server Runtime Module
// Handles match relay, leaderboards, MMR tracking, and match result storage.

var InitModule = function (ctx, logger, nk, initializer) {
  logger.info('Punch-Line Politics server module loaded');

  // Register the match handler used for 1v1 fights.
  initializer.registerMatch('punchline_match', {
    matchInit: matchInit,
    matchJoinAttempt: matchJoinAttempt,
    matchJoin: matchJoin,
    matchLeave: matchLeave,
    matchLoop: matchLoop,
    matchTerminate: matchTerminate,
  });

  // Register RPCs
  initializer.registerRpc('get_leaderboard', getLeaderboard);
  initializer.registerRpc('report_match_result', reportMatchResult);
  initializer.registerRpc('update_player_mmr', updatePlayerMmr);
};

/* ------------------------------------------------------------------ */
/* Match handlers                                                      */
/* ------------------------------------------------------------------ */

var matchInit = function (ctx, logger, nk, params) {
  var state = {
    players: {},
    round: 0,
    startTime: Date.now(),
    preset: (params && params.mode) ? params.mode : 'casual',
  };

  return {
    state: state,
    tickRate: 30,
    label: 'Punch-Line Match',
  };
};

var matchJoinAttempt = function (ctx, logger, nk, dispatcher, tick, state, presence, metadata) {
  logger.info('Player %s attempting to join match', presence.userId);
  return { state: state, accept: true };
};

var matchJoin = function (ctx, logger, nk, dispatcher, tick, state, presences) {
  for (var i = 0; i < presences.length; i++) {
    state.players[presences[i].userId] = presences[i];
    logger.info('Player %s joined match', presences[i].userId);
  }
  return { state: state };
};

var matchLeave = function (ctx, logger, nk, dispatcher, tick, state, presences) {
  for (var i = 0; i < presences.length; i++) {
    delete state.players[presences[i].userId];
    logger.info('Player %s left match', presences[i].userId);
  }
  return { state: state };
};

var matchLoop = function (ctx, logger, nk, dispatcher, tick, state, messages) {
  for (var i = 0; i < messages.length; i++) {
    var msg = messages[i];

    // Relay to every other player in the match.
    // opCodes used by client:
    //   1 = fight action
    //   2 = character select
    //   3 = match end
    dispatcher.broadcastMessage(msg.opCode, msg.data, null, false);

    logger.debug('Relayed opCode=%d from %s', msg.opCode, msg.sender.userId);
  }
  return { state: state };
};

var matchTerminate = function (ctx, logger, nk, dispatcher, tick, state, graceSeconds) {
  logger.info('Match terminating');
  return { state: state };
};

/* ------------------------------------------------------------------ */
/* RPCs                                                                */
/* ------------------------------------------------------------------ */

// Return top 100 MMR records.
var getLeaderboard = function (ctx, logger, nk, payload) {
  try {
    var result = nk.leaderboardRecordsList('mmr_global', null, 100, null, null);
    return JSON.stringify(result);
  } catch (err) {
    logger.error('getLeaderboard error: %s', err.message);
    return JSON.stringify({ error: err.message });
  }
};

// Persist match result to leaderboard and per-player storage.
var reportMatchResult = function (ctx, logger, nk, payload) {
  try {
    var data = JSON.parse(payload);
    var winnerId = data.winnerId;
    var loserId  = data.loserId;
    var winnerMmr = data.winnerMmr || 0;
    var loserMmr  = data.loserMmr  || 0;

    // Write MMR to leaderboard
    nk.leaderboardRecordWrite('mmr_global', winnerId, '', winnerMmr, 0);
    nk.leaderboardRecordWrite('mmr_global', loserId,  '', loserMmr,  0);

    // Persist extra stats (coins, etc.) in storage
    var winnerStats = {
      coins: data.winnerCoins ? String(data.winnerCoins) : '0',
      mmr: String(winnerMmr),
    };
    var loserStats = {
      coins: data.loserCoins ? String(data.loserCoins) : '0',
      mmr: String(loserMmr),
    };

    nk.storageWrite([
      {
        collection: 'player_data',
        key: 'stats',
        userId: winnerId,
        value: winnerStats,
        permissionRead: 2,   // PUBLIC_READ
        permissionWrite: 1,  // OWNER_WRITE
      },
      {
        collection: 'player_data',
        key: 'stats',
        userId: loserId,
        value: loserStats,
        permissionRead: 2,
        permissionWrite: 1,
      },
    ]);

    return JSON.stringify({ success: true });
  } catch (err) {
    logger.error('reportMatchResult error: %s', err.message);
    return JSON.stringify({ error: err.message });
  }
};

// Update a single player's MMR (used for rank adjustments).
var updatePlayerMmr = function (ctx, logger, nk, payload) {
  try {
    var data = JSON.parse(payload);
    var userId = data.userId;
    var mmr    = data.mmr || 0;

    nk.leaderboardRecordWrite('mmr_global', userId, '', mmr, 0);
    return JSON.stringify({ success: true, mmr: mmr });
  } catch (err) {
    logger.error('updatePlayerMmr error: %s', err.message);
    return JSON.stringify({ error: err.message });
  }
};
