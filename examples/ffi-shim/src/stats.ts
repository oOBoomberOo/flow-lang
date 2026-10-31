// TypeScript works on the server (Node strips the types when it imports .ts).

export const average = (xs: number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
