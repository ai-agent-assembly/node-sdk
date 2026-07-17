export interface QuickstartTab {
  frameworkId: string;
  label: string;
  status: "validated" | "experimental";
  lang: string;
  code: string;
}

export interface GeneratedMetadata {
  packageName: string;
  version: string;
  homepage: string;
  repositoryUrl: string;
  docsUrl: string;
  distTag: string;
  cliInstall: { brew?: string; curl?: string };
  installCommands: {
    latest?: { pnpm?: string; npm?: string; yarn?: string };
    distTag?: { pnpm?: string; npm?: string; yarn?: string };
    pinned?: { pnpm?: string; npm?: string; yarn?: string };
  };
  quickstartTabs: QuickstartTab[];
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

export interface InstallHintsWriteResult {
  changed: boolean;
}

export interface RunGeneratorResult {
  meta: GeneratedMetadata;
  results: FileRewriteReport[];
  installHints: InstallHintsWriteResult;
}

export const INSTALL_HINTS_TS_PATH: string;
export const QUICKSTART_SNIPPETS_DIR: string;

export function loadMetadata(repoRoot: string): GeneratedMetadata;

export function loadQuickstartTabs(repoRoot: string): QuickstartTab[];

export function renderQuickstartFrameworkTabs(
  meta: {
    quickstartTabs: ReadonlyArray<{
      frameworkId: string;
      label: string;
      status: string;
      lang: string;
      code: string;
    }>;
  },
  dialect: { header(id: string): string }
): string;

export function rewriteFile(
  filePath: string,
  meta: GeneratedMetadata,
  relPath: string
): FileRewriteResult;

export function renderInstallHintsModule(meta: GeneratedMetadata): string;

export function writeInstallHintsModule(
  repoRoot: string,
  meta: GeneratedMetadata
): InstallHintsWriteResult;

export function runGenerator(options?: RunGeneratorOptions): RunGeneratorResult;
