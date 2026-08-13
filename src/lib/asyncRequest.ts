import { useCallback, useRef } from 'react';

export class LatestRequestGate {
  private sequence = 0;

  begin() {
    this.sequence += 1;
    return this.sequence;
  }

  isLatest(requestId: number) {
    return this.sequence === requestId;
  }

  cancel() {
    this.sequence += 1;
  }
}

/**
 * Creates monotonically increasing request ids. A response may update the UI
 * only while its id is still the most recent one issued by the component.
 */
export function useLatestRequest() {
  const gate = useRef(new LatestRequestGate());

  const begin = useCallback(() => gate.current.begin(), []);

  const isLatest = useCallback((requestId: number) => gate.current.isLatest(requestId), []);
  const cancel = useCallback(() => gate.current.cancel(), []);

  return { begin, isLatest, cancel };
}
