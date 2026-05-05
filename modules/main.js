// Punch-Line Politics — Nakama Server Runtime Module
// Handles match relay, leaderboards, MMR tracking, and match result storage.

var InitModule = function (ctx, logger, nk, initializer) {
  logger.info('Punch-Line Politics server module loaded');

  // Ensure the global MMR leaderboard exists
  try {
    nk.leaderboardCreate('mmr_global', true, 'desc', 'best', '', {}, false);
    logger.info('Created leaderboard: mmr_global');
  } catch (e) {
    logger.info('Leaderboard mmr_global already exists (or error): %s', e.message);
  }

  logger.info('Registering match: punchline_match');
  initializer.registerMatch('punchline_match', {
    matchInit: matchInit,
    matchJoinAttempt: matchJoinAttempt,
    matchJoin: matchJoin,
    matchLeave: matchLeave,
    matchLoop: matchLoop,
    matchTerminate: matchTerminate,
    matchSignal: matchSignal,
  });

  logger.info('Registering matchmaker matched hook');
  initializer.registerMatchmakerMatched(matchmakerMatched);

  logger.info('Registering RPC: get_leaderboard');
  initializer.registerRpc('get_leaderboard', getLeaderboard);

  logger.info('Registering RPC: report_match_result');
  initializer.registerRpc('report_match_result', reportMatchResult);

  logger.info('Registering RPC: update_player_mmr');
  initializer.registerRpc('update_player_mmr', updatePlayerMmr);
};

/* ------------------------------------------------------------------ */
/* Match handlers                                                      */
/* ------------------------------------------------------------------ */

var matchInit = function (ctx, logger, nk, params) {
  var preset = (params && params.mode) ? params.mode : 'casual';
  var state = {
    players: {},
    round: 0,
    startTime: Date.now(),
    preset: preset,
    winnerId: null,
    roundActive: false,
  };

  logger.info('Match initialized: mode=%s', preset);

  return {
    state: state,
    tickRate: 30,
    label: 'Punch-Line Match: ' + preset,
  };
};

var matchJoinAttempt = function (ctx, logger, nk, dispatcher, tick, state, presence, metadata) {
  var playerCount = Object.keys(state.players).length;

  if (playerCount >= 2) {
    logger.info('Rejecting player %s: match is full', presence.userId);
    return { state: state, accept: false };
  }

  if (state.round > 0) {
    logger.info('Rejecting player %s: match already in progress', presence.userId);
    return { state: state, accept: false };
  }

  logger.info('Accepting player %s into match', presence.userId);
  return { state: state, accept: true };
};

var matchJoin = function (ctx, logger, nk, dispatcher, tick, state, presences) {
  for (var i = 0; i < presences.length; i++) {
    var p = presences[i];
    state.players[p.userId] = {
      username: p.username || '',
      characterId: '',
      mmr: 0,
      wins: 0,
      health: 100,
      stamina: 100,
      ready: false,
    };
    logger.info('Player %s (%s) joined match', p.userId, p.username);
  }
  return { state: state };
};

var matchLeave = function (ctx, logger, nk, dispatcher, tick, state, presences) {
  for (var i = 0; i < presences.length; i++) {
    var p = presences[i];
    delete state.players[p.userId];
    logger.info('Player %s left match', p.userId);
  }
  return { state: state };
};

var matchLoop = function (ctx, logger, nk, dispatcher, tick, state, messages) {
  for (var i = 0; i < messages.length; i++) {
    var msg = messages[i];

    switch (msg.opCode) {
      case 1:
        // Fight action — relay to all OTHER players
        dispatcher.broadcastMessage(msg.opCode, msg.data, null, msg.sender);
        break;

      case 2:
        // Character select — store fighterId and relay to others
        if (state.players[msg.sender.userId]) {
          try {
            var charData = JSON.parse(msg.data);
            state.players[msg.sender.userId].characterId = charData.fighterId || '';
          } catch (e) {
            logger.warn('Invalid character select data from %s', msg.sender.userId);
          }
        }
        dispatcher.broadcastMessage(msg.opCode, msg.data, null, msg.sender);
        break;

      case 3:
        // Match end — record winner, deactivate round, relay to others
        try {
          var endData = JSON.parse(msg.data);
          state.winnerId = endData.winnerId || null;
        } catch (e) {
          logger.warn('Invalid match end data from %s', msg.sender.userId);
        }
        state.roundActive = false;
        dispatcher.broadcastMessage(msg.opCode, msg.data, null, msg.sender);
        break;

      case 4:
        // Enhancement loadout — relay to all OTHER players
        dispatcher.broadcastMessage(msg.opCode, msg.data, null, msg.sender);
        break;

      default:
        logger.warn('Unknown opCode %d from %s', msg.opCode, msg.sender.userId);
        dispatcher.broadcastMessage(msg.opCode, msg.data, null, msg.sender);
        break;
    }
  }

  return { state: state };
};

