import { API_PATHS, ApiError, type StatusData, request } from '@lark/shared';
import { useEffect, useState } from 'react';

type Probe =
  | { state: 'probing' }
  | { state: 'online'; data: StatusData }
  | { state: 'offline'; reason: string };

async function probeDaemon(): Promise<Probe> {
  try {
    const envelope = await request<StatusData>('GET', API_PATHS.status);
    if (!envelope.data) return { state: 'offline', reason: 'daemon responded without status data' };
    return { state: 'online', data: envelope.data };
  } catch (err) {
    return {
      state: 'offline',
      reason: err instanceof ApiError ? err.message : 'no response from daemon',
    };
  }
}

export function App(): React.JSX.Element {
  const [probe, setProbe] = useState<Probe>({ state: 'probing' });

  // Syncing with an external system (the daemon) — the one thing useEffect is for.
  useEffect(() => {
    let cancelled = false;
    const run = async (): Promise<void> => {
      const result = await probeDaemon();
      if (!cancelled) setProbe(result);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="shell">
      <h1>lark</h1>
      <p className="hint">M0 骨架 — daemon 垂直链路自检</p>
      {probe.state === 'probing' && <p className="status probing">正在探测 daemon…</p>}
      {probe.state === 'online' && (
        <p className="status online">
          daemon 在线 · pid {probe.data.pid} · v{probe.data.version} · uptime{' '}
          {Math.round(probe.data.uptime)}s
        </p>
      )}
      {probe.state === 'offline' && (
        <p className="status offline">
          daemon 离线（{probe.reason}）—— 先跑 <code>just dev-daemon</code>
        </p>
      )}
    </main>
  );
}
