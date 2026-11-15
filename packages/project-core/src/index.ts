export { decodeDocument, encodeDocument } from "./codec";
export type {
  DecodedDocument,
  DecodeOptions,
  DocumentWarning,
  DocumentWarningCode,
  EncodeMeta,
  EncodeResult,
  UnsupportedDocument,
} from "./codec";
export { getLegacyCodec } from "./legacy-codec";
export type { LegacyCodec, UnencodableCharacter } from "./legacy-codec";
export { diffLines, diffSequences } from "./diff";
export type { DiffOp } from "./diff";
export { preserveMixedEol, restoreEol, splitWithEol } from "./eol";
export type { LineWithEol } from "./eol";
export {
  CURRENT_SCHEMA_VERSION,
  PROJECT_CONFIG_DIRECTORY,
  PROJECT_CONFIG_PATH,
  MAX_CUSTOM_COMMANDS,
  MAX_CUSTOM_CONSTANTS,
  defaultProjectConfig,
  formatCustomCommands,
  formatCustomConstants,
  isCommandName,
  isConstantName,
  normalizeRelativeDirectory,
  parseCustomCommandLines,
  parseCustomConstantLines,
  parseProjectConfig,
  serializeProjectConfig,
} from "./project-config";
export type {
  ConfigIssue,
  ConfigParseResult,
  CrossFileChecks,
  CustomCommandConfig,
  CustomCommandLines,
  CustomConstantConfig,
  CustomConstantLines,
  EmulatorFamily,
  EmulatorMode,
  IndexScope,
  ProjectConfig,
  UnknownCommandPolicy,
} from "./project-config";
export { DEFAULT_SETTINGS, DEFAULT_UPDATE_REPOSITORY, isUpdateRepository, normalizeSettings, resolveLanguage, resolveTheme } from "./settings";
export type { LanguageSetting, Settings, ThemeSetting, UpdateChannelSetting, WhitespaceSetting } from "./settings";
export { EMPTY_SESSION, normalizeSession } from "./session";
export type { SessionState } from "./session";
export { ancestorDirectories, buildTree, flattenVisible } from "./file-tree";
export type { FlatRow, ScanEntryLike, TreeNode } from "./file-tree";
