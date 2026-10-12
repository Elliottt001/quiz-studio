export function httpError(status, message, details = {}) {
  return Object.assign(new Error(message), { status, details });
}
