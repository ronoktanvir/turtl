export const UNREACHABLE_AFTER_MS = 8000;

type Connection = {
  connectionState(): { isWebSocketConnected: boolean };
  subscribeToConnectionState(listener: () => void): () => void;
};

export function watchReachability(
  client: Connection,
  onChange: (reachable: boolean) => void,
  { delayMs = UNREACHABLE_AFTER_MS, now = Date.now }: { delayMs?: number; now?: () => number } = {},
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let down = false;
  const wait = () => {
    const started = now();
    timer = setTimeout(() => {
      timer = undefined;
      if (client.connectionState().isWebSocketConnected) return;
      if (now() - started > delayMs * 1.5) return wait();
      down = true;
      onChange(false);
    }, delayMs);
  };
  const check = () => {
    if (!client.connectionState().isWebSocketConnected) {
      if (timer === undefined && !down) wait();
      return;
    }
    clearTimeout(timer);
    timer = undefined;
    if (down) onChange(true);
    down = false;
  };
  const unsubscribe = client.subscribeToConnectionState(check);
  check();
  return () => {
    clearTimeout(timer);
    unsubscribe();
  };
}
