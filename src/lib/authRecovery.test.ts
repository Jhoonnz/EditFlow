import { describe, expect, it } from 'vitest';
import { parseAuthRecoveryCallback } from './authRecovery';

describe('parseAuthRecoveryCallback', () => {
  it('lê retorno PKCE', () => {
    expect(parseAuthRecoveryCallback('editflow://auth/recovery?code=abc123')).toEqual({ code: 'abc123', accessToken: null, refreshToken: null });
  });

  it('lê retorno por tokens no fragmento', () => {
    expect(parseAuthRecoveryCallback('editflow://auth/recovery#access_token=access&refresh_token=refresh')).toEqual({ code: null, accessToken: 'access', refreshToken: 'refresh' });
  });

  it('rejeita protocolos e callbacks incompletos', () => {
    expect(() => parseAuthRecoveryCallback('https://example.com/?code=abc')).toThrow('inválido');
    expect(() => parseAuthRecoveryCallback('editflow://auth/recovery')).toThrow('sessão válida');
  });
});
