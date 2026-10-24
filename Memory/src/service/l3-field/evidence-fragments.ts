import path from "node:path";
import { sha256Hex } from "../../contracts/index.js";
import type { RawTurnRecord } from "../../storage/repositories.js";
import { matchToolResultIndices } from "../../utils/tool-call-pairing.js";
import type { EvidenceFragment, ResolvedProject } from "./types.js";

const PATH_KEYS = ["file_path", "filePath", "path", "notebook_path", "workdir", "cwd", "directory"];
const COMMAND_KEYS = ["command", "cmd"];
const USER_TEXT_LIMIT = 4_000;
const CLIP_HEAD_CHARS = 600;
const CLIP_TAIL_CHARS = 600;
const ERROR_LINE = /error|fail|exception|denied|not found|traceback|refused|cannot|no such|fatal/i;
const COMMAND_SEPARATORS = new Set(["&&", "||", ";", "|"]);

/**
 * Cuts one raw turn into evidence fragments: the user's words, and each tool
 * call together with its result. Every fragment carries the project units its
 * own paths resolve to, so content about repository A never borrows evidence
 * from a call that touched repository B.
 */
export function buildEvidenceFragments(input: {
  rawTurn: RawTurnRecord;
  l1MemoryId: string;
  sessionCwd: string | null;
  sessionProjectRoot: string | null;
  resolve: (target: string, role: "session_dir" | "tool_path") => ResolvedProject | null;
  unitKeyOf: (project: ResolvedProject) => string;
}): EvidenceFragment[] {
  const { rawTurn } = input;
  const sessionUnits = (): string[] => {
    if (!input.sessionCwd) return [];
    const project = input.resolve(input.sessionCwd, "session_dir");
    return project ? [input.unitKeyOf(project)] : [];
  };
  const unitsForPaths = (paths: string[]): string[] => {
    if (paths.length === 0) return sessionUnits();
    const keys = new Set<string>();
    for (const target of paths) {
      const project = input.resolve(target, "tool_path");
      if (project) keys.add(input.unitKeyOf(project));
    }
    return [...keys];
  };
  const fragmentId = (kind: string, index: number) =>
    sha256Hex(`${rawTurn.id}:${kind}:${index}`).slice(0, 16);

  const fragments: EvidenceFragment[] = [];
  const userText = rawTurn.userText?.trim();
  if (userText) {
    fragments.push({
      id: fragmentId("user", 0),
      rawTurnId: rawTurn.id,
      l1MemoryId: input.l1MemoryId,
      toolName: null,
      input: null,
      output: userText.slice(0, USER_TEXT_LIMIT),
      isError: false,
      paths: [],
      candidateUnitKeys: sessionUnits(),
      at: rawTurn.createdAt
    });
  }

  rawTurn.toolCalls.forEach((call, index) => {
    if (!isRecord(call)) return;
    const paths = extractToolPaths(call, input.sessionCwd);
    fragments.push({
      id: fragmentId("call", index),
      rawTurnId: rawTurn.id,
      l1MemoryId: input.l1MemoryId,
      toolName: typeof call.name === "string" ? call.name : null,
      input: call.input ?? null,
      output: toolOutputText(call),
      isError: isErrorRecord(call),
      paths,
      candidateUnitKeys: unitsForPaths(paths),
      at: typeof call.endedAt === "string" ? call.endedAt : rawTurn.createdAt
    });
  });

  const matched = new Set(
    matchToolResultIndices(rawTurn.toolCalls, rawTurn.toolResults).filter((index): index is number => index !== undefined)
  );
  rawTurn.toolResults.forEach((result, index) => {
    if (matched.has(index) || !isRecord(result)) return;
    const name = [result.name, result.toolName, result.tool_name].find((value) => typeof value === "string");
    fragments.push({
      id: fragmentId("result", index),
      rawTurnId: rawTurn.id,
      l1MemoryId: input.l1MemoryId,
      toolName: typeof name === "string" ? name : null,
      input: null,
      output: toolOutputText(result),
      isError: isErrorRecord(result),
      paths: [],
      candidateUnitKeys: sessionUnits(),
      at: rawTurn.createdAt
    });
  });
  return fragments;
}

/**
 * Paths a tool call actually touched: file/dir arguments, `cd` and `git -C`
 * targets, and absolute path arguments of commands. Relative paths resolve
 * against the call's own workdir/cwd, else the session folder.
 */
export function extractToolPaths(call: Record<string, unknown>, sessionCwd: string | null): string[] {
  const rawArgs = call.input ?? call.arguments ?? call.args;
  const args = parseArguments(rawArgs);
  if (!args) {
    return typeof rawArgs === "string" ? codeModePaths(rawArgs, sessionCwd) : [];
  }
  const workdir = stringValue(args.workdir) ?? stringValue(args.cwd) ?? stringValue(args.directory) ?? sessionCwd;
  const found: string[] = [];
  const add = (value: string, base: string | null) => {
    const resolved = resolveAgainst(value, base);
    if (resolved && !found.includes(resolved)) found.push(resolved);
  };
  for (const key of PATH_KEYS) {
    const value = stringValue(args[key]);
    if (value) add(value, key === "workdir" || key === "cwd" || key === "directory" ? sessionCwd : workdir);
  }
  for (const key of COMMAND_KEYS) {
    const raw = args[key];
    const command = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.filter((part) => typeof part === "string").join(" ") : null;
    if (command) for (const target of commandPaths(command, workdir)) add(target, null);
  }
  return found;
}

