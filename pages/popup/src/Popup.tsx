import { useEffect, useState, useCallback } from 'react';
import type { PollStatusPayload, PlatformCode } from '@extension/shared';

// ─── Popup: Litoral Agency Extension Status ──────────────

const formatRelativeTime = (ms: number | null): string => {
  if (!ms) return 'Never';
  const seconds = Math.floor((Date.now() - ms) / 1000);
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  return `${Math.floor(seconds / 3600)} hr ago`;
};

const formatNextPoll = (lastPollTime: number | null): string => {
  if (!lastPollTime) return 'Waiting...';
  const elapsed = Math.floor((Date.now() - lastPollTime) / 1000);
  const remaining = 20 * 60 - elapsed;
  if (remaining <= 0) return 'Any moment...';
  return `${Math.floor(remaining / 60)} min`;
};

/** Status → emoji icon for the per-platform row. */
const STATUS_ICON: Record<'ok' | 'error' | 'idle' | 'breaker_open', string> = {
  ok: '✅',
  error: '⚠️',
  idle: '•',
  breaker_open: '🔴',
};

interface PlatformRow {
  code: PlatformCode;
  name: string;
  status: 'ok' | 'error' | 'idle' | 'breaker_open';
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastErrorReason: string | null;
  consecutiveFailures: number;
}

const PlatformEntry = ({
  entry,
  expanded,
  onToggle,
}: {
  entry: PlatformRow;
  expanded: boolean;
  onToggle: (code: PlatformCode) => void;
}) => {
  const hasFailure = entry.lastFailureAt != null && entry.lastErrorReason != null;
  return (
    <div className="border-b border-[#f1f1f3] last:border-b-0">
      <button
        type="button"
        onClick={() => onToggle(entry.code)}
        className="flex w-full items-center justify-between px-1 py-2 text-left hover:bg-[#f9f9fb]">
        <span className="flex items-center gap-2 text-[13px] font-medium">
          <span aria-hidden="true">{STATUS_ICON[entry.status]}</span>
          {entry.name}
        </span>
        <span className="flex flex-col items-end text-[12px] text-[#717786]">
          <span>✓ {formatRelativeTime(entry.lastSuccessAt)}</span>
          {hasFailure && <span>✗ {formatRelativeTime(entry.lastFailureAt)}</span>}
        </span>
      </button>
      {expanded && hasFailure && <p className="px-1 pb-2 pl-7 text-[12px] text-[#ba1a1a]">{entry.lastErrorReason}</p>}
    </div>
  );
};

