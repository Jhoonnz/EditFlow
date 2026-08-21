import { describe, expect, it } from 'vitest';
import { compareVersions, releaseNoteForVersion, releaseNotesUpTo } from './releaseNotes';

describe('release notes catalog', () => {
  it('finds the installed version with or without a v prefix', () => {
    expect(releaseNoteForVersion('0.1.48')?.version).toBe('0.1.48');
    expect(releaseNoteForVersion('v0.1.48')?.version).toBe('0.1.48');
  });

  it('does not expose notes newer than the installed application', () => {
    expect(releaseNotesUpTo('0.1.48').map((note) => note.version)).toEqual(['0.1.48', '0.1.47']);
  });

  it('compares semantic version numbers numerically', () => {
    expect(compareVersions('0.1.49', '0.1.48')).toBeGreaterThan(0);
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('', '0.1.48')).toBeLessThan(0);
  });
});
