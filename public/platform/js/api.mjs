export async function api(path, { method = "GET", body, timeoutMs = 12_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, {
      method, credentials: "same-origin", signal: controller.signal,
      headers: body === undefined ? {} : {
        "content-type": "application/json", "x-quiz-action": "1"
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const payload = await response.json();
    if (!response.ok) {
      const error = new Error(payload.error ?? `请求失败 (${response.status})`);
      error.status = response.status;
      error.path = payload.path;
      error.currentVersion = payload.currentVersion;
      throw error;
    }
    return payload;
  } catch (error) {
    if (error.name === "AbortError") {
      const timeout = new Error("连接超时，操作未确认");
      timeout.status = 0;
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