/**
 * Codex "code mode" passes a JavaScript snippet such as
 * `tools.exec_command({cmd: "...", workdir: "..."})` instead of JSON; read the
 * string literals of the known argument keys out of it.
 */
function codeModePaths(code: string, sessionCwd: string | null): string[] {
  const literal = /\b(cmd|command|workdir|cwd|file_path|filePath|path)\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)/g;
  const values: Record<string, string[]> = {};
  for (const match of code.matchAll(literal)) {
    const value = unquoteJsString(match[2]!);
    if (value !== null) (values[match[1]!] ??= []).push(value);
  }
  const found: string[] = [];
  const add = (target: string | null) => {
    if (target && !found.includes(target)) found.push(target);
  };
  const workdirs = [...(values.workdir ?? []), ...(values.cwd ?? [])];
  for (const dir of workdirs) add(resolveAgainst(dir, sessionCwd));
  const base = workdirs[0] ? resolveAgainst(workdirs[0], sessionCwd) : sessionCwd;
  for (const key of ["file_path", "filePath", "path"]) {
    for (const value of values[key] ?? []) add(resolveAgainst(value, base));
  }
  for (const command of [...(values.cmd ?? []), ...(values.command ?? [])]) {
    for (const target of commandPaths(command, base)) add(target);
  }
  return found;
}

function unquoteJsString(quoted: string): string | null {
  const body = quoted.slice(1, -1);
  if (quoted.startsWith("\"")) {
    try {
      return JSON.parse(quoted) as string;
    } catch {
      return null;
    }
  }
  return body.replace(/\\(.)/g, (_, char: string) => (char === "n" ? "\n" : char === "t" ? "\t" : char));
}

/** Keeps head and tail plus any error-looking line from the middle, so a mid-output error is not lost. */
export function clipToolOutput(text: string): string {
  if (text.length <= CLIP_HEAD_CHARS + CLIP_TAIL_CHARS) return text;
  const head = text.slice(0, CLIP_HEAD_CHARS);
  const tail = text.slice(-CLIP_TAIL_CHARS);
  const middle = text.slice(CLIP_HEAD_CHARS, text.length - CLIP_TAIL_CHARS);
  const errorLines = middle.split(/\r?\n/).filter((line) => ERROR_LINE.test(line)).slice(0, 20);
  return [head, "[已截断]", ...errorLines, ...(errorLines.length ? ["[已截断]"] : []), tail].join("\n");
}

function commandPaths(command: string, startDir: string | null): string[] {
  const found: string[] = [];
  let cwd = startDir;
  let segment: string[] = [];
  const flush = () => {
    if (segment.length === 0) return;
    const [executable, ...rest] = segment;
    if (executable === "cd" && rest[0]) {
      const target = resolveAgainst(rest[0], cwd);
      if (target) {
        found.push(target);
        cwd = target;
      }
    } else {
      for (let i = 0; i < rest.length; i += 1) {
        const token = rest[i]!;
        if (executable === "git" && token === "-C" && rest[i + 1]) {
          const target = resolveAgainst(rest[i + 1]!, cwd);
          if (target) found.push(target);
          i += 1;
          continue;
        }
        if (isAbsoluteAny(token) && !token.includes("://")) found.push(token);
      }
    }
    segment = [];
  };
  for (const token of shellTokens(command)) {
    if (COMMAND_SEPARATORS.has(token)) flush();
    else segment.push(token);
  }
  flush();
  return found;
}

/** Minimal shell word splitting: quotes, backslash escapes and the &&, ||, ;, | separators. */
function shellTokens(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let hasToken = false;
  let quote: "'" | "\"" | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!;
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === "\"" && i + 1 < command.length) current += command[++i];
      else current += char;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      hasToken = true;
      continue;
    }
    if (char === "\\" && i + 1 < command.length) {
      current += command[++i];
      hasToken = true;
      continue;
    }
    const pair = command.slice(i, i + 2);
    if (pair === "&&" || pair === "||" || char === ";" || char === "|") {
      if (hasToken) tokens.push(current);
      tokens.push(pair === "&&" || pair === "||" ? pair : char);
      current = "";
      hasToken = false;
      if (pair === "&&" || pair === "||") i += 1;
      continue;
    }
    if (/\s/.test(char)) {
      if (hasToken) tokens.push(current);
      current = "";
      hasToken = false;
      continue;
    }
    current += char;
    hasToken = true;
  }
  if (hasToken) tokens.push(current);
  return tokens;
}

function parseArguments(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function resolveAgainst(value: string, base: string | null): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("://")) return null;
  if (isAbsoluteAny(trimmed)) return trimmed;
  if (!base) return null;
  return isWindowsPath(base) ? path.win32.resolve(base, trimmed) : path.posix.resolve(base, trimmed);
}

function isAbsoluteAny(value: string): boolean {
  return value.startsWith("/") || isWindowsPath(value);
}

function isWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value);
}

function toolOutputText(record: Record<string, unknown>): string | null {
  const error = typeof record.error === "string" ? record.error : null;
  const output = record.output ?? record.result ?? record.content;
  const text = typeof output === "string" ? output : output === undefined || output === null ? null : JSON.stringify(output);
  const combined = [text, error && !text?.includes(error) ? error : null].filter(Boolean).join("\n");
  return combined ? clipToolOutput(combined) : null;
}

function isErrorRecord(record: Record<string, unknown>): boolean {
  return record.success === false ||
    (typeof record.error === "string" && record.error.trim().length > 0) ||
    record.status === "failed" ||
    record.status === "error";
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
