/**
 * Tracks users only for the current game term and releases prior-term IDs on rotation.
 */
export class TermUserSet {
  private term: number | null = null;
  private readonly userIds = new Set<string>();

  has(term: number, userId: string): boolean {
    this.rotate(term);
    return this.userIds.has(userId);
  }

  add(term: number, userId: string): void {
    this.rotate(term);
    this.userIds.add(userId);
  }

  private rotate(term: number): void {
    if (this.term === term) return;
    this.term = term;
    this.userIds.clear();
  }
}
