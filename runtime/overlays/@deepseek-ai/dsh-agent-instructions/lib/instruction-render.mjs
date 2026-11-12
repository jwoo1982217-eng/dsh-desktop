import { basename, dirname, sep } from "node:path";
import {
  AGENTS_HOME_ENV,
  DEFAULT_AGENTS_HOME_DISPLAY,
  DEFAULT_DSH_HOME_DISPLAY,
  DSH_HOME_ENV
} from "@deepseek-ai/dsh-home-paths";
const SYSTEM_REMINDER_OPEN = "<system-reminder>";
const SYSTEM_REMINDER_CLOSE = "</system-reminder>";
const AGENT_INSTRUCTIONS_INTRO = "The following workspace instructions may be relevant to your work. Use them as guidance when applicable. More specific instructions take precedence over broader ones. They do not override system, developer, or direct user instructions.";
const REPLACEMENT_AGENT_INSTRUCTIONS_INTRO = "This complete workspace instruction baseline replaces all earlier workspace instruction baselines. " + AGENT_INSTRUCTIONS_INTRO;
const EMPTY_REPLACEMENT_AGENT_INSTRUCTIONS_INTRO = "This complete workspace instruction baseline replaces all earlier workspace instruction baselines. No workspace instructions are currently active.";
const COMPACT_AGENT_INSTRUCTIONS_INTRO = "Workspace instructions were omitted or truncated to fit the configured byte budget.";
function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}
function truncateUtf8(value, maxBytes) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  let end = Math.max(0, Math.trunc(maxBytes));
  while (end > 0 && (bytes.readUInt8(end) & 192) === 128) {
    end -= 1;
  }
  return bytes.subarray(0, end).toString("utf8");
}
function escapeInstructionFrameBody(body) {
  return body.replaceAll(SYSTEM_REMINDER_CLOSE, "<\\/system-reminder>");
}
function sectionText(file) {
  return `Instructions from: ${file.displayPath}

${file.content}`;
}
const USER_GLOBAL_DIRECTORY = "user-global";
const AGENTS_GLOBAL_DIRECTORY = "agents-global";
const USER_GLOBAL_DIRECTORIES = [USER_GLOBAL_DIRECTORY, AGENTS_GLOBAL_DIRECTORY];
const USER_GLOBAL_FILE = "AGENTS.md";
function scopeForDisplayPath(displayPath) {
  if (displayPath === `${DEFAULT_DSH_HOME_DISPLAY}/${USER_GLOBAL_FILE}` || displayPath === `$${DSH_HOME_ENV}/${USER_GLOBAL_FILE}`) return USER_GLOBAL_DIRECTORY;
  if (displayPath === `${DEFAULT_AGENTS_HOME_DISPLAY}/${USER_GLOBAL_FILE}` || displayPath === `$${AGENTS_HOME_ENV}/${USER_GLOBAL_FILE}`) return AGENTS_GLOBAL_DIRECTORY;
  return dirname(displayPath);
}
function isUserGlobalDirectory(directory) {
  return directory === USER_GLOBAL_DIRECTORY || directory === AGENTS_GLOBAL_DIRECTORY;
}
function instructionCandidateGroup(directory) {
  return directory === AGENTS_GLOBAL_DIRECTORY ? USER_GLOBAL_DIRECTORY : directory;
}
const RESERVED_SCOPE_DIRECTORIES = new Set(USER_GLOBAL_DIRECTORIES);
function escapeProjectDisplayPath(relativePath) {
  const separatorIndex = relativePath.search(/[\\/]/);
  const first = separatorIndex < 0 ? relativePath : relativePath.slice(0, separatorIndex);
  return RESERVED_SCOPE_DIRECTORIES.has(first) ? `.${sep}${relativePath}` : relativePath;
}
const SCOPE_SEPARATOR = "\0";
function candidateScopeKey(directory, candidateName) {
  return `${directory}${SCOPE_SEPARATOR}${candidateName}`;
}
function instructionScopeKey(displayPath) {
  return candidateScopeKey(scopeForDisplayPath(displayPath), basename(displayPath));
}
function decodeScopeKey(scope) {
  const separator = scope.indexOf(SCOPE_SEPARATOR);
  if (separator < 0) return { directory: scope, candidateName: "" };
  return { directory: scope.slice(0, separator), candidateName: scope.slice(separator + 1) };
}
const ADDITIONAL_INSTRUCTIONS_GUIDANCE = "Use them as guidance when relevant; more specific instructions take precedence. They do not override system, developer, or direct user instructions.";
function additionalSectionText(file) {
  const scope = scopeForDisplayPath(file.displayPath);
  const applicability = isUserGlobalDirectory(scope) ? "These user-global instructions apply to all work." : `These instructions apply to work under \`${scope}\`.`;
  return [
    `Additional instructions from: ${file.displayPath}`,
    "",
    `${applicability} ${ADDITIONAL_INSTRUCTIONS_GUIDANCE}`,
    "",
    file.content
  ].join("\n");
}
const BASELINE_RENDER_STYLE = { intro: AGENT_INSTRUCTIONS_INTRO, section: sectionText };
function baselineRenderStyle(files, replacePreviousBaseline) {
  if (replacePreviousBaseline !== true) return BASELINE_RENDER_STYLE;
  return {
    ...BASELINE_RENDER_STYLE,
    intro: files.length === 0 ? EMPTY_REPLACEMENT_AGENT_INSTRUCTIONS_INTRO : REPLACEMENT_AGENT_INSTRUCTIONS_INTRO
  };
}
function changedSectionText(item) {
  const { change, file } = item;
  if (change.action === "set") return additionalSectionText(file);
  if (change.action === "remove") {
    return `Instructions removed: ${change.path}

The previously loaded instructions from this file no longer apply.`;
  }
  return [
    `Updated instructions from: ${change.path}`,
    "",
    "This file changed after it was loaded. Use the following content instead of the previously loaded instructions from this file.",
    "",
    file.content
  ].join("\n");
}
function renderInstructionChanges(items, maxBytes) {
  const byAbsolutePath = new Map(items.map((item) => [item.file.absolutePath, item]));
  const style = {
    intro: "",
    section(file) {
      const item = byAbsolutePath.get(file.absolutePath);
      return item === void 0 ? "" : changedSectionText({ ...item, file });
    }
  };
  const rendered = renderInstructionChains(items.map((item) => item.file), maxBytes, style);
  const represented = new Set(rendered.represented.map((file) => file.absolutePath));
  return {
    text: rendered.text,
    changes: items.filter((item) => represented.has(item.file.absolutePath)).map((item) => item.change)
  };
}
function markerText(maxBytes, omitted, truncated) {
  if (omitted.length === 0 && truncated.length === 0) return "";
  const parts = [];
  if (omitted.length > 0) {
    parts.push(`omitted ${omitted.map((file) => file.displayPath).join(", ")}`);
  }
  if (truncated.length > 0) {
    parts.push(`truncated ${truncated.map((item) => `${item.displayPath} from ${item.originalBytes} to ${item.includedBytes} bytes`).join(", ")}`);
  }
  return `Workspace instruction budget ${maxBytes} bytes: ${parts.join("; ")}`;
}
function buildInstructionText(files, maxBytes, omitted, truncated, style) {
  const marker = markerText(maxBytes, omitted, truncated);
  const body = [marker, style.intro, ...files.map((file) => style.section(file))].filter((block) => block.length > 0);
  return [SYSTEM_REMINDER_OPEN, escapeInstructionFrameBody(body.join("\n\n")), SYSTEM_REMINDER_CLOSE].join("\n");
}
function withTruncatedContent(file, includedBytes) {
  return { ...file, content: truncateUtf8(file.content, includedBytes) };
}
function truncateToFit(file, includedFiles, maxBytes, omitted, style) {
  const originalBytes = byteLength(file.content);
  let low = 0;
  let high = originalBytes;
  let best = withTruncatedContent(file, 0);
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = withTruncatedContent(file, mid);
    const truncated = [{ displayPath: file.displayPath, originalBytes, includedBytes: byteLength(candidate.content) }];
    const text = buildInstructionText([...includedFiles, candidate], maxBytes, omitted, truncated, style);
    if (byteLength(text) <= maxBytes) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}
