/**
 * A refusal that names its own place in the repository.
 *
 * Every parser under `folder/` raises one of these: it knows the file it is
 * reading (repository-relative, exactly as `egma push` shows it) and puts that
 * name into its own sentence. The reporter in `egma-folder.ts` therefore adds
 * a place only to problems that do not carry one — a file the system could not
 * read, a JSON parser's own words — so a refusal names its file exactly once.
 */
export class FolderProblem extends Error {
  readonly where: string;

  constructor(where: string, message: string) {
    super(message);
    this.name = "FolderProblem";
    this.where = where;
  }
}

/** Whether a caught problem already names the file it is about. */
export function namesItsPlace(problem: unknown): problem is FolderProblem {
  return problem instanceof FolderProblem;
}
