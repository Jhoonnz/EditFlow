import releaseNotesData from '../data/release-notes.json';

export type ReleaseNoteSectionKind = 'new' | 'improved' | 'fixed';

export type ReleaseNote = {
  version: string;
  date: string;
  title: string;
  summary: string;
  sections: Array<{
    kind: ReleaseNoteSectionKind;
    title: string;
    items: string[];
  }>;
};

export const releaseNotes = (releaseNotesData as ReleaseNote[])
  .slice()
  .sort((left, right) => compareVersions(right.version, left.version));

export function releaseNoteForVersion(version: string) {
  const normalized = normalizeVersion(version);
  return releaseNotes.find((note) => normalizeVersion(note.version) === normalized) ?? null;
}

export function releaseNotesUpTo(version: string) {
  const normalized = normalizeVersion(version);
  return releaseNotes.filter((note) => compareVersions(note.version, normalized) <= 0);
}

export function compareVersions(left: string, right: string) {
  const leftParts = versionParts(left);
  const rightParts = versionParts(right);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

function normalizeVersion(version: string) {
  return version.trim().replace(/^v/i, '').split('-')[0];
}

function versionParts(version: string) {
  return normalizeVersion(version).split('.').map((part) => Number(part) || 0);
}
