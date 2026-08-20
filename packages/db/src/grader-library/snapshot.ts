import type {
  LibraryOutputDefinition,
  LibraryParameter,
} from "./catalog.ts";
import {
  LIBRARY_TYPES,
  type LibraryType,
} from "../schema/graders.ts";

/**
 * The complete library definition one grader version executes.
 *
 * The stable Library identity owns `type`; one shared immutable Library-version
 * row owns every other field in this shape. A grader version references that
 * row, so runtime joins the stable type and exact revision without following
 * the Library's mutable current pointer. A pinned run cannot change later.
 */
export type GraderDefinitionSnapshot = {
  readonly libraryId: string;
  readonly libraryVersion: number;
  readonly type: LibraryType;
  readonly prompt: string | null;
  readonly params: readonly LibraryParameter[];
  readonly outputDefinition: LibraryOutputDefinition | null;
  readonly sourceCode: string | null;
  readonly sourceCodeLanguage: string | null;
};

/** The fields read from one library row before they become a snapshot. */
export type LibraryDefinitionSource = {
  readonly id: string;
  readonly version: number;
  readonly type: string;
  readonly prompt: string | null;
  readonly params: unknown;
  readonly outputDefinition: unknown;
  readonly sourceCode: string | null;
  readonly sourceCodeLanguage: string | null;
};

/**
 * Turn a Library-version row into the value execution reads.
 *
 * This is the only writer of the JSON shape. It checks the parts execution
 * depends on before a new version can own them.
 */
export function snapshotLibraryDefinition(
  source: LibraryDefinitionSource,
): GraderDefinitionSnapshot {
  const malformed = (because: string): Error =>
    new Error(`library entry ${source.id} ${because}`);

  if (!Number.isInteger(source.version) || source.version < 1) {
    throw malformed("has no readable positive version");
  }
  if (!(LIBRARY_TYPES as readonly string[]).includes(source.type)) {
    throw malformed(`has an executable type Egma does not know: ${source.type}`);
  }
  if (!Array.isArray(source.params)) {
    throw malformed("holds parameters in a shape Egma never writes");
  }
  if (
    source.outputDefinition !== null &&
    (typeof source.outputDefinition !== "object" ||
      Array.isArray(source.outputDefinition))
  ) {
    throw malformed("holds an output definition in a shape Egma never writes");
  }
  if ((source.sourceCode === null) !== (source.sourceCodeLanguage === null)) {
    throw malformed("holds only half of its executable source definition");
  }

  return {
    libraryId: source.id,
    libraryVersion: source.version,
    type: source.type as LibraryType,
    prompt: source.prompt,
    params: source.params as readonly LibraryParameter[],
    outputDefinition:
      source.outputDefinition as LibraryOutputDefinition | null,
    sourceCode: source.sourceCode,
    sourceCodeLanguage: source.sourceCodeLanguage,
  };
}