var matchTerminate = function (ctx, logger, nk, dispatcher, tick, state, graceSeconds) {
  var playerIds = [];
  for (var id in state.players) {
    playerIds.push(id);
  }

  logger.info('Match terminating. Winner: %s, Round: %d, Players: [%s], Duration: %dms',
    state.winnerId || 'none',
    state.round,
    playerIds.join(', '),
    Date.now() - state.startTime);

  return { state: state };
};

var matchSignal = function (ctx, logger, nk, dispatcher, tick, state, data) {
  if (data === 'stop') {
    logger.info('Force-stopping match via signal');
    return { state: state };
  }

  if (data === 'status') {
    logger.info('Status signal for match. Round: %d, Players: %d',
      state.round, Object.keys(state.players).length);
    return { state: state };
  }

  return { state: state };
};

/* ------------------------------------------------------------------ */
/* Matchmaker matched hook                                             */
/* ------------------------------------------------------------------ */

var matchmakerMatched = function (ctx, logger, nk, matches) {
  var usernames = matches.map(function(m) { return m.presence.username; });

  logger.info('Match found: %s',
    usernames.join(' vs '));

  var props = matches[0].properties || {};
  var mode = props.mode || 'casual';
  var fighterId = props.fighterId || '';

  var matchId = nk.matchCreate('punchline_match', { mode: mode, fighterId: fighterId });

  logger.info('Created match %s mode=%s fighter=%s', matchId, mode, fighterId);

  return matchId;
};

/* ------------------------------------------------------------------ */
/* RPCs                                                                */
/* ------------------------------------------------------------------ */

var getLeaderboard = function (ctx, logger, nk, payload) {
  try {
    var data = payload ? JSON.parse(payload) : {};
    var limit = data.limit || 100;
    var result = nk.leaderboardRecordsList('mmr_global', null, limit, null, null);
    var records = [];
    var allRecords = result ? (result.records || result.ownerRecords || []) : [];
    for (var i = 0; i < allRecords.length; i++) {
      var r = allRecords[i];
      records.push({
        username: r.username || '',
        mmr: r.score || r.value || 0,
        wins: (r.metadata && r.metadata.wins) ? parseInt(r.metadata.wins) : 0,
        rank: r.maxNumScore || 0,
        userId: r.ownerId || '',
      });
    }
    return JSON.stringify({ records: records });
  } catch (err) {
    logger.error('getLeaderboard error: %s', err.message);
    return JSON.stringify({ error: err.message });
  }
};

var reportMatchResult = function (ctx, logger, nk, payload) {
  try {
    var data = JSON.parse(payload);
    var winnerId = data.winnerId;
    var loserId  = data.loserId;
    var winnerMmr = data.winnerMmr || 0;
    var loserMmr  = data.loserMmr  || 0;

    nk.leaderboardRecordWrite('mmr_global', winnerId, '', winnerMmr, 0);
    nk.leaderboardRecordWrite('mmr_global', loserId,  '', loserMmr,  0);

    var winnerDisplayName = data.winnerDisplayName;
    var loserDisplayName = data.loserDisplayName;
    if (!winnerDisplayName || !loserDisplayName) {
      var result = nk.accountsGetId([winnerId, loserId]);
      if (result) {
        for (var i = 0; i < result.length; i++) {
          var acct = result[i];
          if (acct && acct.user) {
            if (acct.user.userId === winnerId && !winnerDisplayName) {
              winnerDisplayName = acct.user.displayName || acct.user.username || '';
            }
            if (acct.user.userId === loserId && !loserDisplayName) {
              loserDisplayName = acct.user.displayName || acct.user.username || '';
            }
          }
        }
      }
    }

    nk.storageWrite([
      {
        collection: 'player_data',
        key: winnerId,
        userId: winnerId,
        value: {
          coins: data.winnerCoins ? String(data.winnerCoins) : '0',
          mmr: String(winnerMmr),
          character_wins: data.winnerCharacterWins ? JSON.stringify(data.winnerCharacterWins) : '{}',
        },
        permissionRead: 0,
        permissionWrite: 1,
      },
      {
        collection: 'player_data',
        key: loserId,
        userId: loserId,
        value: {
          coins: data.loserCoins ? String(data.loserCoins) : '0',
          mmr: String(loserMmr),
          character_wins: data.loserCharacterWins ? JSON.stringify(data.loserCharacterWins) : '{}',
        },
        permissionRead: 0,
        permissionWrite: 1,
      },
      {
        collection: 'player_profile',
        key: winnerId,
        userId: winnerId,
        value: {
          displayName: winnerDisplayName || '',
          fighterWins: data.winnerCharacterWins ? JSON.stringify(data.winnerCharacterWins) : '{}',
        },
        permissionRead: 0,
        permissionWrite: 1,
      },
      {
        collection: 'player_profile',
        key: loserId,
        userId: loserId,
        value: {
          displayName: loserDisplayName || '',
          fighterWins: data.loserCharacterWins ? JSON.stringify(data.loserCharacterWins) : '{}',
        },
        permissionRead: 0,
        permissionWrite: 1,
      },
    ]);

    return JSON.stringify({ success: true });
  } catch (err) {
    logger.error('reportMatchResult error: %s', err.message);
    return JSON.stringify({ error: err.message });
  }
};

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
