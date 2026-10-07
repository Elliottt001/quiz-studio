export async function api(path, { method = "GET", body, timeout = 12000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(path, {
      method,
      credentials: "same-origin",
      signal: controller.signal,
      headers: body === undefined ? {} : {
        "content-type": "application/json",
        "x-xlab-action": "1"
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(data.error ?? `请求失败 (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return data;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("连接超时，操作尚未确认");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export const teamNames = {
  software: "软件团队", hardware: "硬件团队",
  operations: "运营团队", design: "设计团队"
};

export function remainingLabel(milliseconds) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
