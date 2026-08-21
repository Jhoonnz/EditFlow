export type MentionContext = {
  start: number;
  end: number;
  query: string;
};

export function findMentionContext(value: string, cursor: number): MentionContext | null {
  const beforeCursor = value.slice(0, cursor);
  const match = beforeCursor.match(/(^|\s)@([^@\n]{0,80})$/);
  if (!match) return null;
  const query = match[2];
  if (/[.,!?;:()[\]{}]/.test(query)) return null;
  const start = beforeCursor.length - query.length - 1;
  return { start, end: cursor, query };
}
