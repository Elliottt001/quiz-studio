export async function runAdminAction(operation, successMessage, notify, refresh) {
  try {
    const detail = await operation();
    notify(typeof detail === "string" && detail ? detail : successMessage);
    await refresh();
    return true;
  } catch (error) {
    notify(error.message, true);
    return false;
  }
}
