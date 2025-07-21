export function updateCursorInUrl(url: string, newCursor: string | number): string {
  const parsedUrl = new URL(url);
  parsedUrl.searchParams.set('cursor', newCursor.toString());
  return parsedUrl.toString();
}
