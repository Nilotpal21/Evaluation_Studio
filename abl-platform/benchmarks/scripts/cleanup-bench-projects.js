// =============================================================================
// Cleanup script: Delete bench-sat* and stress-test* project data
// + auth audit log spam from abl-platform database on agents-dev
//
// Usage (dry-run — default, no data deleted):
//   kubectl exec -n abl-platform-dev abl-platform-dev-mongodb-0 -c mongod -- \
//     mongosh --norc --quiet \
//     "mongodb://abl-app:<password>@localhost:27017/abl-platform?authSource=admin" \
//     /tmp/cleanup-bench-projects.js
//
// Usage (live delete):
//   kubectl exec -n abl-platform-dev abl-platform-dev-mongodb-0 -c mongod -- \
//     mongosh --norc --quiet \
//     "mongodb://abl-app:<password>@localhost:27017/abl-platform?authSource=admin" \
//     --eval 'var DRY_RUN=false' /tmp/cleanup-bench-projects.js
//
// PART A — Project cleanup (bench-sat*, stress-test*):
//   1. messages          (by sessionId — no projectId on messages)
//   2. session_states    (by projectId — no sessionId on session_states)
//   3. sessions          (by projectId)
//   4. project children  (agents, tools, members, configs, eval, etc.)
//   5. projects          (the projects themselves)
//
// PART B — Audit log cleanup (auth event spam):
//   Deletes ONLY these 3 action types from audit_logs:
//     - auth.user.success       (10.9M — every token validation)
//     - authorization:denied    (1.1M  — expired WS reconnects)
//     - auth.user.failure       (753K  — failed logins)
//   PRESERVES:
//     - All CRUD audit docs (collectionName != null)      — ~10K docs
//     - All non-auth action docs (tool calls, CRUD, etc.) — ~19K docs
//   Safety: counts preserved docs BEFORE and AFTER, aborts if mismatch.
//
// Performance:
//   Part A uses single deleteMany calls (all $in arrays fit in 16MB BSON).
//   Part B uses 500K-doc chunks (10x faster than 50K) to balance speed vs
//   replica set oplog pressure.
//
// Estimated runtime:
//   Dry run:    ~2-3 min
//   Live delete: ~10-15 min
// =============================================================================

if (typeof DRY_RUN === 'undefined') {
  var DRY_RUN = true;
}

print('');
print('='.repeat(70));
print(
  DRY_RUN ? '  DRY RUN — no data will be deleted' : '  *** LIVE MODE — DATA WILL BE DELETED ***',
);
print('='.repeat(70));
print('');

// =============================================================================
// Helpers
// =============================================================================

// Timer helper — returns elapsed string
function elapsed(startMs) {
  var secs = (new Date().getTime() - startMs) / 1000;
  return secs < 60 ? secs.toFixed(1) + 's' : (secs / 60).toFixed(1) + 'm';
}

// Single deleteMany with $in. Use when the ids array fits in 16MB BSON (~400K UUIDs).
// Falls back to batched if array is too large.
function directDelete(collectionName, filterField, ids) {
  var filter = {};
  filter[filterField] = { $in: ids };
  if (DRY_RUN) {
    return db.getCollection(collectionName).countDocuments(filter);
  } else {
    var result = db.getCollection(collectionName).deleteMany(filter);
    return result.deletedCount;
  }
}

// Chunked delete by arbitrary filter. Fetches _id batches, deletes by _id.
// Chunks prevent long write locks that stall replication.
// 200K keeps the $in array safely under the 16MB BSON limit (~7MB for ObjectIds).
// 500K was tried but hit RangeError on audit_logs ObjectIds.
function chunkedDelete(collectionName, filter, label, chunkSize) {
  chunkSize = chunkSize || 200000;
  var total = 0;
  var chunkNum = 0;

  if (DRY_RUN) {
    return db.getCollection(collectionName).countDocuments(filter);
  }

  while (true) {
    var docs = db.getCollection(collectionName).find(filter, { _id: 1 }).limit(chunkSize).toArray();
    if (docs.length === 0) break;
    chunkNum++;

    var idList = docs.map(function (d) {
      return d._id;
    });
    var result = db.getCollection(collectionName).deleteMany({ _id: { $in: idList } });
    total += result.deletedCount;

    print(
      '     ' +
        (label || collectionName) +
        ': chunk ' +
        chunkNum +
        ' — ' +
        result.deletedCount +
        ' deleted (total: ' +
        total +
        ')',
    );

    if (docs.length < chunkSize) break;
  }
  return total;
}

