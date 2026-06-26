import { describe, expect, it } from 'vitest';
import { friendlyError } from './errors';

describe('friendlyError', () => {
  it('maps a 429 to a rate-limit message', () => {
    const msg = friendlyError(new Error('429 Too Many Requests for https://api.deadlock-api.com/x'));
    expect(msg).toMatch(/rate-limit/i);
  });

  it('maps any 5xx to a "try again later" message', () => {
    expect(friendlyError(new Error('500 Internal Server Error for https://x'))).toMatch(/trouble/i);
    expect(friendlyError(new Error('503 Service Unavailable for https://x'))).toMatch(/trouble/i);
  });

  it('maps a 404 to a no-data message', () => {
    expect(friendlyError(new Error('404 Not Found for https://x'))).toMatch(/no data/i);
  });

  it('maps other 4xx to a request-not-accepted message', () => {
    expect(friendlyError(new Error('400 Bad Request for https://x'))).toMatch(/accepted/i);
  });

  it('maps a network-level fetch rejection to a connectivity message', () => {
    expect(friendlyError(new TypeError('Failed to fetch'))).toMatch(/reach the stats api/i);
    expect(friendlyError(new TypeError('NetworkError when attempting to fetch resource.'))).toMatch(
      /reach the stats api/i,
    );
  });

  it('never leaks a raw URL or stack into the message', () => {
    const msg = friendlyError(new Error('500 Internal Server Error for https://api.deadlock-api.com/secret'));
    expect(msg).not.toContain('http');
  });

  it('falls back to a generic message for anything unrecognized', () => {
    expect(friendlyError('something odd')).toMatch(/something went wrong/i);
    expect(friendlyError(null)).toMatch(/something went wrong/i);
  });
});
