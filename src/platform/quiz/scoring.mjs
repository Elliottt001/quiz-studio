export { scoreAnswer } from "./rules.mjs";

export function scoreChoice(question, answer) {
  return answer === question.correct_option ? question.points : 0;
}
