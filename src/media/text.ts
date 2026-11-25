export function sanitizeMediaText(text: string): string {
  return text.replace(/<\/?media/gi, '').replace(/\r?\n|\r/g, ' ')
}
