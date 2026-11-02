import { httpStatusCode } from './error';

describe('httpStatusCode', () => {
  it('reads the numeric code from a k8s Status error (RBAC denial)', () => {
    expect(httpStatusCode({ code: 403 })).toBe(403);
  });

  it('reads response.status from an axios-shaped error (resource absent)', () => {
    expect(httpStatusCode({ response: { status: 404 } })).toBe(404);
  });

  it('accepts string digits', () => {
    expect(httpStatusCode({ code: '404' })).toBe(404);
  });

  it('returns undefined for a non-numeric k8s Status field', () => {
    // k8s Status carries status: "Failure" alongside the numeric code.
    expect(httpStatusCode({ status: 'Failure' })).toBeUndefined();
  });

  it('returns undefined for plain Error objects and garbage', () => {
    expect(httpStatusCode(new Error('boom'))).toBeUndefined();
    expect(httpStatusCode('forbidden')).toBeUndefined();
    expect(httpStatusCode(0)).toBeUndefined();
    expect(httpStatusCode(undefined)).toBeUndefined();
    expect(httpStatusCode(null)).toBeUndefined();
  });

  it('prefers code over the non-numeric status field', () => {
    expect(httpStatusCode({ code: 403, status: 'Failure' })).toBe(403);
  });
});
