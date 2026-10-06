'use strict';

async function drainRuntime({ server, beginDrain, stopNewEntries, stopHealthServices, finishHandoff, timeoutMs = 25_000, logger = console, signal = 'manual' } = {}) {
  beginDrain?.();
  const execution = await stopNewEntries?.() || {};
  stopHealthServices?.();
  logger.warn(JSON.stringify({ type: 'shutdown_started', signal, at: new Date().toISOString(), ...execution }));
  if (!server) return { drained: true, ...execution };
  let deadline;
  const startedAt = Date.now();
  const closed = new Promise(resolve => server.close(error => resolve(!error)));
  const timedOut = new Promise(resolve => { deadline = setTimeout(() => resolve(false), Math.max(1, timeoutMs)); });
  const httpDrained = await Promise.race([closed, timedOut]);
  clearTimeout(deadline);
  // server.close only means inbound HTTP connections ended. Position monitors
  // are process-local timers, so keep them alive for the configured window.
  // Durable execution leases are deliberately not released here: a replacement
  // can acquire only after expiry, which fences overlapping processes.
  const elapsed = Date.now() - startedAt;
  const hasManagedPositions = Number(execution.positionsStillManaged || 0) > 0;
  let handoffReady = !hasManagedPositions;
  if (hasManagedPositions) {
    const remaining = Math.max(0, timeoutMs - elapsed);
    await new Promise(resolve => { deadline = setTimeout(resolve, remaining); });
    clearTimeout(deadline);
    handoffReady = false;
  }
  if (httpDrained && finishHandoff) {
    try {
      const result = await finishHandoff();
      handoffReady = result?.handedOff !== false;
    } catch (error) {
      logger.error?.(`[Shutdown] Ownership handoff failed: ${require('./productionHardening').redact(error.message)}`);
      handoffReady = false;
    }
  }
  const drained = httpDrained && handoffReady;
  logger.warn(JSON.stringify({ type: 'shutdown_drained', signal, drained, ...execution, at: new Date().toISOString() }));
  return { drained, handoffReady, ...execution };
}

module.exports = { drainRuntime };
