import { describe, it, expect } from 'vitest';
import {
  ok,
  err,
  isOk,
  isErr,
  map,
  flatMap,
  match,
  fromPromise,
  tryCatch,
  unwrap,
  unwrapOr,
} from '@core/types/result';
import type { Result, Ok, Err } from '@core/types/result';

// ─── ok / err constructors ────────────────────────────────────────────────────

describe('ok constructor', () => {
  it('creates an Ok variant with ok: true', () => {
    const r = ok(42);
    expect(r.ok).toBe(true);
  });

  it('stores the value on the Ok variant', () => {
    const r = ok('hello');
    if (r.ok) {
      expect(r.value).toBe('hello');
    }
  });

  it('accepts any value type including null and undefined', () => {
    expect(ok(null).ok).toBe(true);
    expect(ok(undefined).ok).toBe(true);
    expect(ok(0).ok).toBe(true);
    expect(ok(false).ok).toBe(true);
  });

  it('accepts object values', () => {
    const obj = { id: 1 };
    const r = ok(obj);
    if (r.ok) {
      expect(r.value).toBe(obj);
    }
  });
});

describe('err constructor', () => {
  it('creates an Err variant with ok: false', () => {
    const r = err('something failed');
    expect(r.ok).toBe(false);
  });

  it('stores the error on the Err variant', () => {
    const r = err('oops');
    if (!r.ok) {
      expect(r.error).toBe('oops');
    }
  });

  it('accepts any error type including objects', () => {
    const e = { code: 404, message: 'not found' };
    const r = err(e);
    if (!r.ok) {
      expect(r.error).toBe(e);
    }
  });

  it('accepts null and 0 as error values', () => {
    expect(err(null).ok).toBe(false);
    expect(err(0).ok).toBe(false);
  });
});

// ─── Result type narrowing ────────────────────────────────────────────────────

describe('Result type narrowing', () => {
  it('Ok variant narrows correctly', () => {
    const r: Result<number, string> = ok(10);
    if (r.ok) {
      // TypeScript narrows r to Ok<number> here
      const v: number = r.value;
      expect(v).toBe(10);
    }
  });

  it('Err variant narrows correctly', () => {
    const r: Result<number, string> = err('bad');
    if (!r.ok) {
      // TypeScript narrows r to Err<string> here
      const e: string = r.error;
      expect(e).toBe('bad');
    }
  });

  it('Ok<T> type alias is assignable to Result<T, never>', () => {
    const o: Ok<string> = ok('hi');
    const r: Result<string, never> = o;
    expect(r.ok).toBe(true);
  });

  it('Err<E> type alias is assignable to Result<never, E>', () => {
    const e: Err<number> = err(42);
    const r: Result<never, number> = e;
    expect(r.ok).toBe(false);
  });
});

// ─── isOk / isErr type guards ─────────────────────────────────────────────────

describe('isOk type guard', () => {
  it('returns true for an ok result', () => {
    expect(isOk(ok('value'))).toBe(true);
  });

  it('returns false for an err result', () => {
    expect(isOk(err('error'))).toBe(false);
  });

  it('narrows the result inside an if block', () => {
    const r: Result<number, string> = ok(99);
    if (isOk(r)) {
      expect(r.value).toBe(99);
    } else {
      throw new Error('should not reach err branch');
    }
  });
});

describe('isErr type guard', () => {
  it('returns true for an err result', () => {
    expect(isErr(err('oops'))).toBe(true);
  });

  it('returns false for an ok result', () => {
    expect(isErr(ok(1))).toBe(false);
  });

  it('narrows the result inside an if block', () => {
    const r: Result<number, string> = err('bad input');
    if (isErr(r)) {
      expect(r.error).toBe('bad input');
    } else {
      throw new Error('should not reach ok branch');
    }
  });
});

// ─── map ──────────────────────────────────────────────────────────────────────

describe('map', () => {
  it('transforms the value inside an Ok', () => {
    const r = map(ok(21), (n) => n * 2);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value).toBe(42);
  });

  it('passes the Err through unchanged without calling fn', () => {
    const fn = (n: number) => n * 2;
    const r: Result<number, string> = err('fail');
    const mapped = map(r, fn);
    expect(isErr(mapped)).toBe(true);
    if (isErr(mapped)) expect(mapped.error).toBe('fail');
  });

  it('transforms string to number', () => {
    const r = map(ok('42'), Number);
    if (isOk(r)) expect(r.value).toBe(42);
  });

  it('passes an Err with any error type through unchanged', () => {
    const e = { code: 500 };
    const r = map(err(e), (x: number) => x + 1);
    if (isErr(r)) expect(r.error).toBe(e);
  });
});

// ─── flatMap ──────────────────────────────────────────────────────────────────

describe('flatMap', () => {
  it('applies fn to value when Ok and returns the inner result', () => {
    const r = flatMap(ok(10), (n) => ok(n * 3));
    if (isOk(r)) expect(r.value).toBe(30);
  });

  it('passes Err through without calling fn', () => {
    const r: Result<number, string> = err('upstream failure');
    const result = flatMap(r, (n) => ok(n + 1));
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error).toBe('upstream failure');
  });

  it('chains multiple fallible operations', () => {
    const parseNumber = (s: string): Result<number, string> =>
      isNaN(Number(s)) ? err(`"${s}" is not a number`) : ok(Number(s));
    const double = (n: number): Result<number, string> =>
      n < 0 ? err('negative value') : ok(n * 2);

    expect(isOk(flatMap(parseNumber('21'), double))).toBe(true);
    expect(isErr(flatMap(parseNumber('abc'), double))).toBe(true);
    expect(isErr(flatMap(parseNumber('-5'), double))).toBe(true);
  });

  it('returns the inner Err when fn returns an Err', () => {
    const r = flatMap(ok('bad'), (_s) => err('inner error'));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error).toBe('inner error');
  });
});

