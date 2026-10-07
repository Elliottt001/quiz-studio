export function shortPlayerId(id) {
  return String(id ?? "").slice(0, 8).toUpperCase();
}

export function displayedBallId(ballId) {
  const separator = ballId.lastIndexOf(":");
  return `${shortPlayerId(ballId.slice(0, separator))} / ${ballId.slice(separator + 1)}`;
}