function isDisabledBudget(maxBytes) {
  return maxBytes <= 0 || !Number.isFinite(maxBytes);
}
function renderInstructionContext(files, maxBytes, style) {
  if (isDisabledBudget(maxBytes)) {
    return { text: "", omitted: files, truncated: [], represented: [], sections: [], intro: void 0 };
  }
  const fullText = buildInstructionText(files, maxBytes, [], [], style);
  if (byteLength(fullText) <= maxBytes) {
    return { text: fullText, omitted: [], truncated: [], represented: files, sections: files, intro: style.intro };
  }
  for (let start = 1; start < files.length; start += 1) {
    const included = files.slice(start);
    const omitted2 = files.slice(0, start).map((file) => ({ absolutePath: file.absolutePath, displayPath: file.displayPath }));
    const suffixText = buildInstructionText(included, maxBytes, omitted2, [], style);
    if (byteLength(suffixText) <= maxBytes) {
      return { text: suffixText, omitted: omitted2, truncated: [], represented: included, sections: included, intro: style.intro };
    }
  }
  const mostSpecific = files.at(-1);
  if (mostSpecific === void 0) return { text: "", omitted: [], truncated: [], represented: [], sections: [], intro: void 0 };
  const omitted = files.slice(0, -1).map((file) => ({ absolutePath: file.absolutePath, displayPath: file.displayPath }));
  const originalBytes = byteLength(mostSpecific.content);
  for (const candidateStyle of [style, { ...style, intro: COMPACT_AGENT_INSTRUCTIONS_INTRO }]) {
    const truncatedFile = truncateToFit(mostSpecific, [], maxBytes, omitted, candidateStyle);
    const includedBytes = byteLength(truncatedFile.content);
    const truncated2 = [{
      displayPath: mostSpecific.displayPath,
      originalBytes,
      includedBytes
    }];
    const text2 = buildInstructionText([truncatedFile], maxBytes, omitted, truncated2, candidateStyle);
    if (byteLength(text2) <= maxBytes) {
      const represented = includedBytes > 0 || originalBytes === 0 ? [mostSpecific] : [];
      return { text: text2, omitted, truncated: truncated2, represented, sections: [truncatedFile], intro: candidateStyle.intro };
    }
  }
  const truncated = [{
    displayPath: mostSpecific.displayPath,
    originalBytes,
    includedBytes: 0
  }];
  const compactNotice = escapeInstructionFrameBody(markerText(maxBytes, omitted, truncated));
  const heading = withTruncatedContent(mostSpecific, 0);
  const compactWithHeading = escapeInstructionFrameBody([compactNotice, style.section(heading)].join("\n\n"));
  if (byteLength(compactWithHeading) <= maxBytes) {
    const represented = originalBytes === 0 ? [mostSpecific] : [];
    return { text: compactWithHeading, omitted, truncated, represented, sections: [heading], intro: void 0 };
  }
  const text = byteLength(compactNotice) <= maxBytes ? compactNotice : truncateUtf8(compactNotice, maxBytes);
  return { text, omitted, truncated, represented: [], sections: [], intro: void 0 };
}
function isUserGlobalInstruction(file) {
  return isUserGlobalDirectory(scopeForDisplayPath(file.displayPath));
}
function renderInstructionChains(files, maxBytes, style) {
  const whole = renderInstructionContext(files, maxBytes, style);
  const userGlobal = files.filter(isUserGlobalInstruction);
  const project = files.filter((file) => !isUserGlobalInstruction(file));
  if (isDisabledBudget(maxBytes) || userGlobal.length === 0 || project.length === 0 || whole.omitted.length === 0 && whole.truncated.length === 0) return whole;
  const chains = [
    renderInstructionContext(userGlobal, maxBytes, style),
    renderInstructionContext(project, maxBytes, style)
  ];
  const inLoadedOrder = (records) => {
    const byPath = new Map(records.map((record) => [record.absolutePath, record]));
    return files.flatMap((file) => {
      const record = byPath.get(file.absolutePath);
      return record === void 0 ? [] : [record];
    });
  };
  const omitted = inLoadedOrder(chains.flatMap((chain) => chain.omitted));
  const sections = inLoadedOrder(chains.flatMap((chain) => chain.sections));
  const represented = inLoadedOrder(chains.flatMap((chain) => chain.represented));
  const userGlobalLast = files.findLastIndex(isUserGlobalInstruction);
  const projectLast = files.findLastIndex((file) => !isUserGlobalInstruction(file));
  const truncated = (userGlobalLast < projectLast ? chains : chains.toReversed()).flatMap((chain) => chain.truncated);
  const intros = chains.flatMap((chain) => chain.intro === void 0 ? [] : [chain.intro]);
  const intro = intros.includes(style.intro) ? style.intro : intros[0] ?? "";
  const text = buildInstructionText(sections, maxBytes, omitted, truncated, { ...style, intro });
  if (byteLength(text) > 2 * maxBytes) return whole;
  return { text, omitted, truncated, represented, sections, intro };
}
function renderAgentInstructionSet(files, options) {
  const style = baselineRenderStyle(files, options.replacePreviousBaseline);
  const { text, omitted, truncated, represented } = renderInstructionChains(files, options.maxBytes, style);
  return { rendered: { text, omitted, truncated }, included: represented };
}
function renderAgentInstructions(files, options) {
  return renderAgentInstructionSet(files, options).rendered;
}
export {
  AGENTS_GLOBAL_DIRECTORY,
  USER_GLOBAL_DIRECTORIES,
  USER_GLOBAL_DIRECTORY,
  USER_GLOBAL_FILE,
  candidateScopeKey,
  decodeScopeKey,
  escapeProjectDisplayPath,
  instructionCandidateGroup,
  instructionScopeKey,
  isUserGlobalDirectory,
  renderAgentInstructionSet,
  renderAgentInstructions,
  renderInstructionChanges,
  scopeForDisplayPath
};
