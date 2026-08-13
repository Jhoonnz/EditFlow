export type AuthRecoveryCallback = {
  code: string | null;
  accessToken: string | null;
  refreshToken: string | null;
};

export function parseAuthRecoveryCallback(rawUrl: string): AuthRecoveryCallback {
  const url = new URL(rawUrl);
  if (url.protocol !== 'editflow:') throw new Error('Endereço de recuperação inválido.');
  const query = url.searchParams;
  const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
  const errorMessage = query.get('error_description') ?? hash.get('error_description');
  if (errorMessage) throw new Error(errorMessage);

  const result = {
    code: query.get('code'),
    accessToken: hash.get('access_token') ?? query.get('access_token'),
    refreshToken: hash.get('refresh_token') ?? query.get('refresh_token'),
  };
  if (!result.code && !(result.accessToken && result.refreshToken)) {
    throw new Error('O link de recuperação não contém uma sessão válida.');
  }
  return result;
}
