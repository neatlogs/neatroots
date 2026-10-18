/** A model-backed completion receipt, rather than merely an idle queue. */
export function modelChecksComplete(coverage) {
  return coverage?.state === "done" && coverage.model?.available === true
    && Number.isInteger(coverage.questions) && coverage.questions > 0
    && coverage.answered >= coverage.questions && coverage.pending === 0 && coverage.failed === 0;
}
