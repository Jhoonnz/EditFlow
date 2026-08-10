export type ThemePreference = EditFlowDesktopPreferences['theme'];

export function watchThemePreference(preference: ThemePreference) {
  const media = window.matchMedia('(prefers-color-scheme: dark)');

  const apply = () => {
    const resolved = preference === 'system'
      ? (media.matches ? 'dark' : 'light')
      : preference;
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themePreference = preference;
    document.documentElement.style.colorScheme = resolved;
  };

  apply();
  if (preference !== 'system') return () => undefined;

  media.addEventListener('change', apply);
  return () => media.removeEventListener('change', apply);
}
