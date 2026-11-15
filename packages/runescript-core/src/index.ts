export type {
  DiagnosticCategory,
  DiagnosticConfidence,
  DiagnosticParams,
  DiagnosticSeverity,
  DiagnosticSource,
  EndOfLine,
  ParseDiagnostic,
  Position,
  RelatedLocation,
  SourceDocument,
  SourceRange,
} from "./types";
export type { Token, TokenKind } from "./token";
export { isTrivia } from "./token";
export { tokenize } from "./lexer";
export { INITIAL_LINE_STATE, tokenizeLine } from "./line-lexer";
export type { LineLexState, LineTokens } from "./line-lexer";
export { LineIndex } from "./line-index";
export { applyEol, countEols, detectEol, dominantEol, eolString, normalizeToLf } from "./eol";
export type { EolStats } from "./eol";
export {
  createDiagnostic,
  describeDiagnostic,
  isDiagnosticCode,
  listDiagnosticCodes,
} from "./diagnostics";
export type { DiagnosticCode, DiagnosticOverrides, Language } from "./diagnostics";