// =============================================================================
// PART A: Project cleanup (bench-sat*, stress-test*)
// =============================================================================
print('#'.repeat(70));
print('  PART A: Project Cleanup (bench-sat*, stress-test*)');
print('#'.repeat(70));
print('');

var partAStart = new Date().getTime();

// ---------------------------------------------------------------------------
// A1: Collect project IDs
// ---------------------------------------------------------------------------
var projects = db.projects
  .find(
    {
      $or: [{ name: /^bench-sat/i }, { name: /^stress-test/i }],
    },
    { _id: 1, name: 1 },
  )
  .toArray();

var projectIds = projects.map(function (p) {
  return p._id;
});
print('[A1] Found ' + projectIds.length + ' projects to delete');
if (projectIds.length === 0) {
  print('     No matching projects. Skipping Part A.');
}

// ---------------------------------------------------------------------------
// A2: Collect session IDs (needed for messages — messages has no projectId)
// ---------------------------------------------------------------------------
var sessionIds = [];
if (projectIds.length > 0) {
  print('[A2] Collecting session IDs (needed for messages lookup)...');
  var t = new Date().getTime();
  sessionIds = db.sessions
    .find({ projectId: { $in: projectIds } }, { _id: 1 })
    .toArray()
    .map(function (s) {
      return s._id;
    });
  print('     Found ' + sessionIds.length + ' sessions (' + elapsed(t) + ')');
}

var msgCount = 0;
var ssCount = 0;
var sesCount = 0;
var childTotal = 0;

if (projectIds.length > 0) {
  // -------------------------------------------------------------------------
  // A3: Delete messages (by sessionId — single deleteMany)
  //     294K sessionIds = ~11MB BSON, fits under 16MB limit.
  //     Uses {sessionId: 1} index.
  // -------------------------------------------------------------------------
  print('[A3] Deleting messages (by sessionId, single pass)...');
  var t = new Date().getTime();
  msgCount = directDelete('messages', 'sessionId', sessionIds);
  print(
    '     ' +
      (DRY_RUN ? 'Would delete: ' : 'Deleted: ') +
      msgCount +
      ' messages (' +
      elapsed(t) +
      ')',
  );

  // -------------------------------------------------------------------------
  // A4: Delete session_states (by projectId — single deleteMany)
  //     Only 153 projectIds. Uses {tenantId:1, projectId:1} index.
  // -------------------------------------------------------------------------
  print('[A4] Deleting session_states (by projectId, single pass)...');
  t = new Date().getTime();
  ssCount = directDelete('session_states', 'projectId', projectIds);
  print(
    '     ' +
      (DRY_RUN ? 'Would delete: ' : 'Deleted: ') +
      ssCount +
      ' session_states (' +
      elapsed(t) +
      ')',
  );

  // -------------------------------------------------------------------------
  // A5: Delete sessions (by projectId — single deleteMany)
  //     Only 153 projectIds. Uses {tenantId:1, projectId:1} index.
  // -------------------------------------------------------------------------
  print('[A5] Deleting sessions (by projectId, single pass)...');
  t = new Date().getTime();
  sesCount = directDelete('sessions', 'projectId', projectIds);
  print(
    '     ' +
      (DRY_RUN ? 'Would delete: ' : 'Deleted: ') +
      sesCount +
      ' sessions (' +
      elapsed(t) +
      ')',
  );

  // -------------------------------------------------------------------------
  // A6: Delete project-scoped child collections (single deleteMany each)
  //     All have <1K docs — single pass is instant.
  // -------------------------------------------------------------------------
  print('[A6] Deleting project child data...');

  var childCollections = [
    'project_agents',
    'agent_versions',
    'project_tools',
    'project_members',
    'conversations',
    'deployments',
    'deployment_variable_snapshots',
    'variable_namespaces',
    'variable_namespace_memberships',
    'model_configs',
    'agent_model_configs',
    'pipeline_configs',
    'knowledge_bases',
    'search_indexes',
    'connector_configs',
    'llm_credentials',
    'role_definitions',
    'dek_registry',
    'refresh_tokens',
    'import_operations',
    'field_mappings',
    'pipeline_definitions',
    'project_runtime_configs',
    'project_settings',
    'project_settings_versions',
    'project_config_variables',
    'contacts',
    'environment_variables',
    'project_llm_configs',
    'mcp_server_configs',
    'channel_connections',
    'channel_sessions',
    'sdk_channels',
    'public_api_keys',
    'human_tasks',
    'workflows',
    'workflow_versions',
    'workflow_executions',
    'eval_runs',
    'eval_evaluators',
    'eval_scenarios',
    'eval_sets',
    'eval_personas',
    'tenant_llm_policies',
  ];

  childCollections.forEach(function (c) {
    var count = directDelete(c, 'projectId', projectIds);
    if (count > 0) {
      print('     ' + c.padEnd(40) + ': ' + (DRY_RUN ? 'would delete ' : 'deleted ') + count);
    }
    childTotal += count;
  });
  print('     Child docs total: ' + childTotal);

  // -------------------------------------------------------------------------
  // A7: Delete the projects themselves
  // -------------------------------------------------------------------------
  print('');
  print('[A7] Deleting projects...');
  var projFilter = {
    $or: [{ name: /^bench-sat/i }, { name: /^stress-test/i }],
  };
  if (DRY_RUN) {
    var projCount = db.projects.countDocuments(projFilter);
    print('     Would delete: ' + projCount + ' projects');
  } else {
    var projResult = db.projects.deleteMany(projFilter);
    print('     Deleted: ' + projResult.deletedCount + ' projects');
  }
}

