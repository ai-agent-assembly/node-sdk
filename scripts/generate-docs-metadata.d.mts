export interface GeneratedMetadata {
  packageName: string;
  version: string;
  homepage: string;
  repositoryUrl: string;
  docsUrl: string;
  distTag: string;
  cliPackageName: string;
  installCommands: {
    latest?: { pnpm?: string; npm?: string; yarn?: string };
    distTag?: { pnpm?: string; npm?: string; yarn?: string };
    pinned?: { pnpm?: string; npm?: string; yarn?: string };
  };
}

export interface FileRewriteResult {
  changed: boolean;
  rewritten: string[];
}

export interface FileRewriteReport extends FileRewriteResult {
  file: string;
}

export interface RunGeneratorOptions {
  repoRoot: string;
  targets?: readonly string[];
  logger?: Pick<Console, "log">;
}

export interface RunGeneratorResult {
  meta: GeneratedMetadata;
  results: FileRewriteReport[];
}

export function loadMetadata(repoRoot: string): GeneratedMetadata;

export function rewriteFile(
  filePath: string,
  meta: GeneratedMetadata,
  relPath: string
): FileRewriteResult;

export function runGenerator(options?: RunGeneratorOptions): RunGeneratorResult;
