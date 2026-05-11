/**
 * Canonical Result<T, E> discriminated union.
 *
 * The discriminant field is `ok` (boolean), matching the existing FixResult shape
 * so that FixResult<T> can be unified as a simple type alias.
 */
export type Result<T, E> = Ok<T> | Err<E>;

/** The success variant of Result<T, E>. */
export type Ok<T> = { ok: true; value: T };

/** The failure variant of Result<T, E>. */
export type Err<E> = { ok: false; error: E };

// ─── Constructors ─────────────────────────────────────────────────────────────

/**
 * Construct a success variant.
 *
 * @example
 * const r: Result<number, string> = ok(42);
 */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/**
 * Construct a failure variant.
 *
 * @example
 * const r: Result<never, string> = err('something went wrong');
 */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

// ─── Type Guards ──────────────────────────────────────────────────────────────

/**
 * Narrows `result` to the `Ok<T>` variant.
 */
export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok === true;
}

/**
 * Narrows `result` to the `Err<E>` variant.
 */
export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return result.ok === false;
}

// ─── Transformers ─────────────────────────────────────────────────────────────

/**
 * Transforms the value inside an `Ok` variant; passes `Err` through unchanged.
 *
 * @example
 * const doubled = map(ok(21), (n) => n * 2); // Ok { value: 42 }
 * const same    = map(err('oops'), (n) => n * 2); // Err { error: 'oops' }
 */
export function map<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  if (isOk(result)) {
    return ok(fn(result.value));
  }
  return result;
}

/**
 * Monadic bind: applies `fn` to the value inside an `Ok` variant, returning the
 * inner `Result<U, F>`. Passes `Err` through unchanged.
 *
 * Useful for chaining fallible operations without nesting.
 *
 * @example
 * const r = flatMap(ok(21), (n) => (n > 0 ? ok(n * 2) : err('negative')));
 */
export function flatMap<T, U, E, F>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, F>,
): Result<U, E | F> {
  if (isOk(result)) {
    return fn(result.value);
  }
  return result;
}

// ─── Pattern Matching ─────────────────────────────────────────────────────────

/**
 * Exhaustive pattern-match over a `Result`. Both branches must return the same
 * type `R`, eliminating the need for manual `if (r.ok)` checks.
 *
 * @example
 * const label = match(result, {
 *   ok:  (v) => `success: ${v}`,
 *   err: (e) => `failure: ${e}`,
 * });
 */
export function match<T, E, R>(
  result: Result<T, E>,
  handlers: { ok: (value: T) => R; err: (error: E) => R },
): R {
  if (isOk(result)) {
    return handlers.ok(result.value);
  }
  return handlers.err(result.error);
}

// ─── Async Adapters ───────────────────────────────────────────────────────────

/**
 * Wraps a `Promise<T>` so that:
 * - a resolved value becomes `Ok<T>`
 * - a rejection is mapped to `Err<E>` via `mapError`
 *
 * @example
 * const r = await fromPromise(fetch('/api'), (e) => `network error: ${e}`);
 */
export async function fromPromise<T, E>(
  promise: Promise<T>,
  mapError: (err: unknown) => E,
): Promise<Result<T, E>> {
  try {
    const value = await promise;
    return ok(value);
  } catch (caught) {
    return err(mapError(caught));
  }
}

/**
 * Wraps a synchronous function so that:
 * - a returned value becomes `Ok<T>`
 * - a thrown exception is mapped to `Err<E>` via `mapError`
 *
 * @example
 * const r = tryCatch(() => JSON.parse(text), (e) => `parse error: ${e}`);
 */
export function tryCatch<T, E>(fn: () => T, mapError: (err: unknown) => E): Result<T, E> {
  try {
    return ok(fn());
  } catch (caught) {
    return err(mapError(caught));
  }
}

// ─── Unwrappers ───────────────────────────────────────────────────────────────

/**
 * Returns the value inside `Ok`; throws the error value if the result is `Err`.
 *
 * Use only when you are certain the result is `Ok`, or when throwing on failure
 * is the intended behaviour.
 */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (isOk(result)) {
    return result.value;
  }
  throw result.error;
}

/**
 * Returns the value inside `Ok`; returns `fallback` if the result is `Err`.
 *
 * @example
 * const n = unwrapOr(err('oops'), 0); // 0
 */
export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  if (isOk(result)) {
    return result.value;
  }
  return fallback;
}