// ─── match ────────────────────────────────────────────────────────────────────

describe('match', () => {
  it('calls the ok handler for an Ok result', () => {
    const label = match(ok(42), {
      ok: (v) => `success: ${v}`,
      err: (_e) => 'failure',
    });
    expect(label).toBe('success: 42');
  });

  it('calls the err handler for an Err result', () => {
    const label = match(err('bad'), {
      ok: (_v) => 'success',
      err: (e) => `failure: ${e}`,
    });
    expect(label).toBe('failure: bad');
  });

  it('returns the same type from both branches', () => {
    const result: Result<number, string> = ok(1);
    const n: number = match(result, {
      ok: (v) => v + 10,
      err: (_e) => -1,
    });
    expect(n).toBe(11);
  });

  it('dispatches exhaustively — no branch is skipped for err', () => {
    const calls: string[] = [];
    match(err('x'), {
      ok: () => { calls.push('ok'); },
      err: () => { calls.push('err'); },
    });
    expect(calls).toEqual(['err']);
  });

  it('dispatches exhaustively — no branch is skipped for ok', () => {
    const calls: string[] = [];
    match(ok(1), {
      ok: () => { calls.push('ok'); },
      err: () => { calls.push('err'); },
    });
    expect(calls).toEqual(['ok']);
  });
});

// ─── fromPromise ──────────────────────────────────────────────────────────────

describe('fromPromise', () => {
  it('returns Ok with the resolved value', async () => {
    const r = await fromPromise(Promise.resolve(99), String);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value).toBe(99);
  });

  it('returns Err mapped via mapError when the promise rejects', async () => {
    const r = await fromPromise(
      Promise.reject(new Error('network timeout')),
      (e) => `caught: ${(e as Error).message}`,
    );
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error).toBe('caught: network timeout');
  });

  it('mapError receives the raw rejection value (non-Error)', async () => {
    const r = await fromPromise(Promise.reject('raw string'), (e) => e as string);
    if (isErr(r)) expect(r.error).toBe('raw string');
  });

  it('does not throw even if the promise rejects', async () => {
    await expect(
      fromPromise(Promise.reject(new Error('boom')), () => 'handled'),
    ).resolves.not.toThrow();
  });
});

// ─── tryCatch ─────────────────────────────────────────────────────────────────

describe('tryCatch', () => {
  it('returns Ok when fn succeeds', () => {
    const r = tryCatch(() => JSON.parse('{"x":1}'), String);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value).toEqual({ x: 1 });
  });

  it('returns Err mapped via mapError when fn throws', () => {
    const r = tryCatch(
      () => JSON.parse('not json'),
      (e) => `parse error: ${(e as Error).message}`,
    );
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error).toContain('parse error');
  });

  it('mapError receives the thrown value (non-Error)', () => {
    const r = tryCatch(
      () => { throw 'string thrown'; },
      (e) => e as string,
    );
    if (isErr(r)) expect(r.error).toBe('string thrown');
  });

  it('does not propagate the exception to the caller', () => {
    expect(() => tryCatch(() => { throw new Error('kaboom'); }, () => 'safe')).not.toThrow();
  });
});

// ─── unwrap ───────────────────────────────────────────────────────────────────

describe('unwrap', () => {
  it('returns the value when result is Ok', () => {
    expect(unwrap(ok('data'))).toBe('data');
  });

  it('throws the error value when result is Err (string error)', () => {
    expect(() => unwrap(err('fatal error'))).toThrow('fatal error');
  });

  it('throws the error value when result is Err (Error object)', () => {
    const e = new Error('domain failure');
    expect(() => unwrap(err(e))).toThrow(e);
  });

  it('does not throw for falsy-but-ok values (0, false, empty string)', () => {
    expect(unwrap(ok(0))).toBe(0);
    expect(unwrap(ok(false))).toBe(false);
    expect(unwrap(ok(''))).toBe('');
  });
});

// ─── unwrapOr ─────────────────────────────────────────────────────────────────

describe('unwrapOr', () => {
  it('returns the value when result is Ok', () => {
    expect(unwrapOr(ok(42), 0)).toBe(42);
  });

  it('returns the fallback when result is Err', () => {
    const r: Result<number, string> = err('missing');
    expect(unwrapOr(r, -1)).toBe(-1);
  });

  it('does not throw for either variant', () => {
    expect(() => unwrapOr(ok(1), 0)).not.toThrow();
    expect(() => unwrapOr(err('x'), 0)).not.toThrow();
  });

  it('returns fallback for falsy Ok values (0, false, empty string)', () => {
    // These are Ok variants — fallback must NOT be used
    expect(unwrapOr(ok(0), 99)).toBe(0);
    expect(unwrapOr(ok(false as boolean), true)).toBe(false);
    expect(unwrapOr(ok(''), 'default')).toBe('');
  });
});
