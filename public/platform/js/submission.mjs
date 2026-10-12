const prefix = (gameId, playerId, roundId) => `quiz:${gameId}:${playerId}:${roundId}`;

export function draftStorageKey(gameId, playerId, roundId) {
  return `${prefix(gameId, playerId, roundId)}:draft`;
}

export function pendingStorageKey(gameId, playerId, roundId) {
  return `${prefix(gameId, playerId, roundId)}:pending`;
}

export function createPendingSubmission({ gameId, playerId, roundId, answers }, storage) {
  const key = pendingStorageKey(gameId, playerId, roundId);
  let prior;
  try { prior = JSON.parse(storage.getItem(key)); } catch {}
  if (prior && JSON.stringify(prior.answers) === JSON.stringify(answers)) return prior;
  const pending = { requestKey: crypto.randomUUID(), answers: structuredClone(answers) };
  storage.setItem(key, JSON.stringify(pending));
  return pending;
}

export function clearPendingSubmission(storage, gameId, playerId, roundId) {
  storage.removeItem(pendingStorageKey(gameId, playerId, roundId));
}

export function clearPlayerStorage(storage, gameId, playerId) {
  const pattern = `quiz:${gameId}:${playerId}:`;
  for (let index = storage.length - 1; index >= 0; index--) {
    const key = storage.key(index);
    if (key.startsWith(pattern)) storage.removeItem(key);
  }
}
