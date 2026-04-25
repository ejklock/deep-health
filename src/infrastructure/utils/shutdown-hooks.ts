import { logger } from './logger';

type ShutdownHook = () => Promise<void> | void;

const hooks = new Set<ShutdownHook>();
let handlersInstalled = false;
let shuttingDown = false;

/** Per-hook timeout: a stuck hook (e.g. hanging docker stop) must not block exit. */
const HOOK_TIMEOUT_MS = 7_000;

/**
 * Register a cleanup callback that runs when the process receives SIGINT/SIGTERM,
 * when an uncaught exception / unhandled rejection fires.
 *
 * Hooks run sequentially in registration order. Each hook has a hard timeout
 * (HOOK_TIMEOUT_MS); a hook that exceeds it is abandoned so one bad hook can't
 * trap the process. Hook errors are logged, never re-thrown.
 *
 * Returns an unregister function — call it from your resource's normal teardown
 * path so the hook doesn't fire again at process exit.
 *
 * NOTE: this registry is the reason long-lived Docker containers (e.g. SonarQube)
 * still get cleaned up when the user hits Ctrl+C. JavaScript `finally` blocks do
 * NOT run on abrupt signal termination — without this registry, containers leak.
 */
export function registerShutdownHook(hook: ShutdownHook): () => void {
  hooks.add(hook);
  ensureHandlersInstalled();
  return () => {
    hooks.delete(hook);
  };
}

/** Expose for tests: number of currently registered hooks. */
export function _activeHookCount(): number {
  return hooks.size;
}

/** Expose for tests: reset state between cases. */
export function _resetShutdownHooks(): void {
  hooks.clear();
  shuttingDown = false;
  // handlersInstalled intentionally NOT reset — Node process.on handlers remain;
  // a fresh run still iterates the (now-empty) hooks set safely.
}

/** Expose for tests: run all registered hooks sequentially (without process.exit). */
export async function _runAllHooksForTests(): Promise<void> {
  const snapshot = Array.from(hooks);
  for (const hook of snapshot) {
    await hook();
  }
}

function ensureHandlersInstalled(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;

  process.on('SIGINT', () => {
    logger.warn('Received SIGINT — running shutdown hooks before exit...');
    void runAllHooks(130);
  });
  process.on('SIGTERM', () => {
    logger.warn('Received SIGTERM — running shutdown hooks before exit...');
    void runAllHooks(143);
  });
  process.on('uncaughtException', (err) => {
    logger.error(`Uncaught exception — running shutdown hooks before exit: ${err.message}`);
    if (err.stack) logger.debug(err.stack);
    void runAllHooks(1);
  });
  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    logger.error(`Unhandled rejection — running shutdown hooks before exit: ${msg}`);
    void runAllHooks(1);
  });
}

async function runAllHooks(exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  // Snapshot so hook callbacks that unregister themselves don't mutate
  // the Set mid-iteration.
  const snapshot = Array.from(hooks);
  hooks.clear();

  for (const hook of snapshot) {
    try {
      await Promise.race([
        Promise.resolve().then(() => hook()),
        new Promise<void>((resolve) => setTimeout(() => {
          logger.warn(`Shutdown hook timed out after ${HOOK_TIMEOUT_MS}ms — abandoning`);
          resolve();
        }, HOOK_TIMEOUT_MS)),
      ]);
    } catch (err) {
      logger.warn(`Shutdown hook failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  process.exit(exitCode);
}
