export function submitButtonState(remainingMs, pendingKey, inFlight) {
  if (inFlight) return { disabled: true, label: "正在确认交卷" };
  if (remainingMs <= 0) {
    return pendingKey
      ? { disabled: false, label: "重试确认交卷" }
      : { disabled: true, label: "本轮已截止" };
  }
  return { disabled: false, label: pendingKey ? "重试确认交卷" : "提交本轮答卷 ↗" };
}

export function restoredAnswers(draft, submission) {
  if (draft && (!submission || draft.savedAt > submission.submittedAt)) {
    return { answers: { ...draft.answers }, hasUnsubmittedChanges: !!submission };
  }
  return {
    answers: { ...(submission?.answers ?? {}) },
    hasUnsubmittedChanges: false
  };
}