export default function Popup() {
  const [status, setStatus] = useState<PollStatusPayload | null>(null);
  const [token, setToken] = useState('');
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  /** Code of the platform whose lastErrorReason is currently expanded. */
  const [expandedPlatform, setExpandedPlatform] = useState<PlatformCode | null>(null);

  // Fetch state from service worker on mount
  const fetchState = useCallback(() => {
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, response => {
      if (chrome.runtime.lastError) {
        // Service worker not available (e.g., extension reloaded)
        return;
      }
      if (response && response.type === 'POLL_STATUS') {
        setStatus(response.data);
      }
    });
  }, []);

  useEffect(() => {
    fetchState();
    const interval = setInterval(fetchState, 5000);
    return () => clearInterval(interval);
  }, [fetchState]);

  // Handle connect button
  const handleConnect = async () => {
    if (!token.trim()) {
      setConnectError('Please enter a token');
      return;
    }
    setConnecting(true);
    setConnectError(null);
    chrome.runtime.sendMessage({ type: 'CONNECT', token: token.trim() }, response => {
      setConnecting(false);
      if (response?.success) {
        setToken('');
        fetchState();
      } else {
        setConnectError('Connection failed. Check your token.');
      }
    });
  };

  // Handle Retry Now — fires an immediate poll off the default cadence.
  const handleRetryNow = () => {
    chrome.runtime.sendMessage({ type: 'RETRY_NOW' }, response => {
      if (response?.success) fetchState();
    });
  };

  // Handle Clear Errors — clears telemetry, poll backoff, and breaker state.
  const handleClearErrors = () => {
    chrome.runtime.sendMessage({ type: 'CLEAR_ERRORS' }, response => {
      if (response?.success) {
        setExpandedPlatform(null);
        fetchState();
      }
    });
  };

  // Toggle the expandable error-reason view for a platform row.
  const togglePlatform = (code: PlatformCode) => {
    setExpandedPlatform(prev => (prev === code ? null : code));
  };

  // Determine connection status
  const isAuthenticated = status?.isAuthenticated ?? false;
  const isOffline = status && status.consecutiveFailures >= 6;
  const connectionLabel = !isAuthenticated ? '🔑 Needs Auth' : isOffline ? '🔴 Offline' : '🟢 Online';
  const connectionColor = !isAuthenticated ? '#9e3d00' : isOffline ? '#ba1a1a' : '#16a34a';

  return (
    <div className="w-[360px] bg-[#f5f5f7] font-[Inter] text-[#1a1b1f]">
      {/* Header */}
      <div className="border-b border-[#e5e5e7] px-4 py-3">
        <h1 className="text-[17px] font-semibold tracking-[-0.01em]">Litoral Agency</h1>
        <p className="text-[13px] text-[#717786]">Social Publishing Engine</p>
      </div>

      {/* Auth Prompt (if not connected) */}
      {!isAuthenticated && (
        <div className="mx-4 mt-4 rounded-xl border border-[#e5e5e7] bg-white p-4 shadow-[0px_4px_12px_rgba(0,0,0,0.05)]">
          <h2 className="mb-2 text-[15px] font-semibold">Connect to Litoral</h2>
          <p className="mb-3 text-[13px] text-[#717786]">
            Paste your extension token from the dashboard Settings page to start publishing.
          </p>
          <input
            type="password"
            value={token}
            onChange={e => setToken(e.target.value)}
            placeholder="Paste token here..."
            className="mb-2 w-full rounded-lg border border-[#d1d1d6] px-3 py-2 text-[15px] focus:border-[#0070eb] focus:outline-none"
            // autoFocus removed for a11y
          />
          {connectError && <p className="mb-2 text-[13px] text-[#ba1a1a]">{connectError}</p>}
          <button
            onClick={handleConnect}
            disabled={connecting}
            className="w-full rounded-xl bg-[#0058bc] px-4 py-2.5 text-[15px] font-semibold text-white hover:bg-[#0070eb] disabled:opacity-50">
            {connecting ? 'Connecting...' : 'Connect'}
          </button>
        </div>
      )}

      {/* Status Card */}
      {status && (
        <div className="m-4 rounded-xl border border-[#e5e5e7] bg-white p-4 shadow-[0px_4px_12px_rgba(0,0,0,0.05)]">
          {/* Connection row */}
          <div className="mb-3 flex items-center justify-between">
            <span className="text-[13px] text-[#717786]">Status</span>
            <span className="text-[13px] font-semibold" style={{ color: connectionColor }}>
              {connectionLabel}
            </span>
          </div>

          {/* Pending campaigns */}
          <div className="mb-3 flex items-center justify-between">
            <span className="text-[13px] text-[#717786]">Pending</span>
            <span className="text-[13px] font-semibold">
              {status.pendingCount} campaign{status.pendingCount !== 1 ? 's' : ''}
            </span>
          </div>

          {/* Last poll */}
          <div className="mb-3 flex items-center justify-between">
            <span className="text-[13px] text-[#717786]">Last checked</span>
            <span className="text-[13px]">{formatRelativeTime(status.lastPollTime)}</span>
          </div>

          {/* Next poll */}
          <div className="flex items-center justify-between">
            <span className="text-[13px] text-[#717786]">Next check</span>
            <span className="text-[13px]">{formatNextPoll(status.lastPollTime)}</span>
          </div>

          {/* Backoff indicator (only rendered when actively in backoff) */}
          {status.pollBackoffMinutes !== null && (
            <div className="mb-3 text-[12px] text-[#717786]">
              Next check in {status.pollBackoffMinutes} min (backoff)
            </div>
          )}
        </div>
      )}

      {/* Platforms Card */}
      {status && (
        <div className="mx-4 mb-4 rounded-xl border border-[#e5e5e7] bg-white p-4 shadow-[0px_4px_12px_rgba(0,0,0,0.05)]">
          <h3 className="mb-3 text-[13px] font-semibold">Platforms</h3>
          <div className="mb-3">
            {status.platforms.map(entry => (
              <PlatformEntry
                key={entry.code}
                entry={entry}
                expanded={expandedPlatform === entry.code}
                onToggle={togglePlatform}
              />
            ))}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleRetryNow}
              className="rounded-lg bg-[#0058bc] px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-[#0070eb]">
              Retry Now
            </button>
            <button
              type="button"
              onClick={handleClearErrors}
              className="rounded-lg border border-[#e5e5e7] px-3 py-1.5 text-[13px] font-semibold text-[#1a1b1f] hover:bg-[#f1f1f3]">
              Clear Errors
            </button>
          </div>
        </div>
      )}

      {/* Error card */}
      {status?.lastPollError && status.consecutiveFailures > 0 && (
        <div className="mx-4 mb-4 rounded-xl border border-[#e5e5e7] bg-white p-4 shadow-[0px_4px_12px_rgba(0,0,0,0.05)]">
          <h3 className="mb-1 text-[13px] font-semibold text-[#ba1a1a]">Last Error</h3>
          <p className="text-[13px] text-[#717786]">{status.lastPollError}</p>
          <p className="mt-1 text-[12px] text-[#717786]">
            {status.consecutiveFailures} consecutive failure{status.consecutiveFailures !== 1 ? 's' : ''}
            {status.consecutiveFailures >= 6 ? ' — notification sent' : ''}
          </p>
        </div>
      )}

      {/* Footer */}
      <div className="border-t border-[#e5e5e7] px-4 py-2 text-center">
        <p className="text-[11px] text-[#717786]">Polls every 20 min • v1.0.0</p>
      </div>
    </div>
  );
}