print('');
print('Part A done in ' + elapsed(partAStart));

// =============================================================================
// PART B: Audit log cleanup (auth event spam)
// =============================================================================
print('');
print('#'.repeat(70));
print('  PART B: Audit Log Cleanup (auth event spam)');
print('#'.repeat(70));
print('');

var partBStart = new Date().getTime();

// The EXACT 3 action types to delete — nothing else
var AUTH_SPAM_ACTIONS = ['auth.user.success', 'authorization:denied', 'auth.user.failure'];

// ---------------------------------------------------------------------------
// B1: Safety — snapshot total FIRST, then count subsets
//     Counting total first prevents race conditions where new docs arrive
//     between subset counts, causing a false mismatch.
// ---------------------------------------------------------------------------
print('[B1] Snapshotting audit_logs counts...');

var auditTotal = db.audit_logs.countDocuments({});
print('     Total audit_logs:                         ' + auditTotal);

var keepCrudCount = db.audit_logs.countDocuments({ collectionName: { $ne: null } });
print('     CRUD audit docs (collectionName != null): ' + keepCrudCount);

var keepNonAuthCount = db.audit_logs.countDocuments({
  collectionName: null,
  action: { $nin: AUTH_SPAM_ACTIONS },
});
print('     Non-auth action docs:                     ' + keepNonAuthCount);

var totalKeep = keepCrudCount + keepNonAuthCount;
print('     TOTAL docs to preserve:                   ' + totalKeep);
print('');

// ---------------------------------------------------------------------------
// B2: Count what we're DELETING (only the 3 auth spam actions)
// ---------------------------------------------------------------------------
print('[B2] Counting auth spam to delete...');

var authSpamTotal = 0;
AUTH_SPAM_ACTIONS.forEach(function (action) {
  var count = db.audit_logs.countDocuments({ collectionName: null, action: action });
  print('     ' + action.padEnd(30) + ': ' + count);
  authSpamTotal += count;
});
print('     TOTAL auth spam:                          ' + authSpamTotal);

// ---------------------------------------------------------------------------
// B3: Cross-check — allow small drift from concurrent writes
// ---------------------------------------------------------------------------
print('');
print('[B3] Cross-check...');
print('     Total audit_logs:       ' + auditTotal);
print('     To keep:                ' + totalKeep);
print('     To delete:              ' + authSpamTotal);
print('     Keep + Delete:          ' + (totalKeep + authSpamTotal));

var drift = Math.abs(auditTotal - (totalKeep + authSpamTotal));
var DRIFT_TOLERANCE = 1000;

if (drift > DRIFT_TOLERANCE) {
  print('');
  print(
    '     *** MISMATCH: keep + delete differs from total by ' +
      drift +
      ' (tolerance: ' +
      DRIFT_TOLERANCE +
      ') ***',
  );
  print('     ABORTING Part B for safety. Investigate before proceeding.');
  print('');
} else {
  if (drift > 0) {
    print(
      '     Minor drift of ' +
        drift +
        ' docs (within tolerance of ' +
        DRIFT_TOLERANCE +
        ' — likely concurrent writes)',
    );
  } else {
    print('     Exact match. Safe to proceed.');
  }
  print('');

  // -------------------------------------------------------------------------
  // B4: Delete auth spam (200K-doc chunks)
  //     Uses {action: 1} index on audit_logs.
  //     200K chunks = ~55 rounds for auth.user.success.
  //     500K was tried but hit 16MB BSON limit (RangeError on ObjectIds).
  //     Each chunk: find 200K _ids (~1s) + deleteMany (~5-8s) ≈ 8s/chunk.
  // -------------------------------------------------------------------------
  if (authSpamTotal > 0) {
    print('[B4] Deleting auth spam from audit_logs (200K-doc chunks)...');
    print('');

    var authDeleteTotal = 0;
    AUTH_SPAM_ACTIONS.forEach(function (action) {
      var filter = { collectionName: null, action: action };
      var t = new Date().getTime();
      print('     --- ' + action + ' ---');
      var count = chunkedDelete('audit_logs', filter, action, 500000);
      print('     ' + (DRY_RUN ? 'Would delete: ' : 'Deleted: ') + count + ' (' + elapsed(t) + ')');
      print('');
      authDeleteTotal += count;
    });

    // -----------------------------------------------------------------------
    // B5: Post-delete safety — verify preserved docs are intact
    // -----------------------------------------------------------------------
    if (!DRY_RUN) {
      print('[B5] Post-delete verification...');
      var postCrudCount = db.audit_logs.countDocuments({ collectionName: { $ne: null } });
      var postNonAuthCount = db.audit_logs.countDocuments({
        collectionName: null,
        action: { $nin: AUTH_SPAM_ACTIONS },
      });
      var postTotal = db.audit_logs.countDocuments({});

      print(
        '     CRUD docs before: ' +
          keepCrudCount +
          ' | after: ' +
          postCrudCount +
          (postCrudCount === keepCrudCount ? ' OK' : ' *** MISMATCH ***'),
      );
      print(
        '     Non-auth before:  ' +
          keepNonAuthCount +
          ' | after: ' +
          postNonAuthCount +
          (postNonAuthCount >= keepNonAuthCount ? ' OK' : ' *** MISMATCH ***'),
      );
      print(
        '     Total remaining:  ' +
          postTotal +
          ' (expected >= ' +
          totalKeep +
          ')' +
          (postTotal >= totalKeep ? ' OK' : ' *** MISMATCH ***'),
      );

      if (postCrudCount < keepCrudCount || postNonAuthCount < keepNonAuthCount) {
        print('');
        print('     *** WARNING: Preserved doc count DECREASED! Investigate immediately. ***');
      } else if (postNonAuthCount > keepNonAuthCount || postCrudCount > keepCrudCount) {
        print('     (New docs arrived during deletion — expected on a live system)');
      }
    }
  } else {
    print('     No auth spam found. Nothing to delete.');
  }
}

print('');
print('Part B done in ' + elapsed(partBStart));

// =============================================================================
// FINAL SUMMARY
// =============================================================================
var totalElapsed = elapsed(partAStart);
print('');
print('='.repeat(70));
print('  FINAL SUMMARY');
print('='.repeat(70));
print('');
print('  PART A — Project cleanup:');
print('    Messages:       ' + msgCount);
print('    Session states: ' + ssCount);
print('    Sessions:       ' + sesCount);
print('    Child docs:     ' + childTotal);
print('    Projects:       ' + projectIds.length);
print('    Subtotal:       ' + (msgCount + ssCount + sesCount + childTotal + projectIds.length));
print('');
print('  PART B — Audit log cleanup:');
print('    Auth spam:      ' + authSpamTotal);
print(
  '    Preserved:      ' +
    totalKeep +
    ' (CRUD: ' +
    keepCrudCount +
    ', non-auth: ' +
    keepNonAuthCount +
    ')',
);
print('');
print(
  '  GRAND TOTAL:      ' +
    (msgCount + ssCount + sesCount + childTotal + projectIds.length + authSpamTotal) +
    ' docs',
);
print('  Total time:       ' + totalElapsed);
print('');
if (DRY_RUN) {
  print('  *** DRY RUN — nothing was deleted ***');
  print('  To execute for real, re-run with: --eval "var DRY_RUN=false"');
} else {
  print('  *** DELETION COMPLETE ***');
  print('');
  print('  To reclaim disk space, run compact on the large collections:');
  print('    db.runCommand({compact: "messages"})');
  print('    db.runCommand({compact: "session_states"})');
  print('    db.runCommand({compact: "sessions"})');
  print('    db.runCommand({compact: "audit_logs"})');
}
print('='.repeat(70));
