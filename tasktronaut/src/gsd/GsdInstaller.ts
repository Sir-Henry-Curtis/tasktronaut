import path from "node:path"
import { createHash } from "node:crypto"
import { existsSync } from "fs"
import { chmod, mkdir, readFile, writeFile } from "fs/promises"
import { Logger } from "@/shared/services/Logger"
import { GSD_AGENTS } from "../gsd-agents-generated"
import { GSD_RESEARCH_ASSETS } from "../gsd-research-assets-generated"

// Hook scripts embedded as strings so they survive esbuild bundling.
// The installer writes them to <workspace>/.tasktronautrules/hooks/ at activation.

const HOOK_PRE_COMPACT = `#!/usr/bin/env node
// GSD v1.5 PreCompact hook — preserve planning state before context compaction.
const fs = require('fs');
const path = require('path');
let input = '';
const t = setTimeout(() => process.exit(0), 5000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  clearTimeout(t);
  try {
    const data = JSON.parse(input);
    const cwd = data.cwd || (data.workspaceRoots || [])[0] || process.cwd();
    const sp = path.join(cwd, '.planning', 'STATE.md');
    if (!fs.existsSync(sp)) { out(''); process.exit(0); }
    const state = fs.readFileSync(sp, 'utf8').trim();
    let proj = '';
    const pp = path.join(cwd, '.planning', 'PROJECT.md');
    if (fs.existsSync(pp)) proj = '\\n\\n### Project Summary\\n' + fs.readFileSync(pp, 'utf8').slice(0, 500).trim();
    out('## GSD State Checkpoint (saved before compaction)\\n\\n\`\`\`\\n' + state + '\\n\`\`\`' + proj +
      '\\n\\nContinue from current_step after compaction. Run /gsd-next if unsure.');
  } catch (_) { out(''); }
  process.exit(0);
});
function out(c) { process.stdout.write(JSON.stringify({ cancel: false, contextModification: c })); }
`

const HOOK_TASK_START = `#!/usr/bin/env node
// GSD v1.5 TaskStart hook — inject planning context when a new task begins.
const fs = require('fs');
const path = require('path');
let input = '';
const t = setTimeout(() => process.exit(0), 5000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  clearTimeout(t);
  try {
    const data = JSON.parse(input);
    const cwd = data.cwd || (data.workspaceRoots || [])[0] || process.cwd();
    const sp = path.join(cwd, '.planning', 'STATE.md');
    if (!fs.existsSync(sp)) { out(''); process.exit(0); }
    const state = fs.readFileSync(sp, 'utf8').trim();
    const phase = (state.match(/current_phase:\\s*(\\S+)/) || [])[1];
    const step = (state.match(/current_step:\\s*(\\S+)/) || [])[1];
    let plan = '';
    if (phase && (step === 'execute' || step === 'verify')) {
      const pp = path.join(cwd, '.planning', 'PLANS', 'phase-' + String(phase).padStart(2,'0') + '.xml');
      if (fs.existsSync(pp)) {
        const c = fs.readFileSync(pp, 'utf8');
        plan = '\\n\\n### Active Phase Plan\\n\`\`\`xml\\n' + c.slice(0,3000) + (c.length>3000?'\\n...[truncated]':'') + '\\n\`\`\`';
      }
    }
    out('## GSD Project Context\\n\\nA GSD workflow is active. Current state:\\n\\n\`\`\`\\n' + state + '\\n\`\`\`' + plan +
      '\\n\\nUse /gsd-next to advance, or /gsd-<command> for a specific step.');
  } catch (_) { out(''); }
  process.exit(0);
});
function out(c) { process.stdout.write(JSON.stringify({ cancel: false, contextModification: c })); }
`

const HOOK_USER_PROMPT_SUBMIT = `#!/usr/bin/env node
// GSD v1.5 UserPromptSubmit hook — detect /gsd-* and inject planning context.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
let input = '';
const t = setTimeout(() => process.exit(0), 5000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  clearTimeout(t);
  try {
    const data = JSON.parse(input);
    const prompt = (data.userPromptSubmit || {}).prompt || '';
    const cwd = data.cwd || (data.workspaceRoots || [])[0] || process.cwd();
    const m = prompt.match(/(^|\\s)\\/gsd-([a-zA-Z0-9-]+)/);
    if (!m) { out(''); process.exit(0); }
    const cmd = 'gsd-' + m[2];
    const pd = path.join(cwd, '.planning');
    let ctx = '## GSD Context for /' + cmd + '\\n\\n';
    const bootstrapCommands = new Set(['gsd-new-project', 'gsd-map-project', 'gsd-map-codebase']);
    if (cmd === 'gsd-map-project') {
      const inventory = runSdkQuery(cwd, 'init.map-project');
      if (inventory) {
        ctx += '### Project Inventory\\n\`\`\`json\\n' + truncate(inventory, 12000) + '\\n\`\`\`\\n\\n';
        ctx += 'Use this SDK inventory as the bounded project map source. Do not deep-read large files unless the user asks for a focused follow-up.\\n\\n';
      } else {
        ctx += '### Project Inventory\\nRun \`gsd-sdk query init.map-project\` before deciding whether this is a code, document, mixed, empty, or unclear workspace.\\n\\n';
      }
    }
    if (cmd === 'gsd-map-codebase') {
      const inventory = runSdkQuery(cwd, 'init.map-codebase');
      if (inventory) {
        ctx += '### Codebase Map Bootstrap\\n\`\`\`json\\n' + truncate(inventory, 8000) + '\\n\`\`\`\\n\\n';
      } else {
        ctx += '### Codebase Map Bootstrap\\nRun \`gsd-sdk query init.map-codebase\` before spawning mapper work.\\n\\n';
      }
    }
    const sp = path.join(pd, 'STATE.md');
    let state = '';
    if (fs.existsSync(sp)) {
      state = fs.readFileSync(sp, 'utf8').trim();
      ctx += '### Current State\\n\`\`\`\\n' + state + '\\n\`\`\`\\n\\n';
    } else if (!bootstrapCommands.has(cmd)) {
      ctx += '### No GSD Project\\nRun /gsd-new-project to initialize.\\n\\n';
    }
    if (cmd.includes('execute') || cmd.includes('plan') || cmd.includes('verify')) {
      const ph = (state.match(/current_phase:\\s*(\\S+)/) || [])[1];
      if (ph) {
        const pp = path.join(pd, 'PLANS', 'phase-' + String(ph).padStart(2,'0') + '.xml');
        if (fs.existsSync(pp)) {
          const c = fs.readFileSync(pp, 'utf8');
          ctx += '### Phase ' + ph + ' Plan\\n\`\`\`xml\\n' + c.slice(0,4000) + (c.length>4000?'\\n...[truncated]':'') + '\\n\`\`\`\\n\\n';
        }
      }
    }
    if (cmd.includes('discuss') || cmd.includes('next') || cmd.includes('new-project')) {
      const rp = path.join(pd, 'ROADMAP.md');
      if (fs.existsSync(rp)) {
        const r = fs.readFileSync(rp, 'utf8');
        ctx += '### Roadmap\\n' + r.slice(0,2000) + (r.length>2000?'\\n...[truncated]':'') + '\\n\\n';
      }
    }
    out(ctx);
  } catch (_) { out(''); }
  process.exit(0);
});
function out(c) { process.stdout.write(JSON.stringify({ cancel: false, contextModification: c })); }
function runSdkQuery(cwd, query) {
  const jsCandidates = [
    path.join(cwd, '.tasktronaut', 'bin', 'gsd-sdk.js'),
    path.join(cwd, '..', '.tasktronaut', 'bin', 'gsd-sdk.js'),
    path.join(cwd, '..', '..', '.tasktronaut', 'bin', 'gsd-sdk.js'),
  ];
  for (const script of jsCandidates) {
    const nodeResult = spawnSync('node', [script, 'query', query], {
      cwd,
      encoding: 'utf8',
      timeout: 2500,
      windowsHide: true,
    });
    if (nodeResult.status === 0 && nodeResult.stdout && nodeResult.stdout.trim()) {
      return nodeResult.stdout.trim();
    }
  }
  const wrapperCandidates = [
    path.join(cwd, '.tasktronaut', 'bin', 'gsd-sdk'),
    path.join(cwd, '..', '.tasktronaut', 'bin', 'gsd-sdk'),
    path.join(cwd, '..', '..', '.tasktronaut', 'bin', 'gsd-sdk'),
    'gsd-sdk',
  ];
  for (const bin of wrapperCandidates) {
    const wrapperResult = spawnSync(bin, ['query', query], {
      cwd,
      encoding: 'utf8',
      timeout: 2500,
      windowsHide: true,
    });
    if (wrapperResult.status === 0 && wrapperResult.stdout && wrapperResult.stdout.trim()) {
      return wrapperResult.stdout.trim();
    }
  }
  return '';
}
function truncate(value, max) {
  if (!value || value.length <= max) return value || '';
  return value.slice(0, max) + '\\n...[truncated]';
}
`

const HOOK_POST_TOOL_USE = `#!/usr/bin/env node
// GSD v1.5 PostToolUse hook — detect stuck loops from repetitive file writes.
const fs = require('fs');
const os = require('os');
const path = require('path');
const WARN_AT = 3;
let input = '';
const t = setTimeout(() => process.exit(0), 5000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  clearTimeout(t);
  try {
    const data = JSON.parse(input);
    const sid = data.session_id;
    const tool = (data.postToolUse || {}).tool_name || '';
    if (!['write_to_file','apply_diff','str_replace_editor','create_file'].includes(tool)) { out(''); process.exit(0); }
    const fp = ((data.postToolUse || {}).tool_input || {}).path ||
               ((data.postToolUse || {}).tool_input || {}).file_path || '';
    if (!fp || !sid || /\\.\\.|[\\/\\\\]/.test(sid)) { out(''); process.exit(0); }
    if (/\\.\\./.test(fp)) { out(''); process.exit(0); }
    const tmp = path.join(os.tmpdir(), 'gsd-writes-' + sid + '.json');
    let w = {};
    try { if (fs.existsSync(tmp)) w = JSON.parse(fs.readFileSync(tmp,'utf8')); } catch(_){}
    w[fp] = (w[fp] || 0) + 1;
    try { fs.writeFileSync(tmp, JSON.stringify(w)); } catch(_){}
    if (w[fp] >= WARN_AT) {
      out('## GSD Loop Warning\\n\\n\`' + fp + '\` written **' + w[fp] + ' times** this session.\\n\\n' +
        '**Actions:**\\n1. Verify output meets acceptance criteria.\\n' +
        '2. Run /gsd-verify-work to check criteria.\\n' +
        '3. If blocked: document in STATE.md and ask user for input.');
    } else { out(''); }
  } catch(_) { out(''); }
  process.exit(0);
});
function out(c) { process.stdout.write(JSON.stringify({ cancel: false, contextModification: c })); }
`

const GSD_SDK_SHIM = String.raw`#!/usr/bin/env node
// gsd-sdk shim — bundled with Tasktronaut. Implements gsd-sdk query commands
// using pure filesystem/git so workflows run without the get-shit-done-cc npm package.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createHash } = require('crypto');
const { execSync, spawnSync } = require('child_process');

const args = process.argv.slice(2);
const subcmd = args[0];
if (subcmd !== 'query') { process.stderr.write('Usage: gsd-sdk query <command>\\n\\nAll commands use the "query" prefix. State mutations are fully supported:\\n  gsd-sdk query state.advance-plan\\n  gsd-sdk query state.update-progress\\n  gsd-sdk query state.add-decision "text"\\n  gsd-sdk query state.record-session "" "Stopped at" "None"\\n  gsd-sdk query commit "message" --files file1 file2\\n  gsd-sdk query roadmap.update-plan-progress <phase>\\n  gsd-sdk query init.resume    (read project state)\\n'); process.exit(0); }

const SPACED_QUERY_GROUPS = new Set(['check', 'detect', 'frontmatter', 'init', 'learnings', 'phase', 'phases', 'plan', 'roadmap', 'route', 'state', 'summary', 'todo', 'uat', 'validate', 'verify', 'workstream']);
function normalizeQueryArgs(argv) {
  const rawQuery = argv[1];
  const subcommand = argv[2];
  if (rawQuery === 'scaffold') {
    return {
      rawQuery,
      query: 'phase.scaffold',
      rest: argv.slice(2),
    };
  }
  if (rawQuery === 'state' && !subcommand) {
    return {
      rawQuery,
      query: 'state.load',
      rest: [],
    };
  }
  if ((rawQuery === 'progress' || rawQuery === 'stats') && subcommand && !String(subcommand).startsWith('--')) {
    return {
      rawQuery,
      query: rawQuery + '.' + subcommand,
      rest: argv.slice(3),
    };
  }
  if (SPACED_QUERY_GROUPS.has(rawQuery) && subcommand && !String(subcommand).startsWith('--')) {
    return {
      rawQuery,
      query: rawQuery + '.' + subcommand,
      rest: argv.slice(3),
    };
  }
  return {
    rawQuery,
    query: rawQuery,
    rest: argv.slice(2),
  };
}
const { query, rest } = normalizeQueryArgs(args);
const cwd = process.cwd();

function exists(p, type) {
  try { const s = fs.statSync(p); return type === 'd' ? s.isDirectory() : s.isFile(); } catch { return false; }
}
function hasOwnGitMarker(dir) {
  const marker = path.join(dir, '.git');
  return exists(marker, 'd') || exists(marker, 'f');
}
function findGitRoot(startDir) {
  let current = path.resolve(startDir);
  while (true) {
    if (hasOwnGitMarker(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  try {
    const probe = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: startDir,
      encoding: 'utf8',
    });
    if (probe.status === 0) {
      const top = String(probe.stdout || '').trim();
      return top ? path.resolve(top) : null;
    }
  } catch {}
  return null;
}
function hasGitRepo(startDir) {
  return Boolean(findGitRoot(startDir));
}
function hasProjectMarker(dir) {
  const markers = [
    'package.json',
    'Cargo.toml',
    'go.mod',
    'pyproject.toml',
    'requirements.txt',
    'Pipfile',
    'poetry.lock',
    'Gemfile',
    'pom.xml',
    'build.gradle',
    'build.gradle.kts',
    'composer.json',
    'mix.exs',
    'deno.json',
    'deno.jsonc',
  ];
  if (markers.some((name) => exists(path.join(dir, name), 'f'))) return true;
  try {
    return fs.readdirSync(dir).some((name) => name.endsWith('.sln') || name.endsWith('.csproj') || name.endsWith('.fsproj'));
  } catch {
    return false;
  }
}
function hasCode(dir, depth) {
  if (depth > 3) return false;
  const skip = new Set(['node_modules', '.git', '.planning', '.tasktronaut', 'dist', 'build', 'target']);
  const codeExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.rb', '.java', '.cs', '.cpp', '.c', '.h', '.hpp']);
  try {
    for (const ent of fs.readdirSync(dir)) {
      if (skip.has(ent)) continue;
      const full = path.join(dir, ent);
      const s = fs.statSync(full);
      if (s.isFile() && codeExtensions.has(path.extname(ent))) return true;
      if (s.isDirectory() && hasCode(full, depth + 1)) return true;
    }
  } catch { return false; }
  return false;
}
function detectProjectTypeFromEntries(entries) {
  const codeMarkers = [
    'package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'requirements.txt', 'Pipfile', 'poetry.lock',
    'Gemfile', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'composer.json', 'mix.exs', 'deno.json', 'deno.jsonc',
  ];
  const codeExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.rb', '.java', '.cs', '.cpp', '.c', '.h', '.hpp', '.swift', '.kt', '.kts', '.php', '.ex', '.exs']);
  const documentExtensions = new Set(['.docx', '.doc', '.pdf', '.xlsx', '.xls', '.pptx', '.ppt', '.md', '.txt', '.rtf', '.odt', '.ods', '.odp', '.csv']);
  const codeFiles = entries.filter((entry) => entry.type === 'file' && codeExtensions.has(entry.ext));
  const markerFiles = entries.filter((entry) => entry.type === 'file' && codeMarkers.includes(entry.name));
  const docFiles = entries.filter((entry) => entry.type === 'file' && documentExtensions.has(entry.ext));
  const docExtCounts = {};
  for (const entry of docFiles) docExtCounts[entry.ext || '[none]'] = (docExtCounts[entry.ext || '[none]'] || 0) + 1;
  const codeExtCounts = {};
  for (const entry of codeFiles) codeExtCounts[entry.ext || '[none]'] = (codeExtCounts[entry.ext || '[none]'] || 0) + 1;
  const hasProgrammingSignals = markerFiles.length > 0 || codeFiles.length > 0;
  const hasDocumentSignals = docFiles.length > 0;
  let projectKind = 'unclear';
  if (entries.length === 0) projectKind = 'empty';
  else if (hasProgrammingSignals && hasDocumentSignals) projectKind = 'mixed';
  else if (hasProgrammingSignals) projectKind = 'code';
  else if (hasDocumentSignals) projectKind = 'documents';
  return {
    project_kind: projectKind,
    has_programming_signals: hasProgrammingSignals,
    has_document_signals: hasDocumentSignals,
    code_markers: markerFiles.map((entry) => entry.path),
    code_file_count: codeFiles.length,
    document_file_count: docFiles.length,
    code_extensions: codeExtCounts,
    document_extensions: docExtCounts,
  };
}
function collectProjectInventory() {
  const skipDirs = new Set(['.git', 'node_modules', 'dist', 'build', 'target', '.tasktronaut']);
  const entries = [];
  const maxEntries = 400;
  const maxDepth = 4;
  function visit(dir, rel, depth) {
    if (entries.length >= maxEntries || depth > maxDepth) return;
    let dirents = [];
    try { dirents = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { return; }
    for (const entry of dirents) {
      if (entries.length >= maxEntries) break;
      if (entry.name === '.planning') continue;
      const entryRel = rel ? path.join(rel, entry.name) : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        entries.push({ path: entryRel, name: entry.name, type: 'directory', depth, ext: '' });
        if (!skipDirs.has(entry.name)) visit(full, entryRel, depth + 1);
      } else if (entry.isFile()) {
        let bytes = 0;
        try { bytes = fs.statSync(full).size; } catch {}
        entries.push({ path: entryRel, name: entry.name, type: 'file', depth, ext: path.extname(entry.name).toLowerCase(), bytes });
      }
    }
  }
  visit(cwd, '', 0);
  const dirs = entries.filter((entry) => entry.type === 'directory');
  const files = entries.filter((entry) => entry.type === 'file');
  const classification = detectProjectTypeFromEntries(entries);
  const treeLines = entries.slice(0, 120).map((entry) => {
    const indent = '  '.repeat(Math.max(0, entry.depth));
    return indent + (entry.type === 'directory' ? entry.name + '/' : entry.name);
  });
  return {
    has_entries: entries.length > 0,
    entries_scanned: entries.length,
    truncated: entries.length >= maxEntries,
    directory_count: dirs.length,
    file_count: files.length,
    top_level_directories: dirs.filter((entry) => entry.depth === 0).map((entry) => entry.path).slice(0, 50),
    top_level_files: files.filter((entry) => entry.depth === 0).map((entry) => entry.path).slice(0, 50),
    tree_preview: treeLines,
    recommended_command: classification.has_programming_signals ? '/gsd-map-codebase' : null,
    ...classification,
  };
}
function safeReadJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return fallback; }
}
const SECRET_SCAN_PATTERNS = [
  { id: 'openai_api_key', pattern: /sk-[a-zA-Z0-9]{20,}|sk_live_[a-zA-Z0-9]+|sk_test_[a-zA-Z0-9]+/g },
  { id: 'github_token', pattern: /ghp_[a-zA-Z0-9]{36}|gho_[a-zA-Z0-9]{36}/g },
  { id: 'gitlab_token', pattern: /glpat-[a-zA-Z0-9_-]+/g },
  { id: 'aws_access_key_id', pattern: /AKIA[A-Z0-9]{16}/g },
  { id: 'slack_token', pattern: /xox[baprs]-[a-zA-Z0-9-]+/g },
  { id: 'private_key_header', pattern: /-----BEGIN[^\n\r]*PRIVATE KEY/g },
  { id: 'jwt_like_token', pattern: /eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\./g },
];
function maskSecretValue(value) {
  const text = String(value || '');
  if (text.length <= 8) return '***';
  return text.slice(0, 4) + '...' + text.slice(-4);
}
function resolveWorkspacePath(candidatePath) {
  const requested = String(candidatePath || '').trim() || '.';
  const resolved = path.resolve(cwd, requested);
  const root = path.resolve(cwd);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return { requested, resolved, error: 'Path is outside the workspace' };
  }
  return { requested, resolved, error: null };
}
function collectSecretScanFiles(dirPath) {
  if (!exists(dirPath, 'd')) return [];
  const files = [];
  const stack = [dirPath];
  const skipDirs = new Set(['.git', 'node_modules', 'dist', 'build', 'target', '.tasktronaut']);
  while (stack.length > 0 && files.length < 500) {
    const current = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) stack.push(full);
      } else if (entry.isFile() && /\.(md|txt|json|ya?ml|toml|env|ini|conf|config)$/i.test(entry.name)) {
        files.push(full);
      }
      if (files.length >= 500) break;
    }
  }
  return files.sort();
}
function securityScanForSecrets(argv) {
  const dirIndex = argv.indexOf('--dir');
  const dirArg = dirIndex >= 0 && argv[dirIndex + 1] ? argv[dirIndex + 1] : (argv[0] || '.planning/codebase');
  const resolved = resolveWorkspacePath(dirArg);
  if (resolved.error) {
    return { ok: false, error: resolved.error, dir: resolved.requested, secrets_found: false, findings_count: 0, findings: [] };
  }
  const files = collectSecretScanFiles(resolved.resolved);
  const findings = [];
  for (const filePath of files) {
    let content = '';
    try { content = fs.readFileSync(filePath, 'utf8'); } catch { continue; }
    const lines = content.split(/\r?\n/);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      for (const check of SECRET_SCAN_PATTERNS) {
        check.pattern.lastIndex = 0;
        let match;
        while ((match = check.pattern.exec(line)) && findings.length < 100) {
          findings.push({
            file: path.relative(cwd, filePath),
            line: lineIndex + 1,
            pattern: check.id,
            match: maskSecretValue(match[0]),
          });
        }
      }
    }
  }
  return {
    ok: true,
    dir: resolved.requested,
    scanned_files: files.length,
    secrets_found: findings.length > 0,
    findings_count: findings.length,
    findings,
    truncated: findings.length >= 100,
  };
}
function listSubagentExecutionRuns() {
  const registryPath = path.join(cwd, '.tasktronaut', 'runtime', 'subagent-executions.json');
  const registry = safeReadJson(registryPath, { runs: [] });
  if (Array.isArray(registry)) return registry;
  return Array.isArray(registry.runs) ? registry.runs : [];
}
function parseFlagValues(argv, flagName) {
  const values = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flagName && argv[i + 1] != null) {
      values.push(String(argv[i + 1]));
      i += 1;
    }
  }
  return values;
}
function filterSubagentExecutionRuns(argv) {
  const roleFilters = parseFlagValues(argv, '--role');
  const phaseFilters = parseFlagValues(argv, '--phase');
  const planFilters = parseFlagValues(argv, '--plan');
  const statusValues = parseFlagValues(argv, '--status');
  const statusFilters = statusValues.flatMap((value) => String(value).split(',')).map((value) => value.trim()).filter(Boolean);
  const worktreeOnly = argv.includes('--worktree-only');
  const activeOnly = argv.includes('--active-only');
  const runs = listSubagentExecutionRuns();
  return runs.filter((run) => {
    if (!run || typeof run !== 'object') return false;
    if (roleFilters.length > 0 && !roleFilters.includes(String(run.role || ''))) return false;
    if (phaseFilters.length > 0 && !phaseFilters.includes(String(run.phase_number || ''))) return false;
    if (planFilters.length > 0 && !planFilters.includes(String(run.plan_id || ''))) return false;
    if (statusFilters.length > 0 && !statusFilters.includes(String(run.status || ''))) return false;
    if (worktreeOnly && String(run.isolation || '') !== 'worktree' && !String(run.worktree_path || '').trim()) return false;
    if (activeOnly && !['running', 'completed'].includes(String(run.status || ''))) return false;
    return true;
  }).sort((left, right) => Number(right.updated_at_unix_ms || 0) - Number(left.updated_at_unix_ms || 0));
}
function getTodayDate() {
  return new Date().toISOString().slice(0, 10);
}
function getInstalledAgentStatus(requiredAgents) {
  const agentsDir = path.join(cwd, '.tasktronaut', 'agents');
  const missingAgents = requiredAgents.filter((agent) => !exists(path.join(agentsDir, agent + '.md'), 'f'));
  return { agents_installed: missingAgents.length === 0, missing_agents: missingAgents };
}
function listExistingMaps() {
  const codebaseDir = path.join(cwd, '.planning', 'codebase');
  if (!exists(codebaseDir, 'd')) return [];
  try {
    return fs.readdirSync(codebaseDir).filter((name) => name.endsWith('.md'));
  } catch { return []; }
}
function listExistingMapDetails() {
  const codebaseDir = path.join(cwd, '.planning', 'codebase');
  if (!exists(codebaseDir, 'd')) return [];
  try {
    return fs.readdirSync(codebaseDir)
      .filter((name) => name.endsWith('.md'))
      .sort()
      .map((name) => {
        const filePath = path.join(codebaseDir, name);
        let content = '';
        let size = 0;
        try {
          content = fs.readFileSync(filePath, 'utf8');
          size = fs.statSync(filePath).size;
        } catch {}
        return {
          name,
          path: path.join('.planning', 'codebase', name),
          lines: content ? content.split(/\r?\n/).length : 0,
          bytes: size,
        };
      });
  } catch { return []; }
}
function getResearchEnabled() {
  const cfg = safeReadJson(path.join(cwd, '.planning', 'config.json'), {});
  const workflowCfg = cfg.workflow || {};
  return workflowCfg.research !== false;
}
function countPhaseDirs() {
  const phasesDir = path.join(cwd, '.planning', 'phases');
  if (!exists(phasesDir, 'd')) return 0;
  try {
    return fs.readdirSync(phasesDir)
      .filter((name) => exists(path.join(phasesDir, name), 'd'))
      .length;
  } catch { return 0; }
}
function getLatestCompletedMilestone() {
  const milestonesPath = path.join(cwd, '.planning', 'MILESTONES.md');
  if (!exists(milestonesPath, 'f')) return '';
  const content = fs.readFileSync(milestonesPath, 'utf8');
  const matches = Array.from(content.matchAll(/^##s+(vd+(?:.d+)*)\b/gm));
  return matches.length > 0 ? matches[matches.length - 1][1] : '';
}
function normalizePhaseNumber(rawPhase) {
  const phase = String(rawPhase || '').trim();
  if (!phase) return '';
  if (new RegExp('^\\d+$').test(phase)) return String(Number(phase)).padStart(2, '0');
  const decimalMatch = phase.match(new RegExp('^(\\d+)\\.(\\d+)$'));
  if (decimalMatch) return String(Number(decimalMatch[1])).padStart(2, '0') + '.' + decimalMatch[2];
  return phase;
}
function findPhaseDirectory(rawPhase) {
  const normalized = normalizePhaseNumber(rawPhase);
  const phasesDir = path.join(cwd, '.planning', 'phases');
  if (!normalized || !exists(phasesDir, 'd')) {
    return { found: false, normalized, phaseDir: '', phaseName: '', phaseSlug: '' };
  }
  try {
    const entry = fs.readdirSync(phasesDir).find((name) => name.startsWith(normalized + '-'));
    if (!entry) {
      return { found: false, normalized, phaseDir: '', phaseName: '', phaseSlug: '' };
    }
    const phaseSlug = entry.slice((normalized + '-').length);
    const phaseName = phaseSlug.replace(/-/g, ' ').trim();
    return {
      found: true,
      normalized,
      phaseDir: path.join('.planning', 'phases', entry),
      phaseName,
      phaseSlug,
    };
  } catch {
    return { found: false, normalized, phaseDir: '', phaseName: '', phaseSlug: '' };
  }
}
function firstExistingPath(paths) {
  for (const candidate of paths) {
    if (candidate && exists(path.join(cwd, candidate), 'f')) return candidate;
  }
  return null;
}
function readConfig() {
  const cfg = safeReadJson(path.join(cwd, '.planning', 'config.json'), {});
  const workflowCfg = cfg.workflow && typeof cfg.workflow === 'object' ? cfg.workflow : {};
  const workflowDefaults = {
    research: workflowCfg.research !== false,
    plan_check: workflowCfg.plan_check !== false,
    nyquist_validation: workflowCfg.nyquist_validation !== false,
    text_mode: workflowCfg.text_mode === true,
    auto_advance: workflowCfg.auto_advance === true,
    auto_chain_active: workflowCfg.auto_chain_active === true || workflowCfg._auto_chain_active === true,
    _auto_chain_active: workflowCfg.auto_chain_active === true || workflowCfg._auto_chain_active === true,
    discuss_mode: workflowCfg.discuss_mode || 'discuss',
    ai_integration_phase: workflowCfg.ai_integration_phase !== false,
    ui_phase: workflowCfg.ui_phase !== false,
    ui_safety_gate: workflowCfg.ui_safety_gate !== false,
    pattern_mapper: workflowCfg.pattern_mapper !== false,
    tdd_mode: workflowCfg.tdd_mode === true,
    plan_chunked: workflowCfg.plan_chunked === true,
    security_enforcement: workflowCfg.security_enforcement !== false,
    security_asvs_level: workflowCfg.security_asvs_level == null ? 1 : workflowCfg.security_asvs_level,
    security_block_on: workflowCfg.security_block_on || 'high',
    context_coverage_gate: workflowCfg.context_coverage_gate !== false,
    post_planning_gaps: workflowCfg.post_planning_gaps !== false,
    plan_bounce_passes: workflowCfg.plan_bounce_passes == null ? 2 : workflowCfg.plan_bounce_passes,
    plan_bounce_script: workflowCfg.plan_bounce_script || '',
  };
  return {
    ...cfg,
    model_profile: typeof cfg.model_profile === 'string' ? cfg.model_profile : 'balanced',
    model_overrides: cfg.model_overrides && typeof cfg.model_overrides === 'object' ? cfg.model_overrides : {},
    workflow: {
      ...workflowDefaults,
      ...workflowCfg,
      _auto_chain_active: workflowDefaults._auto_chain_active,
    },
    commit_docs: cfg.commit_docs !== false,
    context_window: cfg.context_window == null ? 200000 : cfg.context_window,
    response_language: cfg.response_language == null ? null : cfg.response_language,
    workflowDefaults,
  };
}
const MODEL_PROFILES = {
  'gsd-planner': { quality: 'opus', balanced: 'opus', budget: 'sonnet', adaptive: 'opus' },
  'gsd-roadmapper': { quality: 'opus', balanced: 'sonnet', budget: 'sonnet', adaptive: 'sonnet' },
  'gsd-executor': { quality: 'opus', balanced: 'sonnet', budget: 'sonnet', adaptive: 'sonnet' },
  'gsd-phase-researcher': { quality: 'opus', balanced: 'sonnet', budget: 'haiku', adaptive: 'sonnet' },
  'gsd-project-researcher': { quality: 'opus', balanced: 'sonnet', budget: 'haiku', adaptive: 'sonnet' },
  'gsd-research-synthesizer': { quality: 'sonnet', balanced: 'sonnet', budget: 'haiku', adaptive: 'haiku' },
  'gsd-debugger': { quality: 'opus', balanced: 'sonnet', budget: 'sonnet', adaptive: 'opus' },
  'gsd-codebase-mapper': { quality: 'sonnet', balanced: 'haiku', budget: 'haiku', adaptive: 'haiku' },
  'gsd-verifier': { quality: 'sonnet', balanced: 'sonnet', budget: 'haiku', adaptive: 'sonnet' },
  'gsd-plan-checker': { quality: 'sonnet', balanced: 'sonnet', budget: 'haiku', adaptive: 'haiku' },
  'gsd-integration-checker': { quality: 'sonnet', balanced: 'sonnet', budget: 'haiku', adaptive: 'haiku' },
  'gsd-nyquist-auditor': { quality: 'sonnet', balanced: 'sonnet', budget: 'haiku', adaptive: 'haiku' },
  'gsd-pattern-mapper': { quality: 'sonnet', balanced: 'sonnet', budget: 'haiku', adaptive: 'haiku' },
  'gsd-ui-researcher': { quality: 'opus', balanced: 'sonnet', budget: 'haiku', adaptive: 'sonnet' },
  'gsd-ui-checker': { quality: 'sonnet', balanced: 'sonnet', budget: 'haiku', adaptive: 'haiku' },
  'gsd-ui-auditor': { quality: 'sonnet', balanced: 'sonnet', budget: 'haiku', adaptive: 'haiku' },
  'gsd-doc-writer': { quality: 'opus', balanced: 'sonnet', budget: 'haiku', adaptive: 'sonnet' },
  'gsd-doc-verifier': { quality: 'sonnet', balanced: 'sonnet', budget: 'haiku', adaptive: 'haiku' },
};
const VALID_MODEL_PROFILES = [...Object.keys(MODEL_PROFILES['gsd-planner']), 'inherit'];
const AGENT_MODEL_ALIASES = {
  'gsd-advisor-researcher': 'gsd-phase-researcher',
  'gsd-ui-researcher': 'gsd-ui-researcher',
  'gsd-ui-checker': 'gsd-ui-checker',
  'gsd-ui-auditor': 'gsd-ui-auditor',
  'gsd-security-auditor': 'gsd-verifier',
  'gsd-nyquist-auditor': 'gsd-nyquist-auditor',
  'gsd-framework-selector': 'gsd-planner',
  'gsd-ai-researcher': 'gsd-phase-researcher',
  'gsd-domain-researcher': 'gsd-phase-researcher',
  'gsd-eval-planner': 'gsd-planner',
  'gsd-eval-auditor': 'gsd-verifier',
  'gsd-integration-checker': 'gsd-integration-checker',
  'gsd-debugger': 'gsd-debugger',
  'gsd-pattern-mapper': 'gsd-pattern-mapper',
};
function normalizeModelProfile(rawProfile) {
  const profile = String(rawProfile || '').trim().toLowerCase();
  return VALID_MODEL_PROFILES.includes(profile) ? profile : 'balanced';
}
function getProfileModel(agentName, profile, fallbackModel) {
  if (profile === 'inherit') return 'inherit';
  const lookupAgent = MODEL_PROFILES[agentName]
    ? agentName
    : (AGENT_MODEL_ALIASES[agentName] || '');
  const profileMap = lookupAgent ? MODEL_PROFILES[lookupAgent] : null;
  if (!profileMap) return fallbackModel;
  return profileMap[profile] || profileMap.balanced || fallbackModel;
}
function getConfiguredAgentModel(agentName, fallbackModel) {
  const config = readConfig();
  const overrides = config.model_overrides && typeof config.model_overrides === 'object' ? config.model_overrides : {};
  const directOverride = typeof overrides[agentName] === 'string' ? overrides[agentName].trim() : '';
  if (directOverride) return directOverride;
  const alias = AGENT_MODEL_ALIASES[agentName];
  const aliasOverride = alias && typeof overrides[alias] === 'string' ? overrides[alias].trim() : '';
  if (aliasOverride) return aliasOverride;
  if (config.resolve_model_ids === 'omit') return '';
  const profile = normalizeModelProfile(config.model_profile);
  return getProfileModel(agentName, profile, fallbackModel);
}
function getConfigValue(pathKey, defaultValue) {
  const cfg = readConfig();
  const keys = String(pathKey || '').split('.').filter(Boolean);
  let value = cfg;
  for (const key of keys) {
    if (!value || typeof value !== 'object' || !(key in value)) return defaultValue;
    value = value[key];
  }
  return value == null ? defaultValue : value;
}
function getConfigFlag(pathKey, defaultValue) {
  const value = getConfigValue(pathKey, defaultValue);
  return typeof value === 'boolean' ? value : defaultValue;
}
function buildDefaultConfig() {
  return {
    commit_docs: true,
    model_profile: 'balanced',
    workflow: {
      research: true,
      plan_check: true,
      verifier: true,
      nyquist_validation: true,
      auto_advance: false,
      text_mode: false,
      use_worktrees: true,
      drift_threshold: 3,
      drift_action: 'warn',
    },
    git: {
      branching_strategy: 'none',
    },
  };
}
function ensureConfigSection() {
  const configPath = path.join(cwd, '.planning', 'config.json');
  const planningDir = path.dirname(configPath);
  if (!exists(planningDir, 'd')) {
    fs.mkdirSync(planningDir, { recursive: true });
  }
  if (!exists(configPath, 'f')) {
    fs.writeFileSync(configPath, JSON.stringify(buildDefaultConfig(), null, 2) + '\n', 'utf8');
    return { created: true, config_path: '.planning/config.json' };
  }
  try {
    const current = safeReadJson(configPath, {});
    const merged = {
      ...buildDefaultConfig(),
      ...current,
      workflow: {
        ...buildDefaultConfig().workflow,
        ...(current && typeof current.workflow === 'object' ? current.workflow : {}),
      },
      git: {
        ...buildDefaultConfig().git,
        ...(current && typeof current.git === 'object' ? current.git : {}),
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
    return { created: false, config_path: '.planning/config.json', normalized: true };
  } catch {
    fs.writeFileSync(configPath, JSON.stringify(buildDefaultConfig(), null, 2) + '\n', 'utf8');
    return { created: false, repaired: true, config_path: '.planning/config.json' };
  }
}
function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^$(){}|[\\]\\\\]/g, '\\\\$&');
}
function stripCommentsAndFences(text) {
  return String(text || '')
    .replace(/<!--[\\s\\S]*?-->/g, ' ')
    .replace(new RegExp('\\\\x60{3}[\\\\s\\\\S]*?\\\\x60{3}', 'g'), ' ')
    .replace(/~~~[\\s\\S]*?~~~/g, ' ');
}
function extractDecisionsBlock(content) {
  const cleaned = stripCommentsAndFences(content);
  const matches = [...cleaned.matchAll(new RegExp('<decisions>([\\\\s\\\\S]*?)<\\\\/decisions>', 'g'))];
  if (matches.length === 0) return null;
  return matches.map((match) => match[1]).join('\\n\\n');
}
function parseContextDecisions(content) {
  const block = extractDecisionsBlock(content);
  if (!block) return [];
  const lines = block.split(/\\r?\\n/);
  const out = [];
  let category = '';
  let inDiscretion = false;
  let current = null;
  const bulletRe = new RegExp('^\\\\s*-\\\\s+\\\\*\\\\*D-(\\\\d+)(?:\\\\s*\\\\[([^\\\\]]+)\\\\])?\\\\s*:\\\\*\\\\*\\\\s*(.*)$');
  const nonTrackableTags = new Set(['informational', 'folded', 'deferred']);
  const discretionHeadings = new Set([
    'claudes discretion',
    'claude discretion',
  ]);
  function flushDecision() {
    if (!current) return;
    current.text = current.text.trim();
    out.push(current);
    current = null;
  }
  for (const line of lines) {
    const trimmed = line.trim();
    const headingMatch = trimmed.match(/^###\\s+(.+?)\\s*$/);
    if (headingMatch) {
      flushDecision();
      category = headingMatch[1];
      const normalizedHeading = category.toLowerCase().replace(/[\\u2018\\u2019\\u201A\\u201B\\u201C\\u201D\\u201E\\u201F'"]/g, '').trim();
      inDiscretion = discretionHeadings.has(normalizedHeading);
      continue;
    }
    const bulletMatch = line.match(bulletRe);
    if (bulletMatch) {
      flushDecision();
      const tags = bulletMatch[2]
        ? bulletMatch[2].split(',').map((tag) => tag.trim().toLowerCase()).filter(Boolean)
        : [];
      current = {
        id: 'D-' + bulletMatch[1],
        text: bulletMatch[3] || '',
        category,
        tags,
        trackable: !inDiscretion && !tags.some((tag) => nonTrackableTags.has(tag)),
      };
      continue;
    }
    if (current && trimmed !== '' && !trimmed.startsWith('-') && /^[ \\t]/.test(line)) {
      current.text += ' ' + trimmed;
      continue;
    }
    if (trimmed === '') {
      flushDecision();
    }
  }
  flushDecision();
  return out;
}
function normalizePhrase(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\\s]/g, ' ')
    .replace(/\\s+/g, ' ')
    .trim();
}
function softPhrase(text) {
  const words = normalizePhrase(text).split(' ').filter(Boolean);
  if (words.length < 6) return '';
  return words.slice(0, 6).join(' ');
}
function decisionMentioned(haystack, decision) {
  if (!haystack || !decision) return false;
  const idRegex = new RegExp('\\\\b' + escapeRegex(decision.id) + '\\\\b');
  if (idRegex.test(haystack)) return true;
  const phrase = softPhrase(decision.text);
  if (!phrase) return false;
  return normalizePhrase(haystack).includes(phrase);
}
function extractYamlBlock(frontmatterContent, key) {
  const keyRegex = new RegExp('^' + escapeRegex(key) + '\\\\s*:(.*)$', 'm');
  const match = frontmatterContent.match(keyRegex);
  if (!match) return '';
  const startIdx = (match.index || 0) + match[0].length;
  const sameLine = match[1] || '';
  const rest = frontmatterContent.slice(startIdx + 1).split(/\\r?\\n/);
  const block = [sameLine];
  for (const line of rest) {
    if (line === '' || /^\\s/.test(line)) {
      block.push(line);
    } else {
      break;
    }
  }
  return block.join('\\n');
}
function extractPlanCoverageSections(planContent) {
  const cleaned = stripCommentsAndFences(planContent);
  const frontmatterMatch = cleaned.match(/^---\\r?\\n([\\s\\S]*?)\\r?\\n---\\r?\\n?([\\s\\S]*)$/);
  const frontmatterContent = frontmatterMatch ? frontmatterMatch[1] : '';
  const body = frontmatterMatch ? frontmatterMatch[2] : cleaned;
  const frontmatterParts = [];
  for (const key of ['must_haves', 'truths', 'objective']) {
    const block = extractYamlBlock(frontmatterContent, key);
    if (block) frontmatterParts.push(block);
  }
  const designatedHeadingRegex = /^#{1,6}\\s+(?:must[_ ]haves?|truths?|tasks?|objective)\\b/i;
  const bodyParts = [];
  let inDesignated = false;
  for (const line of body.split(/\\r?\\n/)) {
    if (/^#{1,6}\\s+/.test(line)) {
      inDesignated = designatedHeadingRegex.test(line);
      if (inDesignated) bodyParts.push(line);
      continue;
    }
    if (inDesignated) bodyParts.push(line);
  }
  return [...frontmatterParts, bodyParts.join('\\n')].join('\\n\\n');
}
function extractMustHavesTruths(planContent) {
  const frontmatterMatch = String(planContent || '').match(/^---\\r?\\n([\\s\\S]*?)\\r?\\n---\\r?\\n?/);
  if (!frontmatterMatch) return [];
  const lines = frontmatterMatch[1].split(/\\r?\\n/);
  const truths = [];
  let inMustHaves = false;
  let inTruths = false;
  for (const line of lines) {
    if (!/^\\s/.test(line) && /^must_haves:\\s*$/.test(line)) {
      inMustHaves = true;
      inTruths = false;
      continue;
    }
    if (inMustHaves && !/^\\s/.test(line) && !/^must_haves:\\s*$/.test(line)) {
      inMustHaves = false;
      inTruths = false;
    }
    if (!inMustHaves) continue;
    if (/^\\s*truths:\\s*$/.test(line)) {
      inTruths = true;
      continue;
    }
    if (!inTruths) continue;
    if (/^\\s{2,}[A-Za-z0-9_-]+:\\s*$/.test(line) && !/^\\s*truths:\\s*$/.test(line)) {
      inTruths = false;
      continue;
    }
    const itemMatch = line.match(/^\\s*-\\s*(.+?)\\s*$/);
    if (itemMatch) truths.push(itemMatch[1].trim());
  }
  return truths;
}
function extractMustHavesArtifacts(content) {
  const match = content.match(/^---\\r?\\n([\\s\\S]*?)\\r?\\n---\\r?\\n?/);
  if (!match) return [];
  const lines = match[1].split(/\\r?\\n/);
  const artifacts = [];
  let inMustHaves = false;
  let inArtifacts = false;
  let current = null;
  for (const line of lines) {
    if (!/^\\s/.test(line) && /^must_haves:\\s*$/.test(line)) {
      inMustHaves = true;
      inArtifacts = false;
      current = null;
      continue;
    }
    if (inMustHaves && !/^\\s/.test(line) && !/^must_haves:\\s*$/.test(line)) {
      inMustHaves = false;
      inArtifacts = false;
      current = null;
    }
    if (!inMustHaves) continue;
    if (/^\\s*artifacts:\\s*$/.test(line)) {
      inArtifacts = true;
      current = null;
      continue;
    }
    if (!inArtifacts) continue;
    const pathMatch = line.match(/^\\s*-\\s*path:\\s*(.+?)\\s*$/);
    if (pathMatch) {
      if (current && current.path) artifacts.push(current);
      current = { path: pathMatch[1].trim() };
      continue;
    }
    const fieldMatch = line.match(/^\\s*(min_lines|contains):\\s*(.+?)\\s*$/);
    if (fieldMatch && current) {
      current[fieldMatch[1]] = fieldMatch[1] === 'min_lines'
        ? parseInt(fieldMatch[2], 10) || 0
        : fieldMatch[2].trim();
      continue;
    }
    const exportsListMatch = line.match(/^\\s*exports:\\s*\\[(.*)\\]\\s*$/);
    if (exportsListMatch && current) {
      current.exports = exportsListMatch[1]
        .split(',')
        .map((item) => item.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
      continue;
    }
    const exportsSingleMatch = line.match(/^\\s*exports:\\s*(.+?)\\s*$/);
    if (exportsSingleMatch && current) {
      current.exports = exportsSingleMatch[1].trim();
      continue;
    }
    if (/^\\s{2,}[A-Za-z0-9_-]+:\\s*$/.test(line) && !/^\\s*(artifacts|truths|key_links):\\s*$/.test(line)) {
      if (current && current.path) artifacts.push(current);
      current = null;
      inArtifacts = false;
    }
  }
  if (current && current.path) artifacts.push(current);
  return artifacts;
}
const SCHEMA_PATTERNS = [
  { pattern: new RegExp('^src/collections/.*\\\\.ts$'), orm: 'payload' },
  { pattern: new RegExp('^src/globals/.*\\\\.ts$'), orm: 'payload' },
  { pattern: new RegExp('^prisma/schema\\\\.prisma$'), orm: 'prisma' },
  { pattern: new RegExp('^prisma/schema/.*\\\\.prisma$'), orm: 'prisma' },
  { pattern: new RegExp('^drizzle/schema\\\\.ts$'), orm: 'drizzle' },
  { pattern: new RegExp('^src/db/schema\\\\.ts$'), orm: 'drizzle' },
  { pattern: new RegExp('^drizzle/.*\\\\.ts$'), orm: 'drizzle' },
  { pattern: new RegExp('^supabase/migrations/.*\\\\.sql$'), orm: 'supabase' },
  { pattern: new RegExp('^src/entities/.*\\\\.ts$'), orm: 'typeorm' },
  { pattern: new RegExp('^src/migrations/.*\\\\.ts$'), orm: 'typeorm' },
];
const ORM_INFO = {
  payload: {
    pushCommand: 'npx payload migrate',
    envHint: 'CI=true PAYLOAD_MIGRATING=true npx payload migrate',
    evidencePatterns: [new RegExp('payload\\\\s+migrate', 'i'), new RegExp('PAYLOAD_MIGRATING')],
  },
  prisma: {
    pushCommand: 'npx prisma db push',
    envHint: 'npx prisma db push --accept-data-loss (if destructive changes are intended)',
    evidencePatterns: [new RegExp('prisma\\\\s+db\\\\s+push', 'i'), new RegExp('prisma\\\\s+migrate\\\\s+deploy', 'i'), new RegExp('prisma\\\\s+migrate\\\\s+dev', 'i')],
  },
  drizzle: {
    pushCommand: 'npx drizzle-kit push',
    envHint: 'npx drizzle-kit push',
    evidencePatterns: [new RegExp('drizzle-kit\\\\s+push', 'i'), new RegExp('drizzle-kit\\\\s+migrate', 'i')],
  },
  supabase: {
    pushCommand: 'supabase db push',
    envHint: 'supabase db push',
    evidencePatterns: [new RegExp('supabase\\\\s+db\\\\s+push', 'i'), new RegExp('supabase\\\\s+migration\\\\s+up', 'i')],
  },
  typeorm: {
    pushCommand: 'npx typeorm migration:run',
    envHint: 'npx typeorm migration:run -d src/data-source.ts',
    evidencePatterns: [new RegExp('typeorm\\\\s+migration:run', 'i'), new RegExp('typeorm\\\\s+schema:sync', 'i')],
  },
};
const DRIFT_CATEGORY_PRIORITY = { new_dir: 0, barrel: 1, route: 2, migration: 3 };
const DRIFT_BARREL_RE = new RegExp('^(packages|apps)/[^/]+/src/index\\\\.(ts|tsx|js|mjs|cjs)$');
const DRIFT_MIGRATION_RES = [
  new RegExp('^supabase/migrations/.+\\\\.sql$'),
  new RegExp('^prisma/migrations/.+'),
  new RegExp('^drizzle/meta/.+'),
  new RegExp('^drizzle/migrations/.+'),
  new RegExp('^src/migrations/.+\\\\.(ts|js|sql)$'),
  new RegExp('^db/migrations/.+\\\\.(sql|ts|js)$'),
  new RegExp('^migrations/.+\\\\.(sql|ts|js)$'),
];
const DRIFT_ROUTE_RES = [
  new RegExp('^(apps|packages)/[^/]+/src/routes/.+\\\\.(ts|tsx|js|jsx|mjs|cjs)$'),
  new RegExp('^src/routes/.+\\\\.(ts|tsx|js|jsx|mjs|cjs)$'),
  new RegExp('^src/api/.+\\\\.(ts|tsx|js|jsx|mjs|cjs)$'),
  new RegExp('^(apps|packages)/[^/]+/src/api/.+\\\\.(ts|tsx|js|jsx|mjs|cjs)$'),
];
function detectSchemaFiles(files) {
  const matches = [];
  const orms = new Set();
  for (const rawFile of Array.isArray(files) ? files : []) {
    const file = String(rawFile || '').replace(/\\\\/g, '/');
    for (const { pattern, orm } of SCHEMA_PATTERNS) {
      if (pattern.test(file)) {
        matches.push(String(rawFile));
        orms.add(orm);
        break;
      }
    }
  }
  return {
    detected: matches.length > 0,
    matches,
    orms: Array.from(orms),
  };
}
function classifyDriftFile(file) {
  if (typeof file !== 'string' || !file) return null;
  const normalized = file.replace(/\\\\/g, '/');
  if (DRIFT_MIGRATION_RES.some((pattern) => pattern.test(normalized))) return 'migration';
  if (DRIFT_ROUTE_RES.some((pattern) => pattern.test(normalized))) return 'route';
  if (DRIFT_BARREL_RE.test(normalized)) return 'barrel';
  return null;
}
function isPathMapped(file, structureMd) {
  const normalized = String(file || '').replace(/\\\\/g, '/');
  const parts = normalized.split('/');
  for (let i = parts.length - 1; i >= 1; i--) {
    const prefix = parts.slice(0, i).join('/');
    if (structureMd.includes(prefix)) return true;
  }
  if (parts.length > 0 && structureMd.includes(parts[0] + '/')) return true;
  if (parts.length > 0 && structureMd.includes(String.fromCharCode(96) + parts[0] + String.fromCharCode(96))) return true;
  return false;
}
function chooseAffectedPaths(paths) {
  const out = new Set();
  for (const raw of Array.isArray(paths) ? paths : []) {
    if (typeof raw !== 'string' || !raw) continue;
    const file = raw.replace(/\\\\/g, '/');
    const parts = file.split('/');
    if (parts.length === 0) continue;
    const top = parts[0];
    if ((top === 'apps' || top === 'packages') && parts.length >= 2) {
      out.add(top + '/' + parts[1]);
    } else {
      out.add(top);
    }
  }
  return Array.from(out).sort();
}
function readMappedCommit(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = parseFrontmatter(content);
    const sha = parsed.last_mapped_commit;
    return typeof sha === 'string' && sha.length > 0 ? sha : null;
  } catch {
    return null;
  }
}
function buildCodebaseDriftMessage(elements, affectedPaths, action) {
  const byCategory = {};
  for (const element of elements) {
    if (!byCategory[element.category]) byCategory[element.category] = [];
    byCategory[element.category].push(element.path);
  }
  const labels = {
    new_dir: 'New directories',
    barrel: 'New barrel exports',
    migration: 'New migrations',
    route: 'New route modules',
  };
  const lines = [
    'Codebase drift detected: ' + elements.length + ' structural element(s) since last mapping.',
    '',
  ];
  for (const category of ['new_dir', 'barrel', 'migration', 'route']) {
    if (!byCategory[category]) continue;
    lines.push(labels[category] + ':');
    for (const item of byCategory[category]) {
      lines.push('  - ' + item);
    }
  }
  lines.push('');
  if (action === 'auto-remap') {
    lines.push('Auto-remap scheduled for paths: ' + affectedPaths.join(', '));
  } else {
    lines.push('Run /gsd-map-codebase --paths ' + affectedPaths.join(',') + ' to refresh planning context.');
  }
  return lines.join('\\n');
}
function detectCodebaseDrift(input) {
  try {
    if (!input || typeof input !== 'object') {
      return {
        skipped: true,
        reason: 'invalid-input',
        elements: [],
        actionRequired: false,
        directive: 'none',
        spawnMapper: false,
        affectedPaths: [],
        message: '',
      };
    }
    const added = Array.isArray(input.addedFiles) ? input.addedFiles.filter((item) => typeof item === 'string') : [];
    const structureMd = input.structureMd;
    const threshold = Number.isInteger(input.threshold) && input.threshold >= 1 ? input.threshold : 3;
    const action = input.action === 'auto-remap' ? 'auto-remap' : 'warn';
    if (structureMd == null) {
      return {
        skipped: true,
        reason: 'missing-structure-md',
        elements: [],
        actionRequired: false,
        directive: 'none',
        spawnMapper: false,
        affectedPaths: [],
        message: '',
      };
    }
    if (typeof structureMd !== 'string') {
      return {
        skipped: true,
        reason: 'invalid-structure-md',
        elements: [],
        actionRequired: false,
        directive: 'none',
        spawnMapper: false,
        affectedPaths: [],
        message: '',
      };
    }
    const seen = new Map();
    for (const rawFile of added) {
      const file = String(rawFile).replace(/\\\\/g, '/');
      const specific = classifyDriftFile(file);
      let category = specific;
      if (!category) {
        if (!isPathMapped(file, structureMd)) {
          category = 'new_dir';
        } else {
          continue;
        }
      }
      const prior = seen.get(file);
      if (prior && DRIFT_CATEGORY_PRIORITY[prior] >= DRIFT_CATEGORY_PRIORITY[category]) continue;
      seen.set(file, category);
    }
    const elements = Array.from(seen.entries())
      .map(([pathValue, category]) => ({ category, path: pathValue }))
      .sort((a, b) => (a.category === b.category ? a.path.localeCompare(b.path) : a.category.localeCompare(b.category)));
    const actionRequired = elements.length >= threshold;
    const directive = actionRequired ? action : 'none';
    const affectedPaths = actionRequired ? chooseAffectedPaths(elements.map((element) => element.path)) : [];
    return {
      skipped: false,
      elements,
      actionRequired,
      directive,
      spawnMapper: actionRequired && action === 'auto-remap',
      affectedPaths,
      threshold,
      action,
      message: actionRequired ? buildCodebaseDriftMessage(elements, affectedPaths, action) : '',
    };
  } catch (error) {
    return {
      skipped: true,
      reason: 'exception:' + (error && error.message ? error.message : String(error)),
      elements: [],
      actionRequired: false,
      directive: 'none',
      spawnMapper: false,
      affectedPaths: [],
      message: '',
    };
  }
}
function checkSchemaDrift(changedFiles, executionLog, options) {
  const skipCheck = !!(options && options.skipCheck);
  const detection = detectSchemaFiles(changedFiles);
  if (!detection.detected) {
    return {
      driftDetected: false,
      blocking: false,
      schemaFiles: [],
      orms: [],
      unpushedOrms: [],
      message: '',
      skipped: false,
    };
  }
  const unpushedOrms = [];
  for (const orm of detection.orms) {
    const info = ORM_INFO[orm];
    if (!info) continue;
    const hasPushEvidence = info.evidencePatterns.some((pattern) => pattern.test(executionLog));
    if (!hasPushEvidence) {
      unpushedOrms.push(orm);
    }
  }
  const driftDetected = unpushedOrms.length > 0;
  if (!driftDetected) {
    return {
      driftDetected: false,
      blocking: false,
      schemaFiles: detection.matches,
      orms: detection.orms,
      unpushedOrms: [],
      message: '',
      skipped: false,
    };
  }
  if (skipCheck) {
    return {
      driftDetected: true,
      blocking: false,
      schemaFiles: detection.matches,
      orms: detection.orms,
      unpushedOrms,
      message: 'Schema drift detected but check was skipped (GSD_SKIP_SCHEMA_CHECK=true).',
      skipped: true,
    };
  }
  const pushCommands = unpushedOrms
    .map((orm) => {
      const info = ORM_INFO[orm];
      return info ? '  ' + orm + ': ' + (info.envHint || info.pushCommand) : null;
    })
    .filter(Boolean)
    .join('\\n');
  return {
    driftDetected: true,
    blocking: true,
    schemaFiles: detection.matches,
    orms: detection.orms,
    unpushedOrms,
    message: [
      'Schema drift detected: schema-relevant files changed but no database push was executed.',
      '',
      'Schema files changed: ' + detection.matches.join(', '),
      'ORMs requiring push: ' + unpushedOrms.join(', '),
      '',
      'Required push commands:',
      pushCommands,
      '',
      'Run the appropriate push command, or set GSD_SKIP_SCHEMA_CHECK=true to bypass this gate.',
    ].join('\\n'),
    skipped: false,
  };
}
function extractSuccessCriteria(section) {
  const lines = String(section || '').split(/\r?\n/);
  const criteria = [];
  let inCriteria = false;
  for (const line of lines) {
    if (!inCriteria) {
      if (/^\*\*Success Criteria:?\*\*/i.test(line.trim())) {
        inCriteria = true;
      }
      continue;
    }
    if (/^\s*-\s+\[[ x]\]/i.test(line)) break;
    if (/^\s*-\s+/.test(line)) {
      criteria.push(line.replace(/^\s*-\s+/, '').trim());
      continue;
    }
    if (criteria.length > 0 && line.trim() === '') continue;
    if (criteria.length > 0) break;
    if (line.trim() !== '') break;
  }
  return criteria;
}
function buildDecisionCoverageMessage(uncovered) {
  if (!uncovered.length) return 'All trackable CONTEXT.md decisions are covered by plans.';
  const lines = [
    '## ⚠ Decision Coverage Gap',
    '',
    uncovered.length + ' CONTEXT.md decision(s) are not covered by any plan:',
    '',
  ];
  for (const item of uncovered) {
    lines.push('- **' + item.id + '** (' + (item.category || 'uncategorized') + '): ' + item.text);
  }
  lines.push('');
  lines.push('Resolve by citing D-NN in a relevant plan must_haves/truths block or the plan body,');
  lines.push("OR move the decision to Claude's Discretion or tag it [informational] if it should not be tracked.");
  return lines.join('\\n');
}
function checkDecisionCoveragePlan(phaseDirArg, contextPathArg) {
  const gateEnabled = getConfigFlag('workflow.context_coverage_gate', true);
  if (!gateEnabled) {
    return {
      data: {
        passed: true,
        skipped: true,
        reason: 'workflow.context_coverage_gate is false',
        total: 0,
        covered: 0,
        uncovered: [],
        message: 'Decision coverage gate disabled by config.',
      },
    };
  }
  const contextPath = contextPathArg ? resolveProjectPath(contextPathArg) : '';
  if (!contextPath || !exists(contextPath, 'f')) {
    return {
      data: {
        passed: true,
        skipped: true,
        reason: 'CONTEXT.md missing',
        total: 0,
        covered: 0,
        uncovered: [],
        message: 'No CONTEXT.md - nothing to check.',
      },
    };
  }
  const decisions = parseContextDecisions(fs.readFileSync(contextPath, 'utf8')).filter((decision) => decision.trackable);
  if (decisions.length === 0) {
    return {
      data: {
        passed: true,
        skipped: true,
        reason: 'no trackable decisions',
        total: 0,
        covered: 0,
        uncovered: [],
        message: 'No trackable decisions in CONTEXT.md.',
      },
    };
  }
  const phaseDir = phaseDirArg ? resolveProjectPath(phaseDirArg) : '';
  let planFiles = [];
  if (phaseDir && exists(phaseDir, 'd')) {
    try {
      planFiles = fs.readdirSync(phaseDir).filter((name) => /-PLAN\\.md$/.test(name) || name === 'PLAN.md');
    } catch {
      planFiles = [];
    }
  }
  const planSections = planFiles.map((planFile) => {
    try {
      return extractPlanCoverageSections(fs.readFileSync(path.join(phaseDir, planFile), 'utf8'));
    } catch {
      return '';
    }
  });
  const uncovered = [];
  let covered = 0;
  for (const decision of decisions) {
    const mentioned = planSections.some((section) => decisionMentioned(section, decision));
    if (mentioned) {
      covered++;
    } else {
      uncovered.push({ id: decision.id, text: decision.text, category: decision.category });
    }
  }
  return {
    data: {
      passed: uncovered.length === 0,
      skipped: false,
      total: decisions.length,
      covered,
      uncovered,
      message: buildDecisionCoverageMessage(uncovered),
    },
  };
}
function buildDecisionCoverageVerifyMessage(notHonored) {
  if (!notHonored.length) return 'All trackable CONTEXT.md decisions are honored by shipped artifacts.';
  const lines = [
    '### Decision Coverage (warning)',
    '',
    notHonored.length + ' decision(s) not found in shipped artifacts:',
    '',
  ];
  for (const item of notHonored) {
    lines.push('- **' + item.id + '** (' + (item.category || 'uncategorized') + '): ' + item.text);
  }
  lines.push('');
  lines.push('This is a soft warning - verification status is unchanged.');
  return lines.join('\\n');
}
function isInsideProjectRoot(candidatePath, rootDir) {
  const root = path.resolve(rootDir || cwd);
  const target = path.isAbsolute(candidatePath) ? candidatePath : path.resolve(root, candidatePath);
  const normalizedRoot = root.endsWith(path.sep) ? root : root + path.sep;
  return target === root || target.startsWith(normalizedRoot);
}
function readBoundedFile(absPath, maxBytes) {
  try {
    const raw = fs.readFileSync(absPath, 'utf8');
    return raw.length > maxBytes ? raw.slice(0, maxBytes) : raw;
  } catch {
    return '';
  }
}
function readRecentCommitMessages(projectDir, limit) {
  try {
    const result = spawnSync('git', ['log', '-n', String(limit || 200), '--pretty=%s%n%b'], {
      cwd: projectDir || cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    });
    return result.status === 0 ? result.stdout || '' : '';
  } catch {
    return '';
  }
}
function readModifiedFilesContent(projectDir, summaries) {
  const output = [];
  let total = 0;
  for (const summary of summaries) {
    if (!summary) continue;
    const blockMatches = [...String(summary).matchAll(/files_modified:\\s*\\n((?:[ \\t]*-\\s+.+\\n?)+)/g)];
    for (const blockMatch of blockMatches) {
      const block = blockMatch[1] || '';
      const files = [...block.matchAll(/-\\s+(.+)/g)].map((match) => match[1].trim().replace(/^["']|["']$/g, ''));
      for (const filePath of files) {
        if (!filePath) continue;
        if (total >= 50) break;
        if (!isInsideProjectRoot(filePath, projectDir || cwd)) continue;
        output.push(readBoundedFile(path.isAbsolute(filePath) ? filePath : path.resolve(projectDir || cwd, filePath), 256 * 1024));
        total++;
      }
      if (total >= 50) break;
    }
    if (total >= 50) break;
  }
  return output.join('\\n\\n');
}
function checkDecisionCoverageVerify(phaseDirArg, contextPathArg) {
  const gateEnabled = getConfigFlag('workflow.context_coverage_gate', true);
  if (!gateEnabled) {
    return {
      data: {
        skipped: true,
        blocking: false,
        reason: 'workflow.context_coverage_gate is false',
        total: 0,
        honored: 0,
        not_honored: [],
        message: 'Decision coverage gate disabled by config.',
      },
    };
  }
  const contextPath = contextPathArg ? resolveProjectPath(contextPathArg) : '';
  if (!contextPath || !exists(contextPath, 'f')) {
    return {
      data: {
        skipped: true,
        blocking: false,
        reason: 'CONTEXT.md missing',
        total: 0,
        honored: 0,
        not_honored: [],
        message: 'No CONTEXT.md - nothing to check.',
      },
    };
  }
  const decisions = parseContextDecisions(fs.readFileSync(contextPath, 'utf8')).filter((decision) => decision.trackable);
  if (decisions.length === 0) {
    return {
      data: {
        skipped: true,
        blocking: false,
        reason: 'no trackable decisions',
        total: 0,
        honored: 0,
        not_honored: [],
        message: 'No trackable decisions in CONTEXT.md.',
      },
    };
  }
  const phaseDir = phaseDirArg ? resolveProjectPath(phaseDirArg) : '';
  let planContents = [];
  let summaryContents = [];
  if (phaseDir && exists(phaseDir, 'd')) {
    try {
      const entries = fs.readdirSync(phaseDir);
      planContents = entries
        .filter((name) => /-PLAN\\.md$/.test(name) || name === 'PLAN.md')
        .map((name) => {
          try { return fs.readFileSync(path.join(phaseDir, name), 'utf8'); } catch { return ''; }
        });
      summaryContents = entries
        .filter((name) => /-SUMMARY\\.md$/.test(name) || name === 'SUMMARY.md')
        .map((name) => {
          try { return fs.readFileSync(path.join(phaseDir, name), 'utf8'); } catch { return ''; }
        });
    } catch {
      planContents = [];
      summaryContents = [];
    }
  }
  const filesModifiedContent = readModifiedFilesContent(cwd, summaryContents);
  const commits = readRecentCommitMessages(cwd, 200);
  const haystack = [planContents.join('\\n\\n'), summaryContents.join('\\n\\n'), filesModifiedContent, commits].join('\\n\\n');
  const notHonored = [];
  let honored = 0;
  for (const decision of decisions) {
    if (decisionMentioned(haystack, decision)) {
      honored++;
    } else {
      notHonored.push({ id: decision.id, text: decision.text, category: decision.category });
    }
  }
  return {
    data: {
      skipped: false,
      blocking: false,
      total: decisions.length,
      honored,
      not_honored: notHonored,
      message: buildDecisionCoverageVerifyMessage(notHonored),
    },
  };
}
function parseRequirementsFromMarkdown(content) {
  if (!content) return [];
  const output = [];
  const seen = new Set();
  const checkboxRegex = /^\\s*-\\s*\\[[x ]\\]\\s*\\*\\*(REQ-[A-Za-z0-9_-]+)\\*\\*\\s*(.*)$/gm;
  let checkboxMatch = checkboxRegex.exec(content);
  while (checkboxMatch) {
    const id = checkboxMatch[1];
    if (!seen.has(id)) {
      seen.add(id);
      output.push({ id, text: (checkboxMatch[2] || '').trim(), source: 'REQUIREMENTS.md' });
    }
    checkboxMatch = checkboxRegex.exec(content);
  }
  const tableRegex = /\\|\\s*(REQ-[A-Za-z0-9_-]+)\\s*\\|/g;
  let tableMatch = tableRegex.exec(content);
  while (tableMatch) {
    const id = tableMatch[1];
    if (!seen.has(id)) {
      seen.add(id);
      output.push({ id, text: '', source: 'REQUIREMENTS.md' });
    }
    tableMatch = tableRegex.exec(content);
  }
  return output;
}
function naturalSortKey(value) {
  return String(value || '').replace(/(\\d+)/g, (_, digits) => digits.padStart(8, '0'));
}
function detectGapCoverage(items, haystack) {
  return items.map((item) => {
    const regex = new RegExp('\\\\b' + escapeRegex(item.id) + '\\\\b');
    return {
      source: item.source,
      item: item.id,
      status: regex.test(haystack) ? 'Covered' : 'Not covered',
    };
  });
}
function sortGapRows(rows) {
  const sourceOrder = { 'REQUIREMENTS.md': 0, 'CONTEXT.md': 1 };
  return rows.slice().sort((a, b) => {
    const sourceDelta = (sourceOrder[a.source] || 99) - (sourceOrder[b.source] || 99);
    if (sourceDelta !== 0) return sourceDelta;
    return naturalSortKey(a.item).localeCompare(naturalSortKey(b.item));
  });
}
function formatGapAnalysisTable(rows) {
  if (rows.length === 0) {
    return '## Post-Planning Gap Analysis\\n\\nNo requirements or decisions to check.\\n';
  }
  const lines = [
    '## Post-Planning Gap Analysis',
    '',
    '| Source | Item | Status |',
    '|--------|------|--------|',
  ];
  for (const row of rows) {
    lines.push('| ' + row.source + ' | ' + row.item + ' | ' + (row.status === 'Covered' ? '✓ Covered' : '✗ Not covered') + ' |');
  }
  return lines.join('\\n') + '\\n';
}
function runGapAnalysis(phaseDirArg) {
  const gateEnabled = getConfigFlag('workflow.post_planning_gaps', true);
  if (!gateEnabled) {
    return {
      enabled: false,
      rows: [],
      table: '',
      summary: 'workflow.post_planning_gaps disabled - skipping post-planning gap analysis',
      counts: { total: 0, covered: 0, uncovered: 0 },
    };
  }
  const phaseDir = phaseDirArg ? resolveProjectPath(phaseDirArg) : '';
  const requirementsPath = path.join(cwd, '.planning', 'REQUIREMENTS.md');
  const requirements = exists(requirementsPath, 'f')
    ? parseRequirementsFromMarkdown(fs.readFileSync(requirementsPath, 'utf8'))
    : [];
  const contextPath = path.join(phaseDir, 'CONTEXT.md');
  const decisions = exists(contextPath, 'f')
    ? parseContextDecisions(fs.readFileSync(contextPath, 'utf8'))
        .filter((decision) => decision.trackable)
        .map((decision) => ({ id: decision.id, text: decision.text, source: 'CONTEXT.md' }))
    : [];
  const items = [...requirements, ...decisions];
  let planText = '';
  if (phaseDir && exists(phaseDir, 'd')) {
    try {
      const planFiles = fs.readdirSync(phaseDir).filter((name) => /-PLAN\\.md$/.test(name));
      planText = planFiles.map((planFile) => {
        try {
          return fs.readFileSync(path.join(phaseDir, planFile), 'utf8');
        } catch {
          return '';
        }
      }).join('\\n');
    } catch {
      planText = '';
    }
  }
  if (items.length === 0) {
    return {
      enabled: true,
      rows: [],
      table: '## Post-Planning Gap Analysis\\n\\nNo requirements or decisions to check.\\n',
      summary: 'no requirements or decisions to check',
      counts: { total: 0, covered: 0, uncovered: 0 },
    };
  }
  const rows = sortGapRows(detectGapCoverage(items, planText));
  const uncovered = rows.filter((row) => row.status === 'Not covered').length;
  const covered = rows.length - uncovered;
  const summary = uncovered === 0
    ? '✓ All ' + rows.length + ' items covered by plans'
    : '⚠ ' + uncovered + ' of ' + rows.length + ' items not covered by any plan';
  return {
    enabled: true,
    rows,
    table: formatGapAnalysisTable(rows) + '\\n' + summary + '\\n',
    summary,
    counts: { total: rows.length, covered, uncovered },
  };
}
function coerceTruthToString(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value && typeof value === 'object') {
    for (const key of ['text', 'title', 'value', 'constraint', 'truth']) {
      if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
    }
  }
  return '';
}
function annotateRoadmapDependencies(phaseNumber) {
  if (!phaseNumber) return { updated: false, reason: 'phase number required' };
  const roadmapPath = path.join(cwd, '.planning', 'ROADMAP.md');
  if (!exists(roadmapPath, 'f')) return { updated: false, reason: 'ROADMAP.md not found' };
  const phaseInfo = getPhaseDirectoryInfo(phaseNumber);
  if (!phaseInfo) return { updated: false, reason: 'phase not found' };
  const planFiles = phaseInfo.phaseFiles.filter((name) => /-PLAN\\.md$/.test(name) || name === 'PLAN.md').sort(comparePhaseValues);
  if (planFiles.length === 0) return { updated: false, reason: 'no plans found for phase' };
  const planData = [];
  for (const planFile of planFiles) {
    try {
      const content = fs.readFileSync(path.join(phaseInfo.phaseDirAbs, planFile), 'utf8');
      const frontmatter = parseFrontmatter(content);
      const wave = parseInt(String(frontmatter.wave), 10) || 1;
      const planId = planFile === 'PLAN.md' ? 'PLAN' : planFile.replace(/-PLAN\\.md$/i, '');
      const truths = extractMustHavesTruths(content);
      planData.push({ planFile, planId, wave, truths });
    } catch {
      continue;
    }
  }
  if (planData.length === 0) return { updated: false, reason: 'could not read plan frontmatter' };
  const waves = [...new Set(planData.map((plan) => plan.wave))].sort((a, b) => a - b);
  const truthCounts = new Map();
  for (const plan of planData) {
    const seen = new Set();
    for (const truth of plan.truths || []) {
      const text = coerceTruthToString(truth).trim();
      if (!text) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (!truthCounts.has(key)) truthCounts.set(key, { count: 0, text });
      truthCounts.get(key).count++;
    }
  }
  const crossCuttingTruths = [...truthCounts.values()].filter((entry) => entry.count >= 2).map((entry) => entry.text);
  let updated = false;
  let roadmapContent = fs.readFileSync(roadmapPath, 'utf8');
  const phaseHeaderRegex = new RegExp('(#{2,4}\\\\s*Phase\\\\s+' + escapeRegex(phaseNumber) + ':[^\\\\n]*)', 'i');
  const phaseMatch = roadmapContent.match(phaseHeaderRegex);
  if (!phaseMatch) {
    return { updated: false, reason: 'phase header not found in ROADMAP.md' };
  }
  const phaseStart = phaseMatch.index || 0;
  const restAfterHeader = roadmapContent.slice(phaseStart);
  const nextPhaseOffset = restAfterHeader.slice(1).search(/\\n#{2,4}\\s+Phase\\s+\\d/i);
  const phaseEnd = nextPhaseOffset >= 0 ? phaseStart + 1 + nextPhaseOffset : roadmapContent.length;
  const phaseSection = roadmapContent.slice(phaseStart, phaseEnd);
  if (/\\*\\*Wave\\s+\\d+/i.test(phaseSection) || /\\*\\*Cross-cutting constraints:\\*\\*/i.test(phaseSection)) {
    return { updated: false, reason: 'already annotated', waves: waves.length, cross_cutting_constraints: crossCuttingTruths.length };
  }
  const plansBlockMatch = phaseSection.match(/(Plans:\\s*\\n)((?:\\s*-\\s*\\[[ x]\\][^\\n]*\\n?)*)/i);
  if (!plansBlockMatch) {
    return { updated: false, reason: 'no plan list found', waves: waves.length, cross_cutting_constraints: crossCuttingTruths.length };
  }
  const listItemRe = new RegExp('^\\\\s*-\\\\s*\\\\[');
  const listLines = plansBlockMatch[2].split('\\n').filter((line) => listItemRe.test(line));
  if (listLines.length === 0) {
    return { updated: false, reason: 'empty plan list', waves: waves.length, cross_cutting_constraints: crossCuttingTruths.length };
  }
  const linesByWave = new Map();
  for (const line of listLines) {
    const idMatch = line.match(/\\[\\s*[x ]\\s*\\]\\s*([\\w-]+?)(?:-PLAN\\.md|\\.md|:|\\s—)/i);
    const planId = idMatch ? idMatch[1] : null;
    const planEntry = planId ? planData.find((plan) => plan.planId === planId) : null;
    const wave = planEntry ? planEntry.wave : 1;
    if (!linesByWave.has(wave)) linesByWave.set(wave, []);
    linesByWave.get(wave).push(line);
  }
  const annotatedLines = [];
  const sortedWaves = [...linesByWave.keys()].sort((a, b) => a - b);
  for (let index = 0; index < sortedWaves.length; index++) {
    const wave = sortedWaves[index];
    if (sortedWaves.length > 1) {
      const dependencySuffix = index > 0 ? ' *(blocked on Wave ' + sortedWaves[index - 1] + ' completion)*' : '';
      annotatedLines.push('**Wave ' + wave + '**' + dependencySuffix);
    }
    annotatedLines.push(...linesByWave.get(wave));
    if (index < sortedWaves.length - 1) annotatedLines.push('');
  }
  if (crossCuttingTruths.length > 0) {
    annotatedLines.push('');
    annotatedLines.push('**Cross-cutting constraints:**');
    for (const truth of crossCuttingTruths) {
      annotatedLines.push('- ' + truth);
    }
  }
  const newPhaseSection = phaseSection.replace(plansBlockMatch[0], plansBlockMatch[1] + annotatedLines.join('\\n') + '\\n');
  const nextRoadmapContent = roadmapContent.slice(0, phaseStart) + newPhaseSection + roadmapContent.slice(phaseEnd);
  if (nextRoadmapContent !== roadmapContent) {
    fs.writeFileSync(roadmapPath, nextRoadmapContent, 'utf8');
    updated = true;
  }
  return {
    updated,
    phase: phaseNumber,
    waves: waves.length,
    cross_cutting_constraints: crossCuttingTruths.length,
  };
}
function parseDefaultValue(value) {
  if (value == null) return '';
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (value === 'undefined') return undefined;
  if (/^-?\\d+(?:\\.\\d+)?$/.test(String(value))) return Number(value);
  return value;
}
function formatScalar(value) {
  if (value == null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
function parseRoadmapPhase(rawPhase) {
  const roadmapPath = path.join(cwd, '.planning', 'ROADMAP.md');
  if (!exists(roadmapPath, 'f')) return null;
  const content = fs.readFileSync(roadmapPath, 'utf8');
  const phaseText = String(rawPhase || '').trim();
  if (!phaseText) return null;
  const numeric = /^\\d+$/.test(phaseText);
  const canonical = numeric ? String(Number(phaseText)) : phaseText;
  const escaped = canonical.replace(/[.*+?^$(){}|[\\]\\\\]/g, '\\\\$&');
  const phasePattern = numeric
    ? new RegExp('^#{2,4}\\s*Phase\\s+0*' + escaped + ':\\s*([^\\n]+)$', 'im')
    : new RegExp('^#{2,4}\\s*Phase\\s+' + escaped + ':\\s*([^\\n]+)$', 'im');
  const headerMatch = content.match(phasePattern);
  if (!headerMatch || headerMatch.index == null) return null;
  const headerIndex = headerMatch.index;
  const restOfContent = content.slice(headerIndex);
  const nextHeaderMatch = restOfContent.slice(1).match(/\n#{2,4}\s+Phase\s+[\w]/i);
  const sectionEnd = nextHeaderMatch ? headerIndex + 1 + nextHeaderMatch.index : content.length;
  const section = content.slice(headerIndex, sectionEnd).trim();
  const phaseName = headerMatch[1].trim();
  const goalMatch = section.match(/\*\*Goal(?:\*\*:|\*?\*?:\*\*)\s*([^\n]+)/i);
  const requirementsMatch = section.match(/^\*\*Requirements:?\*\*[^\S\n]*:?[^\n]*$/im);
  const reqValue = requirementsMatch
    ? requirementsMatch[0].replace(/^\*\*Requirements:?\*\*[^\S\n]*:?\s*/i, '').trim()
    : null;
  const phaseReqIds = reqValue && reqValue !== 'TBD'
    ? reqValue.replace(/[\[\]]/g, '').split(',').map((item) => item.trim()).filter(Boolean).join(', ')
    : null;
  const successCriteria = extractSuccessCriteria(section);
  return {
    found: true,
    phase_number: numeric ? canonical : phaseText,
    phase_name: phaseName,
    phase_slug: slugify(phaseName),
    goal: goalMatch ? goalMatch[1].trim() : null,
    section,
    phase_req_ids: phaseReqIds,
    success_criteria: successCriteria,
  };
}
function frontmatterGet(filePathArg, fieldArg) {
  if (!filePathArg) {
    return { error: 'file path required' };
  }
  let fullPath = '';
  try {
    fullPath = resolveProjectPath(filePathArg);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), path: filePathArg };
  }
  if (!exists(fullPath, 'f')) {
    return { error: 'File not found', path: filePathArg };
  }
  const content = fs.readFileSync(fullPath, 'utf8');
  const field = String(fieldArg || '').trim();
  if (!field) return parseFrontmatter(content);
  if (field === 'must_haves') {
    const mustHaves = {
      truths: extractMustHavesTruths(content),
      artifacts: extractMustHavesArtifacts(content),
      key_links: extractKeyLinks(content),
    };
    const hasValues = mustHaves.truths.length > 0 || mustHaves.artifacts.length > 0 || mustHaves.key_links.length > 0;
    return hasValues ? mustHaves : { error: 'No must_haves found in frontmatter', field };
  }
  const frontmatter = parseFrontmatter(content);
  if (!(field in frontmatter)) {
    return { error: 'Field not found', field };
  }
  return { [field]: frontmatter[field] };
}
function verifyArtifactsForPlan(planFilePath) {
  const mustHaves = frontmatterGet(planFilePath, 'must_haves');
  if (mustHaves.error) {
    return { error: mustHaves.error, path: planFilePath };
  }
  const artifacts = Array.isArray(mustHaves.artifacts) ? mustHaves.artifacts : [];
  if (artifacts.length === 0) {
    return { error: 'No must_haves.artifacts found in frontmatter', path: planFilePath };
  }
  const results = [];
  for (const artifact of artifacts) {
    const artifactPath = typeof artifact.path === 'string' ? artifact.path.trim() : '';
    if (!artifactPath) continue;
    let existsOnDisk = false;
    let fileContent = '';
    try {
      fileContent = fs.readFileSync(resolveProjectPath(artifactPath), 'utf8');
      existsOnDisk = true;
    } catch {
      existsOnDisk = false;
    }
    const check = { path: artifactPath, exists: existsOnDisk, issues: [], passed: false };
    if (!existsOnDisk) {
      check.issues.push('File not found');
    } else {
      const lineCount = fileContent.split(/\\r?\\n/).length;
      if (artifact.min_lines && lineCount < artifact.min_lines) {
        check.issues.push('Only ' + lineCount + ' lines, need ' + artifact.min_lines);
      }
      if (artifact.contains && !fileContent.includes(String(artifact.contains))) {
        check.issues.push('Missing pattern: ' + artifact.contains);
      }
      const exportsToCheck = Array.isArray(artifact.exports)
        ? artifact.exports
        : artifact.exports
          ? [artifact.exports]
          : [];
      for (const exportName of exportsToCheck) {
        if (!fileContent.includes(String(exportName))) {
          check.issues.push('Missing export: ' + exportName);
        }
      }
      check.passed = check.issues.length === 0;
    }
    results.push(check);
  }
  const passed = results.filter((result) => result.passed).length;
  return {
    all_passed: results.length > 0 && passed === results.length,
    passed,
    total: results.length,
    artifacts: results,
  };
}
function analyzeRoadmap() {
  const roadmapPath = path.join(cwd, '.planning', 'ROADMAP.md');
  if (!exists(roadmapPath, 'f')) {
    return { error: 'ROADMAP.md not found', milestones: [], phases: [], current_phase: null };
  }
  const content = fs.readFileSync(roadmapPath, 'utf8');
  const milestoneMatches = [...content.matchAll(/^##\s*(.*v(\d+(?:\.\d+)+)[^(\n]*)/gim)];
  const milestones = milestoneMatches.map((match) => ({
    heading: match[1].trim(),
    version: 'v' + match[2],
  }));
  const phasePattern = /^(#{2,4})\s*Phase\s+(\d+[A-Z]?(?:\.\d+)*)\s*:\s*([^\n]+)$/gim;
  const headers = [...content.matchAll(phasePattern)];
  const phases = headers.map((match, index) => {
    const phaseNumber = match[2];
    const normalizedPhase = normalizePhaseNumber(phaseNumber);
    const sectionStart = match.index || 0;
    const sectionEnd = index + 1 < headers.length ? (headers[index + 1].index || content.length) : content.length;
    const section = content.slice(sectionStart, sectionEnd).trim();
    const phaseInfo = findPhaseDirectory(normalizedPhase);
    const artifacts = getPhaseArtifacts(phaseInfo.phaseDir, phaseInfo.normalized);
    const phaseDirAbs = phaseInfo.found ? path.join(cwd, phaseInfo.phaseDir) : '';
    let summaryCount = 0;
    let diskStatus = phaseInfo.found ? 'empty' : 'no_directory';
    try {
      if (phaseDirAbs && exists(phaseDirAbs, 'd')) {
        const phaseFiles = fs.readdirSync(phaseDirAbs);
        summaryCount = phaseFiles.filter((name) => /-SUMMARY\.md$/.test(name) || name === 'SUMMARY.md').length;
        if (summaryCount >= artifacts.plan_count && artifacts.plan_count > 0) diskStatus = 'complete';
        else if (summaryCount > 0) diskStatus = 'partial';
        else if (artifacts.plan_count > 0) diskStatus = 'planned';
        else if (artifacts.has_research) diskStatus = 'researched';
        else if (artifacts.has_context) diskStatus = 'discussed';
      }
    } catch {}
    const goalMatch = section.match(/\*\*Goal(?:\*\*:|\*?\*?:\*\*)\s*([^\n]+)/i);
    const dependsMatch = section.match(/\*\*Depends on(?:\*\*:|\*?\*?:\*\*)\s*([^\n]+)/i);
    const checkboxPattern = new RegExp('-\\s*\\[(x| )\\]\\s*.*Phase\\s+0*' + escapeRegex(phaseNumber) + '[:\\s]', 'i');
    const checkboxMatch = content.match(checkboxPattern);
    const roadmapComplete = checkboxMatch ? checkboxMatch[1] === 'x' : false;
    if (roadmapComplete && diskStatus !== 'complete') diskStatus = 'complete';
    return {
      number: normalizedPhase,
      name: match[3].replace(/\\(INSERTED\\)/i, '').trim(),
      goal: goalMatch ? goalMatch[1].trim() : null,
      depends_on: dependsMatch ? dependsMatch[1].trim() : null,
      plan_count: artifacts.plan_count,
      summary_count: summaryCount,
      has_context: artifacts.has_context,
      has_research: artifacts.has_research,
      disk_status: diskStatus,
      roadmap_complete: roadmapComplete,
      success_criteria: extractSuccessCriteria(section),
    };
  });
  const currentPhase = phases.find((phase) => phase.disk_status === 'planned' || phase.disk_status === 'partial') || null;
  const nextPhase = phases.find((phase) => ['empty', 'no_directory', 'discussed', 'researched'].includes(phase.disk_status)) || null;
  const totalPlans = phases.reduce((sum, phase) => sum + (phase.plan_count || 0), 0);
  const totalSummaries = phases.reduce((sum, phase) => sum + (phase.summary_count || 0), 0);
  const completedPhases = phases.filter((phase) => phase.disk_status === 'complete').length;
  const checklistMatches = [...content.matchAll(/-\\s*\\[[ x]\\]\\s*\\*\\*Phase\\s+(\\d+[A-Z]?(?:\\.\\d+)*)/gi)];
  const checklistPhases = new Set(checklistMatches.map((match) => match[1]));
  const detailPhases = new Set(phases.map((phase) => phase.number));
  const missingDetails = [...checklistPhases].filter((phaseNumber) => !detailPhases.has(phaseNumber));
  return {
    milestones,
    phases,
    phase_count: phases.length,
    completed_phases: completedPhases,
    total_plans: totalPlans,
    total_summaries: totalSummaries,
    progress_percent: totalPlans > 0 ? Math.min(100, Math.round((totalSummaries / totalPlans) * 100)) : 0,
    current_phase: currentPhase ? currentPhase.number : null,
    next_phase: nextPhase ? nextPhase.number : null,
    missing_phase_details: missingDetails.length > 0 ? missingDetails : null,
  };
}
function readStateContent() {
  const statePath = path.join(cwd, '.planning', 'STATE.md');
  if (!exists(statePath, 'f')) return '';
  try {
    return fs.readFileSync(statePath, 'utf8');
  } catch {
    return '';
  }
}
function parsePlanningFrontmatter(content) {
  const LF = String.fromCharCode(10);
  const normalized = String(content || '').replace(new RegExp('\\r\\n', 'g'), LF);
  if (!normalized.startsWith('---' + LF)) return {};
  const endMarker = normalized.indexOf(LF + '---' + LF, 4);
  if (endMarker < 0) return {};
  const block = normalized.slice(4, endMarker);
  const result = {};
  let currentKey = null;
  for (const rawLine of block.split(LF)) {
    const trimmed = rawLine.trimEnd();
    const separator = trimmed.indexOf(':');
    if (separator > 0 && !/^\s/.test(trimmed)) {
      currentKey = trimmed.slice(0, separator).trim();
      const rawValue = trimmed.slice(separator + 1).trim();
      if (!rawValue) {
        result[currentKey] = [];
      } else if (rawValue === 'true') {
        result[currentKey] = true;
      } else if (rawValue === 'false') {
        result[currentKey] = false;
      } else if (/^-?\\d+$/.test(rawValue)) {
        result[currentKey] = Number(rawValue);
      } else {
        result[currentKey] = rawValue.replace(/^["']|["']$/g, '');
      }
      continue;
    }
    const listLine = trimmed.trimStart();
    if (listLine.startsWith('- ') && currentKey) {
      if (!Array.isArray(result[currentKey])) result[currentKey] = [];
      result[currentKey].push(listLine.slice(2).trim());
    }
  }
  return result;
}
function extractLabeledValue(content, label) {
  const plain = String(label || '').trim();
  const plainPrefix = plain + ':';
  const boldPrefix = '**' + plain + ':**';
  const altBoldPrefix = '**' + plain + '**:';
  for (const rawLine of String(content || '').split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith(boldPrefix)) return trimmed.slice(boldPrefix.length).trim();
    if (trimmed.startsWith(altBoldPrefix)) return trimmed.slice(altBoldPrefix.length).trim();
    if (trimmed.startsWith(plainPrefix)) return trimmed.slice(plainPrefix.length).trim();
  }
  return '';
}
function extractMarkdownSection(content, heading) {
  const lines = String(content || '').split(/\r?\n/);
  const target = String(heading || '').trim().toLowerCase();
  let collecting = false;
  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!collecting) {
      if (/^##\s+/.test(trimmed) && trimmed.replace(/^##\s+/, '').trim().toLowerCase() === target) {
        collecting = true;
      }
      continue;
    }
    if (/^##\s+/.test(trimmed)) break;
    out.push(line);
  }
  return out.join('\n').trim();
}
function findPhaseDirForReporting(phaseNumber) {
  const phasesDir = path.join(cwd, '.planning', 'phases');
  if (!exists(phasesDir, 'd')) return null;
  const normalized = normalizePhaseNumber(phaseNumber);
  for (const name of fs.readdirSync(phasesDir)) {
    if (!exists(path.join(phasesDir, name), 'd')) continue;
    if (name.startsWith(normalized + '-')) {
      return {
        entry: name,
        phase_dir: path.join('.planning', 'phases', name),
        phase_name: name.slice((normalized + '-').length).replace(/-/g, ' ').trim(),
      };
    }
  }
  return null;
}
function getPhaseDirectorySummaries() {
  const phasesDir = path.join(cwd, '.planning', 'phases');
  if (!exists(phasesDir, 'd')) return [];
  const out = [];
  for (const name of fs.readdirSync(phasesDir)) {
    const full = path.join(phasesDir, name);
    if (!exists(full, 'd')) continue;
    const match = name.match(/^(\d+[A-Z]?(?:\.\d+)*)(?:-(.*))?$/);
    if (!match) continue;
    const phaseNumber = normalizePhaseNumber(match[1]);
    const phaseName = (match[2] || '').replace(/-/g, ' ').trim();
    const files = fs.readdirSync(full);
    const planCount = files.filter((file) => file === 'PLAN.md' || file.endsWith('-PLAN.md')).length;
    const summaryCount = files.filter((file) => file === 'SUMMARY.md' || file.endsWith('-SUMMARY.md')).length;
    const hasContext = files.some((file) => file === 'CONTEXT.md' || file.endsWith('-CONTEXT.md'));
    const hasResearch = files.some((file) => file === 'RESEARCH.md' || file.endsWith('-RESEARCH.md'));
    const verificationFile = files.find((file) => file === 'VERIFICATION.md' || file.endsWith('-VERIFICATION.md'));
    let verificationStatus = null;
    if (verificationFile) {
      try {
        const verificationContent = fs.readFileSync(path.join(full, verificationFile), 'utf8');
        const statusMatch = verificationContent.match(new RegExp('status:\\s*(.+)$', 'mi'));
        verificationStatus = statusMatch ? statusMatch[1].trim().toLowerCase() : null;
      } catch {}
    }
    out.push({
      number: phaseNumber,
      name: phaseName,
      phase_dir: path.join('.planning', 'phases', name),
      plan_count: planCount,
      summary_count: summaryCount,
      has_context: hasContext,
      has_research: hasResearch,
      verification_status: verificationStatus,
    });
  }
  out.sort((left, right) => comparePhaseValues(left.number, right.number));
  return out;
}
function analyzeRoadmapForReporting() {
  const roadmapPath = path.join(cwd, '.planning', 'ROADMAP.md');
  if (!exists(roadmapPath, 'f')) {
    return { milestones: [], phases: [], phase_count: 0, completed_phases: 0, total_plans: 0, total_summaries: 0, progress_percent: 0, current_phase: null, next_phase: null, missing_phase_details: null };
  }
  const content = fs.readFileSync(roadmapPath, 'utf8');
  const milestones = [];
  const headings = [];
  const roadmapLines = content.split(/\r?\n/);
  let offset = 0;
  for (const line of roadmapLines) {
    const trimmed = line.trim();
    const milestoneMatch = trimmed.match(/^##\s+(.*?(v\d+(?:\.\d+)+).*)$/i);
    if (milestoneMatch) {
      milestones.push({ heading: milestoneMatch[1].trim(), version: milestoneMatch[2] });
    }
    const phaseMatch = trimmed.match(/^#{2,4}\s*Phase\s+(\d+[A-Z]?(?:\.\d+)*)\s*:\s*(.+)$/i);
    if (phaseMatch) {
      headings.push({
        number: normalizePhaseNumber(phaseMatch[1]),
        name: phaseMatch[2].replace(/\(INSERTED\)/gi, '').trim(),
        index: offset,
      });
    }
    offset += line.length + 1;
  }
  const scanned = new Map(getPhaseDirectorySummaries().map((phase) => [phase.number, phase]));
  const phases = [];
  for (let index = 0; index < headings.length; index++) {
    const heading = headings[index];
    const nextIndex = index + 1 < headings.length ? headings[index + 1].index : content.length;
    const section = content.slice(heading.index, nextIndex);
    const goalValue = extractLabeledValue(section, 'Goal');
    const dependsValue = extractLabeledValue(section, 'Depends on');
    const checkboxPattern = new RegExp('-\\\\s*\\\\[(x| )\\\\]\\\\s*\\\\*\\\\*Phase\\\\s+0*' + heading.number.replace(/[.*+?^$(){}|[\\]\\\\]/g, '\\\\$&') + '[:\\\\s]', 'i');
    const checkboxMatch = content.match(checkboxPattern);
    const scannedPhase = scanned.get(heading.number);
    let diskStatus = 'no_directory';
    if (scannedPhase) {
      if (scannedPhase.plan_count > 0 && scannedPhase.summary_count >= scannedPhase.plan_count) {
        if (scannedPhase.verification_status === 'passed') diskStatus = 'complete';
        else if (scannedPhase.verification_status === 'human_needed') diskStatus = 'needs_review';
        else diskStatus = 'executed';
      } else if (scannedPhase.summary_count > 0) {
        diskStatus = 'partial';
      } else if (scannedPhase.plan_count > 0) {
        diskStatus = 'planned';
      } else if (scannedPhase.has_research) {
        diskStatus = 'researched';
      } else if (scannedPhase.has_context) {
        diskStatus = 'discussed';
      } else {
        diskStatus = 'empty';
      }
    }
    if (checkboxMatch && checkboxMatch[1] === 'x' && (diskStatus === 'executed' || diskStatus === 'needs_review')) {
      diskStatus = 'complete';
    }
    const successCriteria = extractSuccessCriteria(section);
    phases.push({
      number: heading.number,
      name: heading.name,
      goal: goalValue || null,
      depends_on: dependsValue || null,
      plan_count: scannedPhase ? scannedPhase.plan_count : 0,
      summary_count: scannedPhase ? scannedPhase.summary_count : 0,
      has_context: scannedPhase ? scannedPhase.has_context : false,
      has_research: scannedPhase ? scannedPhase.has_research : false,
      disk_status: diskStatus,
      roadmap_complete: !!(checkboxMatch && checkboxMatch[1] === 'x'),
      success_criteria: successCriteria,
    });
  }
  const totalPlans = phases.reduce((sum, phase) => sum + Number(phase.plan_count || 0), 0);
  const totalSummaries = phases.reduce((sum, phase) => sum + Number(phase.summary_count || 0), 0);
  const completedPhases = phases.filter((phase) => phase.disk_status === 'complete').length;
  const currentPhase = phases.find((phase) => ['planned', 'partial', 'executed', 'needs_review'].includes(phase.disk_status)) || null;
  const nextPhase = phases.find((phase) => ['empty', 'no_directory', 'discussed', 'researched'].includes(phase.disk_status)) || null;
  return {
    milestones,
    phases,
    phase_count: phases.length,
    completed_phases: completedPhases,
    total_plans: totalPlans,
    total_summaries: totalSummaries,
    progress_percent: totalPlans > 0 ? Math.min(100, Math.round((totalSummaries / totalPlans) * 100)) : 0,
    current_phase: currentPhase ? currentPhase.number : null,
    next_phase: nextPhase ? nextPhase.number : null,
    missing_phase_details: null,
  };
}
function getStatePathInfo() {
  const planningDir = path.join(cwd, '.planning');
  const workstreamMarker = path.join(planningDir, 'active-workstream');
  if (exists(workstreamMarker, 'f')) {
    try {
      const workstream = fs.readFileSync(workstreamMarker, 'utf8').trim();
      if (workstream) {
        const configPath = path.join('.planning', 'workstreams', workstream, 'config.json');
        return {
          config_path: configPath,
          config_exists: exists(path.join(cwd, configPath), 'f'),
          active_workstream: workstream,
        };
      }
    } catch {}
  }
  return {
    config_path: '.planning/config.json',
    config_exists: exists(path.join(cwd, '.planning', 'config.json'), 'f'),
    active_workstream: null,
  };
}
function parseStateSnapshotData() {
  const content = readStateContent();
  if (!content) return { error: 'STATE.md not found' };
  const frontmatter = parsePlanningFrontmatter(content);
  const roadmap = analyzeRoadmapForReporting();
  const progress = frontmatter.progress && typeof frontmatter.progress === 'object' ? frontmatter.progress : {};
  const rawCurrentPhase = String(frontmatter.current_phase || extractLabeledValue(content, 'current_phase') || extractLabeledValue(content, 'Current Phase') || roadmap.current_phase || '').trim() || null;
  const currentPhase = rawCurrentPhase ? normalizePhaseNumber(rawCurrentPhase) : null;
  const currentPhaseName = String(frontmatter.current_phase_name || extractLabeledValue(content, 'current_phase_name') || extractLabeledValue(content, 'Current Phase Name') || '').trim() || null;
  const currentPlan = String(frontmatter.current_plan || extractLabeledValue(content, 'current_plan') || extractLabeledValue(content, 'Current Plan') || '').trim() || null;
  const status = String(frontmatter.status || extractLabeledValue(content, 'status') || extractLabeledValue(content, 'Status') || '').trim() || 'unknown';
  const pausedAt = String(frontmatter.paused_at || extractLabeledValue(content, 'paused_at') || extractLabeledValue(content, 'Paused At') || '').trim() || null;
  const stoppedAt = String(frontmatter.stopped_at || extractLabeledValue(content, 'stopped_at') || extractLabeledValue(content, 'Stopped At') || '').trim() || null;
  const lastActivity = String(frontmatter.last_activity || extractLabeledValue(content, 'last_activity') || extractLabeledValue(content, 'Last Activity') || '').trim() || null;
  const lastActivityDesc = String(frontmatter.last_activity_desc || extractLabeledValue(content, 'last_activity_desc') || extractLabeledValue(content, 'Last Activity Description') || '').trim() || null;

  const decisions = [];
  const decisionsSection = extractMarkdownSection(content, 'Decisions Made');
  const decisionTableMatch = decisionsSection.match(/\|[^\n]+\n\|[-|\s]+\n([\s\S]*)/i);
  if (decisionTableMatch) {
    for (const row of decisionTableMatch[1].trim().split(/\r?\n/)) {
      if (!row.includes('|')) continue;
      const cells = row.split('|').map((cell) => cell.trim()).filter(Boolean);
      if (cells.length < 2) continue;
      decisions.push({
        phase: cells[0] || null,
        decision: cells[1] || null,
        summary: cells[1] || null,
        rationale: cells[2] || null,
      });
    }
  } else {
    if (decisionsSection) {
      for (const line of decisionsSection.split(/\r?\n/)) {
        const bulletMatch = line.match(/^\s*[-*]\s+(.+)$/);
        if (!bulletMatch) continue;
        decisions.push({
          phase: currentPhase,
          decision: bulletMatch[1].trim(),
          summary: bulletMatch[1].trim(),
          rationale: null,
        });
      }
    }
  }

  const blockers = [];
  const blockersSection = extractMarkdownSection(content, 'Blockers');
  if (blockersSection) {
    for (const line of blockersSection.split(/\r?\n/)) {
      const bulletMatch = line.match(/^\s*[-*]\s+(.+)$/);
      if (!bulletMatch) continue;
      blockers.push({ text: bulletMatch[1].trim() });
    }
  }

  const sessionSection = extractMarkdownSection(content, 'Session');
  const session = {
    last_date: null,
    stopped_at: stoppedAt,
    resume_file: null,
  };
  if (sessionSection) {
    session.last_date = extractLabeledValue(sessionSection, 'Last Date') || null;
    session.stopped_at = extractLabeledValue(sessionSection, 'Stopped At') || session.stopped_at;
    session.resume_file = extractLabeledValue(sessionSection, 'Resume File') || null;
  }

  return {
    current_phase: currentPhase,
    current_phase_name: currentPhaseName,
    total_phases: Number(progress.total_phases || roadmap.phase_count || 0) || null,
    current_plan: currentPlan,
    total_plans_in_phase: Number(frontmatter.total_plans_in_phase || getStateField('total_plans_in_phase') || getStateField('Total Plans in Phase') || 0) || null,
    status,
    progress_percent: Number(progress.percent || roadmap.progress_percent || 0) || 0,
    last_activity: lastActivity,
    last_activity_desc: lastActivityDesc,
    decisions,
    blockers,
    paused_at: pausedAt,
    session,
  };
}
function buildStateJsonPayload() {
  const stateData = parseStateSnapshotData();
  if (stateData.error) return { error: stateData.error };
  const roadmap = analyzeRoadmapForReporting();
  const milestone = roadmap.milestones && roadmap.milestones.length > 0 ? roadmap.milestones[roadmap.milestones.length - 1] : null;
  const content = readStateContent();
  const frontmatter = parsePlanningFrontmatter(content);
  const payload = {
    gsd_state_version: String(frontmatter.gsd_state_version || '1.0'),
    milestone: milestone ? milestone.version : null,
    milestone_name: milestone ? extractMilestoneName(milestone.heading, milestone.version) || null : null,
    current_phase: stateData.current_phase,
    current_phase_name: stateData.current_phase_name,
    current_plan: stateData.current_plan,
    status: stateData.status,
    paused_at: stateData.paused_at,
    stopped_at: stateData.session.stopped_at,
    last_updated: new Date().toISOString(),
    last_activity: stateData.last_activity,
    progress: {
      total_phases: roadmap.phase_count || stateData.total_phases || 0,
      completed_phases: roadmap.completed_phases || 0,
      total_plans: roadmap.total_plans || 0,
      completed_plans: roadmap.total_summaries || 0,
      percent: roadmap.progress_percent || stateData.progress_percent || 0,
    },
  };
  return payload;
}
function buildStateLoadPayload() {
  const statePath = path.join(cwd, '.planning', 'STATE.md');
  const roadmapPath = path.join(cwd, '.planning', 'ROADMAP.md');
  const configInfo = getStatePathInfo();
  return {
    config: readConfig(),
    state_raw: readStateContent(),
    state_exists: exists(statePath, 'f'),
    roadmap_exists: exists(roadmapPath, 'f'),
    config_exists: configInfo.config_exists,
  };
}
function getActiveWorkstreamInfo() {
  const markerPath = path.join(cwd, '.planning', 'active-workstream');
  const workstreamsDir = path.join(cwd, '.planning', 'workstreams');
  const mode = exists(workstreamsDir, 'd') ? 'workstream' : 'flat';
  if (!exists(markerPath, 'f')) {
    return { active: null, mode };
  }
  try {
    const active = fs.readFileSync(markerPath, 'utf8').trim() || null;
    return { active, mode };
  } catch {
    return { active: null, mode };
  }
}
function listWorkstreamDirectories() {
  const workstreamsDir = path.join(cwd, '.planning', 'workstreams');
  if (!exists(workstreamsDir, 'd')) return [];
  try {
    return fs.readdirSync(workstreamsDir).filter((name) => exists(path.join(workstreamsDir, name), 'd')).sort();
  } catch {
    return [];
  }
}
function buildWorkstreamGetPayload() {
  const info = getActiveWorkstreamInfo();
  return {
    active: info.active,
    mode: info.mode,
  };
}
function buildWorkstreamProgressPayload() {
  const names = listWorkstreamDirectories();
  if (names.length === 0) {
    return {
      mode: 'flat',
      workstreams: [],
      count: 0,
      message: 'No workstreams - operating in flat mode',
    };
  }
  const activeInfo = getActiveWorkstreamInfo();
  const workstreams = names.map((name) => {
    const base = path.join(cwd, '.planning', 'workstreams', name);
    const statePath = path.join(base, 'STATE.md');
    const roadmapPath = path.join(base, 'ROADMAP.md');
    const phasesDir = path.join(base, 'phases');
    let status = 'unknown';
    let currentPhase = null;
    if (exists(statePath, 'f')) {
      try {
        const content = fs.readFileSync(statePath, 'utf8');
        status = extractLabeledValue(content, 'Status')
          || extractLabeledValue(content, 'status')
          || 'unknown';
        currentPhase = extractLabeledValue(content, 'Current Phase')
          || extractLabeledValue(content, 'current_phase')
          || null;
      } catch {}
    }
    let roadmapPhaseCount = 0;
    if (exists(roadmapPath, 'f')) {
      try {
        const roadmap = fs.readFileSync(roadmapPath, 'utf8');
        roadmapPhaseCount = (roadmap.match(/^#{2,4}\s*Phase\s+\d+[A-Z]?(?:\.\d+)*\s*:/gm) || []).length;
      } catch {}
    }
    let completedCount = 0;
    let totalPlans = 0;
    let completedPlans = 0;
    if (exists(phasesDir, 'd')) {
      try {
        for (const dirName of fs.readdirSync(phasesDir)) {
          const phaseDir = path.join(phasesDir, dirName);
          if (!exists(phaseDir, 'd')) continue;
          const files = fs.readdirSync(phaseDir);
          const plans = files.filter((fileName) => fileName === 'PLAN.md' || /-PLAN\.md$/.test(fileName));
          const summaries = files.filter((fileName) => fileName === 'SUMMARY.md' || /-SUMMARY\.md$/.test(fileName));
          totalPlans += plans.length;
          completedPlans += Math.min(summaries.length, plans.length);
          if (plans.length > 0 && summaries.length >= plans.length) completedCount += 1;
        }
      } catch {}
    }
    return {
      name,
      active: activeInfo.active === name,
      status,
      current_phase: currentPhase,
      phases: String(completedCount) + '/' + String(roadmapPhaseCount || 0),
      plans: String(completedPlans) + '/' + String(totalPlans),
      progress_percent: roadmapPhaseCount > 0 ? Math.round((completedCount / roadmapPhaseCount) * 100) : 0,
    };
  });
  return {
    mode: 'workstream',
    active: activeInfo.active,
    workstreams,
    count: workstreams.length,
  };
}
function workstreamPlanningPaths(name) {
  const base = path.join(cwd, '.planning', 'workstreams', name);
  return {
    planning: base,
    state: path.join(base, 'STATE.md'),
    roadmap: path.join(base, 'ROADMAP.md'),
    phases: path.join(base, 'phases'),
    requirements: path.join(base, 'REQUIREMENTS.md'),
  };
}
function listSubdirectories(dirPath) {
  if (!exists(dirPath, 'd')) return [];
  try {
    return fs.readdirSync(dirPath).filter((name) => exists(path.join(dirPath, name), 'd'));
  } catch {
    return [];
  }
}
function filterPlanFiles(files) {
  return files.filter((fileName) => fileName === 'PLAN.md' || /-PLAN\.md$/.test(fileName));
}
function filterSummaryFiles(files) {
  return files.filter((fileName) => fileName === 'SUMMARY.md' || /-SUMMARY\.md$/.test(fileName));
}
function syncRootStateMirror(workstreamName) {
  const wsStatePath = path.join(cwd, '.planning', 'workstreams', workstreamName, 'STATE.md');
  const rootStatePath = path.join(cwd, '.planning', 'STATE.md');
  if (!exists(wsStatePath, 'f')) return false;
  try {
    const content = fs.readFileSync(wsStatePath, 'utf8');
    fs.writeFileSync(rootStatePath, content, 'utf8');
    return true;
  } catch {
    return false;
  }
}
function buildWorkstreamListPayload() {
  const names = listWorkstreamDirectories();
  if (names.length === 0) {
    return {
      mode: 'flat',
      workstreams: [],
      message: 'No workstreams - operating in flat mode',
    };
  }
  return {
    mode: 'workstream',
    workstreams: names,
    count: names.length,
  };
}
function buildWorkstreamStatusPayload(name) {
  if (!name) return { error: 'workstream name required. Usage: workstream status <name>' };
  if (String(name).includes('/') || String(name).includes('\\') || name === '.' || name === '..') {
    return { error: 'Invalid workstream name' };
  }
  const wsDir = path.join(cwd, '.planning', 'workstreams', name);
  if (!exists(wsDir, 'd')) {
    return { found: false, workstream: name };
  }
  const paths = workstreamPlanningPaths(name);
  const files = {
    roadmap: exists(paths.roadmap, 'f'),
    state: exists(paths.state, 'f'),
    requirements: exists(paths.requirements, 'f'),
  };
  const phases = [];
  for (const dirName of listSubdirectories(paths.phases).sort()) {
    try {
      const phaseFiles = fs.readdirSync(path.join(paths.phases, dirName));
      const plans = filterPlanFiles(phaseFiles);
      const summaries = filterSummaryFiles(phaseFiles);
      phases.push({
        directory: dirName,
        status: summaries.length >= plans.length && plans.length > 0
          ? 'complete'
          : plans.length > 0
            ? 'in_progress'
            : 'pending',
        plan_count: plans.length,
        summary_count: summaries.length,
      });
    } catch {}
  }
  let stateInfo = {};
  if (exists(paths.state, 'f')) {
    try {
      const stateContent = fs.readFileSync(paths.state, 'utf8');
      stateInfo = {
        status: extractLabeledValue(stateContent, 'Status') || 'unknown',
        current_phase: extractLabeledValue(stateContent, 'Current Phase') || null,
        last_activity: extractLabeledValue(stateContent, 'Last Activity') || null,
      };
    } catch {}
  }
  return {
    found: true,
    workstream: name,
    path: path.posix.join('.planning', 'workstreams', name),
    files,
    phases,
    phase_count: phases.length,
    completed_phases: phases.filter((phase) => phase.status === 'complete').length,
    ...stateInfo,
  };
}
function buildWorkstreamCreatePayload(rawName) {
  if (!rawName) return { created: false, reason: 'name required' };
  if (String(rawName).includes('/') || String(rawName).includes('\\') || String(rawName).includes('..')) {
    return { created: false, reason: 'invalid workstream name - path separators not allowed' };
  }
  const slug = String(rawName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) {
    return { created: false, reason: 'invalid workstream name - must contain at least one alphanumeric character' };
  }
  const planningRoot = path.join(cwd, '.planning');
  if (!exists(planningRoot, 'd')) {
    return { created: false, reason: '.planning/ directory not found - run /gsd-new-project first' };
  }
  const wsRoot = path.join(planningRoot, 'workstreams');
  const wsDir = path.join(wsRoot, slug);
  if (exists(wsDir, 'd') && exists(path.join(wsDir, 'STATE.md'), 'f')) {
    return {
      created: false,
      error: 'already_exists',
      workstream: slug,
      path: path.posix.join('.planning', 'workstreams', slug),
    };
  }
  fs.mkdirSync(path.join(wsDir, 'phases'), { recursive: true });
  const today = new Date().toISOString().split('T')[0];
  const stateContent = [
    '---',
    'workstream: ' + slug,
    'created: ' + today,
    '---',
    '',
    '# Project State',
    '',
    '## Current Position',
    '**Status:** Not started',
    '**Current Phase:** None',
    '**Last Activity:** ' + today,
    '**Last Activity Description:** Workstream created',
    '',
    '## Progress',
    '**Phases Complete:** 0',
    '**Current Plan:** N/A',
    '',
    '## Session Continuity',
    '**Stopped At:** N/A',
    '**Resume File:** None',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(wsDir, 'STATE.md'), stateContent, 'utf8');
  fs.writeFileSync(path.join(planningRoot, 'active-workstream'), slug + '\n', 'utf8');
  return {
    created: true,
    workstream: slug,
    path: path.posix.join('.planning', 'workstreams', slug),
    state_path: path.posix.join('.planning', 'workstreams', slug, 'STATE.md'),
    phases_path: path.posix.join('.planning', 'workstreams', slug, 'phases'),
    active: true,
  };
}
function buildWorkstreamSetPayload(name) {
  const markerPath = path.join(cwd, '.planning', 'active-workstream');
  if (!name || name === '--clear') {
    if (name !== '--clear') {
      return { set: false, reason: 'name required. Usage: workstream set <name> (or workstream set --clear to unset)' };
    }
    const previous = getActiveWorkstreamInfo().active;
    try { fs.unlinkSync(markerPath); } catch {}
    return { active: null, cleared: true, previous: previous || null };
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    return { active: null, error: 'invalid_name', message: 'Workstream name must be alphanumeric, hyphens, and underscores only' };
  }
  const wsDir = path.join(cwd, '.planning', 'workstreams', name);
  if (!exists(wsDir, 'd')) {
    return { active: null, error: 'not_found', workstream: name };
  }
  fs.writeFileSync(markerPath, name + '\n', 'utf8');
  return { active: name, set: true, mirror_synced: syncRootStateMirror(name) };
}
function buildWorkstreamCompletePayload(name) {
  if (!name) return { completed: false, reason: 'workstream name required' };
  if (String(name).includes('/') || String(name).includes('\\') || name === '.' || name === '..') {
    return { completed: false, reason: 'invalid workstream name' };
  }
  const planningRoot = path.join(cwd, '.planning');
  const wsRoot = path.join(planningRoot, 'workstreams');
  const wsDir = path.join(wsRoot, name);
  if (!exists(wsDir, 'd')) {
    return { completed: false, error: 'not_found', workstream: name };
  }
  const active = getActiveWorkstreamInfo().active;
  const markerPath = path.join(planningRoot, 'active-workstream');
  if (active === name) {
    try { fs.unlinkSync(markerPath); } catch {}
  }
  const archiveDir = path.join(planningRoot, 'milestones');
  fs.mkdirSync(archiveDir, { recursive: true });
  const today = new Date().toISOString().split('T')[0];
  let archivePath = path.join(archiveDir, 'ws-' + name + '-' + today);
  let suffix = 1;
  while (exists(archivePath, 'd')) {
    archivePath = path.join(archiveDir, 'ws-' + name + '-' + today + '-' + String(suffix++));
  }
  fs.mkdirSync(archivePath, { recursive: true });
  const moved = [];
  try {
    for (const entry of fs.readdirSync(wsDir)) {
      fs.renameSync(path.join(wsDir, entry), path.join(archivePath, entry));
      moved.push(entry);
    }
  } catch (error) {
    for (const entry of moved) {
      try { fs.renameSync(path.join(archivePath, entry), path.join(wsDir, entry)); } catch {}
    }
    try { fs.rmdirSync(archivePath); } catch {}
    if (active === name) fs.writeFileSync(markerPath, name + '\n', 'utf8');
    return { completed: false, error: 'archive_failed', message: String(error), workstream: name };
  }
  try { fs.rmdirSync(wsDir); } catch {}
  let remaining = 0;
  try {
    remaining = fs.readdirSync(wsRoot).filter((entry) => exists(path.join(wsRoot, entry), 'd')).length;
    if (remaining === 0) fs.rmdirSync(wsRoot);
  } catch {}
  return {
    completed: true,
    workstream: name,
    archived_to: path.posix.join('.planning', 'milestones', path.basename(archivePath)),
    remaining_workstreams: remaining,
    reverted_to_flat: remaining === 0,
  };
}
function workflowBool(value, defaultValue) {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') return false;
    if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') return true;
  }
  return Boolean(value);
}
function buildCheckConfigGatesPayload(workflowName) {
  const config = readConfig();
  const wf = config.workflow || {};
  const planCheckerFlag = wf.plan_checker !== undefined ? wf.plan_checker : wf.plan_check;
  return {
    workflow: workflowName || null,
    research_enabled: workflowBool(wf.research, true),
    plan_checker_enabled: workflowBool(planCheckerFlag, true),
    nyquist_validation: workflowBool(wf.nyquist_validation, true),
    security_enforcement: workflowBool(wf.security_enforcement, true),
    security_asvs_level: wf.security_asvs_level == null ? 1 : wf.security_asvs_level,
    security_block_on: wf.security_block_on || 'high',
    ui_phase: workflowBool(wf.ui_phase, true),
    ui_safety_gate: workflowBool(wf.ui_safety_gate, true),
    ui_review: workflowBool(wf.ui_review, true),
    text_mode: workflowBool(wf.text_mode, false),
    auto_advance: workflowBool(wf.auto_advance, false),
    auto_chain_active: workflowBool(wf._auto_chain_active, false),
    code_review: workflowBool(wf.code_review, true),
    code_review_depth: wf.code_review_depth || 'standard',
    context_window: typeof config.context_window === 'number' ? config.context_window : 200000,
    discuss_mode: String(wf.discuss_mode || 'discuss'),
    use_worktrees: workflowBool(wf.use_worktrees, true),
    skip_discuss: workflowBool(wf.skip_discuss, false),
    max_discuss_passes: wf.max_discuss_passes == null ? 3 : wf.max_discuss_passes,
    node_repair: workflowBool(wf.node_repair, true),
    research_before_questions: workflowBool(wf.research_before_questions, false),
    verifier: workflowBool(wf.verifier, true),
    plan_check: workflowBool(planCheckerFlag, true),
    subagent_timeout: wf.subagent_timeout == null ? 300 : wf.subagent_timeout,
    context_coverage_gate: workflowBool(wf.context_coverage_gate, true),
  };
}
function buildDetectPhaseTypePayload(rawPhase) {
  const phaseArg = normalizePhaseNumber(rawPhase || '');
  if (!phaseArg) return { error: 'phase number required for detect phase-type' };
  const phaseData = getPhasePlanIndexData(phaseArg);
  const roadmapPhase = parseRoadmapPhase(phaseArg);
  const heading = roadmapPhase && roadmapPhase.section ? roadmapPhase.section.split(/\r?\n/, 1)[0] : '';
  const uiRe = /UI|interface|frontend|component|layout|page|screen|view|form|dashboard|widget/i;
  const apiFileRe = /route\.ts|controller\.|api\//i;
  const apiHeadingRe = /\bAPI\b|endpoint|REST|GraphQL/i;
  const infraRe = /docker|terraform|k8s|helm|infra/i;
  const frontendIndicators = [];
  for (const keyword of ['UI', 'interface', 'frontend', 'component', 'layout', 'page', 'screen', 'view', 'form', 'dashboard', 'widget']) {
    if (heading && new RegExp('\\b' + keyword + '\\b', 'i').test(heading)) frontendIndicators.push(keyword);
  }
  const hasFrontend = (heading && uiRe.test(heading)) || phaseData.has_ui_spec === true;
  const phaseAbs = phaseData.phase_dir ? path.join(cwd, phaseData.phase_dir) : null;
  let dirFiles = [];
  if (phaseAbs && exists(phaseAbs, 'd')) {
    try { dirFiles = fs.readdirSync(phaseAbs); } catch {}
  }
  const schemaFiles = dirFiles.filter((name) => /schema\.prisma$|migration|drizzle|typeorm|sequelize|knex|sqlc|supabase/i.test(name));
  let schemaOrm = null;
  if (schemaFiles.some((name) => /prisma/i.test(name))) schemaOrm = 'prisma';
  else if (schemaFiles.some((name) => /drizzle/i.test(name))) schemaOrm = 'drizzle';
  else if (schemaFiles.some((name) => /typeorm/i.test(name))) schemaOrm = 'typeorm';
  else if (schemaFiles.some((name) => /sequelize/i.test(name))) schemaOrm = 'sequelize';
  else if (schemaFiles.some((name) => /knex/i.test(name))) schemaOrm = 'knex';
  const hasApi = dirFiles.some((name) => apiFileRe.test(name)) || (heading && apiHeadingRe.test(heading));
  const hasInfra = dirFiles.some((name) => infraRe.test(name));
  return {
    phase: phaseArg,
    has_frontend: !!hasFrontend,
    frontend_indicators: frontendIndicators,
    has_schema: schemaFiles.length > 0,
    schema_orm: schemaOrm,
    schema_files: schemaFiles,
    push_command: null,
    has_api: !!hasApi,
    has_infra: !!hasInfra,
  };
}
function countFailLines(content) {
  return (String(content || '').match(/\|\s*FAIL\s*\|/gi) || []).length;
}
function deriveVerificationStatus(content) {
  if (!content) return null;
  const failCount = countFailLines(content);
  if (failCount > 0) return 'fail';
  const passCount = (String(content).match(/\|\s*PASS\s*\|/gi) || []).length;
  if (passCount > 0) return 'pass';
  const statusMatch = String(content).match(/^status:\s*(\S+)/im);
  return statusMatch ? statusMatch[1].toLowerCase() : 'missing';
}
function deriveUatStatus(content) {
  if (!content) return null;
  return countFailLines(content) > 0 ? 'fail' : 'pass';
}
function locatePhaseVerificationAndUatFiles(phaseDir) {
  const result = { verification: null, uat: null };
  if (!phaseDir || !exists(phaseDir, 'd')) return result;
  try {
    const files = fs.readdirSync(phaseDir).sort((a, b) => a.localeCompare(b));
    result.verification = files.includes('VERIFICATION.md')
      ? 'VERIFICATION.md'
      : (files.find((fileName) => /-VERIFICATION\.md$/.test(fileName)) || null);
    result.uat = files.includes('UAT.md')
      ? 'UAT.md'
      : (files.find((fileName) => /-UAT\.md$/.test(fileName)) || null);
  } catch {}
  return result;
}
function buildCheckCompletionPayload(scope, identifier) {
  if (!scope) return { error: 'scope required for check completion (phase|milestone)' };
  if (scope !== 'phase' && scope !== 'milestone') {
    return { error: 'invalid scope "' + scope + '" - must be "phase" or "milestone"' };
  }
  if (scope === 'phase') {
    if (!identifier) return { error: 'phase number required for check completion phase' };
    const phaseData = getPhasePlanIndexData(identifier);
    const plans = Array.isArray(phaseData.plan_files) ? phaseData.plan_files : [];
    const summaries = Array.isArray(phaseData.summary_files) ? phaseData.summary_files : [];
    const summaryIds = new Set(summaries.map((name) => String(name).replace('-SUMMARY.md', '').replace('SUMMARY.md', '')));
    const missingSummaries = plans.filter((name) => {
      const planId = String(name).replace('-PLAN.md', '').replace('PLAN.md', '');
      return !summaryIds.has(planId);
    });
    let verificationContent = null;
    let uatContent = null;
    if (phaseData.phase_dir) {
      const phaseAbs = path.join(cwd, phaseData.phase_dir);
      const files = locatePhaseVerificationAndUatFiles(phaseAbs);
      if (files.verification) {
        try { verificationContent = fs.readFileSync(path.join(phaseAbs, files.verification), 'utf8'); } catch {}
      }
      if (files.uat) {
        try { uatContent = fs.readFileSync(path.join(phaseAbs, files.uat), 'utf8'); } catch {}
      }
    }
    const verificationStatus = deriveVerificationStatus(verificationContent);
    const uatStatus = deriveUatStatus(uatContent);
    return {
      complete: plans.length > 0 && missingSummaries.length === 0 && verificationStatus !== 'fail',
      plans_total: plans.length,
      plans_with_summaries: plans.length - missingSummaries.length,
      missing_summaries: missingSummaries,
      verification_status: verificationStatus,
      uat_status: uatStatus,
      debt: {
        uat_gaps: uatContent ? countFailLines(uatContent) : 0,
        verification_failures: verificationContent ? countFailLines(verificationContent) : 0,
        human_needed: false,
      },
    };
  }
  const roadmap = analyzeRoadmap();
  const phases = Array.isArray(roadmap.phases) ? roadmap.phases : [];
  const completePhases = phases.filter((phase) => phase.roadmap_complete === true || phase.disk_status === 'complete');
  return {
    complete: phases.length > 0 && completePhases.length === phases.length,
    phase_count: phases.length,
    phases_complete: completePhases.length,
    phases_incomplete: phases.filter((phase) => phase.roadmap_complete !== true && phase.disk_status !== 'complete').map((phase) => String(normalizePhaseNumber(phase.number))),
    blockers: [],
  };
}
function buildCheckGatesPayload(rest) {
  const workflow = rest[0];
  if (!workflow) return { error: 'workflow name required for check gates' };
  let phaseNum = null;
  const phaseIndex = rest.indexOf('--phase');
  if (phaseIndex >= 0 && rest[phaseIndex + 1]) phaseNum = rest[phaseIndex + 1];
  const blockers = [];
  const warnings = [];
  if (exists(path.join(cwd, '.continue-here.md'), 'f')) {
    blockers.push({
      gate: 'continue-here',
      file: '.continue-here.md',
      severity: 'blocking',
      anti_patterns: ['continue-here.md present - another session may be in progress'],
    });
  }
  const stateContent = readStateContent();
  if (stateContent && (/^status:\s*(error|failed)/im.test(stateContent) || /##\s*Error/i.test(stateContent))) {
    blockers.push({
      gate: 'state-error',
      file: '.planning/STATE.md',
      severity: 'blocking',
      anti_patterns: ['STATE.md status is error/failed'],
    });
  }
  if (phaseNum) {
    const phaseData = getPhasePlanIndexData(phaseNum);
    if (phaseData.phase_dir) {
      const phaseAbs = path.join(cwd, phaseData.phase_dir);
      const files = locatePhaseVerificationAndUatFiles(phaseAbs);
      if (files.verification) {
        try {
          const content = fs.readFileSync(path.join(phaseAbs, files.verification), 'utf8');
          const failLines = content.match(/\|\s*FAIL\s*\|[^\n]*/gi) || [];
          if (failLines.length > 0) {
            warnings.push({
              gate: 'verification-debt',
              phase: normalizePhaseNumber(phaseNum),
              items: failLines.map((line) => 'FAIL: ' + String(line).trim()),
              message: String(failLines.length) + ' FAIL row(s) in VERIFICATION.md',
            });
          }
        } catch {}
      }
    }
  }
  return {
    passed: blockers.length === 0,
    blockers,
    warnings,
  };
}
function parseVerificationTableRows(content) {
  return String(content || '')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed.startsWith('|') && trimmed.endsWith('|') && !/^\|[-: |]+\|$/.test(trimmed);
    })
    .map((line) => ({
      cells: line.split('|').slice(1, -1).map((cell) => cell.trim()),
      raw: line.trim(),
    }));
}
function buildCheckVerificationStatusPayload(rawPhase) {
  const phaseArg = normalizePhaseNumber(rawPhase || '');
  const empty = { status: 'missing', score: null, gaps: [], human_items: [], deferred: [] };
  if (!phaseArg) return { error: 'phase number required for check verification-status' };
  const phaseData = getPhasePlanIndexData(phaseArg);
  if (!phaseData.phase_dir) return empty;
  const phaseAbs = path.join(cwd, phaseData.phase_dir);
  const files = locatePhaseVerificationAndUatFiles(phaseAbs);
  if (!files.verification) return empty;
  let content = '';
  try { content = fs.readFileSync(path.join(phaseAbs, files.verification), 'utf8'); } catch { return empty; }
  const rows = parseVerificationTableRows(content);
  if (rows.length === 0) {
    const statusMatch = content.match(/^status:\s*(\S+)/im);
    return { ...empty, status: statusMatch ? statusMatch[1].toLowerCase() : 'missing' };
  }
  const firstRow = rows[0];
  const isHeader = firstRow.cells.some((cell) => /^(id|status|description|type|notes)$/i.test(cell));
  const dataRows = isHeader ? rows.slice(1) : rows;
  const headerRow = isHeader ? firstRow : null;
  const findCol = (predicate) => headerRow ? headerRow.cells.findIndex((cell) => predicate(cell)) : -1;
  let statusCol = findCol((cell) => /^status$/i.test(cell));
  let typeCol = findCol((cell) => /^type$/i.test(cell));
  let notesCol = findCol((cell) => /^notes$/i.test(cell));
  let descCol = findCol((cell) => /^description$/i.test(cell));
  if (statusCol === -1) statusCol = 2;
  if (descCol === -1) descCol = 1;
  let passCount = 0;
  let totalCount = 0;
  const gaps = [];
  const humanItems = [];
  const deferred = [];
  for (const row of dataRows) {
    const statusVal = String(row.cells[statusCol] || '').toUpperCase();
    const typeVal = typeCol >= 0 ? String(row.cells[typeCol] || '').toLowerCase() : '';
    const notesVal = notesCol >= 0 ? String(row.cells[notesCol] || '').toLowerCase() : '';
    const descVal = row.cells[descCol] || row.cells[0] || row.raw;
    if (statusVal === 'PASS' || statusVal === 'FAIL') totalCount += 1;
    if (statusVal === 'PASS') passCount += 1;
    if (statusVal === 'FAIL') gaps.push(descVal);
    if (typeVal.includes('human')) humanItems.push(descVal);
    if (notesVal.includes('deferred')) deferred.push(descVal);
  }
  const score = totalCount > 0 ? String(passCount) + '/' + String(totalCount) : null;
  let status = 'partial';
  if (gaps.length > 0) status = 'fail';
  else if (passCount === totalCount && totalCount > 0) status = 'pass';
  else {
    const statusMatch = content.match(/^status:\s*(\S+)/im);
    if (statusMatch) status = statusMatch[1].toLowerCase();
  }
  return {
    status,
    score,
    gaps,
    human_items: humanItems,
    deferred,
  };
}
function runSyncSafe(command) {
  try {
    return execSync(command, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}
function boolSyncSafe(command) {
  return runSyncSafe(command) !== null;
}
function runGit(args, runCwd) {
  const result = spawnSync('git', args, {
    cwd: runCwd || cwd,
    stdio: 'pipe',
    encoding: 'utf8',
  });
  return {
    ok: (result.status || 0) === 0,
    code: typeof result.status === 'number' ? result.status : 1,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
    error: result.error ? String(result.error.message || result.error) : null,
  };
}
function readAheadBehind(gitRoot, upstreamRef) {
  const counts = runGit(['rev-list', '--left-right', '--count', upstreamRef + '...HEAD'], gitRoot);
  if (!counts.ok || !counts.stdout) return { ahead: 0, behind: 0, ok: false };
  const parts = counts.stdout.split(/\s+/).filter(Boolean);
  const behind = parseInt(parts[0] || '0', 10) || 0;
  const ahead = parseInt(parts[1] || '0', 10) || 0;
  return { ahead, behind, ok: true };
}
function pushLocalAheadCommits(options) {
  const opts = options || {};
  const gitRoot = findGitRoot(cwd);
  if (!gitRoot) {
    return {
      ok: false,
      pushed: false,
      reason: 'not-a-git-repo',
      git_root: null,
    };
  }
  const branchRes = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], gitRoot);
  if (!branchRes.ok) {
    return {
      ok: false,
      pushed: false,
      reason: 'branch-detect-failed',
      git_root: gitRoot,
      stderr: branchRes.stderr || branchRes.error || null,
    };
  }
  const branch = branchRes.stdout;
  if (!branch || branch === 'HEAD') {
    return {
      ok: false,
      pushed: false,
      reason: 'detached-head',
      git_root: gitRoot,
      branch: branch || null,
    };
  }
  const remotesRes = runGit(['remote'], gitRoot);
  const remotes = remotesRes.ok ? remotesRes.stdout.split('\n').map((line) => line.trim()).filter(Boolean) : [];
  if (remotes.length === 0) {
    return {
      ok: false,
      pushed: false,
      reason: 'no-remote-configured',
      git_root: gitRoot,
      branch,
    };
  }
  const upstreamRes = runGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], gitRoot);
  const hasUpstream = upstreamRes.ok && !!upstreamRes.stdout;
  const upstream = hasUpstream ? upstreamRes.stdout : null;
  let aheadBehind = { ahead: 0, behind: 0, ok: false };
  if (upstream) aheadBehind = readAheadBehind(gitRoot, upstream);

  if (!upstream) {
    const remoteName = remotes.includes('origin') ? 'origin' : remotes[0];
    const initialPush = runGit(['push', '--set-upstream', remoteName, branch], gitRoot);
    return {
      ok: initialPush.ok,
      pushed: initialPush.ok,
      reason: initialPush.ok ? 'pushed-and-set-upstream' : 'push-failed',
      git_root: gitRoot,
      branch,
      remote: remoteName,
      upstream: remoteName + '/' + branch,
      ahead: null,
      behind: null,
      stdout: initialPush.stdout || null,
      stderr: initialPush.stderr || initialPush.error || null,
    };
  }

  const ahead = aheadBehind.ahead;
  const behind = aheadBehind.behind;
  if (ahead <= 0) {
    return {
      ok: true,
      pushed: false,
      reason: 'already-up-to-date',
      git_root: gitRoot,
      branch,
      upstream,
      ahead,
      behind,
    };
  }
  if (behind > 0 && !opts.allow_behind_push) {
    return {
      ok: false,
      pushed: false,
      reason: 'branch-behind-upstream',
      git_root: gitRoot,
      branch,
      upstream,
      ahead,
      behind,
      message: 'Local branch is behind upstream; rebase/merge before pushing.',
    };
  }
  const push = runGit(['push'], gitRoot);
  return {
    ok: push.ok,
    pushed: push.ok,
    reason: push.ok ? 'pushed' : 'push-failed',
    git_root: gitRoot,
    branch,
    upstream,
    ahead,
    behind,
    stdout: push.stdout || null,
    stderr: push.stderr || push.error || null,
  };
}
function buildCheckShipReadyPayload(rawPhase) {
  const phaseArg = normalizePhaseNumber(rawPhase || '');
  if (!phaseArg) return { error: 'phase number required for check ship-ready' };
  const blockers = [];
  const porcelain = runSyncSafe('git status --porcelain');
  const cleanTree = porcelain !== null && porcelain === '';
  const currentBranch = runSyncSafe('git rev-parse --abbrev-ref HEAD');
  const onFeatureBranch = currentBranch !== null && currentBranch !== 'main' && currentBranch !== 'master';
  let baseBranch = null;
  if (currentBranch) {
    const mergeResult = spawnSync('git', ['config', '--get', 'branch.' + currentBranch + '.merge'], { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    const mergeRef = mergeResult.status === 0 ? mergeResult.stdout.trim() : null;
    if (mergeRef) baseBranch = mergeRef.replace('refs/heads/', '');
    else baseBranch = boolSyncSafe('git rev-parse --verify main') ? 'main' : 'master';
  }
  const remoteOut = runSyncSafe('git remote');
  const remoteConfigured = remoteOut !== null && remoteOut.trim().length > 0;
  const ghAvailable = boolSyncSafe('gh --version') || boolSyncSafe('which gh');
  const verificationStatus = buildCheckVerificationStatusPayload(phaseArg);
  const verificationPassed = verificationStatus.status !== 'fail';
  if (!verificationPassed) blockers.push('verification status is fail or missing');
  if (!cleanTree) blockers.push('working tree is not clean (uncommitted changes)');
  if (!onFeatureBranch) blockers.push('not on a feature branch (currently on main/master or unknown)');
  if (!remoteConfigured) blockers.push('no git remote configured');
  return {
    ready: verificationPassed && cleanTree && onFeatureBranch && remoteConfigured,
    verification_passed: verificationPassed,
    clean_tree: cleanTree,
    on_feature_branch: onFeatureBranch,
    current_branch: currentBranch,
    base_branch: baseBranch,
    remote_configured: remoteConfigured,
    gh_available: ghAvailable,
    gh_authenticated: false,
    blockers,
  };
}
function buildPhaseReadyPayload(rawPhase) {
  const phaseArg = normalizePhaseNumber(rawPhase || '');
  if (!phaseArg) return { error: 'phase number required for check phase-ready' };
  const phaseData = getPhasePlanIndexData(phaseArg);
  const roadmap = analyzeRoadmap();
  const phases = Array.isArray(roadmap.phases) ? roadmap.phases.slice().sort((left, right) => comparePhaseNumbers(left.number, right.number)) : [];
  const phaseSummary = phases.find((phase) => normalizePhaseNumber(phase.number) === phaseArg) || null;
  const currentIndex = phases.findIndex((phase) => normalizePhaseNumber(phase.number) === phaseArg);
  let dependenciesMet = true;
  if (currentIndex > 0) {
    for (let index = 0; index < currentIndex; index++) {
      const prior = phases[index];
      const complete = prior.roadmap_complete === true || prior.disk_status === 'complete';
      if (!complete) {
        dependenciesMet = false;
        break;
      }
    }
  }
  const found = !!phaseData.phase_dir;
  const planCount = Array.isArray(phaseData.plan_files) ? phaseData.plan_files.length : 0;
  const incompletePlans = Array.isArray(phaseData.plans) ? phaseData.plans.filter((plan) => !plan.has_summary).length : 0;
  const hasVerification = !!phaseData.verification_path;
  let nextStep = 'discuss';
  if (!found) {
    nextStep = 'discuss';
  } else if (!phaseData.has_context && !phaseData.has_research) {
    nextStep = 'discuss';
  } else if (planCount === 0) {
    nextStep = 'plan';
  } else if (incompletePlans > 0) {
    nextStep = 'execute';
  } else if (!hasVerification) {
    nextStep = 'verify';
  } else {
    nextStep = 'complete';
  }
  return {
    found,
    ready: found && dependenciesMet,
    phase: phaseArg,
    phase_name: phaseData.phase_name || (phaseSummary ? phaseSummary.name : null),
    phase_dir: phaseData.phase_dir || null,
    has_context: !!phaseData.has_context,
    has_research: !!phaseData.has_research,
    has_plans: planCount > 0,
    plan_count: planCount,
    incomplete_plans: incompletePlans,
    has_verification: hasVerification,
    has_ui_spec: phaseData.has_ui_spec === true,
    has_ui_indicators: phaseData.has_ui_spec === true,
    dependencies_met: dependenciesMet,
    blockers: [],
    next_step: nextStep,
  };
}
function buildRouteNextActionPayload() {
  const state = parseStateSnapshotData();
  const roadmap = analyzeRoadmap();
  const phases = Array.isArray(roadmap.phases) ? roadmap.phases.slice().sort((left, right) => comparePhaseNumbers(left.number, right.number)) : [];
  const currentPhase = state.current_phase || roadmap.current_phase || roadmap.next_phase || (phases[0] ? phases[0].number : null);
  const gates = {
    continue_here: exists(path.join(cwd, '.planning', '.continue-here.md'), 'f'),
    error_state: /\b(error|failed)\b/i.test(String(state.status || '')),
    unresolved_verification: false,
    consecutive_calls: 0,
  };
  const context = {
    has_context: false,
    has_research: false,
    has_plans: false,
    plan_count: 0,
    summary_count: 0,
    has_verification: false,
    paused_at: state.paused_at || null,
    uat_gaps: 0,
  };
  if (!currentPhase) {
    return {
      command: '',
      args: '',
      reason: 'No current phase in STATE.md and no roadmap phases',
      current_phase: null,
      phase_name: null,
      gates,
      context,
    };
  }
  const phaseData = getPhasePlanIndexData(currentPhase);
  context.has_context = !!phaseData.has_context;
  context.has_research = !!phaseData.has_research;
  context.has_plans = Array.isArray(phaseData.plan_files) && phaseData.plan_files.length > 0;
  context.plan_count = Array.isArray(phaseData.plan_files) ? phaseData.plan_files.length : 0;
  context.summary_count = Array.isArray(phaseData.summary_files) ? phaseData.summary_files.length : 0;
  context.has_verification = !!phaseData.verification_path;
  const phaseName = phaseData.phase_name || (phases.find((phase) => normalizePhaseNumber(phase.number) === normalizePhaseNumber(currentPhase)) || {}).name || null;
  if (state.paused_at) {
    return {
      command: '/gsd-resume-work',
      args: '',
      reason: 'Paused - resume work before other routing',
      current_phase: currentPhase,
      phase_name: phaseName,
      gates,
      context,
    };
  }
  if (gates.continue_here || gates.error_state) {
    return {
      command: '',
      args: '',
      reason: gates.continue_here
        ? 'Blocked: .planning/.continue-here.md exists'
        : 'Blocked: STATE.md status is error or failed',
      current_phase: currentPhase,
      phase_name: phaseName,
      gates,
      context,
    };
  }
  if (!phaseData.phase_dir) {
    return {
      command: '/gsd-discuss-phase',
      args: currentPhase,
      reason: 'Phase directory not found - start with discuss',
      current_phase: currentPhase,
      phase_name: phaseName,
      gates,
      context,
    };
  }
  if (!context.has_context && !context.has_research) {
    return {
      command: '/gsd-discuss-phase',
      args: currentPhase,
      reason: 'No CONTEXT.md or RESEARCH.md for this phase',
      current_phase: currentPhase,
      phase_name: phaseName,
      gates,
      context,
    };
  }
  if (!context.has_plans) {
    return {
      command: '/gsd-plan-phase',
      args: currentPhase,
      reason: 'Context exists but no PLAN.md files',
      current_phase: currentPhase,
      phase_name: phaseName,
      gates,
      context,
    };
  }
  const incompletePlans = Array.isArray(phaseData.plans) ? phaseData.plans.filter((plan) => !plan.has_summary) : [];
  if (incompletePlans.length > 0) {
    return {
      command: '/gsd-execute-phase',
      args: currentPhase,
      reason: String(incompletePlans.length) + ' plan(s) still need SUMMARY.md',
      current_phase: currentPhase,
      phase_name: phaseName,
      gates,
      context,
    };
  }
  if (!context.has_verification) {
    return {
      command: '/gsd-verify-work',
      args: '',
      reason: 'All plans have summaries - run verification',
      current_phase: currentPhase,
      phase_name: phaseName,
      gates,
      context,
    };
  }
  const currentIndex = phases.findIndex((phase) => normalizePhaseNumber(phase.number) === normalizePhaseNumber(currentPhase));
  const nextPhase = currentIndex >= 0
    ? phases.slice(currentIndex + 1).find((phase) => phase.disk_status !== 'complete' && !phase.roadmap_complete)
    : null;
  if (nextPhase) {
    return {
      command: '/gsd-discuss-phase',
      args: String(nextPhase.number),
      reason: 'Current phase verified - advance to next phase',
      current_phase: String(nextPhase.number),
      phase_name: String(nextPhase.name || ''),
      gates,
      context,
    };
  }
  return {
    command: '/gsd-complete-milestone',
    args: '',
    reason: 'Verified phase with no further phases - complete milestone',
    current_phase: currentPhase,
    phase_name: phaseName,
    gates,
    context,
  };
}
function determineProgressPhaseStatus(phase) {
  const planCount = Number(phase.plan_count || 0);
  const summaryCount = Number(phase.summary_count || 0);
  if (planCount === 0) return 'Pending';
  if (summaryCount > 0 && summaryCount < planCount) return 'In Progress';
  if (summaryCount < planCount) return 'Planned';
  if (phase.disk_status === 'complete') {
    const phaseInfo = findPhaseDirForReporting(phase.number);
    if (phaseInfo) {
      try {
        const phaseAbs = path.join(cwd, phaseInfo.phase_dir);
        const verificationFile = fs.readdirSync(phaseAbs).find((name) => name === 'VERIFICATION.md' || new RegExp('-VERIFICATION\\\\.md$').test(name));
        if (verificationFile) {
          const verificationContent = fs.readFileSync(path.join(phaseAbs, verificationFile), 'utf8');
          if (/status:\\s*passed/i.test(verificationContent)) return 'Complete';
          if (/status:\\s*human_needed/i.test(verificationContent)) return 'Needs Review';
        }
      } catch {}
    }
    return 'Executed';
  }
  return 'Pending';
}
function buildProgressJsonPayload() {
  const roadmap = analyzeRoadmapForReporting();
  const milestone = roadmap.milestones && roadmap.milestones.length > 0 ? roadmap.milestones[roadmap.milestones.length - 1] : null;
  const phases = Array.isArray(roadmap.phases)
    ? roadmap.phases.map((phase) => ({
        number: phase.number,
        name: phase.name || '',
        plans: Number(phase.plan_count || 0),
        summaries: Number(phase.summary_count || 0),
        status: determineProgressPhaseStatus(phase),
      }))
    : [];
  return {
    milestone_version: milestone ? milestone.version : '',
    milestone_name: milestone ? extractMilestoneName(milestone.heading, milestone.version) : '',
    phases,
    total_plans: Number(roadmap.total_plans || 0),
    total_summaries: Number(roadmap.total_summaries || 0),
    percent: Number(roadmap.progress_percent || 0),
  };
}
function buildProgressBarPayload() {
  const progress = buildProgressJsonPayload();
  const percent = Number(progress.percent || 0);
  const completed = Number(progress.total_summaries || 0);
  const total = Number(progress.total_plans || 0);
  const barWidth = 20;
  const filled = Math.round((percent / 100) * barWidth);
  const bar = '[' + '█'.repeat(filled) + '░'.repeat(barWidth - filled) + '] ' + completed + '/' + total + ' plans (' + percent + '%)';
  return { bar, percent, completed, total };
}
function countRequirementProgress() {
  const requirementsPath = path.join(cwd, '.planning', 'REQUIREMENTS.md');
  if (!exists(requirementsPath, 'f')) return { total: 0, complete: 0 };
  try {
    const content = fs.readFileSync(requirementsPath, 'utf8');
    const checked = content.match(new RegExp('^- \\\\[x\\\\] \\\\*\\\\*', 'gm')) || [];
    const unchecked = content.match(new RegExp('^- \\\\[ \\\\] \\\\*\\\\*', 'gm')) || [];
    return { total: checked.length + unchecked.length, complete: checked.length };
  } catch {
    return { total: 0, complete: 0 };
  }
}
function getGitStats() {
  const commitCount = spawnSync('git', ['rev-list', '--count', 'HEAD'], { cwd, encoding: 'utf8' });
  const gitCommits = commitCount.status === 0 ? parseInt(String(commitCount.stdout || '0').trim(), 10) || 0 : 0;
  let gitFirstCommitDate = null;
  const rootHash = spawnSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd, encoding: 'utf8' });
  if (rootHash.status === 0) {
    const firstCommit = String(rootHash.stdout || '').split(/\\r?\\n/)[0].trim();
    if (firstCommit) {
      const firstDate = spawnSync('git', ['show', '-s', '--format=%as', firstCommit], { cwd, encoding: 'utf8' });
      if (firstDate.status === 0) gitFirstCommitDate = String(firstDate.stdout || '').trim() || null;
    }
  }
  return { git_commits: gitCommits, git_first_commit_date: gitFirstCommitDate };
}
function buildStatsJsonPayload() {
  const progress = buildProgressJsonPayload();
  const requirements = countRequirementProgress();
  const lastActivity = parseStateSnapshotData();
  const completedPhases = Array.isArray(progress.phases)
    ? progress.phases.filter((phase) => phase.status === 'Complete').length
    : 0;
  return {
    milestone_version: progress.milestone_version,
    milestone_name: progress.milestone_name,
    phases: progress.phases,
    phases_completed: completedPhases,
    phases_total: Array.isArray(progress.phases) ? progress.phases.length : 0,
    total_plans: progress.total_plans,
    total_summaries: progress.total_summaries,
    percent: completedPhases > 0 && Array.isArray(progress.phases) && progress.phases.length > 0
      ? Math.min(100, Math.round((completedPhases / progress.phases.length) * 100))
      : 0,
    plan_percent: progress.percent,
    requirements_total: requirements.total,
    requirements_complete: requirements.complete,
    ...getGitStats(),
    last_activity: lastActivity.error ? null : lastActivity.last_activity,
  };
}
function buildInitProgressPayload() {
  const roadmap = analyzeRoadmapForReporting();
  const state = parseStateSnapshotData();
  const milestone = roadmap.milestones && roadmap.milestones.length > 0 ? roadmap.milestones[roadmap.milestones.length - 1] : null;
  const configInfo = getStatePathInfo();
  return {
    project_exists: exists(path.join(cwd, '.planning', 'PROJECT.md'), 'f'),
    roadmap_exists: exists(path.join(cwd, '.planning', 'ROADMAP.md'), 'f'),
    state_exists: exists(path.join(cwd, '.planning', 'STATE.md'), 'f'),
    phases: Array.isArray(roadmap.phases) ? roadmap.phases : [],
    current_phase: state.error ? roadmap.current_phase : state.current_phase,
    next_phase: roadmap.next_phase || null,
    milestone_version: milestone ? milestone.version : '',
    milestone_name: milestone ? extractMilestoneName(milestone.heading, milestone.version) : '',
    completed_count: Number(roadmap.completed_phases || 0),
    phase_count: Number(roadmap.phase_count || 0),
    paused_at: state.error ? null : state.paused_at,
    state_path: exists(path.join(cwd, '.planning', 'STATE.md'), 'f') ? '.planning/STATE.md' : null,
    roadmap_path: exists(path.join(cwd, '.planning', 'ROADMAP.md'), 'f') ? '.planning/ROADMAP.md' : null,
    project_path: exists(path.join(cwd, '.planning', 'PROJECT.md'), 'f') ? '.planning/PROJECT.md' : null,
    config_path: configInfo.config_path,
  };
}
function extractMilestoneName(heading, version) {
  const fullHeading = String(heading || '').trim();
  const normalizedVersion = String(version || '').trim();
  if (!fullHeading) return '';
  if (!normalizedVersion) return fullHeading;
  const index = fullHeading.toLowerCase().indexOf(normalizedVersion.toLowerCase());
  if (index < 0) return fullHeading;
  const suffix = fullHeading.slice(index + normalizedVersion.length).trim();
  return suffix || fullHeading;
}
function getCurrentMilestoneInfo() {
  const roadmap = analyzeRoadmapForReporting();
  const milestone = roadmap.milestones && roadmap.milestones.length > 0 ? roadmap.milestones[roadmap.milestones.length - 1] : null;
  const heading = milestone ? milestone.heading : '';
  return {
    roadmap,
    milestone_version: milestone ? milestone.version : '',
    milestone_name: extractMilestoneName(heading, milestone ? milestone.version : ''),
  };
}
function truncateDisplayName(name, maxWidth) {
  const value = String(name || '').trim();
  const width = Number(maxWidth || 20);
  if (!value || value.length <= width) return value;
  return value.slice(0, Math.max(1, width - 1)).trimEnd() + '…';
}
function formatDepsDisplay(dependsOn) {
  const value = String(dependsOn || '').trim();
  if (!value) return '—';
  return value.replace(/phase\\s+/gi, '').replace(/\\s+/g, ' ').trim() || '—';
}
function getActivePhaseRuns() {
  const activeByPhase = new Map();
  for (const run of listSubagentExecutionRuns()) {
    if (!run || typeof run !== 'object') continue;
    const status = String(run.status || '');
    if (status !== 'running' && status !== 'pending') continue;
    const phaseNumber = normalizePhaseNumber(run.phase_number || '');
    if (!phaseNumber) continue;
    const existing = activeByPhase.get(phaseNumber);
    if (!existing || Number(existing.updated_at_unix_ms || 0) < Number(run.updated_at_unix_ms || 0)) {
      activeByPhase.set(phaseNumber, run);
    }
  }
  return activeByPhase;
}
function getManagerFlags() {
  const rawFlags = getConfigValue('manager.flags', {});
  const flags = rawFlags && typeof rawFlags === 'object' ? rawFlags : {};
  return {
    discuss: typeof flags.discuss === 'string' ? flags.discuss : '',
    plan: typeof flags.plan === 'string' ? flags.plan : '',
    execute: typeof flags.execute === 'string' ? flags.execute : '',
  };
}
function buildManagerPayload() {
  const { roadmap, milestone_version, milestone_name } = getCurrentMilestoneInfo();
  const state = parseStateSnapshotData();
  const activeRuns = getActivePhaseRuns();
  const phases = Array.isArray(roadmap.phases) ? roadmap.phases.map((phase) => {
    const phaseNumber = normalizePhaseNumber(phase.number);
    const activeRun = activeRuns.get(phaseNumber);
    const diskStatus = String(phase.disk_status || 'empty');
    const isNextToDiscuss = !activeRun
      && (diskStatus === 'empty' || diskStatus === 'no_directory')
      && normalizePhaseNumber(roadmap.next_phase || '') === phaseNumber;
    const displayStatus = activeRun && diskStatus === 'planned'
      ? 'planning'
      : activeRun && (diskStatus === 'partial' || diskStatus === 'executed' || diskStatus === 'needs_review')
        ? 'executing'
        : diskStatus;
    return {
      number: phaseNumber,
      name: String(phase.name || ''),
      display_name: truncateDisplayName(phase.name || '', 20),
      deps_display: formatDepsDisplay(phase.depends_on),
      goal: phase.goal || '',
      disk_status: displayStatus,
      roadmap_complete: !!phase.roadmap_complete,
      is_active: !!activeRun,
      active_action: activeRun ? (String(activeRun.agent_name || activeRun.display_name || activeRun.role || '').toLowerCase().includes('planner') ? 'Planning' : 'Executing') : '',
      is_next_to_discuss: isNextToDiscuss,
      plan_count: Number(phase.plan_count || 0),
      summary_count: Number(phase.summary_count || 0),
    };
  }) : [];
  const recommendedActions = [];
  for (const phase of phases) {
    if (phase.is_active) continue;
    if (phase.disk_status === 'planned') {
      recommendedActions.push({ action: 'execute', phase_number: phase.number, phase_name: phase.name, label: 'Execute Phase ' + phase.number, background: true });
      continue;
    }
    if (phase.disk_status === 'discussed' || phase.disk_status === 'researched') {
      recommendedActions.push({ action: 'plan', phase_number: phase.number, phase_name: phase.name, label: 'Plan Phase ' + phase.number, background: true });
      continue;
    }
    if ((phase.disk_status === 'empty' || phase.disk_status === 'no_directory') && phase.is_next_to_discuss) {
      recommendedActions.push({ action: 'discuss', phase_number: phase.number, phase_name: phase.name, label: 'Discuss Phase ' + phase.number, background: false });
      break;
    }
  }
  const activeSummaries = phases.filter((phase) => phase.is_active).map((phase) => (phase.active_action || 'Working') + ' Phase ' + phase.number);
  return {
    milestone_version,
    milestone_name,
    phase_count: Number(roadmap.phase_count || phases.length || 0),
    completed_count: Number(roadmap.completed_phases || phases.filter((phase) => phase.disk_status === 'complete').length || 0),
    in_progress_count: phases.filter((phase) => ['planned', 'partial', 'executed', 'needs_review', 'discussed', 'researched', 'planning', 'executing'].includes(phase.disk_status) || phase.is_active).length,
    phases,
    recommended_actions: recommendedActions,
    all_complete: phases.length > 0 && phases.every((phase) => phase.disk_status === 'complete'),
    waiting_signal: activeSummaries.length > 0 ? activeSummaries.join(', ') : '',
    manager_flags: getManagerFlags(),
    queued_milestone_version: '',
    queued_milestone_name: '',
    queued_phases: [],
    current_phase: state.error ? roadmap.current_phase : state.current_phase,
    progress_percent: Number(roadmap.progress_percent || 0),
    text_mode: getConfigFlag('workflow.text_mode', false),
    commit_docs: readConfig().commit_docs !== false,
  };
}
function getResumePayload() {
  const planningDir = path.join(cwd, '.planning');
  const interrupted = listSubagentExecutionRuns().find((run) => {
    const status = String(run && run.status || '');
    return status === 'running' || status === 'pending';
  });
  return {
    state_exists: exists(path.join(planningDir, 'STATE.md'), 'f'),
    roadmap_exists: exists(path.join(planningDir, 'ROADMAP.md'), 'f'),
    project_exists: exists(path.join(planningDir, 'PROJECT.md'), 'f'),
    planning_exists: exists(planningDir, 'd'),
    has_interrupted_agent: !!interrupted,
    interrupted_agent_id: interrupted ? String(interrupted.run_id || interrupted.agent_id || '') : '',
    commit_docs: readConfig().commit_docs !== false,
  };
}
function listPendingTodos(area) {
  const pendingDir = path.join(cwd, '.planning', 'todos', 'pending');
  const todos = [];
  if (!exists(pendingDir, 'd')) return { area: area || null, todo_count: 0, todos };
  for (const file of fs.readdirSync(pendingDir).filter((name) => name.endsWith('.md'))) {
    try {
      const content = fs.readFileSync(path.join(pendingDir, file), 'utf8');
      let createdValue = '';
      let titleValue = 'Untitled';
      let areaValue = 'general';
      for (const line of content.split(/\r?\n/)) {
        const separator = line.indexOf(':');
        if (separator < 0) continue;
        const key = line.slice(0, separator).trim();
        const value = line.slice(separator + 1).trim();
        if (key === 'created') createdValue = value;
        else if (key === 'title' && value) titleValue = value;
        else if (key === 'area' && value) areaValue = value;
      }
      const todoArea = areaValue;
      if (area && todoArea !== area) continue;
      todos.push({
        file,
        created: createdValue,
        title: titleValue,
        area: todoArea,
        path: path.join('.planning', 'todos', 'pending', file),
      });
    } catch {}
  }
  todos.sort((left, right) => String(left.created || '').localeCompare(String(right.created || '')));
  return { area: area || null, todo_count: todos.length, todos };
}
function getAgentSkillsBlock(agentType) {
  const normalizedType = String(agentType || '').trim();
  if (!normalizedType) return '';
  const config = readConfig();
  const agentSkills = config.agent_skills && typeof config.agent_skills === 'object' ? config.agent_skills : {};
  const raw = agentSkills[normalizedType];
  const entries = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const refs = [];
  for (const entry of entries) {
    if (typeof entry !== 'string' || !entry.trim()) continue;
    if (entry.startsWith('global:')) {
      const skillName = entry.slice(7).trim();
      if (!skillName) continue;
      refs.push('~/.claude/skills/' + skillName + '/SKILL.md');
      continue;
    }
    const cleanEntry = entry.replace(/\/+$/, '');
    if (exists(path.join(cwd, cleanEntry, 'SKILL.md'), 'f')) refs.push(cleanEntry + '/SKILL.md');
  }
  if (refs.length === 0) return '';
  return '<agent_skills>\nRead these user-configured skills:\n' + refs.map((ref) => '- @' + ref).join('\n') + '\n</agent_skills>';
}
function recordStateSession(argv) {
  const stoppedIndex = argv.indexOf('--stopped-at');
  const resumeIndex = argv.indexOf('--resume-file');
  const stoppedAt = stoppedIndex >= 0 ? String(argv[stoppedIndex + 1] || '').trim() : '';
  const resumeFile = resumeIndex >= 0 ? String(argv[resumeIndex + 1] || '').trim() : 'None';
  const statePath = path.join(cwd, '.planning', 'STATE.md');
  if (!exists(statePath, 'f')) return { recorded: false, reason: 'STATE.md not found' };
  const now = new Date().toISOString();
  let content = fs.readFileSync(statePath, 'utf8');
  const originalContent = content;
  const updated = [];
  function replaceSessionField(label, value) {
    const pattern = new RegExp('^(\\*\\*' + escapeRegex(label) + ':?\\*\\*\\s*:?\\s*|' + escapeRegex(label) + ':\\s*).*$','mi');
    if (!pattern.test(content)) return false;
    content = content.replace(pattern, '$1' + value);
    updated.push(label);
    return true;
  }
  function upsertSessionField(key, value) {
    const next = upsertLine(content, key, value);
    if (next === content) return false;
    content = next;
    updated.push(key);
    return true;
  }
  replaceSessionField('Last session', now);
  replaceSessionField('Last Date', now);
  if (stoppedAt) {
    if (!replaceSessionField('Stopped At', stoppedAt)) replaceSessionField('Stopped at', stoppedAt);
  }
  if (!replaceSessionField('Resume File', resumeFile)) replaceSessionField('Resume file', resumeFile);
  upsertSessionField('last_session', now);
  upsertSessionField('last_date', now);
  if (stoppedAt) upsertSessionField('stopped_at', stoppedAt);
  upsertSessionField('resume_file', resumeFile);
  if (content !== originalContent) {
    fs.writeFileSync(statePath, content, 'utf8');
    return { recorded: true, updated: [...new Set(updated)] };
  }
  return { recorded: false, reason: 'No session fields found in STATE.md' };
}
function todoMatchPhase(phase) {
  const phaseValue = String(phase || '').trim();
  if (!phaseValue) return { error: 'phase required for todo match-phase' };
  const todoData = listPendingTodos(null);
  const todos = Array.isArray(todoData.todos) ? todoData.todos : [];
  if (todos.length === 0) return { phase: phaseValue, matches: [], todo_count: 0 };
  const pendingDir = path.join(cwd, '.planning', 'todos', 'pending');
  const enrichedTodos = [];
  function parsePhaseAssignments(value) {
    if (Array.isArray(value)) return value.map((entry) => normalizePhaseNumber(entry)).filter(Boolean);
    const text = String(value == null ? '' : value).trim();
    if (!text) return [];
    if (text.startsWith('[') && text.endsWith(']')) {
      return text
        .slice(1, -1)
        .split(',')
        .map((entry) => normalizePhaseNumber(entry.replace(/['"]/g, '').trim()))
        .filter(Boolean);
    }
    return [normalizePhaseNumber(text)].filter(Boolean);
  }
  for (const todo of todos) {
    try {
      const content = fs.readFileSync(path.join(pendingDir, todo.file), 'utf8');
      const frontmatter = parseFrontmatter(content);
      const filesFromFrontmatter = getFrontmatterList(frontmatter, 'files', 'files_modified');
      const filesMatch = content.match(/^files:\s*(.+)$/m);
      const resolvesPhaseMatch = content.match(/^resolves_phase:\s*(.+)$/m);
      const frontmatterBlock = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
      const body = (frontmatterBlock ? content.slice(frontmatterBlock[0].length) : content)
        .replace(/^(title|area|files|created|priority|resolves_phase):.*$/gm, '')
        .trim();
      enrichedTodos.push({
        ...todo,
        title: String(frontmatter.title || todo.title || 'Untitled'),
        area: String(frontmatter.area || todo.area || 'general'),
        files: filesFromFrontmatter.length > 0
          ? filesFromFrontmatter
          : filesMatch
            ? filesMatch[1].trim().split(/[,\s]+/).filter(Boolean)
            : [],
        resolvesPhase: parsePhaseAssignments(
          frontmatter.resolves_phase != null
            ? frontmatter.resolves_phase
            : resolvesPhaseMatch
              ? resolvesPhaseMatch[1].trim()
              : frontmatter.phase,
        ),
        body: body.slice(0, 200),
      });
    } catch {
      enrichedTodos.push({ ...todo, files: [], resolvesPhase: [], body: '' });
    }
  }
  const roadmapPhase = parseRoadmapPhase(phaseValue);
  const phaseInfoDisk = findPhaseDirectory(phaseValue);
  const stopWords = new Set(['the','and','for','with','from','that','this','will','are','was','has','have','been','not','but','all','can','into','each','when','any','use','new']);
  const phaseText = [roadmapPhase?.phase_name || '', roadmapPhase?.goal || '', roadmapPhase?.section || ''].join(' ').toLowerCase();
  const phaseKeywords = new Set(phaseText.split(/[\s\-_/.,;:()\[\]{}|]+/).map((word) => word.replace(/[^a-z0-9]/g, '')).filter((word) => word.length > 2 && !stopWords.has(word)));
  const phasePlans = [];
  if (phaseInfoDisk && phaseInfoDisk.found) {
    try {
      const phaseDir = path.join(cwd, phaseInfoDisk.phaseDir);
      for (const planFile of fs.readdirSync(phaseDir).filter((name) => name.endsWith('-PLAN.md'))) {
        const planContent = fs.readFileSync(path.join(phaseDir, planFile), 'utf8');
        const filesMatch = planContent.match(/files_modified:\s*\[([^\]]*)\]/);
        if (filesMatch) {
          phasePlans.push(...filesMatch[1].split(',').map((item) => item.trim().replace(/['"]/g, '')).filter(Boolean));
        }
      }
    } catch {}
  }
  const matches = [];
  const normalizedTargetPhase = normalizePhaseNumber(phaseValue);
  for (const todo of enrichedTodos) {
    let score = 0;
    const reasons = [];
    if (Array.isArray(todo.resolvesPhase) && todo.resolvesPhase.some((candidate) => comparePhaseValues(candidate, normalizedTargetPhase) === 0)) {
      score = 1;
      reasons.push('resolves_phase: ' + normalizedTargetPhase);
    }
    const todoWords = (String(todo.title || '') + ' ' + String(todo.body || ''))
      .toLowerCase()
      .split(/[\s\-_/.,;:()\[\]{}|]+/)
      .map((word) => word.replace(/[^a-z0-9]/g, ''))
      .filter((word) => word.length > 2 && !stopWords.has(word));
    const matchedKeywords = todoWords.filter((word) => phaseKeywords.has(word));
    if (matchedKeywords.length > 0) {
      score += Math.min(matchedKeywords.length * 0.2, 0.6);
      reasons.push('keywords: ' + [...new Set(matchedKeywords)].slice(0, 5).join(', '));
    }
    if (todo.area !== 'general' && phaseText.includes(String(todo.area || '').toLowerCase())) {
      score += 0.3;
      reasons.push('area: ' + todo.area);
    }
    if (Array.isArray(todo.files) && todo.files.length > 0 && phasePlans.length > 0) {
      const fileOverlap = todo.files.filter((file) => phasePlans.some((planFile) => String(planFile).includes(file) || String(file).includes(planFile)));
      if (fileOverlap.length > 0) {
        score += 0.4;
        reasons.push('files: ' + fileOverlap.slice(0, 3).join(', '));
      }
    }
    if (score > 0) {
      matches.push({
        file: todo.file,
        title: todo.title,
        area: todo.area,
        score: Math.round(score * 100) / 100,
        reasons,
      });
    }
  }
  matches.sort((left, right) => right.score - left.score);
  return { phase: phaseValue, matches, todo_count: enrichedTodos.length };
}
function verifyPlanStructure(planPathArg) {
  const planPath = String(planPathArg || '').trim();
  if (!planPath) return { error: 'file path required', classification: 'validation' };
  if (planPath.includes('\0')) return { error: 'file path contains null bytes', classification: 'validation' };
  const fullPath = path.isAbsolute(planPath) ? planPath : path.join(cwd, planPath);
  if (!exists(fullPath, 'f')) return { error: 'File not found', path: planPath };

  const content = fs.readFileSync(fullPath, 'utf8');
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const fmLines = fmMatch ? fmMatch[1].split(/\r?\n/) : [];
  const fm = {};
  let currentListKey = null;
  for (const rawLine of fmLines) {
    const line = String(rawLine || '');
    const topLevel = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (topLevel) {
      currentListKey = null;
      const key = topLevel[1];
      const rawValue = topLevel[2].trim();
      if (!rawValue) {
        fm[key] = [];
        currentListKey = key;
      } else {
        fm[key] = rawValue;
      }
      continue;
    }
    const listItem = line.match(/^\s*-\s*(.+)\s*$/);
    if (listItem && currentListKey) {
      if (!Array.isArray(fm[currentListKey])) fm[currentListKey] = [];
      fm[currentListKey].push(listItem[1].trim());
    }
  }
  const errors = [];
  const warnings = [];
  const required = ['phase', 'plan', 'type', 'wave', 'depends_on', 'files_modified', 'autonomous', 'must_haves'];
  for (const field of required) {
    if (typeof fm[field] === 'undefined') errors.push('Missing required frontmatter field: ' + field);
  }

  const taskPattern = /<task[^>]*>([\s\S]*?)<\/task>/g;
  const tasks = [];
  let taskMatch;
  while ((taskMatch = taskPattern.exec(content)) !== null) {
    const taskContent = String(taskMatch[1] || '');
    const nameMatch = taskContent.match(/<name>([\s\S]*?)<\/name>/);
    const taskName = nameMatch ? nameMatch[1].trim() : 'unnamed';
    const hasFiles = /<files>/.test(taskContent);
    const hasAction = /<action>/.test(taskContent);
    const hasVerify = /<verify>/.test(taskContent);
    const hasDone = /<done>/.test(taskContent);
    if (!nameMatch) errors.push('Task missing <name> element');
    if (!hasAction) errors.push("Task '" + taskName + "' missing <action>");
    if (!hasVerify) warnings.push("Task '" + taskName + "' missing <verify>");
    if (!hasDone) warnings.push("Task '" + taskName + "' missing <done>");
    if (!hasFiles) warnings.push("Task '" + taskName + "' missing <files>");
    tasks.push({ name: taskName, hasFiles, hasAction, hasVerify, hasDone });
  }
  if (tasks.length === 0) warnings.push('No <task> elements found');

  const waveValue = parseInt(String(fm.wave == null ? '' : fm.wave), 10);
  const dependsOn = fm.depends_on;
  const dependsOnEmpty = dependsOn == null || dependsOn === '' || dependsOn === '[]' || (Array.isArray(dependsOn) && dependsOn.length === 0);
  if (Number.isFinite(waveValue) && waveValue > 1 && dependsOnEmpty) {
    warnings.push('Wave > 1 but depends_on is empty');
  }

  const hasCheckpoints = /<task\s+type=["']?checkpoint/i.test(content);
  if (hasCheckpoints && fm.autonomous !== 'false') {
    errors.push('Has checkpoint tasks but autonomous is not false');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    task_count: tasks.length,
    tasks,
    frontmatter_fields: Object.keys(fm),
  };
}
function verifyPhaseCompleteness(phaseArg) {
  const phase = String(phaseArg || '').trim();
  if (!phase) return { error: 'phase required', classification: 'validation' };
  const phaseInfo = findPhaseDirectory(phase);
  if (!phaseInfo.found) return { error: 'Phase not found', phase };
  const phaseDirAbs = path.join(cwd, phaseInfo.phaseDir);
  if (!exists(phaseDirAbs, 'd')) return { error: 'Cannot read phase directory' };

  const files = fs.readdirSync(phaseDirAbs);
  const plans = files.filter((name) => /-PLAN\.md$/i.test(name));
  const summaries = files.filter((name) => /-SUMMARY\.md$/i.test(name));
  const planIds = new Set(plans.map((name) => name.replace(/-PLAN\.md$/i, '')));
  const summaryIds = new Set(summaries.map((name) => name.replace(/-SUMMARY\.md$/i, '')));
  const incompletePlans = [...planIds].filter((id) => !summaryIds.has(id));
  const orphanSummaries = [...summaryIds].filter((id) => !planIds.has(id));
  const errors = [];
  const warnings = [];
  if (incompletePlans.length > 0) errors.push('Plans without summaries: ' + incompletePlans.join(', '));
  if (orphanSummaries.length > 0) warnings.push('Summaries without plans: ' + orphanSummaries.join(', '));
  return {
    complete: errors.length === 0,
    phase: phaseInfo.normalized || normalizePhaseNumber(phase),
    plan_count: plans.length,
    summary_count: summaries.length,
    incomplete_plans: incompletePlans,
    orphan_summaries: orphanSummaries,
    errors,
    warnings,
  };
}
function checkCommit() {
  const config = readConfig();
  const commitDocs = config.commit_docs !== false;
  const diffResult = spawnSync('git', ['diff', '--cached', '--name-only'], { cwd, encoding: 'utf8' });
  const stagedFiles = diffResult.status === 0 && diffResult.stdout
    ? diffResult.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    : [];
  if (!commitDocs) {
    const planningFiles = stagedFiles.filter((file) => file.startsWith('.planning/') || file.startsWith('.planning\\'));
    if (planningFiles.length > 0) {
      return {
        allowed: false,
        can_commit: false,
        reason: 'commit_docs is false but ' + planningFiles.length + ' .planning/ file(s) are staged',
        commit_docs: false,
        staged_files: planningFiles,
      };
    }
  }
  return {
    allowed: true,
    can_commit: true,
    reason: commitDocs ? 'commit_docs_enabled' : 'no_planning_files_staged',
    commit_docs: commitDocs,
    staged_files: stagedFiles,
  };
}
function replaceStateField(content, label, value) {
  const escaped = escapeRegex(label);
  const patterns = [
    new RegExp('^(\\*\\*' + escaped + ':?\\*\\*\\s*:?\\s*).*$','mi'),
    new RegExp('^(' + escaped + ':\\s*).*$','mi'),
  ];
  for (const pattern of patterns) {
    if (pattern.test(content)) {
      return content.replace(pattern, '$1' + value);
    }
  }
  return null;
}
function setStateFields(content, updates) {
  let next = String(content || '');
  const changed = [];
  for (const update of updates) {
    const value = String(update.value == null ? '' : update.value);
    if (update.label) {
      const replaced = replaceStateField(next, update.label, value);
      if (replaced && replaced !== next) {
        next = replaced;
        changed.push(update.label);
      }
    }
    if (update.key) {
      const updated = upsertLine(next, update.key, value);
      if (updated !== next) {
        next = updated;
        changed.push(update.key);
      }
    }
  }
  return { content: next, changed: [...new Set(changed)] };
}
function countPlanAndSummaryFiles() {
  const phasesDir = path.join(cwd, '.planning', 'phases');
  let totalPlans = 0;
  let totalSummaries = 0;
  let highestIncompletePhase = null;
  let highestIncompletePhasePlanCount = 0;
  if (!exists(phasesDir, 'd')) {
    return { totalPlans, totalSummaries, highestIncompletePhase, highestIncompletePhasePlanCount };
  }
  for (const dir of fs.readdirSync(phasesDir).sort(comparePhaseNumbers)) {
    const dirPath = path.join(phasesDir, dir);
    if (!exists(dirPath, 'd')) continue;
    const files = fs.readdirSync(dirPath);
    const plans = files.filter((name) => /-PLAN\.md$/i.test(name)).length;
    const summaries = files.filter((name) => /-SUMMARY\.md$/i.test(name)).length;
    totalPlans += plans;
    totalSummaries += summaries;
    const phaseMatch = dir.match(/^(\d+[A-Z]?(?:\.\d+)*)/i);
    if (phaseMatch && plans > 0 && summaries < plans) {
      highestIncompletePhase = phaseMatch[1];
      highestIncompletePhasePlanCount = plans;
    }
  }
  return { totalPlans, totalSummaries, highestIncompletePhase, highestIncompletePhasePlanCount };
}
function buildProgressString(percent) {
  const barWidth = 10;
  const filled = Math.round(percent / 100 * barWidth);
  return '[' + '█'.repeat(filled) + '░'.repeat(barWidth - filled) + '] ' + percent + '%';
}
function stateUpdateProgress() {
  const statePath = path.join(cwd, '.planning', 'STATE.md');
  if (!exists(statePath, 'f')) return { updated: false, reason: 'STATE.md not found' };
  const { totalPlans, totalSummaries } = countPlanAndSummaryFiles();
  const percent = totalPlans > 0 ? Math.min(100, Math.round(totalSummaries / totalPlans * 100)) : 0;
  const progressStr = buildProgressString(percent);
  let content = fs.readFileSync(statePath, 'utf8');
  const original = content;
  const replaced = replaceStateField(content, 'Progress', progressStr);
  if (replaced) content = replaced;
  const updated = upsertLine(upsertLine(upsertLine(content, 'progress_percent', String(percent)), 'completed_plans', String(totalSummaries)), 'total_plans', String(totalPlans));
  content = updated;
  if (content !== original) {
    fs.writeFileSync(statePath, content, 'utf8');
    return { updated: true, percent, completed: totalSummaries, total: totalPlans, bar: progressStr };
  }
  return { updated: false, reason: 'Progress field not found in STATE.md' };
}
function stateSignalWaiting(args) {
  function getFlag(name) {
    const index = args.indexOf('--' + name);
    return index >= 0 && args[index + 1] != null && !String(args[index + 1]).startsWith('--')
      ? String(args[index + 1])
      : null;
  }
  const signal = {
    status: 'waiting',
    type: getFlag('type') || 'decision_point',
    question: getFlag('question') || null,
    options: getFlag('options') ? String(getFlag('options')).split('|').map((item) => item.trim()).filter(Boolean) : [],
    since: new Date().toISOString(),
    phase: getFlag('phase') || null,
  };
  const waitingPaths = [
    path.join(cwd, '.gsd', 'WAITING.json'),
    path.join(cwd, '.planning', 'WAITING.json'),
  ];
  try {
    fs.mkdirSync(path.join(cwd, '.gsd'), { recursive: true });
    fs.mkdirSync(path.join(cwd, '.planning'), { recursive: true });
    const payload = JSON.stringify(signal, null, 2);
    for (const waitingPath of waitingPaths) fs.writeFileSync(waitingPath, payload, 'utf8');
    return { signaled: true, path: waitingPaths[0], paths: waitingPaths };
  } catch (error) {
    return { signaled: false, error: error instanceof Error ? error.message : String(error) };
  }
}
function stateSignalResume() {
  const waitingPaths = [
    path.join(cwd, '.gsd', 'WAITING.json'),
    path.join(cwd, '.planning', 'WAITING.json'),
  ];
  let removed = false;
  for (const waitingPath of waitingPaths) {
    if (!exists(waitingPath, 'f')) continue;
    try {
      fs.unlinkSync(waitingPath);
      removed = true;
    } catch {}
  }
  return { resumed: true, removed };
}
function stateSync(args) {
  const verify = args.includes('--verify');
  const statePath = path.join(cwd, '.planning', 'STATE.md');
  if (!exists(statePath, 'f')) return { error: 'STATE.md not found' };
  const original = fs.readFileSync(statePath, 'utf8');
  const changes = [];
  const today = new Date().toISOString().split('T')[0];
  const { totalPlans, totalSummaries, highestIncompletePhase, highestIncompletePhasePlanCount } = countPlanAndSummaryFiles();
  let content = original;
  const percent = totalPlans > 0 ? Math.min(100, Math.round((totalSummaries / totalPlans) * 100)) : 0;
  const progressStr = buildProgressString(percent);
  const currentProgress = extractLabeledValue(content, 'Progress');
  if (currentProgress && currentProgress !== progressStr) changes.push('Progress: ' + currentProgress + ' -> ' + progressStr);
  const replacedProgress = replaceStateField(content, 'Progress', progressStr);
  if (replacedProgress) content = replacedProgress;
  const lastActivity = extractLabeledValue(content, 'Last Activity');
  if (lastActivity && lastActivity !== today) changes.push('Last Activity: ' + lastActivity + ' -> ' + today);
  const stateUpdates = setStateFields(content, [
    { label: 'Last Activity', key: 'last_activity', value: today },
    { label: 'Total Plans in Phase', key: 'total_plans_in_phase', value: highestIncompletePhasePlanCount || 0 },
    { label: 'Current Phase', key: 'current_phase', value: highestIncompletePhase || '' },
    { key: 'progress_percent', value: percent },
    { key: 'completed_plans', value: totalSummaries },
    { key: 'total_plans', value: totalPlans },
  ]);
  content = stateUpdates.content;
  if (verify) {
    return { synced: false, changes, dry_run: true };
  }
  if (content !== original) {
    fs.writeFileSync(statePath, content, 'utf8');
  }
  return { synced: true, changes, dry_run: false };
}
function todoComplete(filenameArg) {
  const filename = String(filenameArg || '').trim();
  if (!filename) return { error: 'filename required for todo complete', classification: 'validation' };
  const pendingDir = path.join(cwd, '.planning', 'todos', 'pending');
  const completedDir = path.join(cwd, '.planning', 'todos', 'completed');
  const sourcePath = path.join(pendingDir, filename);
  if (!exists(sourcePath, 'f')) return { error: 'Todo not found: ' + filename, classification: 'validation' };
  fs.mkdirSync(completedDir, { recursive: true });
  const today = new Date().toISOString().split('T')[0];
  const content = 'completed: ' + today + '\n' + fs.readFileSync(sourcePath, 'utf8');
  fs.writeFileSync(path.join(completedDir, filename), content, 'utf8');
  fs.unlinkSync(sourcePath);
  return { completed: true, file: filename, date: today };
}
function configPath() {
  return { path: path.join(cwd, '.planning', 'config.json') };
}
function getAgentToModelMapForProfile(profileName) {
  const normalized = normalizeModelProfile(profileName);
  const result = {};
  for (const agentName of Object.keys(MODEL_PROFILES)) {
    result[agentName] = getProfileModel(agentName, normalized, 'sonnet');
  }
  return result;
}
function configSetModelProfile(profileNameArg) {
  const profileName = String(profileNameArg || '').trim();
  if (!profileName) return { error: 'Usage: config-set-model-profile <' + VALID_MODEL_PROFILES.join('|') + '>', classification: 'validation' };
  const normalized = profileName.toLowerCase();
  if (!VALID_MODEL_PROFILES.includes(normalized)) {
    return { error: "Invalid profile '" + profileName + "'. Valid profiles: " + VALID_MODEL_PROFILES.join(', '), classification: 'validation' };
  }
  const cfgPath = path.join(cwd, '.planning', 'config.json');
  let config = {};
  if (exists(cfgPath, 'f')) {
    try { config = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch {}
  }
  const previousProfile = typeof config.model_profile === 'string' && VALID_MODEL_PROFILES.includes(String(config.model_profile).toLowerCase())
    ? String(config.model_profile).toLowerCase()
    : 'balanced';
  config.model_profile = normalized;
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  return {
    updated: true,
    profile: normalized,
    previousProfile,
    agentToModelMap: getAgentToModelMapForProfile(normalized),
  };
}
function planTaskStructure(planPathArg) {
  const rel = String(planPathArg || '').trim();
  if (!rel) return { error: 'PLAN.md path required', classification: 'validation' };
  const fullPath = resolveProjectPath(rel);
  if (!exists(fullPath, 'f')) return { error: 'cannot read plan file: ' + rel, classification: 'blocked' };
  const content = fs.readFileSync(fullPath, 'utf8');
  const frontmatterLines = getLeadingFrontmatterLines(content);
  const phase = extractFrontmatterScalar(frontmatterLines, ['phase']) || null;
  const plan = extractFrontmatterScalar(frontmatterLines, ['plan']) || null;
  const waveRaw = extractFrontmatterScalar(frontmatterLines, ['wave']);
  const autonomousRaw = extractFrontmatterScalar(frontmatterLines, ['autonomous']);
  const dependsOn = extractFrontmatterList(frontmatterLines, ['depends_on', 'depends-on']);
  const tasks = [];
  const taskPattern = /<task(?:\s+type="([^"]+)")?[^>]*>([\s\S]*?)<\/task>/g;
  let match;
  while ((match = taskPattern.exec(content)) !== null) {
    const typeValue = String(match[1] || 'auto').trim();
    const body = String(match[2] || '');
    const nameMatch = body.match(/<name>([\s\S]*?)<\/name>/);
    const name = nameMatch ? nameMatch[1].trim() : 'unnamed';
    tasks.push({
      index: tasks.length + 1,
      type: typeValue,
      name,
      is_checkpoint: typeValue === 'checkpoint',
    });
  }
  const checkpoints = tasks.filter((task) => task.is_checkpoint).map((task, index) => ({ index: index + 1, name: task.name }));
  return {
    path: rel,
    plan,
    phase,
    wave: waveRaw ? parseInt(waveRaw, 10) || 1 : 1,
    depends_on: dependsOn,
    autonomous: autonomousRaw === 'false' ? false : true,
    task_count: tasks.length,
    checkpoint_count: checkpoints.length,
    tasks,
    checkpoints,
  };
}
function progressTable() {
  const d = buildProgressJsonPayload();
  const milestoneVersion = d.milestone_version || '';
  const milestoneName = d.milestone_name || '';
  const phases = Array.isArray(d.phases) ? d.phases : [];
  const totalPlans = Number(d.total_plans || 0);
  const totalSummaries = Number(d.total_summaries || 0);
  const percent = Number(d.percent || 0);
  const barWidth = 10;
  const filled = Math.round((percent / 100) * barWidth);
  const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);
  let out = '# ' + milestoneVersion + ' ' + milestoneName + '\n\n';
  out += '**Progress:** [' + bar + '] ' + totalSummaries + '/' + totalPlans + ' plans (' + percent + '%)\n\n';
  out += '| Phase | Name | Plans | Status |\n';
  out += '|-------|------|-------|--------|\n';
  for (const phase of phases) {
    out += '| ' + phase.number + ' | ' + phase.name + ' | ' + phase.summaries + '/' + phase.plans + ' | ' + phase.status + ' |\n';
  }
  return { rendered: out };
}
function extractFrontmatterLeading(content) {
  const match = String(content || '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return {};
  const result = {};
  for (const rawLine of match[1].split(/\r?\n/)) {
    const fieldMatch = rawLine.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!fieldMatch) continue;
    result[fieldMatch[1]] = fieldMatch[2].trim();
  }
  return result;
}
function buildSkillManifest(skillsDirArg) {
  const rootsSpec = skillsDirArg
    ? [{ root: path.resolve(skillsDirArg), path: path.resolve(skillsDirArg), scope: 'custom', kind: 'skills' }]
    : [
        { root: '.claude/skills', path: path.join(cwd, '.claude', 'skills'), scope: 'project', kind: 'skills' },
        { root: '.agents/skills', path: path.join(cwd, '.agents', 'skills'), scope: 'project', kind: 'skills' },
        { root: '.cursor/skills', path: path.join(cwd, '.cursor', 'skills'), scope: 'project', kind: 'skills' },
        { root: '.github/skills', path: path.join(cwd, '.github', 'skills'), scope: 'project', kind: 'skills' },
        { root: '.codex/skills', path: path.join(cwd, '.codex', 'skills'), scope: 'project', kind: 'skills' },
        { root: '~/.claude/skills', path: path.join(os.homedir(), '.claude', 'skills'), scope: 'global', kind: 'skills' },
        { root: '~/.codex/skills', path: path.join(os.homedir(), '.codex', 'skills'), scope: 'global', kind: 'skills' },
        { root: '.claude/get-shit-done/skills', path: path.join(os.homedir(), '.claude', 'get-shit-done', 'skills'), scope: 'import-only', kind: 'skills', deprecated: true },
        { root: '.claude/commands/gsd', path: path.join(os.homedir(), '.claude', 'commands', 'gsd'), scope: 'legacy-commands', kind: 'commands', deprecated: true },
      ];
  const skills = [];
  const roots = [];
  let legacyClaudeCommandsInstalled = false;
  for (const rootInfo of rootsSpec) {
    const present = exists(rootInfo.path, 'd');
    const rootSummary = { root: rootInfo.root, path: rootInfo.path, scope: rootInfo.scope, present, deprecated: !!rootInfo.deprecated };
    if (!present) {
      roots.push(rootSummary);
      continue;
    }
    let entries = [];
    try { entries = fs.readdirSync(rootInfo.path, { withFileTypes: true }); } catch {}
    if (rootInfo.kind === 'commands') {
      const commandCount = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.md')).length;
      rootSummary.command_count = commandCount;
      if (commandCount > 0) legacyClaudeCommandsInstalled = true;
      roots.push(rootSummary);
      continue;
    }
    let skillCount = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillMdPath = path.join(rootInfo.path, entry.name, 'SKILL.md');
      if (!exists(skillMdPath, 'f')) continue;
      let content = '';
      try { content = fs.readFileSync(skillMdPath, 'utf8'); } catch { continue; }
      const frontmatter = extractFrontmatterLeading(content);
      const bodyMatch = content.match(/^---[\s\S]*?---\s*\n([\s\S]*)$/);
      const triggers = [];
      if (bodyMatch) {
        const triggerLines = bodyMatch[1].match(/^TRIGGER\s+when:\s*(.+)$/gim) || [];
        for (const line of triggerLines) {
          const m = line.match(/^TRIGGER\s+when:\s*(.+)$/i);
          if (m) triggers.push(m[1].trim());
        }
      }
      skills.push({
        name: frontmatter.name || entry.name,
        description: frontmatter.description || '',
        triggers,
        path: entry.name,
        file_path: entry.name + '/SKILL.md',
        root: rootInfo.root,
        scope: rootInfo.scope,
        installed: rootInfo.scope !== 'import-only',
        deprecated: !!rootInfo.deprecated,
      });
      skillCount++;
    }
    rootSummary.skill_count = skillCount;
    roots.push(rootSummary);
  }
  skills.sort((a, b) => {
    const rootCmp = a.root.localeCompare(b.root);
    return rootCmp !== 0 ? rootCmp : a.name.localeCompare(b.name);
  });
  return {
    skills,
    roots,
    installation: {
      gsd_skills_installed: skills.some((skill) => String(skill.name || '').startsWith('gsd-')),
      legacy_claude_commands_installed: legacyClaudeCommandsInstalled,
    },
    counts: { skills: skills.length, roots: roots.length },
  };
}
function skillManifest(args) {
  const skillsDirIndex = args.indexOf('--skills-dir');
  const skillsDir = skillsDirIndex >= 0 && args[skillsDirIndex + 1] ? args[skillsDirIndex + 1] : null;
  const manifest = buildSkillManifest(skillsDir);
  if (args.includes('--write') && exists(path.join(cwd, '.planning'), 'd')) {
    fs.writeFileSync(path.join(cwd, '.planning', 'skill-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  }
  return manifest;
}
function resolveOutputPathWithinProject(outputPath) {
  const resolvedOut = path.resolve(cwd, outputPath);
  if (resolvedOut !== cwd && !resolvedOut.startsWith(cwd + path.sep)) {
    throw new Error('Output path escapes project directory: ' + outputPath);
  }
  return resolvedOut;
}
function yamlScalar(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  const text = String(value == null ? '' : value);
  return text;
}
function renderYamlValue(key, value, indent) {
  const prefix = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return prefix + key + ': []';
    return [
      prefix + key + ':',
      ...value.map((entry) => prefix + '  - ' + yamlScalar(entry)),
    ].join('\n');
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return prefix + key + ': {}';
    const lines = [prefix + key + ':'];
    for (const childKey of keys) {
      lines.push(renderYamlValue(childKey, value[childKey], indent + 2));
    }
    return lines.join('\n');
  }
  return prefix + key + ': ' + yamlScalar(value);
}
function buildTemplateFrontmatter(fields) {
  return ['---', ...Object.keys(fields).map((key) => renderYamlValue(key, fields[key], 0)), '---'].join('\n');
}
function templateSelect(phaseArg) {
  const phaseNum = String(phaseArg || '').trim();
  if (!phaseNum) return { template: 'plan' };
  const phaseInfo = findPhaseDirectory(phaseNum);
  if (!phaseInfo.found) return { template: 'plan' };
  const phaseDirAbs = path.join(cwd, phaseInfo.phaseDir);
  try {
    const files = fs.readdirSync(phaseDirAbs);
    const plans = files.filter((name) => /-PLAN\.md$/i.test(name));
    const summaries = files.filter((name) => /-SUMMARY\.md$/i.test(name));
    if (plans.length === 0) return { template: 'plan' };
    const allHaveSummaries = plans.every((plan) => {
      const prefix = plan.replace(/-PLAN\.md$/i, '');
      return summaries.some((summary) => summary.startsWith(prefix));
    });
    return { template: allHaveSummaries ? 'verification' : 'summary' };
  } catch {
    return { template: 'plan' };
  }
}
function templateFill(args) {
  const templateType = String(args[0] || '').trim();
  const outputPath = String(args[1] || '').trim();
  if (!templateType) return { error: 'template type required: summary, plan, or verification', classification: 'validation' };
  if (!outputPath) return { error: 'output path required', classification: 'validation' };
  const resolvedOut = resolveOutputPathWithinProject(outputPath);
  const overrides = {};
  for (let index = 2; index < args.length; index++) {
    const entry = String(args[index] || '');
    const eqIndex = entry.indexOf('=');
    if (eqIndex > 0) overrides[entry.slice(0, eqIndex)] = entry.slice(eqIndex + 1);
  }
  let fm;
  let body;
  switch (templateType) {
    case 'summary':
      fm = {
        phase: '', plan: '', subsystem: '', tags: [],
        requires: [], provides: [], affects: [],
        'tech-stack': { added: [], patterns: [] },
        'key-files': { created: [], modified: [] },
        'key-decisions': [], 'patterns-established': [],
        'requirements-completed': [],
        duration: '', completed: '',
      };
      body = [
        '# Phase {phase} Plan {plan}: Summary',
        '',
        '## Performance',
        '',
        '## Accomplishments',
        '',
        '## Task Commits',
        '',
        '## Files Created/Modified',
        '',
        '## Decisions Made',
        '',
        '## Deviations from Plan',
        '',
        '## Issues Encountered',
        '',
        '## User Setup Required',
        '',
        '## Next Phase Readiness',
        '',
        '## Self-Check',
      ].join('\n');
      break;
    case 'plan':
      fm = {
        phase: '', plan: '', type: 'execute', wave: 1,
        depends_on: [], files_modified: [], autonomous: true,
        requirements: [], must_haves: { truths: [], artifacts: [], key_links: [] },
      };
      body = [
        '<objective>',
        '</objective>',
        '',
        '<context>',
        '</context>',
        '',
        '<tasks>',
        '</tasks>',
        '',
        '<verification>',
        '</verification>',
        '',
        '<success_criteria>',
        '</success_criteria>',
      ].join('\n');
      break;
    case 'verification':
      fm = { phase: '', status: 'pending', verified_at: '' };
      body = [
        '# Phase {phase} Verification',
        '',
        '## Must-Have Checks',
        '',
        '## Artifact Verification',
        '',
        '## Key-Link Verification',
        '',
        '## Result',
      ].join('\n');
      break;
    default:
      return { error: 'Unknown template type: ' + templateType + '. Available: summary, plan, verification', classification: 'validation' };
  }
  Object.assign(fm, overrides);
  const content = buildTemplateFrontmatter(fm) + '\n\n' + body + '\n';
  fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
  fs.writeFileSync(resolvedOut, content, 'utf8');
  return { created: true, path: outputPath, template: templateType };
}
function requirementsExtractFromPlans(phaseArg) {
  const phase = String(phaseArg || '').trim();
  if (!phase) return { error: 'phase required', classification: 'validation' };
  const phaseInfo = findPhaseDirectory(phase);
  const normalized = normalizePhaseNumber(phase);
  if (!phaseInfo.found) {
    return { phase: normalized, requirements: [], by_plan: {}, error: 'Phase not found' };
  }
  const phaseDirAbs = path.join(cwd, phaseInfo.phaseDir);
  const files = fs.readdirSync(phaseDirAbs).filter((name) => name.endsWith('-PLAN.md') || name === 'PLAN.md').sort();
  const byPlan = {};
  const seen = new Set();
  for (const planFile of files) {
    const planId = planFile === 'PLAN.md' ? 'PLAN' : planFile.replace(/-PLAN\.md$/i, '').replace(/PLAN\.md$/i, '');
    const content = fs.readFileSync(path.join(phaseDirAbs, planFile), 'utf8');
    const frontmatterLines = getLeadingFrontmatterLines(content);
    const requirements = extractFrontmatterList(frontmatterLines, ['requirements']);
    byPlan[planId] = requirements;
    for (const requirement of requirements) seen.add(requirement);
  }
  return { phase: normalized, requirements: [...seen].sort(), by_plan: byPlan };
}
function requirementsMarkComplete(args) {
  if (!args.length) return { error: 'requirement IDs required. Usage: requirements mark-complete REQ-01,REQ-02 or REQ-01 REQ-02', classification: 'validation' };
  const reqIds = args.join(' ').replace(/[\[\]]/g, '').split(/[,\s]+/).map((item) => item.trim()).filter(Boolean);
  if (reqIds.length === 0) return { error: 'no valid requirement IDs found', classification: 'validation' };
  const requirementsPath = path.join(cwd, '.planning', 'REQUIREMENTS.md');
  if (!exists(requirementsPath, 'f')) return { updated: false, reason: 'REQUIREMENTS.md not found', ids: reqIds };
  let reqContent = fs.readFileSync(requirementsPath, 'utf8').replace(/\r\n/g, '\n');
  const updated = [];
  const alreadyComplete = [];
  const notFound = [];
  for (const reqId of reqIds) {
    let found = false;
    const reqEscaped = escapeRegex(reqId);
    const checkboxPattern = new RegExp('(-\\s*\\[)[ ](\\]\\s*\\*\\*' + reqEscaped + '\\*\\*)', 'gi');
    const afterCheckbox = reqContent.replace(checkboxPattern, '$1x$2');
    if (afterCheckbox !== reqContent) {
      reqContent = afterCheckbox;
      found = true;
    }
    const tablePattern = new RegExp('(\\|\\s*' + reqEscaped + '\\s*\\|[^|]+\\|)\\s*Pending\\s*(\\|)', 'gi');
    const afterTable = reqContent.replace(tablePattern, '$1 Complete $2');
    if (afterTable !== reqContent) {
      reqContent = afterTable;
      found = true;
    }
    if (found) {
      updated.push(reqId);
    } else {
      const doneCheckbox = new RegExp('-\\s*\\[x\\]\\s*\\*\\*' + reqEscaped + '\\*\\*', 'i');
      const doneTable = new RegExp('\\|\\s*' + reqEscaped + '\\s*\\|[^|]+\\|\\s*Complete\\s*\\|', 'i');
      if (doneCheckbox.test(reqContent) || doneTable.test(reqContent)) alreadyComplete.push(reqId);
      else notFound.push(reqId);
    }
  }
  if (updated.length > 0) fs.writeFileSync(requirementsPath, reqContent, 'utf8');
  return {
    updated: updated.length > 0,
    marked_complete: updated,
    already_complete: alreadyComplete,
    not_found: notFound,
    total: reqIds.length,
  };
}
function buildInitTodosPayload(area) {
  const todoData = listPendingTodos(area || null);
  return {
    commit_docs: readConfig().commit_docs !== false,
    date: getTodayDate(),
    timestamp: new Date().toISOString(),
    todo_count: todoData.todo_count,
    todos: todoData.todos,
    pending_dir: '.planning/todos/pending',
    todos_dir_exists: exists(path.join(cwd, '.planning', 'todos'), 'd'),
    text_mode: getConfigFlag('workflow.text_mode', false),
  };
}
function getQuickTaskInit(description) {
  const cfg = readConfig();
  const timestamp = new Date().toISOString();
  const date = getTodayDate();
  const slugBase = slugify(description || 'quick-task') || 'quick-task';
  const quickId = 'quick-' + timestamp.replace(/[-:TZ.]/g, '').slice(0, 14);
  const branchStrategy = String(getConfigValue('git.branching_strategy', 'none') || 'none');
  const template = String(getConfigValue('git.quick_branch_template', '') || '');
  const branchName = branchStrategy === 'quick'
    ? (template
        ? template.replace('{slug}', slugBase).replace('{id}', quickId)
        : 'quick/' + slugBase)
    : null;
  return {
    planner_model: getConfiguredAgentModel('gsd-planner', 'claude-sonnet-4-6'),
    executor_model: getConfiguredAgentModel('gsd-executor', 'claude-sonnet-4-6'),
    checker_model: getConfiguredAgentModel('gsd-plan-checker', 'claude-sonnet-4-6'),
    verifier_model: getConfiguredAgentModel('gsd-verifier', 'claude-sonnet-4-6'),
    commit_docs: cfg.commit_docs !== false,
    branch_name: branchName,
    quick_id: quickId,
    slug: slugBase,
    date,
    timestamp,
    quick_dir: '.planning/quick',
    task_dir: '.planning/tasks',
    roadmap_exists: exists(path.join(cwd, '.planning', 'ROADMAP.md'), 'f'),
    planning_exists: exists(path.join(cwd, '.planning'), 'd'),
    text_mode: getConfigFlag('workflow.text_mode', false),
  };
}
function getMilestoneOpPayload() {
  const { roadmap, milestone_version, milestone_name } = getCurrentMilestoneInfo();
  return {
    milestone_version,
    milestone_name,
    phase_count: Number(roadmap.phase_count || 0),
    completed_phases: Number(roadmap.completed_phases || 0),
    roadmap_exists: exists(path.join(cwd, '.planning', 'ROADMAP.md'), 'f'),
    state_exists: exists(path.join(cwd, '.planning', 'STATE.md'), 'f'),
    commit_docs: readConfig().commit_docs !== false,
  };
}
function extractFirstNarrativeLine(content) {
  const lines = String(content || '').split(/\r?\n/);
  let inFrontmatter = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (index === 0 && line === '---') {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (line === '---') inFrontmatter = false;
      continue;
    }
    if (!line || /^#/.test(line) || /^[-*]\s+/.test(line) || /^\|/.test(line)) continue;
    return line;
  }
  return '';
}
function stripMatchingQuotes(value) {
  return String(value || '').trim().replace(/^["']|["']$/g, '');
}
function getLeadingFrontmatterLines(content) {
  const lines = [];
  let inFrontmatter = false;
  for (const [index, rawLine] of String(content || '').split(/\r?\n/).entries()) {
    const line = rawLine.trimEnd();
    if (index === 0 && line.trim() === '---') {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter && line.trim() === '---') break;
    if (inFrontmatter) lines.push(line);
  }
  return lines;
}
function getIndentSize(value) {
  const match = String(value || '').match(/^(\s*)/);
  return match ? match[1].length : 0;
}
function extractFrontmatterList(lines, keys) {
  const normalizedKeys = keys.map((key) => String(key || '').toLowerCase());
  const values = [];
  let collecting = false;
  let baseIndent = 0;
  for (const rawLine of lines) {
    const indent = getIndentSize(rawLine);
    const trimmed = rawLine.trim();
    const fieldMatch = rawLine.match(/^(\s*)([A-Za-z0-9_-]+):\s*(.*)$/);
    if (fieldMatch) {
      const fieldIndent = fieldMatch[1].length;
      const fieldName = fieldMatch[2].toLowerCase();
      const inlineValue = fieldMatch[3].trim();
      if (!collecting && fieldIndent === 0 && normalizedKeys.includes(fieldName)) {
        collecting = true;
        baseIndent = fieldIndent;
        if (inlineValue) values.push(stripMatchingQuotes(inlineValue));
        continue;
      }
      if (collecting && fieldIndent <= baseIndent) {
        collecting = false;
      }
      if (!collecting) continue;
    }
    if (!collecting) continue;
    if (!trimmed) continue;
    if (indent <= baseIndent) {
      collecting = false;
      continue;
    }
    const itemMatch = trimmed.match(/^-\s+(.+)$/);
    if (itemMatch) {
      values.push(stripMatchingQuotes(itemMatch[1]));
    }
  }
  return values.filter(Boolean);
}
function extractFrontmatterScalar(lines, keys) {
  const normalizedKeys = keys.map((key) => String(key || '').toLowerCase());
  for (const rawLine of lines) {
    const fieldMatch = rawLine.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!fieldMatch) continue;
    const fieldName = fieldMatch[1].toLowerCase();
    if (!normalizedKeys.includes(fieldName)) continue;
    const inlineValue = fieldMatch[2].trim();
    if (!inlineValue) return '';
    return stripMatchingQuotes(inlineValue);
  }
  return '';
}
function extractNestedFrontmatterList(lines, parentKeys, childKeys) {
  const normalizedParents = parentKeys.map((key) => String(key || '').toLowerCase());
  const normalizedChildren = childKeys.map((key) => String(key || '').toLowerCase());
  const values = [];
  let inParent = false;
  let parentIndent = 0;
  let inChild = false;
  let childIndent = 0;
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    const fieldMatch = rawLine.match(/^(\s*)([A-Za-z0-9_-]+):\s*(.*)$/);
    if (fieldMatch) {
      const indent = fieldMatch[1].length;
      const fieldName = fieldMatch[2].toLowerCase();
      const inlineValue = fieldMatch[3].trim();
      if (!inParent && indent === 0 && normalizedParents.includes(fieldName)) {
        inParent = true;
        parentIndent = indent;
        inChild = false;
        continue;
      }
      if (inParent && indent <= parentIndent) {
        inParent = false;
        inChild = false;
      }
      if (!inParent) continue;
      if (normalizedChildren.includes(fieldName)) {
        inChild = true;
        childIndent = indent;
        if (inlineValue) values.push(stripMatchingQuotes(inlineValue));
        continue;
      }
      if (inChild && indent <= childIndent) {
        inChild = false;
      }
      continue;
    }
    if (!inParent || !inChild || !trimmed) continue;
    const indent = getIndentSize(rawLine);
    if (indent <= childIndent) {
      inChild = false;
      continue;
    }
    const itemMatch = trimmed.match(/^-\s+(.+)$/);
    if (!itemMatch) continue;
    const rawValue = itemMatch[1].trim();
    const namedMatch = rawValue.match(/^(?:name|summary|decision):\s*(.+)$/i);
    values.push(stripMatchingQuotes(namedMatch ? namedMatch[1] : rawValue));
  }
  return values.filter(Boolean);
}
function parseSummaryDecisionEntries(entries) {
  return entries.map((entry) => {
    const text = String(entry || '').trim();
    const colonIndex = text.indexOf(':');
    if (colonIndex > 0) {
      return {
        summary: text.slice(0, colonIndex).trim(),
        rationale: text.slice(colonIndex + 1).trim() || null,
      };
    }
    return { summary: text, rationale: null };
  }).filter((entry) => entry.summary);
}
function readSummaryMetadata(summaryPathArg) {
  if (!summaryPathArg) return { error: 'summary file path required' };
  let fullPath = '';
  try {
    fullPath = resolveProjectPath(summaryPathArg);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), path: summaryPathArg };
  }
  if (!exists(fullPath, 'f')) return { error: 'File not found', path: summaryPathArg };
  const content = fs.readFileSync(fullPath, 'utf8');
  const frontmatterLines = getLeadingFrontmatterLines(content);
  const explicitOneLiner = extractFrontmatterScalar(frontmatterLines, ['one_liner', 'one-liner']);
  const oneLiner = explicitOneLiner || extractFirstNarrativeLine(content) || null;
  const keyFiles = extractFrontmatterList(frontmatterLines, ['key-files', 'key_files']);
  const patterns = extractFrontmatterList(frontmatterLines, ['patterns-established', 'patterns_established']);
  const requirementsCompleted = extractFrontmatterList(frontmatterLines, ['requirements-completed', 'requirements_completed']);
  const decisionEntries = extractFrontmatterList(frontmatterLines, ['key-decisions', 'key_decisions']);
  const techAdded = extractNestedFrontmatterList(frontmatterLines, ['tech-stack', 'tech_stack'], ['added']);
  const provides = extractNestedFrontmatterList(frontmatterLines, ['dependency-graph', 'dependency_graph'], ['provides']);
  const affects = extractNestedFrontmatterList(frontmatterLines, ['dependency-graph', 'dependency_graph'], ['affects']);
  const phase = extractFrontmatterScalar(frontmatterLines, ['phase']) || null;
  const name = extractFrontmatterScalar(frontmatterLines, ['name']) || null;
  return {
    path: summaryPathArg,
    one_liner: oneLiner,
    key_files: keyFiles,
    tech_added: techAdded,
    patterns,
    decisions: parseSummaryDecisionEntries(decisionEntries),
    decision_strings: decisionEntries,
    requirements_completed: requirementsCompleted,
    phase,
    name,
    provides,
    affects,
  };
}
function summaryExtract(filePathArg, fieldsArg, pickArg) {
  const metadata = readSummaryMetadata(filePathArg);
  if (metadata.error) return metadata;
  const requestedFields = String(fieldsArg || '').split(',').map((field) => field.trim()).filter(Boolean);
  let data = metadata;
  if (requestedFields.length > 0) {
    data = { path: metadata.path };
    for (const field of requestedFields) {
      if (metadata[field] !== undefined) data[field] = metadata[field];
    }
  }
  if (pickArg) return data[pickArg] != null ? data[pickArg] : '';
  return data;
}
function getArchivedPhaseDirectories() {
  const results = [];
  const milestonesDir = path.join(cwd, '.planning', 'milestones');
  if (!exists(milestonesDir, 'd')) return results;
  for (const archiveName of fs.readdirSync(milestonesDir).filter((name) => /-phases$/i.test(name)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
    const archiveDir = path.join(milestonesDir, archiveName);
    if (!exists(archiveDir, 'd')) continue;
    for (const dir of fs.readdirSync(archiveDir).filter((name) => exists(path.join(archiveDir, name), 'd')).sort(comparePhaseValues)) {
      results.push({ name: dir, fullPath: path.join(archiveDir, dir) });
    }
  }
  return results;
}
function getHistoryDigest() {
  const phases = {};
  const decisions = [];
  const techStack = new Set();
  const phaseDirectories = [];
  for (const archived of getArchivedPhaseDirectories()) {
    phaseDirectories.push(archived);
  }
  const currentPhasesDir = path.join(cwd, '.planning', 'phases');
  if (exists(currentPhasesDir, 'd')) {
    for (const dir of fs.readdirSync(currentPhasesDir).filter((name) => exists(path.join(currentPhasesDir, name), 'd')).sort(comparePhaseValues)) {
      phaseDirectories.push({ name: dir, fullPath: path.join(currentPhasesDir, dir) });
    }
  }
  for (const phaseDir of phaseDirectories) {
    const summaryFiles = fs.readdirSync(phaseDir.fullPath)
      .filter((name) => name === 'SUMMARY.md' || name.endsWith('-SUMMARY.md'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    for (const summaryFile of summaryFiles) {
      const summaryPath = path.relative(cwd, path.join(phaseDir.fullPath, summaryFile));
      const metadata = readSummaryMetadata(summaryPath);
      if (metadata.error) continue;
      const phaseNumber = normalizePhaseNumber(metadata.phase || phaseDir.name.split('-')[0] || '');
      if (!phaseNumber) continue;
      if (!phases[phaseNumber]) {
        phases[phaseNumber] = {
          name: metadata.name || phaseDir.name.split('-').slice(1).join(' ') || 'Unknown',
          provides: new Set(),
          affects: new Set(),
          patterns: new Set(),
        };
      }
      for (const item of metadata.provides || []) phases[phaseNumber].provides.add(item);
      for (const item of metadata.affects || []) phases[phaseNumber].affects.add(item);
      for (const item of metadata.patterns || []) phases[phaseNumber].patterns.add(item);
      for (const item of metadata.decision_strings || []) decisions.push({ phase: phaseNumber, decision: item });
      for (const item of metadata.tech_added || []) techStack.add(item);
    }
  }
  const phasesOut = {};
  for (const key of Object.keys(phases).sort(comparePhaseValues)) {
    phasesOut[key] = {
      name: phases[key].name,
      provides: Array.from(phases[key].provides),
      affects: Array.from(phases[key].affects),
      patterns: Array.from(phases[key].patterns),
    };
  }
  return {
    phases: phasesOut,
    decisions,
    tech_stack: Array.from(techStack),
  };
}
function verifyCommitHashes(hashes) {
  const valid = [];
  const invalid = [];
  for (const hash of hashes) {
    const result = spawnSync('git', ['cat-file', '-t', String(hash)], { cwd, encoding: 'utf8' });
    if (result.status === 0 && String(result.stdout || '').trim() === 'commit') valid.push(String(hash));
    else invalid.push(String(hash));
  }
  return {
    all_valid: invalid.length === 0,
    valid,
    invalid,
    total: hashes.length,
  };
}
function verifyDocumentReferences(filePathArg) {
  if (!filePathArg) return { error: 'file path required' };
  let fullPath = '';
  try {
    fullPath = resolveProjectPath(filePathArg);
  } catch {
    return { error: 'File not found', path: filePathArg };
  }
  if (!exists(fullPath, 'f')) return { error: 'File not found', path: filePathArg };
  const content = fs.readFileSync(fullPath, 'utf8');
  const found = [];
  const missing = [];
  const seen = new Set();
  const atRefs = content.match(/@([^\s\n,)]+\/[^\s\n,)]+)/g) || [];
  for (const ref of atRefs) {
    const cleanRef = ref.slice(1);
    if (seen.has(cleanRef)) continue;
    seen.add(cleanRef);
    const resolved = cleanRef.startsWith('~/')
      ? path.join(process.env.HOME || '', cleanRef.slice(2))
      : path.join(cwd, cleanRef);
    if (exists(resolved, null)) found.push(cleanRef);
    else missing.push(cleanRef);
  }
  const backtickRefs = content.match(/\x60([^\x60]+\/[^\x60]+\.[a-zA-Z]{1,10})\x60/g) || [];
  for (const ref of backtickRefs) {
    const cleanRef = ref.slice(1, -1);
    if (cleanRef.startsWith('http') || cleanRef.includes('$' + '{') || cleanRef.includes('{{') || seen.has(cleanRef)) continue;
    seen.add(cleanRef);
    const resolved = path.join(cwd, cleanRef);
    if (exists(resolved, null)) found.push(cleanRef);
    else missing.push(cleanRef);
  }
  return {
    valid: missing.length === 0,
    found: found.length,
    missing,
    total: found.length + missing.length,
  };
}
function verifySummaryDocument(summaryPathArg, rest) {
  if (!summaryPathArg) return { error: 'summary-path required' };
  const checkCountIndex = rest.indexOf('--check-count');
  const checkCount = checkCountIndex >= 0 ? parseInt(rest[checkCountIndex + 1], 10) || 2 : 2;
  let fullPath = '';
  try {
    fullPath = resolveProjectPath(summaryPathArg);
  } catch {
    return {
      passed: false,
      checks: {
        summary_exists: false,
        files_created: { checked: 0, found: 0, missing: [] },
        commits_exist: false,
        self_check: 'not_found',
      },
      errors: ['SUMMARY.md not found'],
    };
  }
  if (!exists(fullPath, 'f')) {
    return {
      passed: false,
      checks: {
        summary_exists: false,
        files_created: { checked: 0, found: 0, missing: [] },
        commits_exist: false,
        self_check: 'not_found',
      },
      errors: ['SUMMARY.md not found'],
    };
  }
  const content = fs.readFileSync(fullPath, 'utf8');
  const errors = [];
  const mentionedFiles = new Set();
  const patterns = [
    /\x60([^\x60]+\.[a-zA-Z]+)\x60/g,
    /(?:Created|Modified|Added|Updated|Edited):\s*\x60?([^\s\x60]+\.[a-zA-Z]+)\x60?/gi,
  ];
  for (const pattern of patterns) {
    let match = pattern.exec(content);
    while (match) {
      const filePath = match[1];
      if (filePath && !filePath.startsWith('http') && filePath.includes('/')) mentionedFiles.add(filePath);
      match = pattern.exec(content);
    }
  }
  const filesToCheck = Array.from(mentionedFiles).slice(0, checkCount);
  const missingFiles = filesToCheck.filter((file) => !exists(path.join(cwd, file), null));
  const hashes = content.match(/\b[0-9a-f]{7,40}\b/g) || [];
  let commitsExist = false;
  for (const hash of hashes.slice(0, 3)) {
    const result = spawnSync('git', ['cat-file', '-t', hash], { cwd, encoding: 'utf8' });
    if (result.status === 0 && String(result.stdout || '').trim() === 'commit') {
      commitsExist = true;
      break;
    }
  }
  let selfCheck = 'not_found';
  const selfCheckPattern = /##\s*(?:Self[- ]?Check|Verification|Quality Check)/i;
  if (selfCheckPattern.test(content)) {
    const section = content.slice(content.search(selfCheckPattern));
    if (/(?:fail|✗|❌|incomplete|blocked)/i.test(section)) selfCheck = 'failed';
    else if (/(?:all\s+)?(?:pass|✓|✅|complete|succeeded)/i.test(section)) selfCheck = 'passed';
  }
  if (missingFiles.length > 0) errors.push('Missing files: ' + missingFiles.join(', '));
  if (!commitsExist && hashes.length > 0) errors.push('Referenced commit hashes not found in git history');
  if (selfCheck === 'failed') errors.push('Self-check section indicates failure');
  return {
    passed: missingFiles.length === 0 && selfCheck !== 'failed',
    checks: {
      summary_exists: true,
      files_created: { checked: filesToCheck.length, found: filesToCheck.length - missingFiles.length, missing: missingFiles },
      commits_exist: commitsExist,
      self_check: selfCheck,
    },
    errors,
  };
}
function verifyPathExists(targetPath) {
  if (!targetPath) return { error: 'path required for verification' };
  if (String(targetPath).includes('\0')) return { error: 'path contains null bytes' };
  const fullPath = path.isAbsolute(targetPath) ? targetPath : path.join(cwd, targetPath);
  try {
    const stats = fs.statSync(fullPath);
    return { exists: true, type: stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other' };
  } catch {
    return { exists: false, type: null };
  }
}
function detectCustomFiles(rest) {
  const configDirIndex = rest.indexOf('--config-dir');
  const configDir = configDirIndex >= 0 ? rest[configDirIndex + 1] : '';
  if (!configDir) return { error: 'Usage: detect-custom-files --config-dir <path>' };
  const resolvedConfigDir = path.resolve(cwd, configDir);
  if (!exists(resolvedConfigDir, 'd')) return { error: 'Config directory not found: ' + resolvedConfigDir };
  const manifestPath = path.join(resolvedConfigDir, 'gsd-file-manifest.json');
  if (!exists(manifestPath, 'f')) {
    return { custom_files: [], custom_count: 0, manifest_found: false };
  }
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return { custom_files: [], custom_count: 0, manifest_found: false, error: 'manifest parse error' };
  }
  const manifestKeys = new Set(Object.keys((manifest && manifest.files) || {}));
  const managedDirs = ['get-shit-done', 'agents', path.join('commands', 'gsd'), 'hooks'];
  const customFiles = [];
  function walk(dirPath) {
    if (!exists(dirPath, 'd')) return;
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else {
        const relPath = path.relative(resolvedConfigDir, fullPath).split(path.sep).join('/');
        if (!manifestKeys.has(relPath)) customFiles.push(relPath);
      }
    }
  }
  for (const managedDir of managedDirs) {
    walk(path.join(resolvedConfigDir, managedDir));
  }
  return {
    custom_files: customFiles,
    custom_count: customFiles.length,
    manifest_found: true,
    manifest_version: manifest.version || null,
  };
}
function getStateValue(rest) {
  const statePath = path.join(cwd, '.planning', 'STATE.md');
  if (!exists(statePath, 'f')) return { error: 'STATE.md not found' };
  const content = fs.readFileSync(statePath, 'utf8');
  const section = rest[0];
  if (!section) return { content };
  const escaped = String(section).replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
  const boldMatch = content.match(new RegExp('\\*\\*' + escaped + ':\\*\\*\\s*(.*)', 'i'));
  if (boldMatch) return { [section]: boldMatch[1].trim() };
  const plainMatch = content.match(new RegExp('^' + escaped + ':\\s*(.*)', 'im'));
  if (plainMatch) return { [section]: plainMatch[1].trim() };
  const sectionMatch = content.match(new RegExp('##\\s*' + escaped + '\\s*\\n([\\s\\S]*?)(?=\\n##|$)', 'i'));
  if (sectionMatch) return { [section]: sectionMatch[1].trim() };
  return { error: 'Section or field "' + section + '" not found' };
}
function validateAgentsInstalled() {
  const agentsDir = path.join(cwd, '.tasktronaut', 'agents');
  const expected = Object.keys(MODEL_PROFILES);
  const installed = [];
  const missing = [];
  if (!exists(agentsDir, 'd')) {
    return {
      agents_dir: agentsDir,
      agents_found: false,
      installed,
      missing: expected,
      expected,
    };
  }
  for (const agent of expected) {
    if (exists(path.join(agentsDir, agent + '.md'), 'f') || exists(path.join(agentsDir, agent + '.agent.md'), 'f')) {
      installed.push(agent);
    } else {
      missing.push(agent);
    }
  }
  return {
    agents_dir: agentsDir,
    agents_found: installed.length > 0 && missing.length === 0,
    installed,
    missing,
    expected,
  };
}
function validatePlanningConsistency() {
  const errors = [];
  const warnings = [];
  const roadmapPath = path.join(cwd, '.planning', 'ROADMAP.md');
  const phasesDir = path.join(cwd, '.planning', 'phases');
  if (!exists(roadmapPath, 'f')) {
    return { passed: false, errors: ['ROADMAP.md not found'], warnings: [], warning_count: 0 };
  }
  const roadmapContent = fs.readFileSync(roadmapPath, 'utf8').replace(/<details>[\s\S]*?<\/details>/gi, '');
  const roadmapPhases = new Set();
  let match = null;
  const phasePattern = /#{2,4}\s*Phase\s+(\d+[A-Z]?(?:\.\d+)*)\s*:/gi;
  while ((match = phasePattern.exec(roadmapContent)) !== null) roadmapPhases.add(match[1]);
  const diskPhases = new Set();
  const diskDirs = exists(phasesDir, 'd')
    ? fs.readdirSync(phasesDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(comparePhaseValues)
    : [];
  for (const dir of diskDirs) {
    const dirMatch = dir.match(/^(\d+[A-Z]?(?:\.\d+)*)/i);
    if (dirMatch) diskPhases.add(dirMatch[1]);
  }
  for (const phase of roadmapPhases) {
    if (!diskPhases.has(phase) && !diskPhases.has(normalizePhaseNumber(phase))) {
      warnings.push('Phase ' + phase + ' in ROADMAP.md but no directory on disk');
    }
  }
  for (const phase of diskPhases) {
    const unpadded = String(parseInt(phase, 10));
    if (!roadmapPhases.has(phase) && !roadmapPhases.has(unpadded)) {
      warnings.push('Phase ' + phase + ' exists on disk but not in ROADMAP.md');
    }
  }
  const config = readConfig();
  if (config.phase_naming !== 'custom') {
    const integerPhases = Array.from(diskPhases).filter((phase) => !String(phase).includes('.')).map((phase) => parseInt(phase, 10)).sort((a, b) => a - b);
    for (let index = 1; index < integerPhases.length; index++) {
      if (integerPhases[index] !== integerPhases[index - 1] + 1) {
        warnings.push('Gap in phase numbering: ' + integerPhases[index - 1] + ' -> ' + integerPhases[index]);
      }
    }
  }
  for (const dir of diskDirs) {
    const phaseDir = path.join(phasesDir, dir);
    let phaseFiles = [];
    try {
      phaseFiles = fs.readdirSync(phaseDir);
    } catch {
      continue;
    }
    const plans = phaseFiles.filter((name) => name.endsWith('-PLAN.md')).sort(comparePhaseValues);
    const summaries = phaseFiles.filter((name) => name.endsWith('-SUMMARY.md'));
    const planNums = plans.map((name) => {
      const planMatch = name.match(/-(\d{2})-PLAN\.md$/);
      return planMatch ? parseInt(planMatch[1], 10) : null;
    }).filter((value) => value != null);
    for (let index = 1; index < planNums.length; index++) {
      if (planNums[index] !== planNums[index - 1] + 1) {
        warnings.push('Gap in plan numbering in ' + dir + ': plan ' + planNums[index - 1] + ' -> ' + planNums[index]);
      }
    }
    const planIds = new Set(plans.map((name) => name.replace('-PLAN.md', '')));
    const summaryIds = new Set(summaries.map((name) => name.replace('-SUMMARY.md', '')));
    for (const summaryId of summaryIds) {
      if (!planIds.has(summaryId)) warnings.push('Summary ' + summaryId + '-SUMMARY.md in ' + dir + ' has no matching PLAN.md');
    }
    for (const plan of plans) {
      try {
        const content = fs.readFileSync(path.join(phaseDir, plan), 'utf8');
        const fm = parseFrontmatter(content);
        if (!fm.wave) warnings.push(dir + '/' + plan + ": missing 'wave' in frontmatter");
      } catch {}
    }
  }
  return {
    passed: errors.length === 0,
    errors,
    warnings,
    warning_count: warnings.length,
  };
}
function getWorkspaceBaseDir() {
  return path.join(process.env.HOME || process.env.USERPROFILE || cwd, 'gsd-workspaces');
}
function initNewWorkspace() {
  const defaultBase = getWorkspaceBaseDir();
  const childRepos = [];
  try {
    const entries = fs.readdirSync(cwd, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const fullPath = path.join(cwd, entry.name);
      if (!hasOwnGitMarker(fullPath)) continue;
      let hasUncommitted = false;
      try {
        const status = spawnSync('git', ['status', '--porcelain'], { cwd: fullPath, encoding: 'utf8' });
        hasUncommitted = status.status === 0 && String(status.stdout || '').trim().length > 0;
      } catch {}
      childRepos.push({ name: entry.name, path: fullPath, has_uncommitted: hasUncommitted });
    }
  } catch {}
  let worktreeAvailable = false;
  try {
    const version = spawnSync('git', ['--version'], { encoding: 'utf8' });
    worktreeAvailable = version.status === 0;
  } catch {}
  return {
    default_workspace_base: defaultBase,
    child_repos: childRepos,
    child_repo_count: childRepos.length,
    worktree_available: worktreeAvailable,
    is_git_repo: hasGitRepo(cwd),
    cwd_repo_name: path.basename(cwd),
    project_root: cwd,
  };
}
function initListWorkspaces() {
  const workspaceBase = getWorkspaceBaseDir();
  const workspaces = [];
  if (exists(workspaceBase, 'd')) {
    let entries = [];
    try {
      entries = fs.readdirSync(workspaceBase, { withFileTypes: true });
    } catch {}
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const wsPath = path.join(workspaceBase, entry.name);
      const manifestPath = path.join(wsPath, 'WORKSPACE.md');
      if (!exists(manifestPath, 'f')) continue;
      let repoCount = 0;
      let strategy = 'unknown';
      try {
        const manifest = fs.readFileSync(manifestPath, 'utf8');
        const strategyMatch = manifest.match(/^Strategy:\s*(.+)$/m);
        if (strategyMatch) strategy = strategyMatch[1].trim();
        const tableRows = manifest.split('\n').filter((line) => /^\|\s*\w/.test(line) && !line.includes('Repo') && !line.includes('---'));
        repoCount = tableRows.length;
      } catch {}
      workspaces.push({
        name: entry.name,
        path: wsPath,
        repo_count: repoCount,
        strategy,
        has_project: exists(path.join(wsPath, '.planning', 'PROJECT.md'), 'f'),
      });
    }
  }
  return {
    workspace_base: workspaceBase,
    workspaces,
    workspace_count: workspaces.length,
  };
}
function initRemoveWorkspace(name) {
  if (!name) return { error: 'workspace name required for init remove-workspace' };
  if (String(name).includes('/') || String(name).includes('\\') || String(name).includes('..')) {
    return { error: 'Invalid workspace name: ' + name + ' (path separators not allowed)' };
  }
  const workspaceBase = getWorkspaceBaseDir();
  const wsPath = path.join(workspaceBase, name);
  const manifestPath = path.join(wsPath, 'WORKSPACE.md');
  if (!exists(wsPath, 'd')) return { error: 'Workspace not found: ' + wsPath };
  const repos = [];
  let strategy = 'unknown';
  if (exists(manifestPath, 'f')) {
    try {
      const manifest = fs.readFileSync(manifestPath, 'utf8');
      const strategyMatch = manifest.match(/^Strategy:\s*(.+)$/m);
      if (strategyMatch) strategy = strategyMatch[1].trim();
      for (const line of manifest.split('\n')) {
        const match = line.match(/^\|\s*(\S+)\s*\|\s*(\S+)\s*\|\s*(\S+)\s*\|\s*(\S+)\s*\|$/);
        if (match && match[1] !== 'Repo' && !match[1].includes('---')) {
          repos.push({ name: match[1], source: match[2], branch: match[3], strategy: match[4] });
        }
      }
    } catch {}
  }
  const dirtyRepos = [];
  for (const repo of repos) {
    const repoPath = path.join(wsPath, repo.name);
    if (!exists(repoPath, 'd')) continue;
    try {
      const status = spawnSync('git', ['status', '--porcelain'], { cwd: repoPath, encoding: 'utf8' });
      if (status.status === 0 && String(status.stdout || '').trim().length > 0) dirtyRepos.push(repo.name);
    } catch {}
  }
  return {
    workspace_name: name,
    workspace_path: wsPath,
    has_manifest: exists(manifestPath, 'f'),
    strategy,
    repos,
    repo_count: repos.length,
    dirty_repos: dirtyRepos,
    has_dirty_repos: dirtyRepos.length > 0,
  };
}
function parseUatCurrentTest(content) {
  const lines = String(content || '').split(/\r?\n/);
  let name = '';
  let expected = '';
  let inExpectedBlock = false;
  const expectedLines = [];
  let insideCurrentTest = false;
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!insideCurrentTest) {
      if (/^##\s*Current Test$/i.test(trimmed)) {
        insideCurrentTest = true;
      }
      continue;
    }
    if (/^##\s+/.test(trimmed)) break;
    if (trimmed.startsWith('name:')) {
      name = trimmed.slice('name:'.length).trim();
      inExpectedBlock = false;
      continue;
    }
    if (trimmed === 'expected: |') {
      inExpectedBlock = true;
      expected = '';
      continue;
    }
    if (trimmed.startsWith('expected:') && !inExpectedBlock) {
      expected = trimmed.slice('expected:'.length).trim();
      continue;
    }
    if (inExpectedBlock) {
      if (/^[A-Za-z][A-Za-z0-9_-]*:\s*/.test(trimmed)) {
        inExpectedBlock = false;
      } else {
        expectedLines.push(line.replace(/^ {2}/, ''));
        continue;
      }
    }
  }
  return {
    name,
    expected: expectedLines.length > 0 ? expectedLines.join('\n').trim() : expected,
  };
}
function classifyAuditNeedle(status, content) {
  const normalizedStatus = String(status || '').toLowerCase();
  const haystack = String(content || '').toLowerCase();
  if (normalizedStatus === 'human_needed') return 'human_uat';
  if (haystack.includes('device') || haystack.includes('physical device')) return 'device_needed';
  if (haystack.includes('preview build') || haystack.includes('release build') || haystack.includes('build needed')) return 'build_needed';
  if (haystack.includes('third-party') || haystack.includes('3rd party') || haystack.includes('oauth') || haystack.includes('stripe')) return 'third_party';
  if (haystack.includes('server') || haystack.includes('backend') || haystack.includes('api running')) return 'server_blocked';
  if (normalizedStatus === 'partial' || haystack.includes('result: pending')) return 'pending';
  if (normalizedStatus === 'diagnosed' || normalizedStatus === 'gaps_found' || haystack.includes('result: skipped')) return 'skipped_unresolved';
  return 'pending';
}
function auditUatArtifacts() {
  const phasesDir = path.join(cwd, '.planning', 'phases');
  const results = [];
  if (!exists(phasesDir, 'd')) {
    return { results, summary: { total_items: 0, total_files: 0, phase_count: 0, by_category: {} } };
  }
  const seenFiles = new Set();
  for (const dir of fs.readdirSync(phasesDir)) {
    const phaseDir = path.join(phasesDir, dir);
    if (!exists(phaseDir, 'd')) continue;
    const phaseMatch = dir.match(/^(\\d+[A-Z]?(?:\\.\\d+)*)/i);
    const phase = phaseMatch ? normalizePhaseNumber(phaseMatch[1]) : dir;
    for (const file of fs.readdirSync(phaseDir).filter((name) => name.endsWith('.md'))) {
      const absPath = path.join(phaseDir, file);
      const relPath = path.join('.planning', 'phases', dir, file);
      if (/UAT/i.test(file)) {
        const content = fs.readFileSync(absPath, 'utf8');
        const fm = parseFrontmatter(content);
        const status = String(fm.status || '').toLowerCase();
        if (status === 'complete' || status === 'passed') continue;
        const currentTest = parseUatCurrentTest(content);
        results.push({
          phase,
          file,
          path: relPath,
          type: 'uat',
          category: classifyAuditNeedle(status, content),
          test_name: currentTest && currentTest.name ? currentTest.name : file.replace(/\\.md$/, ''),
          expected: currentTest && currentTest.expected ? currentTest.expected : '',
          status: status || 'pending',
          description: (currentTest && (currentTest.expected || currentTest.name)) || extractFirstNarrativeLine(content) || '',
        });
        seenFiles.add(relPath);
        continue;
      }
      if (/VERIFICATION/i.test(file)) {
        const content = fs.readFileSync(absPath, 'utf8');
        const fm = parseFrontmatter(content);
        const status = String(fm.status || '').toLowerCase();
        if (status !== 'gaps_found' && status !== 'human_needed') continue;
        results.push({
          phase,
          file,
          path: relPath,
          type: 'verification',
          category: status === 'human_needed' ? 'human_uat' : 'skipped_unresolved',
          test_name: file.replace(/\\.md$/, ''),
          expected: '',
          status,
          description: extractFirstNarrativeLine(content) || 'Verification follow-up required',
        });
        seenFiles.add(relPath);
      }
    }
  }
  const byCategory = {};
  for (const item of results) byCategory[item.category] = (byCategory[item.category] || 0) + 1;
  return {
    results,
    summary: {
      total_items: results.length,
      total_files: seenFiles.size,
      phase_count: new Set(results.map((item) => item.phase)).size,
      by_category: byCategory,
    },
  };
}
function buildUatCheckpoint(currentTest) {
  return [
    '╔══════════════════════════════════════════════════════════════╗',
    '║  CHECKPOINT: Verification Required                           ║',
    '╚══════════════════════════════════════════════════════════════╝',
    '',
    '**Test ' + currentTest.number + ': ' + currentTest.name + '**',
    '',
    currentTest.expected,
    '',
    '──────────────────────────────────────────────────────────────',
    "Type \`pass\` or describe what's wrong.",
    '──────────────────────────────────────────────────────────────',
  ].join('\\n');
}
function renderUatCheckpoint(argv) {
  const fileIndex = argv.indexOf('--file');
  const filePathArg = fileIndex >= 0 ? argv[fileIndex + 1] : '';
  if (!filePathArg) {
    return { error: 'UAT file required: use uat render-checkpoint --file <path>' };
  }
  let fullPath = '';
  try {
    fullPath = resolveProjectPath(filePathArg);
  } catch {
    return { error: 'UAT file not found: ' + filePathArg };
  }
  if (!exists(fullPath, 'f')) {
    return { error: 'UAT file not found: ' + filePathArg };
  }
  const content = fs.readFileSync(fullPath, 'utf8');
  const currentTestMatch = content.match(/##\\s*Current Test\\s*(?:\\n<!--[\\s\\S]*?-->)?\\n([\\s\\S]*?)(?=\\n##\\s|$)/i);
  if (!currentTestMatch) return { error: 'UAT file is missing a Current Test section' };
  const section = currentTestMatch[1].trimEnd();
  if (!section.trim()) return { error: 'Current Test section is empty' };
  if (/\\[testing complete\\]/i.test(section)) {
    return { error: 'UAT session is already complete; no pending checkpoint to render' };
  }
  const numberMatch = section.match(/^number:\\s*(\\d+)\\s*$/m);
  const nameMatch = section.match(/^name:\\s*(.+)\\s*$/m);
  const expectedBlockMatch = section.match(/^expected:\\s*\\|\\n([\\s\\S]*?)(?=^\\w[\\w-]*:\\s)/m)
    || section.match(/^expected:\\s*\\|\\n([\\s\\S]+)/m);
  const expectedInlineMatch = section.match(/^expected:\\s*(.+)\\s*$/m);
  if (!numberMatch || !nameMatch || (!expectedBlockMatch && !expectedInlineMatch)) {
    return { error: 'Current Test section is malformed' };
  }
  const expectedRaw = expectedBlockMatch
    ? expectedBlockMatch[1].split('\\n').map((line) => line.replace(/^ {2}/, '')).join('\\n').trim()
    : expectedInlineMatch[1].trim();
  const currentTest = {
    number: parseInt(numberMatch[1], 10),
    name: nameMatch[1].trim(),
    expected: expectedRaw,
  };
  return {
    file_path: filePathArg,
    test_number: currentTest.number,
    test_name: currentTest.name,
    checkpoint: buildUatCheckpoint(currentTest),
  };
}
function parseAuditFrontmatter(content) {
  return parseFrontmatter(content);
}
function scanOpenUatArtifacts() {
  const phasesDir = path.join(cwd, '.planning', 'phases');
  if (!exists(phasesDir, 'd')) return [];
  const results = [];
  for (const dir of fs.readdirSync(phasesDir)) {
    const phaseDir = path.join(phasesDir, dir);
    if (!exists(phaseDir, 'd')) continue;
    const phaseMatch = dir.match(/^(\\d+[A-Z]?(?:\\.\\d+)*)/i);
    const phaseNum = phaseMatch ? phaseMatch[1] : dir;
    for (const file of fs.readdirSync(phaseDir).filter((name) => name.includes('-UAT') && name.endsWith('.md'))) {
      try {
        const content = fs.readFileSync(path.join(phaseDir, file), 'utf8');
        const fm = parseAuditFrontmatter(content);
        const status = String(fm.status || 'unknown').toLowerCase();
        if (status === 'complete') continue;
        const pendingMatches = (content.match(/result:\\s*(?:pending|\\[pending\\])/gi) || []).length;
        results.push({ phase: phaseNum, file, status, open_scenario_count: pendingMatches });
      } catch {
        results.push({ phase: phaseNum, file, status: 'unreadable', scan_error: true });
      }
    }
  }
  return results;
}
function scanOpenVerificationArtifacts() {
  const phasesDir = path.join(cwd, '.planning', 'phases');
  if (!exists(phasesDir, 'd')) return [];
  const results = [];
  for (const dir of fs.readdirSync(phasesDir)) {
    const phaseDir = path.join(phasesDir, dir);
    if (!exists(phaseDir, 'd')) continue;
    const phaseMatch = dir.match(/^(\\d+[A-Z]?(?:\\.\\d+)*)/i);
    const phaseNum = phaseMatch ? phaseMatch[1] : dir;
    for (const file of fs.readdirSync(phaseDir).filter((name) => name.includes('-VERIFICATION') && name.endsWith('.md'))) {
      try {
        const content = fs.readFileSync(path.join(phaseDir, file), 'utf8');
        const fm = parseAuditFrontmatter(content);
        const status = String(fm.status || 'unknown').toLowerCase();
        if (status !== 'gaps_found' && status !== 'human_needed') continue;
        results.push({ phase: phaseNum, file, status });
      } catch {
        results.push({ phase: phaseNum, file, status: 'unreadable', scan_error: true });
      }
    }
  }
  return results;
}
function scanOpenContextQuestions() {
  const phasesDir = path.join(cwd, '.planning', 'phases');
  if (!exists(phasesDir, 'd')) return [];
  const results = [];
  for (const dir of fs.readdirSync(phasesDir)) {
    const phaseDir = path.join(phasesDir, dir);
    if (!exists(phaseDir, 'd')) continue;
    const phaseMatch = dir.match(/^(\\d+[A-Z]?(?:\\.\\d+)*)/i);
    const phaseNum = phaseMatch ? phaseMatch[1] : dir;
    for (const file of fs.readdirSync(phaseDir).filter((name) => name.includes('-CONTEXT') && name.endsWith('.md'))) {
      try {
        const content = fs.readFileSync(path.join(phaseDir, file), 'utf8');
        const fm = parseAuditFrontmatter(content);
        let questions = [];
        if (Array.isArray(fm.open_questions)) {
          questions = fm.open_questions.map((value) => String(value).trim()).filter(Boolean);
        }
        if (questions.length === 0) {
          const openQuestionsMatch = content.match(/##\\s*Open Questions[^\\n]*\\n([\\s\\S]*?)(?=\\n##\\s|$)/i);
          if (openQuestionsMatch) {
            questions = openQuestionsMatch[1]
              .split('\\n')
              .map((line) => line.trim())
              .filter((line) => line && line !== '-' && line !== '*')
              .filter((line) => /^[-*\\d]/.test(line) || line.includes('?'))
              .slice(0, 3);
          }
        }
        if (questions.length === 0) continue;
        results.push({ phase: phaseNum, file, question_count: questions.length, questions: questions.slice(0, 3) });
      } catch {
        results.push({ phase: phaseNum, file, question_count: 0, questions: [], scan_error: true });
      }
    }
  }
  return results;
}
function auditOpenArtifacts() {
  const uatGaps = scanOpenUatArtifacts();
  const verificationGaps = scanOpenVerificationArtifacts();
  const contextQuestions = scanOpenContextQuestions();
  const counts = {
    debug_sessions: 0,
    quick_tasks: 0,
    threads: 0,
    todos: 0,
    seeds: 0,
    uat_gaps: uatGaps.filter((item) => !item.scan_error).length,
    verification_gaps: verificationGaps.filter((item) => !item.scan_error).length,
    context_questions: contextQuestions.filter((item) => !item.scan_error).length,
    total: 0,
  };
  counts.total = counts.uat_gaps + counts.verification_gaps + counts.context_questions;
  const hasScanErrors = [uatGaps, verificationGaps, contextQuestions].some((items) => items.some((item) => item.scan_error === true));
  return {
    scanned_at: new Date().toISOString(),
    has_scan_errors: hasScanErrors,
    has_open_items: counts.total > 0,
    counts,
    items: {
      debug_sessions: [],
      quick_tasks: [],
      threads: [],
      todos: [],
      seeds: [],
      uat_gaps: uatGaps,
      verification_gaps: verificationGaps,
      context_questions: contextQuestions,
    },
  };
}
function formatAuditReport(auditResult) {
  const { counts, items, has_open_items, has_scan_errors } = auditResult;
  const lines = [];
  const hr = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';
  lines.push(hr);
  lines.push('  Milestone Close: Open Artifact Audit');
  lines.push(hr);
  if (has_scan_errors) {
    lines.push('');
    lines.push('  ⚠ Some files or directories could not be scanned completely.');
    lines.push('  Treat this audit as incomplete until read errors are resolved.');
  }
  if (!has_open_items && !has_scan_errors) {
    lines.push('');
    lines.push('  All artifact types clear. Safe to proceed.');
    lines.push('');
    lines.push(hr);
    return lines.join('\\n');
  }
  if (counts.uat_gaps > 0) {
    lines.push('');
    lines.push('🔴 UAT Gaps (' + counts.uat_gaps + ' phases with incomplete UAT)');
    for (const item of items.uat_gaps.filter((entry) => !entry.scan_error)) {
      lines.push('   • Phase ' + item.phase + ': ' + item.file + ' [' + item.status + '] — ' + item.open_scenario_count + ' pending scenarios');
    }
  }
  if (counts.verification_gaps > 0) {
    lines.push('');
    lines.push('🔴 Verification Gaps (' + counts.verification_gaps + ' unresolved)');
    for (const item of items.verification_gaps.filter((entry) => !entry.scan_error)) {
      lines.push('   • Phase ' + item.phase + ': ' + item.file + ' [' + item.status + ']');
    }
  }
  if (counts.context_questions > 0) {
    lines.push('');
    lines.push('🔵 CONTEXT Open Questions (' + counts.context_questions + ' phases with open questions)');
    for (const item of items.context_questions.filter((entry) => !entry.scan_error)) {
      lines.push('   • Phase ' + item.phase + ': ' + item.file + ' (' + item.question_count + ' question' + (item.question_count !== 1 ? 's' : '') + ')');
      for (const question of item.questions || []) {
        lines.push('     - ' + question);
      }
    }
  }
  lines.push('');
  lines.push(hr);
  lines.push('  ' + counts.total + ' item' + (counts.total !== 1 ? 's' : '') + ' require decisions before close.');
  lines.push(hr);
  return lines.join('\\n');
}
function getPhaseArtifacts(phaseDir, normalizedPhase) {
  if (!phaseDir || !exists(path.join(cwd, phaseDir), 'd')) {
    return {
      context_path: null,
      research_path: null,
      verification_path: null,
      uat_path: null,
      reviews_path: null,
      patterns_path: null,
      has_context: false,
      has_research: false,
      has_reviews: false,
      has_plans: false,
      plan_count: 0,
    };
  }
  const prefixed = normalizedPhase ? normalizedPhase + '-' : '';
  const resolveArtifact = (suffix) => firstExistingPath([
    path.join(phaseDir, prefixed + suffix),
    path.join(phaseDir, suffix),
  ]);
  const planFiles = fs.readdirSync(path.join(cwd, phaseDir))
    .filter((name) => /-PLAN\.md$/.test(name));
  const contextPath = resolveArtifact('CONTEXT.md');
  const researchPath = resolveArtifact('RESEARCH.md');
  const reviewsPath = resolveArtifact('REVIEWS.md');
  return {
    context_path: contextPath,
    research_path: researchPath,
    verification_path: resolveArtifact('VERIFICATION.md'),
    uat_path: resolveArtifact('UAT.md'),
    reviews_path: reviewsPath,
    patterns_path: resolveArtifact('PATTERNS.md'),
    has_context: contextPath != null,
    has_research: researchPath != null,
    has_reviews: reviewsPath != null,
    has_plans: planFiles.length > 0,
    plan_count: planFiles.length,
  };
}
function getStateField(fieldName) {
  const statePath = path.join(cwd, '.planning', 'STATE.md');
  if (!exists(statePath, 'f')) return '';
  const content = fs.readFileSync(statePath, 'utf8');
  const match = content.match(new RegExp('^' + fieldName.replace(/[.*+?^$(){}|[\\]\\\\]/g, '\\\\$&') + ':\\\\s*(.+)$', 'm'));
  return match ? match[1].trim() : '';
}
function comparePhaseValues(a, b) {
  return String(a || '').localeCompare(String(b || ''), undefined, { numeric: true, sensitivity: 'base' });
}
function resolveProjectPath(relPath) {
  const resolved = path.resolve(cwd, relPath);
  if (resolved === cwd || resolved.startsWith(cwd + path.sep)) return resolved;
  throw new Error('Path escapes project root: ' + relPath);
}
const INTEL_FILES = {
  files: 'files.json',
  apis: 'apis.json',
  deps: 'deps.json',
  arch: 'arch.md',
  stack: 'stack.json',
};
const INTEL_STALE_MS = 24 * 60 * 60 * 1000;
const INTEL_DISABLED_MSG = 'Intel system disabled. Set intel.enabled=true in config.json to activate.';
function getIntelDir() {
  return path.join(cwd, '.planning', 'intel');
}
function isIntelEnabled() {
  const config = readConfig();
  return !!(config && config.intel && config.intel.enabled === true);
}
function intelFilePath(filename) {
  return path.join(getIntelDir(), filename);
}
function hashIntelFile(filePath) {
  try {
    if (!exists(filePath, 'f')) return null;
    const content = fs.readFileSync(filePath);
    return createHash('sha256').update(content).digest('hex');
  } catch {
    return null;
  }
}
function searchJsonEntries(data, term, depth) {
  const lowerTerm = String(term || '').toLowerCase();
  const results = [];
  const maxDepth = 48;
  const currentDepth = Number(depth || 0);
  if (currentDepth > maxDepth) return results;
  if (!data || typeof data !== 'object') return results;
  function matchesInValue(value, innerDepth) {
    if (innerDepth > maxDepth) return false;
    if (typeof value === 'string') return value.toLowerCase().includes(lowerTerm);
    if (Array.isArray(value)) return value.some((entry) => matchesInValue(entry, innerDepth + 1));
    if (value && typeof value === 'object') return Object.values(value).some((entry) => matchesInValue(entry, innerDepth + 1));
    return false;
  }
  if (Array.isArray(data)) {
    for (const entry of data) {
      if (matchesInValue(entry, currentDepth + 1)) results.push(entry);
    }
  } else {
    for (const value of Object.values(data)) {
      if (Array.isArray(value)) {
        for (const entry of value) {
          if (matchesInValue(entry, currentDepth + 1)) results.push(entry);
        }
      }
    }
  }
  return results;
}
function searchIntelArch(filePath, term) {
  if (!exists(filePath, 'f')) return [];
  const lowerTerm = String(term || '').toLowerCase();
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter((line) => line.toLowerCase().includes(lowerTerm));
}
function intelStatus() {
  if (!isIntelEnabled()) return { disabled: true, message: INTEL_DISABLED_MSG };
  const now = Date.now();
  const files = {};
  let overallStale = false;
  for (const filename of Object.values(INTEL_FILES)) {
    const filePath = intelFilePath(filename);
    if (!exists(filePath, 'f')) {
      files[filename] = { exists: false, updated_at: null, stale: true };
      overallStale = true;
      continue;
    }
    let updatedAt = null;
    if (filename.endsWith('.md')) {
      try { updatedAt = fs.statSync(filePath).mtime.toISOString(); } catch {}
    } else {
      const data = safeReadJson(filePath, null);
      if (data && data._meta) updatedAt = data._meta.updated_at || null;
    }
    const stale = !updatedAt || (now - new Date(updatedAt).getTime()) > INTEL_STALE_MS;
    if (stale) overallStale = true;
    files[filename] = { exists: true, updated_at: updatedAt, stale };
  }
  return { files, overall_stale: overallStale };
}
function intelDiff() {
  if (!isIntelEnabled()) return { disabled: true, message: INTEL_DISABLED_MSG };
  const snapshotPath = intelFilePath('.last-refresh.json');
  const snapshot = safeReadJson(snapshotPath, null);
  if (!snapshot) return { no_baseline: true };
  const prevHashes = snapshot.hashes && typeof snapshot.hashes === 'object' ? snapshot.hashes : {};
  const changed = [];
  const added = [];
  const removed = [];
  for (const filename of Object.values(INTEL_FILES)) {
    const currentHash = hashIntelFile(intelFilePath(filename));
    if (currentHash && !prevHashes[filename]) added.push(filename);
    else if (currentHash && prevHashes[filename] && currentHash !== prevHashes[filename]) changed.push(filename);
    else if (!currentHash && prevHashes[filename]) removed.push(filename);
  }
  return { changed, added, removed };
}
function intelSnapshot() {
  if (!isIntelEnabled()) return { disabled: true, message: INTEL_DISABLED_MSG };
  const dir = getIntelDir();
  fs.mkdirSync(dir, { recursive: true });
  const hashes = {};
  let filesCount = 0;
  for (const filename of Object.values(INTEL_FILES)) {
    const hash = hashIntelFile(path.join(dir, filename));
    if (hash) {
      hashes[filename] = hash;
      filesCount += 1;
    }
  }
  const timestamp = new Date().toISOString();
  fs.writeFileSync(path.join(dir, '.last-refresh.json'), JSON.stringify({ hashes, timestamp, version: 1 }, null, 2), 'utf8');
  return { saved: true, timestamp, files: filesCount };
}
function intelValidate() {
  if (!isIntelEnabled()) return { disabled: true, message: INTEL_DISABLED_MSG };
  const errors = [];
  const warnings = [];
  for (const filename of Object.values(INTEL_FILES)) {
    const filePath = intelFilePath(filename);
    if (!exists(filePath, 'f')) {
      errors.push('Missing intel file: ' + filename);
      continue;
    }
    if (!filename.endsWith('.md')) {
      const data = safeReadJson(filePath, null);
      if (!data) {
        errors.push('Invalid JSON in: ' + filename);
        continue;
      }
      const meta = data._meta && typeof data._meta === 'object' ? data._meta : null;
      if (!meta || !meta.updated_at) {
        warnings.push(filename + ': missing _meta.updated_at');
      } else {
        const age = Date.now() - new Date(meta.updated_at).getTime();
        if (age > INTEL_STALE_MS) warnings.push(filename + ': stale (' + Math.round(age / 3600000) + 'h old)');
      }
    }
  }
  return { valid: errors.length === 0, errors, warnings };
}
function intelQuery(argv) {
  const term = String(argv[0] || '');
  if (!isIntelEnabled()) return { disabled: true, message: INTEL_DISABLED_MSG };
  const matches = [];
  let total = 0;
  for (const filename of Object.values(INTEL_FILES)) {
    const filePath = intelFilePath(filename);
    if (filename.endsWith('.md')) {
      const found = searchIntelArch(filePath, term);
      if (found.length > 0) {
        matches.push({ source: filename, entries: found });
        total += found.length;
      }
    } else {
      const data = safeReadJson(filePath, null);
      if (!data) continue;
      const found = searchJsonEntries(data, term, 0);
      if (found.length > 0) {
        matches.push({ source: filename, entries: found });
        total += found.length;
      }
    }
  }
  return { matches, term, total };
}
function intelExtractExports(argv) {
  const rawPath = String(argv[0] || '').trim();
  if (!rawPath) return { file: '', exports: [], method: 'none' };
  let filePath = '';
  try { filePath = resolveProjectPath(rawPath); } catch { return { file: rawPath, exports: [], method: 'none' }; }
  if (!exists(filePath, 'f')) return { file: filePath, exports: [], method: 'none' };
  const content = fs.readFileSync(filePath, 'utf8');
  const exportsList = [];
  let method = 'none';
  const moduleMatches = [...content.matchAll(/module\.exports\s*=\s*\{/g)];
  if (moduleMatches.length > 0) {
    const lastMatch = moduleMatches[moduleMatches.length - 1];
    const startIdx = (lastMatch.index || 0) + lastMatch[0].length;
    let depth = 1;
    let endIdx = startIdx;
    while (endIdx < content.length && depth > 0) {
      if (content[endIdx] === '{') depth += 1;
      else if (content[endIdx] === '}') depth -= 1;
      if (depth > 0) endIdx += 1;
    }
    const block = content.substring(startIdx, endIdx);
    method = 'module.exports';
    for (const line of block.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
      const keyMatch = trimmed.match(/^(\w+)\s*[,}:]/) || trimmed.match(/^(\w+)$/);
      if (keyMatch && !exportsList.includes(keyMatch[1])) exportsList.push(keyMatch[1]);
    }
  }
  let match;
  const exportsPattern = /^exports\.(\w+)\s*=/gm;
  while ((match = exportsPattern.exec(content)) !== null) {
    if (!exportsList.includes(match[1])) {
      exportsList.push(match[1]);
      if (method === 'none') method = 'exports.X';
    }
  }
  const hadCjs = exportsList.length > 0;
  const esmExports = [];
  const defaultNamedPattern = /^export\s+default\s+(?:function|class)\s+(\w+)/gm;
  while ((match = defaultNamedPattern.exec(content)) !== null) {
    if (!esmExports.includes(match[1])) esmExports.push(match[1]);
  }
  const defaultAnonPattern = /^export\s+default\s+(?!function\s|class\s)/gm;
  if (defaultAnonPattern.test(content) && esmExports.length === 0) esmExports.push('default');
  const exportFnPattern = /^export\s+(?:async\s+)?function\s+(\w+)\s*\(/gm;
  while ((match = exportFnPattern.exec(content)) !== null) {
    if (!esmExports.includes(match[1])) esmExports.push(match[1]);
  }
  const exportVarPattern = /^export\s+(?:const|let|var)\s+(\w+)\s*=/gm;
  while ((match = exportVarPattern.exec(content)) !== null) {
    if (!esmExports.includes(match[1])) esmExports.push(match[1]);
  }
  const exportClassPattern = /^export\s+class\s+(\w+)/gm;
  while ((match = exportClassPattern.exec(content)) !== null) {
    if (!esmExports.includes(match[1])) esmExports.push(match[1]);
  }
  const exportBlockPattern = /^export\s*\{([^}]+)\}/gm;
  while ((match = exportBlockPattern.exec(content)) !== null) {
    for (const item of match[1].split(',')) {
      const trimmed = item.trim();
      if (!trimmed) continue;
      const name = trimmed.split(/\s+as\s+/)[0].trim();
      if (name && !esmExports.includes(name)) esmExports.push(name);
    }
  }
  for (const entry of esmExports) {
    if (!exportsList.includes(entry)) exportsList.push(entry);
  }
  const hadEsm = esmExports.length > 0;
  if (hadCjs && hadEsm) method = 'mixed';
  else if (hadEsm && !hadCjs) method = 'esm';
  return { file: filePath, exports: exportsList, method };
}
function intelPatchMeta(argv) {
  const rawPath = String(argv[0] || '').trim();
  if (!rawPath) return { patched: false, error: 'File not found' };
  let filePath = '';
  try { filePath = resolveProjectPath(rawPath); } catch (error) { return { patched: false, error: String(error && error.message ? error.message : error) }; }
  if (!exists(filePath, 'f')) return { patched: false, error: 'File not found: ' + filePath };
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!data._meta) data._meta = {};
    const timestamp = new Date().toISOString();
    data._meta.updated_at = timestamp;
    data._meta.version = ((data._meta.version || 0) + 1);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    return { patched: true, file: filePath, timestamp };
  } catch (error) {
    return { patched: false, error: String(error && error.message ? error.message : error) };
  }
}
function intelUpdate() {
  if (!isIntelEnabled()) return { disabled: true, message: INTEL_DISABLED_MSG };
  return {
    action: 'spawn_agent',
    message: 'Run gsd-tools intel update or spawn gsd-intel-updater agent for full refresh',
  };
}
function parseFrontmatter(content) {
  const match = content.match(/^---\\r?\\n([\\s\\S]*?)\\r?\\n---\\r?\\n?/);
  if (!match) return {};
  const result = {};
  let currentKey = null;
  for (const rawLine of match[1].split(/\\r?\\n/)) {
    const line = rawLine.replace(/\\t/g, '    ');
    const fieldMatch = line.match(/^([A-Za-z0-9_-]+):\\s*(.*)$/);
    if (fieldMatch) {
      currentKey = fieldMatch[1];
      const rawValue = fieldMatch[2].trim();
      if (!rawValue) {
        result[currentKey] = [];
      } else if (rawValue === 'true') {
        result[currentKey] = true;
      } else if (rawValue === 'false') {
        result[currentKey] = false;
      } else if (/^-?\\d+$/.test(rawValue)) {
        result[currentKey] = Number(rawValue);
      } else {
        result[currentKey] = rawValue;
      }
      continue;
    }
    const itemMatch = line.match(/^\\s*-\\s*(.+?)\\s*$/);
    if (itemMatch && currentKey) {
      if (!Array.isArray(result[currentKey])) result[currentKey] = [];
      result[currentKey].push(itemMatch[1].trim());
    }
  }
  return result;
}
function extractObjective(content) {
  const blockMatch = content.match(/<objective>\\s*([\\s\\S]*?)<[/]objective>/i);
  if (blockMatch) return blockMatch[1].trim();
  const lineMatch = content.match(/<objective>\\s*\\n?\\s*(.+)/i);
  return lineMatch ? lineMatch[1].trim() : null;
}
function getPlanTaskCount(content) {
  const xmlTasks = content.match(/<task[\\s>]/gi) || [];
  const markdownTasks = content.match(/##\\s*Task\\s*\\d+/gi) || [];
  return xmlTasks.length || markdownTasks.length;
}
function getFrontmatterList(frontmatter, primaryKey, secondaryKey) {
  const value = frontmatter[primaryKey] != null ? frontmatter[primaryKey] : frontmatter[secondaryKey];
  if (Array.isArray(value)) return value.map((entry) => String(entry).trim()).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}
function extractKeyLinks(content) {
  const match = content.match(/^---\\r?\\n([\\s\\S]*?)\\r?\\n---\\r?\\n?/);
  if (!match) return [];
  const lines = match[1].split(/\\r?\\n/);
  const links = [];
  let inMustHaves = false;
  let inKeyLinks = false;
  let current = null;
  for (const line of lines) {
    if (!/^\\s/.test(line) && /^must_haves:\\s*$/.test(line)) {
      inMustHaves = true;
      inKeyLinks = false;
      current = null;
      continue;
    }
    if (inMustHaves && !/^\\s/.test(line) && !/^must_haves:\\s*$/.test(line)) {
      inMustHaves = false;
      inKeyLinks = false;
      current = null;
    }
    if (!inMustHaves) continue;
    if (/^\\s*key_links:\\s*$/.test(line)) {
      inKeyLinks = true;
      current = null;
      continue;
    }
    if (!inKeyLinks) continue;
    const fromMatch = line.match(/^\\s*-\\s*from:\\s*(.+?)\\s*$/);
    if (fromMatch) {
      if (current) links.push(current);
      current = { from: fromMatch[1].trim(), to: '', via: '', pattern: '' };
      continue;
    }
    const fieldMatch = line.match(/^\\s*(to|via|pattern):\\s*(.+?)\\s*$/);
    if (fieldMatch && current) {
      current[fieldMatch[1]] = fieldMatch[2].trim();
      continue;
    }
    if (/^\\s{2,}[A-Za-z0-9_-]+:\\s*$/.test(line) && !/^\\s*key_links:\\s*$/.test(line)) {
      if (current) links.push(current);
      current = null;
      inKeyLinks = false;
    }
  }
  if (current) links.push(current);
  return links;
}
function getPhaseDirectoryInfo(rawPhase) {
  const phaseInfo = findPhaseDirectory(rawPhase);
  if (!phaseInfo.found) return null;
  const phaseDirAbs = path.join(cwd, phaseInfo.phaseDir);
  const phaseFiles = fs.readdirSync(phaseDirAbs);
  return { phaseInfo, phaseDirAbs, phaseFiles };
}
function getPhasePlanIndexData(rawPhase) {
  const directoryInfo = getPhaseDirectoryInfo(rawPhase);
  const normalized = normalizePhaseNumber(rawPhase);
  if (!directoryInfo) {
    return {
      phase: normalized,
      phase_dir: null,
      phase_name: '',
      phase_slug: '',
      plans: [],
      plan_files: [],
      summary_files: [],
      waves: {},
      incomplete: [],
      incomplete_plan_files: [],
      has_checkpoints: false,
      error: 'Phase not found',
    };
  }
  const { phaseInfo, phaseDirAbs, phaseFiles } = directoryInfo;
  const planFiles = phaseFiles.filter((name) => /-PLAN\.md$/.test(name) || name === 'PLAN.md').sort(comparePhaseValues);
  const summaryFiles = phaseFiles.filter((name) => /-SUMMARY\.md$/.test(name) || name === 'SUMMARY.md');
  const completedPlanIds = new Set(summaryFiles.map((name) => name === 'SUMMARY.md' ? 'PLAN' : name.replace(/-SUMMARY\.md$/, '')));
  const plans = [];
  const waves = {};
  const incomplete = [];
  const incompletePlanFiles = [];
  let hasCheckpoints = false;
  for (const planFile of planFiles) {
    const planId = planFile === 'PLAN.md' ? 'PLAN' : planFile.replace(/-PLAN\\.md$/, '');
    const content = fs.readFileSync(path.join(phaseDirAbs, planFile), 'utf8');
    const frontmatter = parseFrontmatter(content);
    const wave = parseInt(String(frontmatter.wave), 10) || 1;
    const autonomous = frontmatter.autonomous === undefined
      ? true
      : !(frontmatter.autonomous === false || String(frontmatter.autonomous).trim().toLowerCase() === 'false');
    if (!autonomous || /<task\s+type=["']?checkpoint/i.test(content)) {
      hasCheckpoints = true;
    }
    const filesModified = getFrontmatterList(frontmatter, 'files_modified', 'files-modified');
    const hasSummary = completedPlanIds.has(planId);
    if (!hasSummary) {
      incomplete.push(planId);
      incompletePlanFiles.push(planFile);
    }
    plans.push({
      id: planId,
      wave,
      autonomous,
      objective: extractObjective(content) || (typeof frontmatter.objective === 'string' ? frontmatter.objective : null),
      files_modified: filesModified,
      task_count: getPlanTaskCount(content),
      has_summary: hasSummary,
    });
    const waveKey = String(wave);
    if (!waves[waveKey]) waves[waveKey] = [];
    waves[waveKey].push(planId);
  }
  return {
    phase: phaseInfo.normalized || normalized,
    phase_dir: phaseInfo.phaseDir,
    phase_name: phaseInfo.phaseName || '',
    phase_slug: phaseInfo.phaseSlug || '',
    plans,
    plan_files: planFiles,
    summary_files: summaryFiles.sort(comparePhaseValues),
    waves,
    incomplete,
    incomplete_plan_files: incompletePlanFiles,
    has_checkpoints: hasCheckpoints,
  };
}
function computeBranchName(config, branchingStrategy, phaseNumber, phaseSlug) {
  const gitCfg = config && typeof config.git === 'object' ? config.git : {};
  const projectCode = typeof config.project_code === 'string' ? config.project_code : '';
  if (branchingStrategy === 'phase' && phaseNumber) {
    const template = typeof gitCfg.phase_branch_template === 'string' && gitCfg.phase_branch_template
      ? gitCfg.phase_branch_template
      : '{project}phase-{phase}-{slug}';
    return template
      .replace('{project}', projectCode ? projectCode + '-' : '')
      .replace('{phase}', phaseNumber)
      .replace('{slug}', phaseSlug || 'phase');
  }
  return null;
}
function findNextPhaseInfo(currentPhase) {
  const normalizedCurrent = normalizePhaseNumber(currentPhase);
  const candidates = [];
  const phasesDir = path.join(cwd, '.planning', 'phases');
  if (exists(phasesDir, 'd')) {
    for (const name of fs.readdirSync(phasesDir)) {
      const match = name.match(/^([0-9]+(?:\\.[0-9]+)*)-(.+)$/);
      if (!match) continue;
      candidates.push({ phase: normalizePhaseNumber(match[1]), name: match[2].replace(/-/g, ' ') });
    }
  }
  const roadmapPath = path.join(cwd, '.planning', 'ROADMAP.md');
  if (exists(roadmapPath, 'f')) {
    const roadmapContent = fs.readFileSync(roadmapPath, 'utf8');
    const phasePattern = /^#{2,4}\\s*Phase\\s+([0-9]+(?:\\.[0-9]+)*)\\s*:\\s*([^\\n]+)/gim;
    let match;
    while ((match = phasePattern.exec(roadmapContent)) !== null) {
      candidates.push({ phase: normalizePhaseNumber(match[1]), name: match[2].replace(/\\(INSERTED\\)/gi, '').trim() });
    }
  }
  const deduped = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate.phase || seen.has(candidate.phase)) continue;
    seen.add(candidate.phase);
    deduped.push(candidate);
  }
  deduped.sort((a, b) => comparePhaseValues(a.phase, b.phase));
  return deduped.find((candidate) => comparePhaseValues(candidate.phase, normalizedCurrent) > 0) || null;
}
function upsertLine(source, key, value) {
  const newline = String.fromCharCode(10);
  const line = key + ': ' + value;
  const pattern = new RegExp('^' + key.replace(/[.*+?^$(){}|[\\]\\\\]/g, '\\\\$&') + ':.*$', 'm');
  if (pattern.test(source)) {
    return source.replace(pattern, line);
  }
  const headingMatch = source.match(/^##\s+/m);
  if (headingMatch && headingMatch.index != null) {
    const header = source.slice(0, headingMatch.index).trimEnd();
    const remainder = source.slice(headingMatch.index);
    return (header ? header + newline : '') + line + newline + remainder.replace(/^\n*/, '');
  }
  return source.trimEnd() + (source.trim() ? newline : '') + line + newline;
}
function updateStateForExecution(phaseValue, phaseName, plansValue) {
  const statePath = path.join(cwd, '.planning', 'STATE.md');
  let content = exists(statePath, 'f') ? fs.readFileSync(statePath, 'utf8') : '';
  content = upsertLine(content, 'current_phase', phaseValue);
  content = upsertLine(content, 'current_phase_name', phaseName || '');
  content = upsertLine(content, 'current_step', 'execute');
  content = upsertLine(content, 'total_plans_in_phase', plansValue);
  content = upsertLine(content, 'last_activity', new Date().toISOString());
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, content, 'utf8');
}
function buildSkippedCodebaseDrift(reason) {
  return {
    skipped: true,
    reason,
    action_required: false,
    directive: 'none',
    elements: [],
  };
}
function readPhaseRequirementIds(rawPhase) {
  const roadmapPhase = parseRoadmapPhase(rawPhase);
  if (!roadmapPhase || !roadmapPhase.phase_req_ids) return [];
  return String(roadmapPhase.phase_req_ids).split(',').map((item) => item.trim()).filter(Boolean);
}
function updateRoadmapPlanProgress(rawPhase) {
  const phaseData = getPhasePlanIndexData(rawPhase);
  const roadmapPath = path.join(cwd, '.planning', 'ROADMAP.md');
  if (!phaseData.phase_dir || !exists(roadmapPath, 'f')) {
    return {
      updated: false,
      reason: !phaseData.phase_dir ? 'Phase not found' : 'ROADMAP.md not found',
      plan_count: phaseData.plan_files.length,
      summary_count: phaseData.summary_files.length,
    };
  }
  const phaseNumber = phaseData.phase;
  const planCount = phaseData.plan_files.length;
  const summaryCount = phaseData.summary_files.length;
  const isComplete = planCount > 0 && summaryCount >= planCount;
  const status = isComplete ? 'Complete' : summaryCount > 0 ? 'In Progress' : 'Planned';
  const today = new Date().toISOString().split('T')[0];
  const roadmapContent = fs.readFileSync(roadmapPath, 'utf8');
  const phaseEscaped = phaseNumber.replace(/[.*+?^$(){}|[\\]\\\\]/g, '\\\\$&');
  const lines = roadmapContent.split(/\r?\n/);
  let currentPhaseSection = '';
  const updatedLines = lines.map((line) => {
    const headingMatch = line.match(/^#{2,4}\s*Phase\s+(\d+[A-Z]?(?:\.\d+)*)\s*:/i);
    if (headingMatch) currentPhaseSection = normalizePhaseNumber(headingMatch[1]);
    if (/^\|/.test(line) && !/^\|\s*-/.test(line)) {
      const rowMatch = line.match(/^\|\s*(\d+[A-Z]?(?:\.\d+)*)\b/i);
      if (rowMatch && normalizePhaseNumber(rowMatch[1]) === phaseNumber) {
        const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
        if (cells.length >= 4) {
          cells[1] = summaryCount + '/' + planCount;
          cells[2] = status;
          cells[3] = isComplete ? today : '';
          return '| ' + cells.join(' | ') + ' |';
        }
      }
    }
    if (currentPhaseSection === phaseNumber && /^\*\*Plans:\*\*/i.test(line.trim())) {
      return '**Plans:** ' + (isComplete ? summaryCount + '/' + planCount + ' plans complete' : summaryCount + '/' + planCount + ' plans executed');
    }
    return line;
  });
  let nextRoadmapContent = updatedLines.join('\n');
  for (const summaryFile of phaseData.summary_files) {
    const planId = summaryFile === 'SUMMARY.md' ? 'PLAN' : summaryFile.replace(/-SUMMARY\.md$/, '');
    const planEscaped = planId.replace(/[.*+?^$(){}|[\\]\\\\]/g, '\\\\$&');
    const planCheckboxPattern = new RegExp('(-\\s*\\[) (\\]\\s*(?:\\*\\*)?' + planEscaped + '(?:\\*\\*)?(?:-PLAN\\.md)?)', 'i');
    nextRoadmapContent = nextRoadmapContent.replace(planCheckboxPattern, '$1x$2');
  }
  fs.writeFileSync(roadmapPath, nextRoadmapContent, 'utf8');
  return {
    updated: true,
    phase: phaseNumber,
    plan_count: planCount,
    summary_count: summaryCount,
    status,
    complete: isComplete,
  };
}
function parseSimpleJsonArg(input) {
  try {
    return JSON.parse(String(input || ''));
  } catch {
    return null;
  }
}
function parseSimpleValueArg(input) {
  const parsed = parseSimpleJsonArg(input);
  return parsed == null && String(input || '').trim() !== 'null' ? input : parsed;
}
function splitFrontmatterDocument(content) {
  const match = String(content || '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: String(content || '') };
  return { frontmatter: parseFrontmatter(match[0]), body: match[2] || '' };
}
function serializeFrontmatterValue(key, value) {
  if (Array.isArray(value)) {
    if (value.length === 0) return key + ': []';
    return [key + ':', ...value.map((entry) => '  - ' + String(entry))].join('\n');
  }
  if (typeof value === 'boolean' || typeof value === 'number') return key + ': ' + String(value);
  if (value == null || value === '') return key + ':';
  return key + ': ' + String(value);
}
function spliceFrontmatterDocument(content, frontmatter) {
  const { body } = splitFrontmatterDocument(content);
  const frontmatterLines = Object.entries(frontmatter).map(([key, value]) => serializeFrontmatterValue(key, value));
  return ['---', ...frontmatterLines, '---', body.replace(/^\r?\n/, '')].join('\n').replace(/\n+$/, '\n');
}
function frontmatterSetQuery(args) {
  const fieldIndex = args.indexOf('--field');
  const valueIndex = args.indexOf('--value');
  const filePath = args[0] || '';
  const field = fieldIndex >= 0 ? args[fieldIndex + 1] : args[1];
  const valueArg = valueIndex >= 0 ? args[valueIndex + 1] : args[2];
  if (!filePath || !field || valueArg === undefined) return { error: 'file, field, and value required', classification: 'validation' };
  const fullPath = resolveProjectPath(filePath);
  if (!exists(fullPath, 'f')) return { error: 'File not found', path: filePath };
  const content = fs.readFileSync(fullPath, 'utf8');
  const { frontmatter } = splitFrontmatterDocument(content);
  const parsedValue = parseSimpleValueArg(valueArg);
  frontmatter[field] = parsedValue;
  fs.writeFileSync(fullPath, spliceFrontmatterDocument(content, frontmatter), 'utf8');
  return { updated: true, field, value: parsedValue };
}
function frontmatterMergeQuery(args) {
  const filePath = args[0] || '';
  const dataIndex = args.indexOf('--data');
  const dataArg = dataIndex >= 0 ? args[dataIndex + 1] : args[1];
  if (!filePath || !dataArg) return { error: 'file and data required', classification: 'validation' };
  const mergeData = parseSimpleJsonArg(dataArg);
  if (!mergeData || Array.isArray(mergeData) || typeof mergeData !== 'object') {
    return { error: 'Invalid JSON for merge data', classification: 'validation' };
  }
  const fullPath = resolveProjectPath(filePath);
  if (!exists(fullPath, 'f')) return { error: 'File not found', path: filePath };
  const content = fs.readFileSync(fullPath, 'utf8');
  const { frontmatter } = splitFrontmatterDocument(content);
  Object.assign(frontmatter, mergeData);
  fs.writeFileSync(fullPath, spliceFrontmatterDocument(content, frontmatter), 'utf8');
  return { merged: true, fields: Object.keys(mergeData) };
}
function frontmatterValidateQuery(args) {
  const filePath = args[0] || '';
  const schemaIndex = args.indexOf('--schema');
  const schemaName = schemaIndex >= 0 ? args[schemaIndex + 1] : '';
  if (!filePath || !schemaName) return { error: 'file and schema required', classification: 'validation' };
  const schemas = {
    plan: ['phase', 'plan', 'wave'],
    summary: ['phase', 'plan'],
    verification: ['phase'],
  };
  const requiredFields = schemas[schemaName];
  if (!requiredFields) {
    return { error: 'Unknown schema: ' + schemaName + '. Available: ' + Object.keys(schemas).join(', '), classification: 'validation' };
  }
  const fullPath = resolveProjectPath(filePath);
  if (!exists(fullPath, 'f')) return { error: 'File not found', path: filePath };
  const content = fs.readFileSync(fullPath, 'utf8');
  const frontmatter = parseFrontmatter(content);
  const missing = requiredFields.filter((field) => typeof frontmatter[field] === 'undefined');
  const present = requiredFields.filter((field) => typeof frontmatter[field] !== 'undefined');
  return { valid: missing.length === 0, missing, present, schema: schemaName };
}
function ensureStateFile() {
  const statePath = path.join(cwd, '.planning', 'STATE.md');
  if (!exists(path.dirname(statePath), 'd')) fs.mkdirSync(path.dirname(statePath), { recursive: true });
  if (!exists(statePath, 'f')) fs.writeFileSync(statePath, '', 'utf8');
  return statePath;
}
function stateUpdateField(fieldName, value) {
  const statePath = ensureStateFile();
  let content = fs.readFileSync(statePath, 'utf8');
  content = upsertLine(content, fieldName, value);
  fs.writeFileSync(statePath, content, 'utf8');
  return { updated: true, field: fieldName, value };
}
function statePatchObject(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { updated: false, matched_fields: [], error: 'patch object required' };
  }
  const statePath = ensureStateFile();
  let content = fs.readFileSync(statePath, 'utf8');
  const matchedFields = [];
  for (const [key, rawValue] of Object.entries(patch)) {
    content = upsertLine(content, key, String(rawValue == null ? '' : rawValue));
    matchedFields.push(key);
  }
  fs.writeFileSync(statePath, content, 'utf8');
  return { updated: true, matched_fields: matchedFields };
}
function stateAddRoadmapEvolution(argv) {
  const newline = String.fromCharCode(10);
  const getFlag = (flag) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? String(argv[index + 1] || '').trim() : '';
  };
  const phase = getFlag('--phase');
  const action = getFlag('--action');
  const after = getFlag('--after');
  const note = getFlag('--note');
  const urgent = argv.includes('--urgent');
  const entry = '- Phase ' + phase + ' ' + action + (after ? ' after Phase ' + after : '') + ': ' + note + (urgent ? ' (URGENT)' : '');
  const statePath = ensureStateFile();
  let content = fs.readFileSync(statePath, 'utf8');
  if (content.includes(entry)) {
    return { added: false, reason: 'duplicate', entry };
  }
  if (!/##\s+Accumulated Context/i.test(content)) {
    content = content.trimEnd() + (content.trim() ? newline + newline : '') + '## Accumulated Context' + newline;
  }
  if (!/###\s+Roadmap Evolution/i.test(content)) {
    content = content.replace(/(##\s+Accumulated Context[^\n]*\n)/i, (match) => match + newline + '### Roadmap Evolution' + newline);
  }
  content = content.replace(/(###\s+Roadmap Evolution[^\n]*\n)/i, (match) => match + entry + newline);
  fs.writeFileSync(statePath, content, 'utf8');
  return { added: true, entry };
}
function stateMilestoneSwitch(argv) {
  const milestone = (() => {
    const index = argv.indexOf('--milestone');
    return index >= 0 ? String(argv[index + 1] || '').trim() : '';
  })();
  const name = (() => {
    const index = argv.indexOf('--name');
    return index >= 0 ? String(argv[index + 1] || '').trim() : '';
  })();
  const statePath = ensureStateFile();
  let content = fs.readFileSync(statePath, 'utf8');
  content = upsertLine(content, 'milestone', milestone);
  content = upsertLine(content, 'milestone_name', name);
  content = upsertLine(content, 'current_phase', '');
  content = upsertLine(content, 'current_step', 'discuss');
  content = upsertLine(content, 'last_activity', new Date().toISOString());
  fs.writeFileSync(statePath, content, 'utf8');
  return { updated: true, milestone, name };
}
function getFlagValue(argv, flagName, fallbackIndex) {
  const flagIndex = argv.indexOf(flagName);
  if (flagIndex >= 0 && argv[flagIndex + 1] != null) return String(argv[flagIndex + 1]).trim();
  if (fallbackIndex != null && argv[fallbackIndex] != null) return String(argv[fallbackIndex]).trim();
  return '';
}
function findMarkdownSectionBounds(lines, heading) {
  const target = String(heading || '').trim().toLowerCase();
  let start = -1;
  let end = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (start < 0) {
      if (/^##\s+/.test(trimmed) && trimmed.replace(/^##\s+/, '').trim().toLowerCase() === target) {
        start = index;
      }
      continue;
    }
    if (/^##\s+/.test(trimmed)) {
      end = index;
      break;
    }
  }
  return { start, end };
}
function ensureMarkdownSection(content, heading) {
  const trimmed = String(content || '').trimEnd();
  const lines = trimmed ? trimmed.split(/\r?\n/) : [];
  const bounds = findMarkdownSectionBounds(lines, heading);
  if (bounds.start >= 0) return trimmed + '\n';
  const nextLines = [...lines];
  if (nextLines.length > 0 && nextLines[nextLines.length - 1].trim() !== '') nextLines.push('');
  nextLines.push('## ' + heading);
  nextLines.push('');
  return nextLines.join('\n').replace(/\n+$/, '\n');
}
function appendBulletToMarkdownSection(content, heading, bulletText) {
  const ensured = ensureMarkdownSection(content, heading);
  const lines = ensured.split(/\r?\n/);
  const bounds = findMarkdownSectionBounds(lines, heading);
  if (bounds.start < 0) return { content: ensured, added: false };
  const bulletLine = '- ' + bulletText.trim();
  const sectionLines = lines.slice(bounds.start + 1, bounds.end);
  if (sectionLines.some((line) => line.trim() === bulletLine.trim())) {
    return { content: ensured, added: false };
  }
  let insertAt = bounds.end;
  while (insertAt > bounds.start + 1 && lines[insertAt - 1].trim() === '') insertAt -= 1;
  lines.splice(insertAt, 0, bulletLine);
  return { content: lines.join('\n').replace(/\n+$/, '\n'), added: true };
}
function removeBulletFromMarkdownSection(content, heading, matcher) {
  const lines = String(content || '').split(/\r?\n/);
  const bounds = findMarkdownSectionBounds(lines, heading);
  if (bounds.start < 0) return { content: String(content || ''), removed: [] };
  const removed = [];
  const kept = [];
  for (const line of lines.slice(bounds.start + 1, bounds.end)) {
    if (/^\s*-\s+/.test(line) && matcher(line.replace(/^\s*-\s+/, '').trim())) {
      removed.push(line.replace(/^\s*-\s+/, '').trim());
    } else {
      kept.push(line);
    }
  }
  const nextLines = [...lines.slice(0, bounds.start + 1), ...kept, ...lines.slice(bounds.end)];
  return { content: nextLines.join('\n').replace(/\n+$/, '\n'), removed };
}
function stateAddBlocker(argv) {
  const text = getFlagValue(argv, '--text', 0);
  const phase = getFlagValue(argv, '--phase');
  const owner = getFlagValue(argv, '--owner');
  const severity = getFlagValue(argv, '--severity');
  if (!text) return { added: false, error: 'blocker text required' };
  const parts = [text];
  const metadata = [];
  if (phase) metadata.push('phase ' + normalizePhaseNumber(phase));
  if (severity) metadata.push('severity ' + severity);
  if (owner) metadata.push('owner ' + owner);
  if (metadata.length > 0) parts.push('(' + metadata.join('; ') + ')');
  const statePath = ensureStateFile();
  const current = fs.readFileSync(statePath, 'utf8');
  const result = appendBulletToMarkdownSection(current, 'Blockers', parts.join(' '));
  if (result.added) {
    let next = upsertLine(result.content, 'status', 'blocked');
    next = upsertLine(next, 'last_activity', new Date().toISOString());
    fs.writeFileSync(statePath, next, 'utf8');
  }
  return { added: result.added, blocker: parts.join(' '), phase: phase ? normalizePhaseNumber(phase) : null };
}
function stateResolveBlocker(argv) {
  const target = getFlagValue(argv, '--text', 0);
  if (!target) return { resolved: false, error: 'blocker text required' };
  const statePath = ensureStateFile();
  const current = fs.readFileSync(statePath, 'utf8');
  const result = removeBulletFromMarkdownSection(current, 'Blockers', (line) => line.toLowerCase().includes(target.toLowerCase()));
  let next = result.content;
  if (result.removed.length > 0) {
    const remainingOpen = extractMarkdownSection(next, 'Blockers')
      .split(/\r?\n/)
      .some((line) => /^\s*-\s+/.test(line));
    if (!remainingOpen) next = upsertLine(next, 'status', 'active');
    next = upsertLine(next, 'last_activity', new Date().toISOString());
    fs.writeFileSync(statePath, next, 'utf8');
  }
  return { resolved: result.removed.length > 0, removed: result.removed };
}
function stateAddDecision(argv) {
  const text = getFlagValue(argv, '--text', 0);
  const phase = getFlagValue(argv, '--phase');
  const rationale = getFlagValue(argv, '--rationale');
  if (!text) return { added: false, error: 'decision text required' };
  const normalizedPhase = phase ? normalizePhaseNumber(phase) : '';
  const bullet = [normalizedPhase ? '[' + normalizedPhase + '] ' : '', text, rationale ? ' :: ' + rationale : ''].join('');
  const statePath = ensureStateFile();
  const current = fs.readFileSync(statePath, 'utf8');
  const result = appendBulletToMarkdownSection(current, 'Decisions Made', bullet);
  if (result.added) {
    const next = upsertLine(result.content, 'last_activity', new Date().toISOString());
    fs.writeFileSync(statePath, next, 'utf8');
  }
  return { added: result.added, decision: bullet };
}
function stateAdvancePlan(argv) {
  const explicitPhase = getFlagValue(argv, '--phase');
  const explicitCurrentPlan = getFlagValue(argv, '--current-plan');
  const statePath = ensureStateFile();
  const currentState = fs.readFileSync(statePath, 'utf8');
  const phase = normalizePhaseNumber(explicitPhase || getStateField('current_phase') || getStateField('Current Phase'));
  if (!phase) return { advanced: false, error: 'current phase not set' };
  const phaseData = getPhasePlanIndexData(phase);
  if (!phaseData.plans || phaseData.plans.length === 0) {
    return { advanced: false, error: 'no plans found for phase', phase };
  }
  const incompletePlans = phaseData.plans.filter((plan) => !plan.has_summary).map((plan) => plan.id);
  const currentPlan = explicitCurrentPlan || getStateField('current_plan') || getStateField('Current Plan');
  let nextPlan = '';
  if (currentPlan && incompletePlans.includes(currentPlan)) {
    const currentIndex = incompletePlans.indexOf(currentPlan);
    nextPlan = incompletePlans[currentIndex + 1] || '';
  } else {
    nextPlan = incompletePlans[0] || '';
  }
  let next = currentState;
  next = upsertLine(next, 'current_phase', phase);
  next = upsertLine(next, 'current_plan', nextPlan);
  next = upsertLine(next, 'last_activity', new Date().toISOString());
  next = upsertLine(next, 'current_step', nextPlan ? 'execute' : 'verify');
  fs.writeFileSync(statePath, next, 'utf8');
  return {
    advanced: true,
    phase,
    previous_plan: currentPlan || null,
    next_plan: nextPlan || null,
    phase_complete: !nextPlan,
    remaining_plans: incompletePlans,
  };
}
function stateRecordMetric(argv) {
  const key = getFlagValue(argv, '--key', 0);
  const value = getFlagValue(argv, '--value', 1);
  const unit = getFlagValue(argv, '--unit');
  if (!key || !value) return { recorded: false, error: 'metric key and value required' };
  const statePath = ensureStateFile();
  const current = fs.readFileSync(statePath, 'utf8');
  const metricLine = getTodayDate() + ' :: ' + key + ' = ' + value + (unit ? ' ' + unit : '');
  const result = appendBulletToMarkdownSection(current, 'Metrics', metricLine);
  if (result.added) {
    const next = upsertLine(result.content, 'last_activity', new Date().toISOString());
    fs.writeFileSync(statePath, next, 'utf8');
  }
  return { recorded: result.added, metric: metricLine };
}
function stateValidate() {
  const content = readStateContent();
  if (!content) return { valid: false, errors: ['STATE.md not found'], warnings: [], counts: {} };
  const requiredFields = ['current_phase', 'current_step', 'last_activity'];
  const errors = [];
  const warnings = [];
  for (const field of requiredFields) {
    if (!getStateField(field) && !getStateField(field.replace(/_/g, ' '))) {
      warnings.push('Missing recommended state field: ' + field);
    }
  }
  if (content.includes('\\n')) warnings.push('STATE.md contains escaped newline text');
  const counts = {
    decisions: extractMarkdownSection(content, 'Decisions Made').split(/\r?\n/).filter((line) => /^\s*-\s+/.test(line)).length,
    blockers: extractMarkdownSection(content, 'Blockers').split(/\r?\n/).filter((line) => /^\s*-\s+/.test(line)).length,
    metrics: extractMarkdownSection(content, 'Metrics').split(/\r?\n/).filter((line) => /^\s*-\s+/.test(line)).length,
  };
  if (counts.blockers > 0 && (getStateField('status') || '').toLowerCase() !== 'blocked') {
    warnings.push('Open blockers exist but status is not blocked');
  }
  return { valid: errors.length === 0, errors, warnings, counts };
}
function extractPerformanceMetricsRowPhase(line) {
  const phaseNamed = String(line || '').match(/^\|\s*Phase\s+(\d+)/i);
  if (phaseNamed) return parseInt(phaseNamed[1], 10);
  const legacy = String(line || '').match(/^\|\s*(\d+)\s*\|/);
  if (legacy) return parseInt(legacy[1], 10);
  return null;
}
function pruneStateSectionEntries(content, headingCandidates, matcher, sectionLabel) {
  for (const heading of headingCandidates) {
    const bounds = findMarkdownSectionBounds(String(content || '').split(/\r?\n/), heading);
    if (bounds.start < 0) continue;
    const lines = String(content || '').split(/\r?\n/);
    const sectionLines = lines.slice(bounds.start + 1, bounds.end);
    const kept = [];
    const archived = [];
    for (const line of sectionLines) {
      if (/^\s*-\s+/.test(line) || /^\|/.test(line)) {
        if (matcher(line)) archived.push(line);
        else kept.push(line);
      } else {
        kept.push(line);
      }
    }
    if (archived.length === 0) continue;
    const nextLines = [...lines.slice(0, bounds.start + 1), ...kept, ...lines.slice(bounds.end)];
    return {
      content: nextLines.join('\n').replace(/\n+$/, '\n'),
      archived,
      section: sectionLabel,
    };
  }
  return null;
}
function statePrune(argv) {
  const keepRecentIndex = argv.indexOf('--keep-recent');
  const parsedKeepRecent = keepRecentIndex >= 0 ? parseInt(String(argv[keepRecentIndex + 1] || '3'), 10) : 3;
  if (!Number.isInteger(parsedKeepRecent) || parsedKeepRecent < 0) {
    return { error: 'keep-recent must be a non-negative integer' };
  }
  const dryRun = argv.includes('--dry-run');
  const keepRecent = parsedKeepRecent;
  const statePath = path.join(cwd, '.planning', 'STATE.md');
  if (!exists(statePath, 'f')) return { error: 'STATE.md not found' };
  const fullContent = fs.readFileSync(statePath, 'utf8');
  const currentPhase = parseInt(String(getStateField('current_phase') || getStateField('Current Phase') || ''), 10) || 0;
  const cutoff = currentPhase - keepRecent;
  if (cutoff <= 0) {
    return {
      pruned: false,
      reason: 'Only ' + currentPhase + ' phases — nothing to prune with --keep-recent ' + keepRecent,
    };
  }
  const archiveSections = [];
  let nextContent = String(fullContent || '');
  const operations = [
    {
      headings: ['Decisions Made', 'Decisions', 'Accumulated Decisions'],
      section: 'Decisions',
      matcher: (line) => {
        const match = String(line).match(/\[Phase\s+(\d+)/i);
        return match ? parseInt(match[1], 10) <= cutoff : false;
      },
    },
    {
      headings: ['Recently Completed'],
      section: 'Recently Completed',
      matcher: (line) => {
        const match = String(line).match(/Phase\s+(\d+)/i);
        return match ? parseInt(match[1], 10) <= cutoff : false;
      },
    },
    {
      headings: ['Blockers', 'Blockers/Concerns', 'Blockers & Concerns'],
      section: 'Blockers (resolved)',
      matcher: (line) => {
        const match = String(line).match(/Phase\s+(\d+)/i);
        return /~~.*~~|\[RESOLVED\]/i.test(String(line)) && match ? parseInt(match[1], 10) <= cutoff : false;
      },
    },
    {
      headings: ['Performance Metrics', 'Metrics'],
      section: 'Performance Metrics',
      matcher: (line) => {
        const rowPhase = extractPerformanceMetricsRowPhase(line);
        return rowPhase != null ? rowPhase <= cutoff : false;
      },
    },
  ];
  for (const operation of operations) {
    const result = pruneStateSectionEntries(nextContent, operation.headings, operation.matcher, operation.section);
    if (!result) continue;
    nextContent = result.content;
    archiveSections.push({ section: result.section, lines: result.archived });
  }
  const totalArchived = archiveSections.reduce((sum, section) => sum + section.lines.length, 0);
  if (dryRun) {
    return {
      pruned: false,
      dry_run: true,
      cutoff_phase: cutoff,
      keep_recent: keepRecent,
      sections: archiveSections.map((section) => ({
        section: section.section,
        entries_would_archive: section.lines.length,
      })),
      total_would_archive: totalArchived,
      note: totalArchived > 0 ? 'Run without --dry-run to actually prune' : 'Nothing to prune',
    };
  }
  if (totalArchived === 0) {
    return {
      pruned: false,
      cutoff_phase: cutoff,
      keep_recent: keepRecent,
      sections: [],
      total_archived: 0,
      archive_file: null,
    };
  }
  fs.writeFileSync(statePath, nextContent.replace(/\n+$/, '\n'), 'utf8');
  const archivePath = path.join(cwd, '.planning', 'STATE-ARCHIVE.md');
  const timestamp = getTodayDate();
  let archiveContent = exists(archivePath, 'f')
    ? fs.readFileSync(archivePath, 'utf8')
    : '# STATE Archive\n\nPruned entries from STATE.md. Recoverable but no longer loaded into agent context.\n\n';
  archiveContent += '## Pruned ' + timestamp + ' (phases 1-' + cutoff + ', kept recent ' + keepRecent + ')\n\n';
  for (const section of archiveSections) {
    archiveContent += '### ' + section.section + '\n\n' + section.lines.join('\n') + '\n\n';
  }
  fs.writeFileSync(archivePath, archiveContent, 'utf8');
  return {
    pruned: true,
    cutoff_phase: cutoff,
    keep_recent: keepRecent,
    sections: archiveSections.map((section) => ({
      section: section.section,
      entries_archived: section.lines.length,
    })),
    total_archived: totalArchived,
    archive_file: 'STATE-ARCHIVE.md',
  };
}
const DISCRETION_HEADINGS = new Set(["claude's discretion", 'claudes discretion', 'claude discretion']);
const NON_TRACKABLE_DECISION_TAGS = new Set(['informational', 'folded', 'deferred']);
function stripFencedCodeBlocks(content) {
  return String(content || '')
    .replace(new RegExp('\\x60{3}[\\s\\S]*?\\x60{3}', 'g'), ' ')
    .replace(new RegExp('~~~[\\s\\S]*?~~~', 'g'), ' ');
}
function extractDecisionsBlocks(content) {
  const cleaned = stripFencedCodeBlocks(content);
  const matches = [...cleaned.matchAll(new RegExp('<decisions>([\\s\\S]*?)<\\/decisions>', 'g'))];
  if (matches.length === 0) return null;
  return matches.map((match) => match[1]).join('\n\n');
}
function parseDecisionsContent(content) {
  const block = extractDecisionsBlocks(content);
  if (!block) return [];
  const lines = block.split(/\r?\n/);
  const decisions = [];
  const bulletPattern = /^\s*-\s+\*\*D-(\d+)(?:\s*\[([^\]]+)\])?\s*:\*\*\s*(.*)$/;
  let category = '';
  let inDiscretion = false;
  let current = null;
  const flush = () => {
    if (!current) return;
    current.text = current.text.trim();
    decisions.push(current);
    current = null;
  };
  for (const line of lines) {
    const trimmed = line.trim();
    const headingMatch = trimmed.match(/^###\s+(.+?)\s*$/);
    if (headingMatch) {
      flush();
      category = headingMatch[1];
      const normalizedHeading = category
        .toLowerCase()
        .replace(new RegExp('[\\u2018\\u2019\\u201A\\u201B\\u201C\\u201D\\u201E\\u201F\'"\\x60]', 'g'), '')
        .trim();
      inDiscretion = DISCRETION_HEADINGS.has(normalizedHeading);
      continue;
    }
    const bulletMatch = line.match(bulletPattern);
    if (bulletMatch) {
      flush();
      const tags = bulletMatch[2]
        ? bulletMatch[2].split(',').map((value) => value.trim().toLowerCase()).filter(Boolean)
        : [];
      const trackable = !inDiscretion && !tags.some((tag) => NON_TRACKABLE_DECISION_TAGS.has(tag));
      current = {
        id: 'D-' + bulletMatch[1],
        text: bulletMatch[3],
        category,
        tags,
        trackable,
      };
      continue;
    }
    if (current && trimmed !== '' && !trimmed.startsWith('-') && /^[ \t]/.test(line)) {
      current.text += ' ' + trimmed;
      continue;
    }
    if (trimmed === '') flush();
  }
  flush();
  return decisions;
}
function decisionsParseQuery(args) {
  const filePath = args[0];
  if (!filePath) {
    return { decisions: [], trackable: 0, total: 0, missing: true };
  }
  const fullPath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
  if (!exists(fullPath, 'f')) {
    return { decisions: [], trackable: 0, total: 0, missing: true };
  }
  const decisions = parseDecisionsContent(fs.readFileSync(fullPath, 'utf8'));
  return {
    decisions,
    trackable: decisions.filter((decision) => decision.trackable).length,
    total: decisions.length,
    missing: false,
  };
}
function listPhasesQuery(argv) {
  const phaseSummaries = getPhaseDirectorySummaries();
  const typeIndex = argv.indexOf('--type');
  const type = typeIndex >= 0 ? String(argv[typeIndex + 1] || '').trim() : 'directories';
  const raw = argv.includes('--raw');
  const pickIndex = argv.indexOf('--pick');
  const directories = phaseSummaries.map((phase) => phase.phase_dir);
  const summaries = phaseSummaries.flatMap((phase) => {
    const abs = path.join(cwd, phase.phase_dir);
    try {
      return fs.readdirSync(abs)
        .filter((name) => name === 'SUMMARY.md' || name.endsWith('-SUMMARY.md'))
        .map((name) => path.join(phase.phase_dir, name));
    } catch {
      return [];
    }
  });
  const payload = {
    phases: phaseSummaries,
    directories,
    summaries,
  };
  if (pickIndex >= 0) {
    const pick = String(argv[pickIndex + 1] || '');
    if (pick === 'directories[-1]') return directories.length > 0 ? directories[directories.length - 1] : '';
    if (pick === 'summaries[-1]') return summaries.length > 0 ? summaries[summaries.length - 1] : '';
  }
  if (raw) {
    const target = type === 'summaries' ? summaries : directories;
    return JSON.stringify(target);
  }
  return payload;
}
function currentTimestamp(argv) {
  const mode = String(argv[0] || 'full');
  const iso = new Date().toISOString();
  if (mode === 'date') return iso.slice(0, 10);
  return iso;
}
function docsInitPayload() {
  const cfg = readConfig();
  const existingDocs = [];
  const hasMarker = (content) => /GSD|Tasktronaut/i.test(content);
  const scanDir = (dir) => {
    if (!exists(dir, 'd')) return;
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const rel = path.relative(cwd, full).replace(/\\/g, '/');
      if (exists(full, 'd')) {
        if (name === 'node_modules' || name === '.git' || name === '.planning') continue;
        scanDir(full);
      } else if (name.endsWith('.md')) {
        let marker = false;
        try { marker = hasMarker(fs.readFileSync(full, 'utf8')); } catch {}
        existingDocs.push({ path: rel, has_gsd_marker: marker });
      }
    }
  };
  scanDir(cwd);
  const pkg = safeReadJson(path.join(cwd, 'package.json'), null);
  const projectType = {
    has_package_json: !!pkg,
    has_api_routes: exists(path.join(cwd, 'src', 'api'), 'd') || exists(path.join(cwd, 'api'), 'd') || exists(path.join(cwd, 'routes'), 'd'),
    has_cli_bin: !!(pkg && pkg.bin),
    is_open_source: exists(path.join(cwd, 'LICENSE'), 'f') || exists(path.join(cwd, 'LICENSE.md'), 'f'),
    has_deploy_config: exists(path.join(cwd, 'docker-compose.yml'), 'f') || exists(path.join(cwd, 'Dockerfile'), 'f') || exists(path.join(cwd, '.github', 'workflows'), 'd'),
    is_monorepo: !!(pkg && Array.isArray(pkg.workspaces) && pkg.workspaces.length > 0),
    has_tests: exists(path.join(cwd, 'tests'), 'd') || exists(path.join(cwd, '__tests__'), 'd'),
  };
  return {
    doc_writer_model: getConfiguredAgentModel('gsd-doc-writer', 'claude-sonnet-4-6'),
    commit_docs: cfg.commit_docs !== false,
    existing_docs: existingDocs.sort((a, b) => a.path.localeCompare(b.path)),
    project_type: projectType,
    doc_tooling: {
      docusaurus: exists(path.join(cwd, 'docusaurus.config.js'), 'f') || exists(path.join(cwd, 'docusaurus.config.ts'), 'f'),
      vitepress: exists(path.join(cwd, '.vitepress'), 'd'),
      mkdocs: exists(path.join(cwd, 'mkdocs.yml'), 'f'),
      storybook: exists(path.join(cwd, '.storybook'), 'd'),
    },
    monorepo_workspaces: projectType.is_monorepo && pkg && Array.isArray(pkg.workspaces) ? pkg.workspaces : [],
    project_root: cwd,
  };
}
function validateHealth(argv) {
  const repair = argv.includes('--repair');
  const backfill = argv.includes('--backfill');
  const errors = [];
  const warnings = [];
  const info = [];
  const repairs = [];
  const planningDir = path.join(cwd, '.planning');
  const projectPath = path.join(planningDir, 'PROJECT.md');
  const roadmapPath = path.join(planningDir, 'ROADMAP.md');
  const statePath = path.join(planningDir, 'STATE.md');
  const configPath = path.join(planningDir, 'config.json');
  if (!exists(planningDir, 'd')) {
    errors.push({ code: 'E001', message: '.planning/ directory not found', fix: 'Run /gsd-new-project first', repairable: false });
  }
  if (!exists(projectPath, 'f')) errors.push({ code: 'E002', message: 'PROJECT.md not found', fix: 'Run /gsd-new-project to create', repairable: false });
  if (!exists(roadmapPath, 'f')) errors.push({ code: 'E003', message: 'ROADMAP.md not found', fix: 'Run /gsd-new-project to create', repairable: false });
  if (!exists(statePath, 'f')) {
    if (repair && exists(roadmapPath, 'f')) {
      fs.writeFileSync(statePath, 'current_step: discuss\nlast_activity: ' + new Date().toISOString() + '\n', 'utf8');
      repairs.push('STATE.md regenerated from minimal defaults');
    } else {
      errors.push({ code: 'E004', message: 'STATE.md not found', fix: 'Run /gsd-health --repair to regenerate STATE.md', repairable: true });
    }
  }
  if (!exists(configPath, 'f')) {
    if (repair) {
      ensureConfigSection();
      repairs.push('config.json created with defaults');
    } else {
      warnings.push({ code: 'W003', message: 'config.json not found', fix: 'Run /gsd-health --repair to create defaults' });
    }
  } else {
    try {
      JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
      if (repair) {
        fs.writeFileSync(configPath, JSON.stringify(buildDefaultConfig(), null, 2) + '\n', 'utf8');
        repairs.push('config.json reset to defaults');
      } else {
        errors.push({ code: 'E005', message: 'config.json parse error', fix: 'Run /gsd-health --repair to reset config', repairable: true });
      }
    }
  }
  if (backfill && exists(path.join(planningDir, 'milestones'), 'd')) {
    const milestonesPath = path.join(planningDir, 'MILESTONES.md');
    if (!exists(milestonesPath, 'f')) {
      fs.writeFileSync(milestonesPath, '# Milestones\n', 'utf8');
      repairs.push('MILESTONES.md backfilled');
    }
  }
  const status = errors.length > 0 ? 'broken' : warnings.length > 0 ? 'degraded' : 'healthy';
  return {
    status,
    errors,
    warnings,
    info,
    repairable_count: errors.filter((item) => item.repairable).length + warnings.filter((item) => item.code === 'W003').length,
    repairs_performed: repairs,
  };
}
const PROFILE_DIMENSIONS = [
  {
    dimension: 'communication_style',
    header: 'Communication Style',
    context: 'Think about how you usually frame build or change requests.',
    question: 'When you ask Tasktronaut to build something, how much context do you typically provide?',
    options: [
      { label: 'Minimal request', value: 'a', rating: 'terse-direct' },
      { label: 'Some context', value: 'b', rating: 'conversational' },
      { label: 'Detailed specs and structure', value: 'c', rating: 'detailed-structured' },
      { label: 'It depends on the task', value: 'd', rating: 'mixed' },
    ],
  },
  {
    dimension: 'decision_speed',
    header: 'Decision Making',
    context: 'Think about how you choose between options and trade-offs.',
    question: 'When options are presented, how do you typically decide?',
    options: [
      { label: 'Pick quickly from instinct', value: 'a', rating: 'fast-intuitive' },
      { label: 'Ask for a structured comparison', value: 'b', rating: 'deliberate-informed' },
      { label: 'Research independently first', value: 'c', rating: 'research-first' },
      { label: 'Usually trust the recommendation', value: 'd', rating: 'delegator' },
    ],
  },
  {
    dimension: 'explanation_depth',
    header: 'Explanation Preferences',
    context: 'Think about how much detail feels useful when code is explained.',
    question: 'When something is explained, how much detail do you want?',
    options: [
      { label: 'Just the code', value: 'a', rating: 'code-only' },
      { label: 'Brief explanation', value: 'b', rating: 'concise' },
      { label: 'Detailed walkthrough', value: 'c', rating: 'detailed' },
      { label: 'Teach the underlying concepts', value: 'd', rating: 'educational' },
    ],
  },
  {
    dimension: 'debugging_approach',
    header: 'Debugging Style',
    context: 'Think about how you work through broken behavior with AI help.',
    question: 'When something breaks, how do you typically approach debugging?',
    options: [
      { label: 'Fix it fast', value: 'a', rating: 'fix-first' },
      { label: 'Diagnose root cause first', value: 'b', rating: 'diagnostic' },
      { label: 'Test my hypotheses', value: 'c', rating: 'hypothesis-driven' },
      { label: 'Walk through it collaboratively', value: 'd', rating: 'collaborative' },
    ],
  },
  {
    dimension: 'ux_philosophy',
    header: 'UX Philosophy',
    context: 'Think about how you balance polish and function.',
    question: 'When building user-facing work, what do you prioritize?',
    options: [
      { label: 'Function first', value: 'a', rating: 'function-first' },
      { label: 'Practical usability', value: 'b', rating: 'pragmatic' },
      { label: 'Design quality matters deeply', value: 'c', rating: 'design-conscious' },
      { label: 'Mostly backend or CLI work', value: 'd', rating: 'backend-focused' },
    ],
  },
  {
    dimension: 'vendor_philosophy',
    header: 'Library & Vendor Choices',
    context: 'Think about how you choose tools and services.',
    question: 'When choosing libraries or services, what is your typical approach?',
    options: [
      { label: 'Move fast with the obvious choice', value: 'a', rating: 'pragmatic-fast' },
      { label: 'Prefer battle-tested tools', value: 'b', rating: 'conservative' },
      { label: 'Research and compare thoroughly', value: 'c', rating: 'thorough-evaluator' },
      { label: 'Strong existing preferences', value: 'd', rating: 'opinionated' },
    ],
  },
  {
    dimension: 'frustration_triggers',
    header: 'Frustration Triggers',
    context: 'Think about what annoys you most when working with coding agents.',
    question: 'What frustrates you most when working with AI coding assistants?',
    options: [
      { label: 'Scope creep', value: 'a', rating: 'scope-creep' },
      { label: 'Not following instructions', value: 'b', rating: 'instruction-adherence' },
      { label: 'Too much verbosity', value: 'c', rating: 'verbosity' },
      { label: 'Regressions in working code', value: 'd', rating: 'regression' },
    ],
  },
  {
    dimension: 'learning_style',
    header: 'Learning Preferences',
    context: 'Think about how you prefer to understand unfamiliar code or concepts.',
    question: 'When you encounter something new, how do you prefer to learn it?',
    options: [
      { label: 'Read and explore directly', value: 'a', rating: 'self-directed' },
      { label: 'Ask for guided explanation', value: 'b', rating: 'guided' },
      { label: 'Read docs first', value: 'c', rating: 'documentation-first' },
      { label: 'Start from examples', value: 'd', rating: 'example-driven' },
    ],
  },
];
function getProfileSessionsRoot(argv) {
  const pathIndex = argv.indexOf('--path');
  const overridePath = pathIndex >= 0 ? String(argv[pathIndex + 1] || '').trim() : '';
  const root = overridePath || path.join(os.homedir(), '.tasktronaut', 'projects');
  return exists(root, 'd') ? root : null;
}
function formatBytes(bytes) {
  if (bytes < 1024) return String(bytes) + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(1) + ' GB';
}
function readProfileSessionIndex(projectDirPath) {
  try {
    const indexPath = path.join(projectDirPath, 'sessions-index.json');
    const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    const entries = new Map();
    for (const entry of Array.isArray(parsed.entries) ? parsed.entries : []) {
      if (entry && entry.sessionId) entries.set(entry.sessionId, entry);
    }
    return { originalPath: parsed.originalPath || null, entries };
  } catch {
    return { originalPath: null, entries: new Map() };
  }
}
function getProfileProjectName(projectDirName, indexData) {
  if (indexData.originalPath) return path.basename(indexData.originalPath);
  return projectDirName;
}
function scanProfileProjectDir(projectDirPath) {
  const sessions = [];
  for (const entry of fs.readdirSync(projectDirPath)) {
    if (!entry.endsWith('.jsonl')) continue;
    const filePath = path.join(projectDirPath, entry);
    try {
      const stat = fs.statSync(filePath);
      sessions.push({
        sessionId: entry.replace(/\.jsonl$/i, ''),
        filePath,
        size: stat.size,
        modified: stat.mtime,
      });
    } catch {}
  }
  sessions.sort((left, right) => right.modified.getTime() - left.modified.getTime());
  return sessions;
}
function buildScanSessionsPayload(argv) {
  const root = getProfileSessionsRoot(argv);
  if (!root) return [];
  const verbose = argv.includes('--verbose');
  const projects = [];
  for (const dirName of fs.readdirSync(root)) {
    const projectPath = path.join(root, dirName);
    if (!exists(projectPath, 'd')) continue;
    const sessions = scanProfileProjectDir(projectPath);
    if (sessions.length === 0) continue;
    const indexData = readProfileSessionIndex(projectPath);
    const projectName = getProfileProjectName(dirName, indexData);
    const totalSize = sessions.reduce((sum, session) => sum + session.size, 0);
    const payload = {
      name: projectName,
      directory: dirName,
      sessionCount: sessions.length,
      totalSize,
      totalSizeHuman: formatBytes(totalSize),
      lastActive: sessions[0].modified.toISOString().replace('T', ' ').substring(0, 19),
      dateRange: {
        first: sessions[sessions.length - 1].modified.toISOString(),
        last: sessions[0].modified.toISOString(),
      },
    };
    if (verbose) {
      payload.sessions = sessions.map((session) => {
        const indexed = indexData.entries.get(session.sessionId) || {};
        return {
          sessionId: session.sessionId,
          size: session.size,
          sizeHuman: formatBytes(session.size),
          modified: session.modified.toISOString(),
          summary: indexed.summary,
          messageCount: indexed.messageCount,
          created: indexed.created,
        };
      });
    }
    projects.push(payload);
  }
  projects.sort((left, right) => String(right.dateRange.last).localeCompare(String(left.dateRange.last)));
  return projects;
}
function isGenuineProfileMessage(record) {
  if (!record || record.type !== 'user') return false;
  if (record.userType !== 'external') return false;
  if (record.isMeta === true || record.isSidechain === true) return false;
  const content = record.message && typeof record.message.content === 'string' ? record.message.content : '';
  if (!content) return false;
  if (content.startsWith('<local-command')) return false;
  if (content.startsWith('<command-')) return false;
  if (content.startsWith('<task-notification')) return false;
  if (content.startsWith('<local-command-stdout')) return false;
  return true;
}
function truncateProfileContent(content, maxLen) {
  if (String(content).length <= maxLen) return String(content);
  return String(content).slice(0, maxLen) + '... [truncated]';
}
function readSessionMessages(filePath, maxMessages, maxChars) {
  const messages = [];
  let skippedContextDumps = 0;
  let raw = '';
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { messages, skippedContextDumps };
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim() || messages.length >= maxMessages) continue;
    let record = null;
    try { record = JSON.parse(line); } catch { continue; }
    if (!isGenuineProfileMessage(record)) continue;
    const content = String(record.message && record.message.content ? record.message.content : '');
    if (content.startsWith('This session is being continued')) {
      skippedContextDumps += 1;
      continue;
    }
    const lines = content.split('\n').filter((entry) => entry.trim().length > 0);
    if (lines.length > 3) {
      const logLines = lines.filter((entry) => /^(?:\[?(?:DEBUG|INFO|WARN|ERROR|LOG)\]?|\d{4}-\d{2}-\d{2})/i.test(entry.trim()));
      if (logLines.length / lines.length > 0.8) {
        skippedContextDumps += 1;
        continue;
      }
    }
    messages.push({
      sessionId: path.basename(filePath, '.jsonl'),
      projectPath: record.cwd || null,
      timestamp: record.timestamp || null,
      content: truncateProfileContent(content, maxChars),
    });
  }
  return { messages, skippedContextDumps };
}
function profileSample(argv) {
  const root = getProfileSessionsRoot(argv);
  if (!root) return { error: 'No Tasktronaut sessions found', searched: path.join(os.homedir(), '.tasktronaut', 'projects') };
  const limitIndex = argv.indexOf('--limit');
  const maxPerIndex = argv.indexOf('--max-per-project');
  const maxCharsIndex = argv.indexOf('--max-chars');
  const limit = limitIndex >= 0 ? parseInt(argv[limitIndex + 1], 10) || 150 : 150;
  const maxPerProject = maxPerIndex >= 0 ? parseInt(argv[maxPerIndex + 1], 10) || null : null;
  const maxChars = maxCharsIndex >= 0 ? parseInt(argv[maxCharsIndex + 1], 10) || 500 : 500;
  const projects = buildScanSessionsPayload(['scan-sessions', '--path', root]);
  if (projects.length === 0) return { error: 'No projects with sessions found', projects_sampled: 0, messages_sampled: 0 };
  const perProjectCap = maxPerProject || Math.max(5, Math.floor(limit / projects.length));
  const recentThreshold = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const allMessages = [];
  const projectBreakdown = [];
  let skippedContextDumps = 0;
  for (const project of projects) {
    if (allMessages.length >= limit) break;
    const projectPath = path.join(root, project.directory);
    const sessions = scanProfileProjectDir(projectPath).slice(0, perProjectCap);
    let projectMessages = 0;
    let sessionsUsed = 0;
    for (const session of sessions) {
      if (allMessages.length >= limit) break;
      const isRecent = session.modified.getTime() >= recentThreshold;
      const perSessionMax = isRecent ? 10 : 3;
      const remaining = Math.min(perSessionMax, limit - allMessages.length);
      const extracted = readSessionMessages(session.filePath, remaining, maxChars);
      skippedContextDumps += extracted.skippedContextDumps;
      if (extracted.messages.length > 0) sessionsUsed += 1;
      for (const message of extracted.messages) {
        allMessages.push({
          sessionId: message.sessionId,
          projectName: project.name,
          projectPath: message.projectPath,
          timestamp: message.timestamp,
          content: message.content,
        });
        projectMessages += 1;
      }
    }
    if (projectMessages > 0) {
      projectBreakdown.push({ project: project.name, messages: projectMessages, sessions: sessionsUsed });
    }
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasktronaut-profile-'));
  const outputPath = path.join(tmpDir, 'profile-sample.jsonl');
  for (const message of allMessages) {
    fs.appendFileSync(outputPath, JSON.stringify(message) + '\n');
  }
  return {
    output_file: outputPath,
    projects_sampled: projectBreakdown.length,
    messages_sampled: allMessages.length,
    per_project_cap: perProjectCap,
    message_char_limit: maxChars,
    skipped_context_dumps: skippedContextDumps,
    project_breakdown: projectBreakdown,
  };
}
function extractMessages(argv) {
  const pathIndex = argv.indexOf('--path');
  const overridePath = pathIndex >= 0 ? String(argv[pathIndex + 1] || '').trim() : '';
  const sessionIndex = argv.indexOf('--session') >= 0 ? argv.indexOf('--session') : argv.indexOf('--session-id');
  const sessionId = sessionIndex >= 0 ? String(argv[sessionIndex + 1] || '').trim() : '';
  const limitIndex = argv.indexOf('--limit');
  const limit = limitIndex >= 0 ? parseInt(String(argv[limitIndex + 1] || ''), 10) || null : null;
  const projectArg = String(argv[0] || '').trim();
  if (!projectArg || projectArg.startsWith('--')) {
    return {
      error: 'Usage: gsd-tools extract-messages <project> [--session <id>] [--limit N] [--path <dir>]',
      classification: 'validation',
    };
  }
  const root = getProfileSessionsRoot(overridePath ? ['--path', overridePath] : []);
  if (!root) {
    return {
      error: 'No Tasktronaut sessions found',
      searched: overridePath || path.join(os.homedir(), '.tasktronaut', 'projects'),
      classification: 'validation',
    };
  }
  const projectDirs = fs.readdirSync(root).filter((entry) => exists(path.join(root, entry), 'd'));
  let matchedDir = projectDirs.find((entry) => entry === projectArg) || null;
  let matchedName = null;
  if (!matchedDir) {
    const lowerArg = projectArg.toLowerCase();
    const matches = projectDirs.filter((entry) => entry.toLowerCase().includes(lowerArg));
    if (matches.length === 1) {
      matchedDir = matches[0];
    } else if (matches.length > 1) {
      const exactNameMatches = [];
      for (const dirName of matches) {
        const indexData = readProfileSessionIndex(path.join(root, dirName));
        const projectName = getProfileProjectName(dirName, indexData);
        if (projectName.toLowerCase() === lowerArg) exactNameMatches.push({ dirName, projectName });
      }
      if (exactNameMatches.length === 1) {
        matchedDir = exactNameMatches[0].dirName;
        matchedName = exactNameMatches[0].projectName;
      } else {
        return {
          error: 'Multiple projects match "' + projectArg + '"',
          matches: matches.map((dirName) => {
            const indexData = readProfileSessionIndex(path.join(root, dirName));
            return { name: getProfileProjectName(dirName, indexData), directory: dirName };
          }),
          classification: 'validation',
        };
      }
    }
  }
  if (!matchedDir) {
    return {
      error: 'No project matching "' + projectArg + '"',
      available_projects: projectDirs.map((dirName) => {
        const indexData = readProfileSessionIndex(path.join(root, dirName));
        return getProfileProjectName(dirName, indexData);
      }),
      classification: 'validation',
    };
  }
  const projectPath = path.join(root, matchedDir);
  const indexData = readProfileSessionIndex(projectPath);
  const projectName = matchedName || getProfileProjectName(matchedDir, indexData);
  let sessions = scanProfileProjectDir(projectPath);
  if (sessionId) {
    sessions = sessions.filter((session) => session.sessionId === sessionId);
    if (sessions.length === 0) {
      return {
        error: 'Session "' + sessionId + '" not found in project "' + projectName + '"',
        classification: 'validation',
      };
    }
  }
  if (limit != null && limit > 0) sessions = sessions.slice(0, limit);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-pipeline-'));
  const outputPath = path.join(tmpDir, 'extracted-messages.jsonl');
  fs.writeFileSync(outputPath, '', 'utf8');
  let sessionsProcessed = 0;
  let sessionsSkipped = 0;
  let messagesExtracted = 0;
  let messagesTruncated = 0;
  const batchLimit = 300;
  for (const session of sessions) {
    if (messagesExtracted >= batchLimit) break;
    try {
      const remaining = batchLimit - messagesExtracted;
      const raw = fs.readFileSync(session.filePath, 'utf8');
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim() || messagesExtracted >= batchLimit || remaining <= 0) continue;
        let record = null;
        try { record = JSON.parse(line); } catch { continue; }
        if (!isGenuineProfileMessage(record)) continue;
        const content = String(record.message && record.message.content ? record.message.content : '');
        const truncated = truncateProfileContent(content, 2000);
        fs.appendFileSync(outputPath, JSON.stringify({
          sessionId: session.sessionId,
          projectPath: record.cwd || null,
          timestamp: record.timestamp || null,
          content: truncated,
        }) + '\n');
        messagesExtracted += 1;
        if (truncated.endsWith('... [truncated]')) messagesTruncated += 1;
        if (messagesExtracted >= batchLimit) break;
      }
      sessionsProcessed += 1;
    } catch {
      sessionsSkipped += 1;
    }
  }
  return {
    output_file: outputPath,
    project: projectName,
    sessions_processed: sessionsProcessed,
    sessions_skipped: sessionsSkipped,
    messages_extracted: messagesExtracted,
    messages_truncated: messagesTruncated,
  };
}
function genericProfileInstruction(dimension, rating) {
  return 'Adapt to this developer\'s ' + String(dimension).replace(/_/g, ' ') + ' preference: ' + rating + '.';
}
function buildQuestionnaireAnalysis(answerValues) {
  const dimensions = {};
  for (let index = 0; index < PROFILE_DIMENSIONS.length; index++) {
    const question = PROFILE_DIMENSIONS[index];
    const answerValue = answerValues[index];
    const selectedOption = question.options.find((option) => option.value === answerValue);
    if (!selectedOption) {
      return { error: 'Invalid answer "' + answerValue + '" for ' + question.dimension };
    }
    const ambiguous = selectedOption.rating === 'mixed';
    dimensions[question.dimension] = {
      rating: selectedOption.rating,
      confidence: ambiguous ? 'LOW' : 'MEDIUM',
      evidence_count: 1,
      cross_project_consistent: null,
      evidence: [
        {
          signal: 'Self-reported via questionnaire',
          quote: selectedOption.label,
          project: 'N/A (questionnaire)',
        },
      ],
      summary: 'Developer self-reported as ' + selectedOption.rating + ' for ' + question.header.toLowerCase() + '.',
      claude_instruction: genericProfileInstruction(question.dimension, selectedOption.rating),
    };
  }
  return {
    profile_version: '1.0',
    analyzed_at: new Date().toISOString(),
    data_source: 'questionnaire',
    projects_analyzed: [],
    messages_analyzed: 0,
    message_threshold: 'questionnaire',
    sensitive_excluded: [],
    dimensions,
  };
}
function parseProfileAnswersArg(rawValue) {
  if (!rawValue) return null;
  const candidate = String(rawValue).trim();
  let parsed = null;
  if (exists(candidate, 'f')) {
    try { parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')); } catch { return null; }
  } else if (candidate.startsWith('{') || candidate.startsWith('[')) {
    try { parsed = JSON.parse(candidate); } catch { return null; }
  } else {
    return candidate.split(',').map((item) => item.trim()).filter(Boolean);
  }
  if (Array.isArray(parsed)) return parsed.map((item) => String(item).trim());
  if (parsed && typeof parsed === 'object') {
    return PROFILE_DIMENSIONS.map((question) => String(parsed[question.dimension] || '').trim()).filter((value) => value.length > 0 || true);
  }
  return null;
}
function profileQuestionnaire(argv) {
  const answersIndex = argv.indexOf('--answers');
  const answersValue = answersIndex >= 0 ? argv[answersIndex + 1] : '';
  if (!answersValue) {
    return {
      mode: 'interactive',
      questions: PROFILE_DIMENSIONS.map((question) => ({
        dimension: question.dimension,
        header: question.header,
        context: question.context,
        question: question.question,
        options: question.options.map((option) => ({ label: option.label, value: option.value })),
      })),
    };
  }
  const answerValues = parseProfileAnswersArg(answersValue);
  if (!answerValues || answerValues.length !== PROFILE_DIMENSIONS.length) {
    return { error: 'Expected ' + PROFILE_DIMENSIONS.length + ' answers' };
  }
  return buildQuestionnaireAnalysis(answerValues);
}
function readProfileAnalysisInput(inputPathArg) {
  if (!inputPathArg) return { error: '--input or --analysis is required' };
  const inputPath = path.isAbsolute(inputPathArg) ? inputPathArg : path.join(cwd, inputPathArg);
  if (!exists(inputPath, 'f')) return { error: 'Analysis file not found: ' + inputPath };
  try {
    const analysis = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    if (!analysis || typeof analysis !== 'object' || !analysis.dimensions || typeof analysis.dimensions !== 'object') {
      return { error: 'Analysis JSON must contain a dimensions object' };
    }
    return { analysis, inputPath };
  } catch (error) {
    return { error: 'Failed to parse analysis JSON: ' + String(error && error.message ? error.message : error) };
  }
}
function getProfileHomeDir() {
  return path.join(os.homedir(), '.tasktronaut', 'gsd');
}
function getLearningsStoreDir() {
  return path.join(getProfileHomeDir(), 'knowledge');
}
function getProfileCommandDir() {
  return path.join(os.homedir(), '.tasktronaut', 'commands', 'gsd');
}
function getGlobalTasktronautProfilePath() {
  return path.join(os.homedir(), '.tasktronaut', 'TASKTRONAUT.md');
}
function renderProfileMarkdown(analysis) {
  const dims = analysis.dimensions || {};
  const rows = [
    '# Developer Profile',
    '',
    '> Generated by Tasktronaut GSD profiling.',
    '',
    '| Dimension | Rating | Confidence |',
    '|-----------|--------|------------|',
  ];
  const highlights = [];
  for (const question of PROFILE_DIMENSIONS) {
    const dim = dims[question.dimension];
    if (!dim) continue;
    rows.push('| ' + question.header + ' | ' + String(dim.rating || 'UNSCORED') + ' | ' + String(dim.confidence || 'UNSCORED') + ' |');
    if (highlights.length < 4 && dim.summary) {
      highlights.push('- **' + question.header + ' (' + String(dim.confidence || 'UNSCORED') + '):** ' + String(dim.summary));
    }
  }
  rows.push('');
  rows.push('## Highlights');
  rows.push('');
  if (highlights.length > 0) rows.push(...highlights);
  else rows.push('- Profile generated with limited highlight data.');
  return rows.join('\n') + '\n';
}
function countProfileConfidence(analysis) {
  const dims = analysis.dimensions || {};
  let high = 0;
  let medium = 0;
  let low = 0;
  let total = 0;
  for (const value of Object.values(dims)) {
    total += 1;
    const confidence = String(value && value.confidence ? value.confidence : '').toUpperCase();
    if (confidence === 'HIGH') high += 1;
    else if (confidence === 'MEDIUM') medium += 1;
    else low += 1;
  }
  return { total, high, medium, low };
}
function writeProfile(argv) {
  const inputIndex = argv.indexOf('--input');
  const outputIndex = argv.indexOf('--output');
  const loaded = readProfileAnalysisInput(inputIndex >= 0 ? argv[inputIndex + 1] : '');
  if (loaded.error) return loaded;
  const outputPath = outputIndex >= 0
    ? (path.isAbsolute(argv[outputIndex + 1]) ? argv[outputIndex + 1] : path.join(cwd, argv[outputIndex + 1]))
    : path.join(getProfileHomeDir(), 'USER-PROFILE.md');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, renderProfileMarkdown(loaded.analysis), 'utf8');
  const counts = countProfileConfidence(loaded.analysis);
  return {
    profile_path: outputPath,
    dimensions_scored: counts.total,
    high_confidence: counts.high,
    medium_confidence: counts.medium,
    low_confidence: counts.low,
    sensitive_redacted: 0,
    source: String(loaded.analysis.data_source || 'session_analysis'),
  };
}
function generateDevPreferences(argv) {
  const analysisIndex = argv.indexOf('--analysis');
  const outputIndex = argv.indexOf('--output');
  const loaded = readProfileAnalysisInput(analysisIndex >= 0 ? argv[analysisIndex + 1] : '');
  if (loaded.error) return loaded;
  const outputPath = outputIndex >= 0
    ? (path.isAbsolute(argv[outputIndex + 1]) ? argv[outputIndex + 1] : path.join(cwd, argv[outputIndex + 1]))
    : path.join(getProfileCommandDir(), 'dev-preferences.md');
  const lines = [
    '# /gsd-dev-preferences',
    '',
    '> Generated by Tasktronaut profiling.',
    '',
  ];
  for (const question of PROFILE_DIMENSIONS) {
    const dim = loaded.analysis.dimensions && loaded.analysis.dimensions[question.dimension];
    if (!dim) continue;
    lines.push('## ' + question.header);
    lines.push('');
    lines.push(String(dim.claude_instruction || genericProfileInstruction(question.dimension, dim.rating || 'default')));
    lines.push('');
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, lines.join('\n'), 'utf8');
  return {
    command_path: outputPath,
    command_name: '/gsd-dev-preferences',
    dimensions_included: PROFILE_DIMENSIONS.map((question) => question.dimension),
    source: String(loaded.analysis.data_source || 'session_analysis'),
  };
}
function generateTasktronautProfile(argv) {
  const analysisIndex = argv.indexOf('--analysis');
  const outputIndex = argv.indexOf('--output');
  const globalFlag = argv.includes('--global');
  const loaded = readProfileAnalysisInput(analysisIndex >= 0 ? argv[analysisIndex + 1] : '');
  if (loaded.error) return loaded;
  const outputPath = globalFlag
    ? getGlobalTasktronautProfilePath()
    : outputIndex >= 0
      ? (path.isAbsolute(argv[outputIndex + 1]) ? argv[outputIndex + 1] : path.join(cwd, argv[outputIndex + 1]))
      : path.join(cwd, 'TASKTRONAUT.md');
  const sectionLines = [
    '<!-- GSD:profile-start -->',
    '## Developer Profile',
    '',
    '> Generated by Tasktronaut from ' + String(loaded.analysis.data_source || 'session_analysis') + '.',
    '',
    '| Dimension | Rating | Confidence |',
    '|-----------|--------|------------|',
  ];
  for (const question of PROFILE_DIMENSIONS) {
    const dim = loaded.analysis.dimensions && loaded.analysis.dimensions[question.dimension];
    if (!dim) continue;
    sectionLines.push('| ' + question.header + ' | ' + String(dim.rating || 'UNSCORED') + ' | ' + String(dim.confidence || 'UNSCORED') + ' |');
  }
  sectionLines.push('', '**Directives:**');
  for (const question of PROFILE_DIMENSIONS) {
    const dim = loaded.analysis.dimensions && loaded.analysis.dimensions[question.dimension];
    if (!dim) continue;
    sectionLines.push('- **' + question.header + ':** ' + String(dim.claude_instruction || genericProfileInstruction(question.dimension, dim.rating || 'default')));
  }
  sectionLines.push('<!-- GSD:profile-end -->');
  const section = sectionLines.join('\n');
  let action = 'created';
  if (exists(outputPath, 'f')) {
    const existing = fs.readFileSync(outputPath, 'utf8');
    const startMarker = '<!-- GSD:profile-start -->';
    const endMarker = '<!-- GSD:profile-end -->';
    const startIndex = existing.indexOf(startMarker);
    const endIndex = existing.indexOf(endMarker);
    let updated = '';
    if (startIndex >= 0 && endIndex >= 0) {
      updated = existing.slice(0, startIndex) + section + existing.slice(endIndex + endMarker.length);
      action = 'updated';
    } else {
      updated = existing.trimEnd() + '\n\n' + section + '\n';
      action = 'appended';
    }
    fs.writeFileSync(outputPath, updated, 'utf8');
  } else {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, section + '\n', 'utf8');
  }
  return {
    tasktronaut_md_path: outputPath,
    action,
    dimensions_included: PROFILE_DIMENSIONS.map((question) => question.dimension),
    is_global: globalFlag,
  };
}
function ensureLearningsStoreDir() {
  const dir = getLearningsStoreDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function readLearningRecord(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}
function listLearningsRecords() {
  const dir = getLearningsStoreDir();
  if (!exists(dir, 'd')) return [];
  const records = [];
  for (const file of fs.readdirSync(dir).filter((entry) => entry.endsWith('.json'))) {
    const record = readLearningRecord(path.join(dir, file));
    if (record) records.push(record);
  }
  records.sort((a, b) => new Date(String(b.date || 0)).getTime() - new Date(String(a.date || 0)).getTime());
  return records;
}
function createLearningId() {
  return Date.now().toString(36) + '-' + createHash('sha256')
    .update(String(process.pid) + ':' + String(Math.random()) + ':' + String(Date.now()))
    .digest('hex')
    .slice(0, 8);
}
function writeLearningRecord(entry) {
  const dir = ensureLearningsStoreDir();
  const normalizedLearning = String(entry.learning || '').trim();
  const sourceProject = String(entry.source_project || path.basename(cwd));
  const contentHash = createHash('sha256')
    .update(normalizedLearning + '\n' + sourceProject)
    .digest('hex');
  for (const record of listLearningsRecords()) {
    if (record && record.content_hash === contentHash) {
      return { created: false, id: String(record.id || '') };
    }
  }
  const id = createLearningId();
  const record = {
    id,
    source_project: sourceProject,
    date: new Date().toISOString(),
    context: String(entry.context || ''),
    learning: normalizedLearning,
    tags: Array.isArray(entry.tags) ? entry.tags : [],
    content_hash: contentHash,
  };
  fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(record, null, 2), 'utf8');
  return { created: true, id };
}
function learningsCopy() {
  const learningsPath = path.join(cwd, '.planning', 'LEARNINGS.md');
  if (!exists(learningsPath, 'f')) {
    return { copied: false, total: 0, created: 0, skipped: 0, reason: 'No LEARNINGS.md found' };
  }
  const content = fs.readFileSync(learningsPath, 'utf8');
  const sections = content.split(/^## /m).slice(1);
  let created = 0;
  let skipped = 0;
  for (const section of sections) {
    const lines = section.trim().split('\n');
    const title = (lines[0] || '').trim();
    const body = lines.slice(1).join('\n').trim();
    if (!body) continue;
    const tags = title.toLowerCase().split(/\s+/).filter((word) => word.length > 2);
    const result = writeLearningRecord({
      source_project: path.basename(cwd),
      learning: body,
      context: title,
      tags,
    });
    if (result.created) created++;
    else skipped++;
  }
  return { copied: true, total: created + skipped, created, skipped, store_dir: getLearningsStoreDir() };
}
function learningsList() {
  const learnings = listLearningsRecords();
  return { learnings, count: learnings.length, store_dir: getLearningsStoreDir() };
}
function learningsQuery(argv) {
  const tagIndex = argv.indexOf('--tag');
  const tag = tagIndex >= 0 ? argv[tagIndex + 1] : null;
  const limitIndex = argv.indexOf('--limit');
  const limitValue = limitIndex >= 0 ? Number.parseInt(argv[limitIndex + 1] || '', 10) : null;
  let learnings = listLearningsRecords();
  if (tag) {
    learnings = learnings.filter((record) => Array.isArray(record.tags) && record.tags.includes(tag));
  }
  if (limitValue && Number.isFinite(limitValue) && limitValue > 0) {
    learnings = learnings.slice(0, limitValue);
  }
  return { learnings, count: learnings.length, tag: tag || null, store_dir: getLearningsStoreDir() };
}
function parseLearningsOlderThan(value) {
  const match = /^(\d+)d$/.exec(String(value || '').trim());
  if (!match) return null;
  const days = Number.parseInt(match[1], 10);
  if (!Number.isFinite(days) || days < 0) return null;
  return days;
}
function learningsPrune(argv) {
  const olderThanIndex = argv.indexOf('--older-than');
  const olderThan = olderThanIndex >= 0 ? argv[olderThanIndex + 1] : '';
  const days = parseLearningsOlderThan(olderThan);
  if (days === null) {
    return { error: 'Usage: learnings.prune --older-than <duration like 90d>' };
  }
  const dir = getLearningsStoreDir();
  if (!exists(dir, 'd')) return { removed: 0, kept: 0, store_dir: dir };
  const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
  let removed = 0;
  let kept = 0;
  for (const file of fs.readdirSync(dir).filter((entry) => entry.endsWith('.json'))) {
    const filePath = path.join(dir, file);
    const record = readLearningRecord(filePath);
    if (!record || !record.date) continue;
    const recordTime = new Date(String(record.date)).getTime();
    if (Number.isFinite(recordTime) && recordTime < cutoff) {
      fs.unlinkSync(filePath);
      removed++;
    } else {
      kept++;
    }
  }
  return { removed, kept, store_dir: dir };
}
function learningsDelete(argv) {
  const id = String(argv[0] || '').trim();
  if (!id) {
    return { error: 'Usage: learnings.delete <id>' };
  }
  if (!/^[a-z0-9]+-[a-f0-9]+$/.test(id)) {
    return { error: 'Invalid learning ID: "' + id + '"' };
  }
  const dir = getLearningsStoreDir();
  const filePath = path.join(dir, id + '.json');
  if (!exists(filePath, 'f')) {
    return { id, deleted: false, store_dir: dir };
  }
  fs.unlinkSync(filePath);
  return { id, deleted: true, store_dir: dir };
}
function readRoadmapContent() {
  const roadmapPath = path.join(cwd, '.planning', 'ROADMAP.md');
  if (!exists(roadmapPath, 'f')) return null;
  return fs.readFileSync(roadmapPath, 'utf8');
}
function writeRoadmapContent(content) {
  const roadmapPath = path.join(cwd, '.planning', 'ROADMAP.md');
  fs.writeFileSync(roadmapPath, content, 'utf8');
  return roadmapPath;
}
function getRoadmapPhaseHeaders(content) {
  const phasePattern = /^(#{2,4})\s*Phase\s+(\d+(?:\.\d+)*)\s*:\s*([^\n]+)$/gim;
  const matches = [...String(content || '').matchAll(phasePattern)];
  return matches.map((match, index) => ({
    level: match[1],
    number: match[2],
    name: String(match[3] || '').trim(),
    index: match.index || 0,
    nextIndex: index + 1 < matches.length ? (matches[index + 1].index || String(content || '').length) : String(content || '').length,
  }));
}
function comparePhaseNumbers(left, right) {
  const leftParts = String(left || '').split('.').map((part) => parseInt(part, 10) || 0);
  const rightParts = String(right || '').split('.').map((part) => parseInt(part, 10) || 0);
  const maxLen = Math.max(leftParts.length, rightParts.length);
  for (let i = 0; i < maxLen; i++) {
    const diff = (leftParts[i] || 0) - (rightParts[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
function padPhaseIdentifier(rawPhase) {
  const value = String(rawPhase || '').trim();
  if (!value) return '';
  if (value.includes('.')) {
    const parts = value.split('.');
    const major = String(parseInt(parts[0], 10) || 0).padStart(2, '0');
    return [major, ...parts.slice(1)].join('.');
  }
  const numeric = parseInt(value, 10);
  if (String(numeric) === value) return String(numeric).padStart(2, '0');
  return value;
}
function getHighestIntegerPhase(content) {
  const headers = getRoadmapPhaseHeaders(content);
  let highest = 0;
  for (const header of headers) {
    if (/^\d+$/.test(header.number)) highest = Math.max(highest, parseInt(header.number, 10) || 0);
  }
  return highest;
}
function getNextInsertedPhaseNumber(content, afterPhase) {
  const base = parseInt(String(afterPhase || '').trim(), 10);
  if (!Number.isFinite(base) || base < 1) return '';
  const headers = getRoadmapPhaseHeaders(content);
  let highestDecimal = 0;
  for (const header of headers) {
    const match = String(header.number).match(/^(\d+)\.(\d+)$/);
    if (!match) continue;
    if ((parseInt(match[1], 10) || 0) !== base) continue;
    highestDecimal = Math.max(highestDecimal, parseInt(match[2], 10) || 0);
  }
  return String(base) + '.' + String(highestDecimal + 1);
}
function formatRoadmapPhaseBlock(phaseNumber, phaseName, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const marker = opts.inserted ? ' (INSERTED)' : '';
  return [
    '### Phase ' + phaseNumber + ': ' + phaseName + marker,
    '',
    '**Goal:** TBD',
    '**Depends on:** ' + (opts.dependsOn || 'TBD'),
    '**Plans:**',
    '- [ ] ' + phaseNumber + '-01-PLAN.md',
    '',
  ].join('\n');
}
function ensurePhaseDirectory(phaseNumber, slug) {
  const padded = padPhaseIdentifier(phaseNumber);
  const entry = padded + '-' + slug;
  const phaseDir = path.join(cwd, '.planning', 'phases', entry);
  fs.mkdirSync(phaseDir, { recursive: true });
  return {
    absolute: phaseDir,
    relative: path.join('.planning', 'phases', entry),
    padded,
  };
}
function addPhaseToRoadmap(content, block) {
  const roadmap = String(content || '');
  const backlogIndex = roadmap.search(/^##\s+Backlog\b/im);
  if (backlogIndex >= 0) {
    const prefix = roadmap.slice(0, backlogIndex).replace(/\s*$/, '\n\n');
    const suffix = roadmap.slice(backlogIndex).replace(/^\s*/, '');
    return prefix + block + '\n' + suffix;
  }
  return roadmap.replace(/\s*$/, '\n\n') + block + '\n';
}
function insertPhaseIntoRoadmap(content, afterPhase, block) {
  const roadmap = String(content || '');
  const headers = getRoadmapPhaseHeaders(roadmap);
  const target = headers.find((header) => comparePhaseNumbers(header.number, afterPhase) === 0);
  if (!target) return { updated: false, reason: 'target phase not found' };
  const before = roadmap.slice(0, target.nextIndex).replace(/\s*$/, '\n\n');
  const after = roadmap.slice(target.nextIndex).replace(/^\s*/, '');
  return { updated: true, content: before + block + '\n' + after };
}
function phaseAdd(description) {
  const phaseName = String(description || '').trim();
  if (!phaseName) return { error: 'phase description required' };
  const roadmapContent = readRoadmapContent();
  if (roadmapContent == null) return { error: 'ROADMAP.md not found' };
  const nextPhase = getHighestIntegerPhase(roadmapContent) + 1;
  const phaseNumber = String(nextPhase);
  const slug = slugify(phaseName) || ('phase-' + phaseNumber);
  const dirInfo = ensurePhaseDirectory(phaseNumber, slug);
  const block = formatRoadmapPhaseBlock(phaseNumber, phaseName, { dependsOn: nextPhase > 1 ? 'Phase ' + String(nextPhase - 1) : 'TBD' });
  writeRoadmapContent(addPhaseToRoadmap(roadmapContent, block));
  const stateUpdated = syncStatePhaseCountToRoadmap();
  return {
    added: true,
    phase_number: phaseNumber,
    padded: dirInfo.padded,
    name: phaseName,
    slug,
    directory: dirInfo.relative,
    roadmap_updated: true,
    state_updated: stateUpdated,
  };
}
function phaseInsert(afterPhase, description) {
  const phaseName = String(description || '').trim();
  const afterValue = String(afterPhase || '').trim();
  if (!/^\d+$/.test(afterValue)) return { error: 'integer phase number required for insertion' };
  if (!phaseName) return { error: 'phase description required' };
  const roadmapContent = readRoadmapContent();
  if (roadmapContent == null) return { error: 'ROADMAP.md not found' };
  const headers = getRoadmapPhaseHeaders(roadmapContent);
  if (!headers.some((header) => comparePhaseNumbers(header.number, afterValue) === 0)) {
    return { error: 'target phase not found', after_phase: afterValue };
  }
  const phaseNumber = getNextInsertedPhaseNumber(roadmapContent, afterValue);
  if (!phaseNumber) return { error: 'could not calculate inserted phase number', after_phase: afterValue };
  const slug = slugify(phaseName) || ('phase-' + phaseNumber.replace(/\./g, '-'));
  const dirInfo = ensurePhaseDirectory(phaseNumber, slug);
  const block = formatRoadmapPhaseBlock(phaseNumber, phaseName, {
    inserted: true,
    dependsOn: 'Phase ' + afterValue,
  });
  const inserted = insertPhaseIntoRoadmap(roadmapContent, afterValue, block);
  if (!inserted.updated) return inserted;
  writeRoadmapContent(inserted.content);
  const stateUpdated = syncStatePhaseCountToRoadmap();
  return {
    inserted: true,
    phase_number: phaseNumber,
    after_phase: afterValue,
    name: phaseName,
    slug,
    directory: dirInfo.relative,
    roadmap_updated: true,
    state_updated: stateUpdated,
  };
}
function phaseAddBatch(argv) {
  let descriptions = [];
  const descriptionsIndex = argv.indexOf('--descriptions');
  if (descriptionsIndex !== -1 && argv[descriptionsIndex + 1] !== undefined) {
    try {
      const parsed = JSON.parse(String(argv[descriptionsIndex + 1] || '[]'));
      if (!Array.isArray(parsed)) return { error: '--descriptions must be a JSON array' };
      descriptions = parsed.map((value) => String(value || '').trim()).filter(Boolean);
    } catch {
      return { error: '--descriptions must be a valid JSON array' };
    }
  } else {
    descriptions = argv.filter((arg) => arg !== '--raw').map((arg) => String(arg || '').trim()).filter(Boolean);
  }
  if (descriptions.length === 0) return { error: 'descriptions array required for phase add-batch' };
  const phases = [];
  for (const description of descriptions) {
    const result = phaseAdd(description);
    if (result && result.error) return result;
    phases.push(result);
  }
  return { phases, count: phases.length };
}
function phaseListArtifacts(argv) {
  const phase = String(argv[0] || '').trim();
  if (!phase) return { error: 'phase required' };
  const typeIdx = argv.indexOf('--type');
  const artifactType = typeIdx >= 0 ? String(argv[typeIdx + 1] || '').trim().toLowerCase() : '';
  if (!artifactType) return { error: '--type context|summary|verification|research required' };
  if (!['context', 'summary', 'verification', 'research'].includes(artifactType)) {
    return { error: 'invalid --type ' + artifactType };
  }
  const phaseInfo = findPhaseDirectory(phase);
  if (!phaseInfo.found) {
    return { phase: normalizePhaseNumber(phase), type: artifactType, artifacts: [], error: 'Phase not found' };
  }
  const phaseDirAbs = path.join(cwd, phaseInfo.phaseDir);
  const files = fs.readdirSync(phaseDirAbs).filter((name) => {
    if (artifactType === 'context') return name.endsWith('-CONTEXT.md') || name === 'CONTEXT.md';
    if (artifactType === 'summary') return name.endsWith('-SUMMARY.md') || name === 'SUMMARY.md';
    if (artifactType === 'verification') return name.endsWith('-VERIFICATION.md') || name === 'VERIFICATION.md';
    return name.endsWith('-RESEARCH.md') || name === 'RESEARCH.md';
  }).sort();
  return {
    phase: phaseInfo.normalized || normalizePhaseNumber(phase),
    type: artifactType,
    artifacts: files.map((name) => path.join(phaseInfo.phaseDir, name).replace(/\\/g, '/')),
  };
}
function phaseListPlans(argv) {
  const phase = String(argv[0] || '').trim();
  if (!phase) return { error: 'phase required' };
  const schemaIdx = argv.indexOf('--with-schema');
  const schemaKey = schemaIdx >= 0 ? String(argv[schemaIdx + 1] || '').trim() : '';
  if (schemaIdx >= 0 && !schemaKey) return { error: '--with-schema requires a field name' };
  const phaseInfo = findPhaseDirectory(phase);
  if (!phaseInfo.found) {
    return { phase: normalizePhaseNumber(phase), with_schema: schemaKey || null, plans: [], error: 'Phase not found' };
  }
  const phaseDirAbs = path.join(cwd, phaseInfo.phaseDir);
  const planFiles = fs.readdirSync(phaseDirAbs).filter((name) => name.endsWith('-PLAN.md') || name === 'PLAN.md').sort();
  const plans = [];
  for (const planFile of planFiles) {
    const content = fs.readFileSync(path.join(phaseDirAbs, planFile), 'utf8');
    const fm = parseFrontmatter(content);
    if (schemaKey && typeof fm[schemaKey] === 'undefined') continue;
    plans.push({
      id: planFile.replace('-PLAN.md', '').replace('PLAN.md', ''),
      file: planFile,
      wave: parseInt(String(fm.wave == null ? '1' : fm.wave), 10) || 1,
      autonomous: fm.autonomous !== false && fm.autonomous !== 'false',
      frontmatter_keys: Object.keys(fm).sort(),
    });
  }
  return {
    phase: phaseInfo.normalized || normalizePhaseNumber(phase),
    with_schema: schemaKey || null,
    plans,
  };
}
function phaseNextDecimal(argv) {
  const basePhase = String(argv[0] || '').trim();
  if (!basePhase) return { error: 'base phase number required' };
  const normalized = normalizePhaseNumber(basePhase);
  const decimalSet = new Set();
  const phasesDir = path.join(cwd, '.planning', 'phases');
  let found = false;
  if (exists(phasesDir, 'd')) {
    const entries = fs.readdirSync(phasesDir);
    found = entries.some((name) => name.startsWith(normalized + '-'));
    const decimalPattern = new RegExp('^(?:[A-Z]{1,6}-)?' + escapeRegex(normalized) + '\\.(\\d+)');
    for (const entry of entries) {
      const match = entry.match(decimalPattern);
      if (match) decimalSet.add(parseInt(match[1], 10));
    }
  }
  const roadmapContent = readRoadmapContent();
  if (roadmapContent != null) {
    const roadmapPattern = new RegExp('#{2,4}\\s*Phase\\s+0*' + escapeRegex(normalized) + '\\.(\\d+)\\s*:', 'gi');
    let match;
    while ((match = roadmapPattern.exec(roadmapContent)) !== null) {
      decimalSet.add(parseInt(match[1], 10));
    }
  }
  const existing = [...decimalSet].sort((left, right) => left - right).map((value) => normalized + '.' + value);
  const next = decimalSet.size === 0 ? normalized + '.1' : normalized + '.' + (Math.max(...decimalSet) + 1);
  return { found, base_phase: normalized, next, existing };
}
function normalizeScaffoldArgs(argv) {
  const type = argv[0];
  if (!type || !argv.includes('--phase')) return argv;
  const phaseIdx = argv.indexOf('--phase');
  const phase = phaseIdx >= 0 && argv[phaseIdx + 1] && !String(argv[phaseIdx + 1]).startsWith('--')
    ? String(argv[phaseIdx + 1])
    : '';
  const nameIdx = argv.indexOf('--name');
  let name;
  if (nameIdx !== -1) {
    const tail = argv.slice(nameIdx + 1);
    const stop = tail.findIndex((arg) => String(arg).startsWith('--'));
    const parts = stop === -1 ? tail : tail.slice(0, stop);
    name = parts.join(' ').trim() || undefined;
  }
  return [type, phase, ...(name ? [name] : [])];
}
function phaseScaffold(argv) {
  const normalizedArgs = normalizeScaffoldArgs(argv);
  const type = String(normalizedArgs[0] || '').trim();
  const phase = String(normalizedArgs[1] || '').trim();
  const name = String(normalizedArgs[2] || '').trim();
  if (!type) return { error: 'type required for scaffold' };
  if (!['context', 'uat', 'verification', 'phase-dir'].includes(type)) {
    return { error: 'Unknown scaffold type: ' + type + '. Available: context, uat, verification, phase-dir' };
  }
  const padded = phase ? normalizePhaseNumber(phase) : '00';
  const today = getTodayDate();
  if (type === 'phase-dir') {
    if (!phase || !name) return { error: 'phase and name required for phase-dir scaffold' };
    const slug = slugify(name);
    const dirInfo = ensurePhaseDirectory(phase, slug);
    const gitkeep = path.join(dirInfo.absolute, '.gitkeep');
    if (!exists(gitkeep, 'f')) fs.writeFileSync(gitkeep, '', 'utf8');
    return { created: true, directory: dirInfo.relative.replace(/\\/g, '/'), path: dirInfo.relative.replace(/\\/g, '/') };
  }
  const phaseInfo = findPhaseDirectory(phase);
  if (!phaseInfo.found) return { error: 'Phase ' + phase + ' directory not found' };
  const phaseDirAbs = path.join(cwd, phaseInfo.phaseDir);
  const phaseName = name || phaseInfo.phaseName || 'Unnamed';
  let filePath = '';
  let content = '';
  if (type === 'context') {
    filePath = path.join(phaseDirAbs, padded + '-CONTEXT.md');
    content = [
      '---',
      'phase: "' + padded + '"',
      'name: "' + phaseName + '"',
      'created: ' + today,
      '---',
      '',
      '# Phase ' + phase + ': ' + phaseName + ' - Context',
      '',
      '## Decisions',
      '',
      '_Decisions will be captured during /gsd-discuss-phase ' + phase + '_',
      '',
      '## Discretion Areas',
      '',
      '_Areas where the executor can use judgment_',
      '',
      '## Deferred Ideas',
      '',
      '_Ideas to consider later_',
      '',
    ].join('\n');
  } else if (type === 'uat') {
    filePath = path.join(phaseDirAbs, padded + '-UAT.md');
    content = [
      '---',
      'phase: "' + padded + '"',
      'name: "' + phaseName + '"',
      'created: ' + today,
      'status: pending',
      '---',
      '',
      '# Phase ' + phase + ': ' + phaseName + ' - User Acceptance Testing',
      '',
      '## Test Results',
      '',
      '| # | Test | Status | Notes |',
      '|---|------|--------|-------|',
      '',
      '## Summary',
      '',
      '_Pending UAT_',
      '',
    ].join('\n');
  } else {
    filePath = path.join(phaseDirAbs, padded + '-VERIFICATION.md');
    content = [
      '---',
      'phase: "' + padded + '"',
      'name: "' + phaseName + '"',
      'created: ' + today,
      'status: pending',
      '---',
      '',
      '# Phase ' + phase + ': ' + phaseName + ' - Verification',
      '',
      '## Goal-Backward Verification',
      '',
      '**Phase Goal:** [From ROADMAP.md]',
      '',
      '## Checks',
      '',
      '| # | Requirement | Status | Evidence |',
      '|---|------------|--------|----------|',
      '',
      '## Result',
      '',
      '_Pending verification_',
      '',
    ].join('\n');
  }
  const relPath = path.relative(cwd, filePath).replace(/\\/g, '/');
  if (exists(filePath, 'f')) return { created: false, reason: 'already_exists', path: relPath };
  fs.writeFileSync(filePath, content, 'utf8');
  return { created: true, path: relPath };
}
function phasesArchive(argv) {
  const version = String(argv[0] || '').trim();
  if (!version) return { error: 'version required for phases archive' };
  const phasesDir = path.join(cwd, '.planning', 'phases');
  const archiveDir = path.join(cwd, '.planning', 'milestones', version + '-phases');
  fs.mkdirSync(archiveDir, { recursive: true });
  let archived = 0;
  if (exists(phasesDir, 'd')) {
    for (const entry of fs.readdirSync(phasesDir)) {
      const source = path.join(phasesDir, entry);
      if (!exists(source, 'd')) continue;
      fs.renameSync(source, path.join(archiveDir, entry));
      archived += 1;
    }
  }
  return {
    archived,
    version,
    archive_directory: path.relative(cwd, archiveDir).replace(/\\/g, '/'),
  };
}
function collectMilestoneAccomplishments() {
  const summaries = [];
  const phasesDir = path.join(cwd, '.planning', 'phases');
  if (!exists(phasesDir, 'd')) return summaries;
  for (const phaseEntry of fs.readdirSync(phasesDir)) {
    const phaseDir = path.join(phasesDir, phaseEntry);
    if (!exists(phaseDir, 'd')) continue;
    for (const name of fs.readdirSync(phaseDir)) {
      if (!(name === 'SUMMARY.md' || name.endsWith('-SUMMARY.md'))) continue;
      try {
        const content = fs.readFileSync(path.join(phaseDir, name), 'utf8');
        const extracted = summaryExtract(path.join('.planning', 'phases', phaseEntry, name), 'one_liner', 'one_liner');
        const line = typeof extracted === 'string'
          ? extracted.trim()
          : extractFirstNarrativeLine(content);
        if (line) summaries.push(line);
      } catch {}
    }
  }
  return summaries;
}
function countMilestoneArtifacts() {
  const phasesDir = path.join(cwd, '.planning', 'phases');
  let plans = 0;
  let tasks = 0;
  if (!exists(phasesDir, 'd')) return { plans, tasks };
  for (const phaseEntry of fs.readdirSync(phasesDir)) {
    const phaseDir = path.join(phasesDir, phaseEntry);
    if (!exists(phaseDir, 'd')) continue;
    for (const name of fs.readdirSync(phaseDir)) {
      if (name === 'PLAN.md' || name.endsWith('-PLAN.md')) plans += 1;
      if (name === 'SUMMARY.md' || name.endsWith('-SUMMARY.md')) tasks += 1;
    }
  }
  return { plans, tasks };
}
function milestoneComplete(argv) {
  const version = String(argv[0] || '').trim();
  const nameIndex = argv.indexOf('--name');
  const milestoneName = nameIndex >= 0 ? String(argv[nameIndex + 1] || '').trim() : '';
  if (!version) return { error: 'milestone version required' };
  const planningDir = path.join(cwd, '.planning');
  if (!exists(planningDir, 'd')) return { error: '.planning directory not found' };
  const milestonesDir = path.join(planningDir, 'milestones');
  fs.mkdirSync(milestonesDir, { recursive: true });
  const archived = [];
  const roadmapPath = path.join(planningDir, 'ROADMAP.md');
  const requirementsPath = path.join(planningDir, 'REQUIREMENTS.md');
  const versionSlug = String(version).replace(/[^a-zA-Z0-9.-]+/g, '-');
  if (exists(roadmapPath, 'f')) {
    const target = path.join(milestonesDir, versionSlug + '-ROADMAP.md');
    fs.copyFileSync(roadmapPath, target);
    archived.push(path.relative(cwd, target).replace(/\\/g, '/'));
  }
  if (exists(requirementsPath, 'f')) {
    const target = path.join(milestonesDir, versionSlug + '-REQUIREMENTS.md');
    const source = fs.readFileSync(requirementsPath, 'utf8');
    const archiveHeader = '# Archived Requirements: ' + version + (milestoneName ? ' ' + milestoneName : '') + '\n\n';
    fs.writeFileSync(target, archiveHeader + source, 'utf8');
    archived.push(path.relative(cwd, target).replace(/\\/g, '/'));
  }
  const auditSource = firstExistingPath([
    path.join('.planning', 'audit.md'),
    path.join('.planning', 'AUDIT.md'),
    path.join('.planning', 'audit', 'open-audit.md'),
  ]);
  if (auditSource) {
    const sourceAbs = path.join(cwd, auditSource);
    const auditName = path.basename(auditSource).replace(/\.md$/i, '');
    const target = path.join(milestonesDir, versionSlug + '-' + auditName + '.md');
    fs.copyFileSync(sourceAbs, target);
    archived.push(path.relative(cwd, target).replace(/\\/g, '/'));
  }
  const roadmap = analyzeRoadmapForReporting();
  const artifactCounts = countMilestoneArtifacts();
  const accomplishments = collectMilestoneAccomplishments();
  const milestoneDocPath = path.join(planningDir, 'MILESTONES.md');
  const date = getTodayDate();
  const entryLines = [
    '## ' + version + (milestoneName ? ' ' + milestoneName : ''),
    '',
    '- Date: ' + date,
    '- Phases: ' + Number(roadmap.phase_count || 0),
    '- Plans: ' + Number(roadmap.total_plans || 0),
    '- Tasks: ' + Number(roadmap.total_summaries || 0),
    '',
    '### Accomplishments',
  ];
  if (accomplishments.length > 0) {
    for (const item of accomplishments) entryLines.push('- ' + item);
  } else {
    entryLines.push('- Milestone archived');
  }
  entryLines.push('');
  let milestoneDoc = exists(milestoneDocPath, 'f') ? fs.readFileSync(milestoneDocPath, 'utf8').trimEnd() + '\n\n' : '# Milestones\n\n';
  milestoneDoc += entryLines.join('\n');
  fs.writeFileSync(milestoneDocPath, milestoneDoc.replace(/\s*$/, '\n'), 'utf8');
  const statePath = ensureStateFile();
  let stateContent = fs.readFileSync(statePath, 'utf8');
  stateContent = upsertLine(stateContent, 'milestone', version);
  stateContent = upsertLine(stateContent, 'milestone_name', milestoneName);
  stateContent = upsertLine(stateContent, 'current_phase', '');
  stateContent = upsertLine(stateContent, 'current_phase_name', '');
  stateContent = upsertLine(stateContent, 'current_step', 'discuss');
  stateContent = upsertLine(stateContent, 'last_activity', new Date().toISOString());
  fs.writeFileSync(statePath, stateContent, 'utf8');
  return {
    version,
    name: milestoneName,
    date,
    phases: Number(roadmap.phase_count || 0),
    plans: artifactCounts.plans,
    tasks: artifactCounts.tasks,
    accomplishments,
    archived,
    milestones_path: '.planning/MILESTONES.md',
    state_updated: true,
  };
}
function parsePhaseToken(rawPhase) {
  const match = String(rawPhase || '').trim().match(/^(\d+)(?:\.(\d+))?$/);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10) || 0,
    minor: match[2] == null ? null : (parseInt(match[2], 10) || 0),
  };
}
function formatPhaseToken(token) {
  if (!token) return '';
  return token.minor == null ? String(token.major) : String(token.major) + '.' + String(token.minor);
}
function renamePhaseFilesInDir(dirAbs, oldPhase, newPhase) {
  const renamedFiles = [];
  const oldPad = padPhaseIdentifier(oldPhase);
  const newPad = padPhaseIdentifier(newPhase);
  for (const name of fs.readdirSync(dirAbs)) {
    const fileAbs = path.join(dirAbs, name);
    if (!exists(fileAbs, 'f')) continue;
    let nextName = name;
    if (oldPad && newPad) nextName = nextName.replaceAll(oldPad, newPad);
    nextName = nextName.replaceAll(String(oldPhase), String(newPhase));
    if (nextName === name) continue;
    fs.renameSync(fileAbs, path.join(dirAbs, nextName));
    renamedFiles.push({ from: name, to: nextName });
  }
  return renamedFiles;
}
function buildPhaseRemovalRenamePlan(targetPhase) {
  const phasesDir = path.join(cwd, '.planning', 'phases');
  if (!exists(phasesDir, 'd')) return { targetDir: null, mappings: [], error: null };
  const targetToken = parsePhaseToken(targetPhase);
  if (!targetToken) return { targetDir: null, mappings: [], error: 'invalid phase number' };
  const targetInfo = findPhaseDirectory(targetPhase);
  const targetDir = targetInfo.found ? path.basename(targetInfo.phaseDir) : null;
  const mappings = [];
  for (const name of fs.readdirSync(phasesDir)) {
    const match = name.match(/^(\d+(?:\.\d+)?)-(.*)$/);
    if (!match) continue;
    const phaseNumber = match[1];
    const slug = match[2];
    const parsed = parsePhaseToken(phaseNumber);
    if (!parsed) continue;
    let newToken = null;
    if (targetToken.minor == null) {
      if (parsed.major === targetToken.major && parsed.minor != null) {
        return { targetDir, mappings: [], error: 'cannot remove integer phase with inserted decimal descendants yet' };
      }
      if (parsed.major > targetToken.major) newToken = { major: parsed.major - 1, minor: parsed.minor };
    } else if (parsed.major === targetToken.major && parsed.minor != null && parsed.minor > targetToken.minor) {
      newToken = { major: parsed.major, minor: parsed.minor - 1 };
    }
    if (!newToken) continue;
    const oldPhase = phaseNumber;
    const newPhase = formatPhaseToken(newToken);
    mappings.push({
      oldPhase,
      newPhase,
      oldDir: name,
      newDir: padPhaseIdentifier(newPhase) + '-' + slug,
    });
  }
  mappings.sort((left, right) => comparePhaseValues(left.oldPhase, right.oldPhase));
  return { targetDir, mappings, error: null };
}
function applyPhaseRemovalRenames(mappings) {
  const phasesDir = path.join(cwd, '.planning', 'phases');
  const renamedDirectories = [];
  const renamedFiles = [];
  for (const mapping of mappings) {
    const oldAbs = path.join(phasesDir, mapping.oldDir);
    const newAbs = path.join(phasesDir, mapping.newDir);
    if (!exists(oldAbs, 'd')) continue;
    fs.renameSync(oldAbs, newAbs);
    renamedDirectories.push({ from: mapping.oldDir, to: mapping.newDir });
    for (const renamed of renamePhaseFilesInDir(newAbs, mapping.oldPhase, mapping.newPhase)) {
      renamedFiles.push({
        from: path.join('.planning', 'phases', mapping.newDir, renamed.from).replace(/\\/g, '/'),
        to: path.join('.planning', 'phases', mapping.newDir, renamed.to).replace(/\\/g, '/'),
      });
    }
  }
  return { renamedDirectories, renamedFiles };
}
function replaceRoadmapPhaseRefs(content, oldPhase, newPhase) {
  const oldPad = padPhaseIdentifier(oldPhase);
  const newPad = padPhaseIdentifier(newPhase);
  const oldPlain = formatPhaseToken(parsePhaseToken(oldPhase));
  const newPlain = formatPhaseToken(parsePhaseToken(newPhase));
  let next = String(content || '');
  next = next.replace(new RegExp('(#{2,4}\\s*Phase\\s+)' + escapeRegex(oldPlain || oldPhase) + '(?=\\s*:)', 'g'), '$1' + (newPlain || newPhase));
  next = next.replace(new RegExp('(\\*\\*Depends on:\\*\\*\\s*Phase\\s+)' + escapeRegex(oldPlain || oldPhase) + '\\b', 'gi'), '$1' + (newPlain || newPhase));
  next = next.replace(new RegExp('(Phase\\s+)' + escapeRegex(oldPlain || oldPhase) + '\\b', 'g'), '$1' + (newPlain || newPhase));
  if (oldPad && newPad) next = next.replace(new RegExp('\\b' + escapeRegex(oldPad) + '-(\\d{2})\\b', 'g'), newPad + '-$1');
  next = next.replace(new RegExp('\\b' + escapeRegex(oldPlain || oldPhase) + '-(\\d{2})\\b', 'g'), (newPlain || newPhase) + '-$1');
  next = next.replace(new RegExp('(\\|\\s*)' + escapeRegex(oldPlain || oldPhase) + '(\\.\\s)', 'g'), '$1' + (newPlain || newPhase) + '$2');
  return next;
}
function getPhaseRemovalFallback(targetPhase) {
  const parsed = parsePhaseToken(targetPhase);
  if (!parsed) return null;
  if (parsed.minor == null) {
    if (parsed.major <= 1) return null;
    return formatPhaseToken({ major: parsed.major - 1, minor: null });
  }
  if (parsed.minor <= 1) return formatPhaseToken({ major: parsed.major, minor: null });
  return formatPhaseToken({ major: parsed.major, minor: parsed.minor - 1 });
}
function updateRoadmapAfterPhaseRemoval(targetPhase, mappings) {
  const roadmapPath = path.join(cwd, '.planning', 'ROADMAP.md');
  if (!exists(roadmapPath, 'f')) return false;
  const content = fs.readFileSync(roadmapPath, 'utf8');
  const headers = getRoadmapPhaseHeaders(content);
  const targetHeader = headers.find((header) => comparePhaseNumbers(header.number, targetPhase) === 0);
  if (!targetHeader) return false;
  let next = content.slice(0, targetHeader.index).replace(/\s*$/, '\n\n') + content.slice(targetHeader.nextIndex).replace(/^\s*/, '');
  const fallbackPhase = getPhaseRemovalFallback(targetPhase);
  if (fallbackPhase) {
    next = replaceRoadmapPhaseRefs(next, targetPhase, fallbackPhase);
  }
  for (const mapping of mappings) {
    next = replaceRoadmapPhaseRefs(next, mapping.oldPhase, mapping.newPhase);
  }
  fs.writeFileSync(roadmapPath, next.replace(/\n{3,}/g, '\n\n'), 'utf8');
  return true;
}
function syncStatePhaseCountToRoadmap() {
  const roadmapPath = path.join(cwd, '.planning', 'ROADMAP.md');
  const statePath = path.join(cwd, '.planning', 'STATE.md');
  if (!exists(roadmapPath, 'f') || !exists(statePath, 'f')) return false;
  const roadmapContent = fs.readFileSync(roadmapPath, 'utf8');
  const totalPhases = getRoadmapPhaseHeaders(roadmapContent).length;
  let content = fs.readFileSync(statePath, 'utf8');
  content = content.replace(/^(\s*total_phases:\s*)(\d+)\s*$/mi, (_match, prefix) => {
    return prefix + String(totalPhases);
  });
  content = content.replace(/(\bof\s+)(\d+)(\s*(?:\(|phases?))/i, (_m, left, _count, right) => left + String(totalPhases) + right);
  const totalPhasesLabel = extractLabeledValue(content, 'Total Phases');
  if (Number.isFinite(parseInt(totalPhasesLabel, 10)) && String(totalPhasesLabel).trim() !== '') {
    const replacement = String(totalPhases);
    content = content.replace(/^(\\*\\*Total Phases:?\\*\\*\\s*:?\\s*)\d+\s*$/mi, '$1' + replacement);
    content = content.replace(/^(Total Phases:\s*)\d+\s*$/mi, '$1' + replacement);
  } else {
    content = upsertLine(content, 'total_phases', String(totalPhases));
  }
  fs.writeFileSync(statePath, content, 'utf8');
  return true;
}
function phaseRemove(argv) {
  const targetPhase = String(argv[0] || '').trim();
  if (!targetPhase) return { error: 'phase number required for phase remove' };
  const roadmapPath = path.join(cwd, '.planning', 'ROADMAP.md');
  if (!exists(roadmapPath, 'f')) return { error: 'ROADMAP.md not found' };
  const currentPhase = normalizePhaseNumber(getStateField('current_phase') || '');
  const normalizedTarget = normalizePhaseNumber(targetPhase);
  if (currentPhase && comparePhaseValues(normalizedTarget, currentPhase) <= 0) {
    return { error: 'Cannot remove Phase ' + targetPhase, current_phase: currentPhase, reason: 'Only future phases can be removed' };
  }
  const phaseInfo = findPhaseDirectory(targetPhase);
  if (!phaseInfo.found) return { error: 'Phase not found', phase: targetPhase };
  const phaseDirAbs = path.join(cwd, phaseInfo.phaseDir);
  const force = argv.includes('--force');
  if (!force) {
    const summaries = fs.readdirSync(phaseDirAbs).filter((name) => name === 'SUMMARY.md' || name.endsWith('-SUMMARY.md'));
    if (summaries.length > 0) {
      return { error: 'Phase ' + targetPhase + ' has ' + summaries.length + ' executed plan(s). Use --force to remove anyway.' };
    }
  }
  const renamePlan = buildPhaseRemovalRenamePlan(targetPhase);
  if (renamePlan.error) return { error: renamePlan.error, phase: targetPhase };
  fs.rmSync(phaseDirAbs, { recursive: true, force: true });
  const renamed = applyPhaseRemovalRenames(renamePlan.mappings);
  const roadmapUpdated = updateRoadmapAfterPhaseRemoval(targetPhase, renamePlan.mappings);
  const stateUpdated = syncStatePhaseCountToRoadmap();
  return {
    removed: targetPhase,
    directory_deleted: path.basename(phaseInfo.phaseDir),
    renamed_directories: renamed.renamedDirectories,
    renamed_files: renamed.renamedFiles,
    roadmap_updated: roadmapUpdated,
    state_updated: stateUpdated,
  };
}

switch (query) {
  case 'init.new-project': {
    const hasGit = hasGitRepo(cwd);
    const planningExists = exists(path.join(cwd, '.planning'), 'd');
    const projectExists = exists(path.join(cwd, '.planning', 'PROJECT.md'), 'f');
    const hasCbMap = exists(path.join(cwd, '.planning', 'codebase', 'ARCHITECTURE.md'), 'f');
    const hasPkg = hasProjectMarker(cwd);
    const hasExisting = hasPkg || hasCode(cwd, 0);
    const isBrownfield = hasExisting && !planningExists;
    const needsMap = isBrownfield && !hasCbMap;
    const projectResearcherModel = getConfiguredAgentModel('gsd-project-researcher', 'claude-sonnet-4-6');
    const synthesizerModel = getConfiguredAgentModel('gsd-research-synthesizer', 'claude-sonnet-4-6');
    const roadmapperModel = getConfiguredAgentModel('gsd-roadmapper', 'claude-sonnet-4-6');
    const agentStatus = getInstalledAgentStatus(['gsd-project-researcher', 'gsd-research-synthesizer', 'gsd-roadmapper']);
    process.stdout.write(JSON.stringify({
      researcher_model: projectResearcherModel, synthesizer_model: synthesizerModel, roadmapper_model: roadmapperModel,
      commit_docs: true, project_exists: projectExists, has_codebase_map: hasCbMap,
      planning_exists: planningExists, has_existing_code: hasExisting, has_package_file: hasPkg,
      is_brownfield: isBrownfield, needs_codebase_map: needsMap, has_git: hasGit,
      project_path: '.planning/PROJECT.md', task_tool_available: false, date: getTodayDate(),
      ...agentStatus,
    }));
    break;
  }
  case 'init.map-codebase': {
    const model = getConfiguredAgentModel('gsd-codebase-mapper', 'claude-sonnet-4-6');
    const existingMaps = listExistingMaps();
    const existingMapDetails = listExistingMapDetails();
    const codebaseDirExists = exists(path.join(cwd, '.planning', 'codebase'), 'd');
    const agentStatus = getInstalledAgentStatus(['gsd-codebase-mapper']);
    process.stdout.write(JSON.stringify({
      mapper_model: model,
      commit_docs: true,
      codebase_dir: '.planning/codebase',
      existing_maps: existingMaps,
      existing_map_details: existingMapDetails,
      has_maps: existingMaps.length > 0,
      codebase_dir_exists: codebaseDirExists,
      subagent_timeout: 300000,
      date: getTodayDate(),
      task_tool_available: false,
      ...agentStatus,
    }));
    break;
  }
  case 'init.map-project': {
    process.stdout.write(JSON.stringify({
      date: getTodayDate(),
      project_path: '.planning/project-map/PROJECT-MAP.md',
      codebase_map_command: '/gsd-map-codebase',
      ...collectProjectInventory(),
    }));
    break;
  }
  case 'init.quick': {
    process.stdout.write(JSON.stringify(getQuickTaskInit(rest.join(' ').trim())));
    break;
  }
  case 'init.milestone-op': {
    process.stdout.write(JSON.stringify(getMilestoneOpPayload()));
    break;
  }
  case 'init.resume': {
    process.stdout.write(JSON.stringify(getResumePayload()));
    break;
  }
  case 'init.manager': {
    process.stdout.write(JSON.stringify(buildManagerPayload()));
    break;
  }
  case 'init.todos': {
    process.stdout.write(JSON.stringify(buildInitTodosPayload(rest[0] || null)));
    break;
  }
  case 'init.ingest-docs': {
    const config = readConfig();
    process.stdout.write(JSON.stringify({
      project_exists: exists('.planning/PROJECT.md', 'f'),
      planning_exists: exists('.planning', 'd'),
      has_git: hasGitRepo(cwd),
      project_path: '.planning/PROJECT.md',
      commit_docs: config.commit_docs,
    }));
    break;
  }
  case 'docs-init': {
    process.stdout.write(JSON.stringify(docsInitPayload()));
    break;
  }
  case 'init.new-milestone': {
    const projectResearcherModel = getConfiguredAgentModel('gsd-project-researcher', 'claude-sonnet-4-6');
    const synthesizerModel = getConfiguredAgentModel('gsd-research-synthesizer', 'claude-sonnet-4-6');
    const roadmapperModel = getConfiguredAgentModel('gsd-roadmapper', 'claude-sonnet-4-6');
    const phaseDirCount = countPhaseDirs();
    const agentStatus = getInstalledAgentStatus(['gsd-project-researcher', 'gsd-research-synthesizer', 'gsd-roadmapper']);
    process.stdout.write(JSON.stringify({
      researcher_model: projectResearcherModel,
      synthesizer_model: synthesizerModel,
      roadmapper_model: roadmapperModel,
      commit_docs: true,
      research_enabled: getResearchEnabled(),
      current_milestone: '',
      project_exists: exists(path.join(cwd, '.planning', 'PROJECT.md'), 'f'),
      roadmap_exists: exists(path.join(cwd, '.planning', 'ROADMAP.md'), 'f'),
      latest_completed_milestone: getLatestCompletedMilestone(),
      phase_dir_count: phaseDirCount,
      phase_archive_path: phaseDirCount > 0 ? '.planning/archive/phases-' + Date.now() : '',
      task_tool_available: false,
      ...agentStatus,
    }));
    break;
  }
  case 'init.phase-op': {
    const stateFile = path.join(cwd, '.planning', 'STATE.md');
    const roadmapFile = path.join(cwd, '.planning', 'ROADMAP.md');
    const stateContent = exists(stateFile, 'f') ? fs.readFileSync(stateFile, 'utf8') : '';
    const currentPhase = (stateContent.match(/current_phase:\\s*(\\S+)/) || [])[1] || '1';
    const researcherModel = getConfiguredAgentModel('gsd-phase-researcher', 'claude-sonnet-4-6');
    const advisorModel = getConfiguredAgentModel('gsd-advisor-researcher', researcherModel);
    const config = readConfig();
    const agentStatus = getInstalledAgentStatus(['gsd-phase-researcher']);
    const phaseInfo = findPhaseDirectory(rest[0] || currentPhase);
    const contextPath = phaseInfo.found
      ? firstExistingPath([
          path.join(phaseInfo.phaseDir, phaseInfo.normalized + '-CONTEXT.md'),
          path.join(phaseInfo.phaseDir, 'CONTEXT.md'),
        ])
      : null;
    const researchPath = phaseInfo.found
      ? firstExistingPath([
          path.join(phaseInfo.phaseDir, phaseInfo.normalized + '-RESEARCH.md'),
          path.join(phaseInfo.phaseDir, 'RESEARCH.md'),
        ])
      : null;
    process.stdout.write(JSON.stringify({
      phase: rest[0] || '1', current_phase: currentPhase,
      phase_found: phaseInfo.found,
      phase_dir: phaseInfo.found ? phaseInfo.phaseDir : null,
      phase_number: phaseInfo.normalized || normalizePhaseNumber(rest[0] || currentPhase),
      padded_phase: phaseInfo.normalized || normalizePhaseNumber(rest[0] || currentPhase),
      phase_name: phaseInfo.phaseName || '',
      phase_slug: phaseInfo.phaseSlug || '',
      researcher_model: researcherModel, advisor_model: advisorModel,
      roadmap_exists: exists(roadmapFile, 'f'), state_exists: exists(stateFile, 'f'),
      state_path: exists(stateFile, 'f') ? '.planning/STATE.md' : null,
      roadmap_path: exists(roadmapFile, 'f') ? '.planning/ROADMAP.md' : null,
      requirements_path: exists(path.join(cwd, '.planning', 'REQUIREMENTS.md'), 'f') ? '.planning/REQUIREMENTS.md' : null,
      context_path: contextPath,
      research_path: researchPath,
      commit_docs: config.commit_docs,
      text_mode: config.workflowDefaults.text_mode,
      planning_exists: exists(path.join(cwd, '.planning'), 'd'),
      brave_search: getConfigFlag('search.brave_search', false),
      exa_search: getConfigFlag('search.exa_search', false),
      firecrawl: getConfigFlag('search.firecrawl', false),
      task_tool_available: false,
      ...agentStatus,
    }));
    break;
  }
  case 'init.plan-phase': {
    const config = readConfig();
    const requestedPhase = rest[0] || getStateField('current_phase') || '1';
    const researcherModel = getConfiguredAgentModel('gsd-phase-researcher', 'claude-sonnet-4-6');
    const plannerModel = getConfiguredAgentModel('gsd-planner', 'claude-sonnet-4-6');
    const checkerModel = getConfiguredAgentModel('gsd-plan-checker', 'claude-sonnet-4-6');
    const roadmapPhase = parseRoadmapPhase(requestedPhase);
    const phaseDirMatch = findPhaseDirectory(requestedPhase);
    const normalizedPhase = phaseDirMatch.normalized || normalizePhaseNumber(roadmapPhase?.phase_number || requestedPhase);
    const phaseDir = phaseDirMatch.found
      ? phaseDirMatch.phaseDir
      : roadmapPhase
        ? path.join('.planning', 'phases', normalizedPhase + '-' + roadmapPhase.phase_slug)
        : null;
    const artifacts = getPhaseArtifacts(phaseDir, normalizedPhase);
    const phaseFound = phaseDirMatch.found || !!roadmapPhase;
    const agentStatus = getInstalledAgentStatus([
      'gsd-phase-researcher',
      'gsd-pattern-mapper',
      'gsd-planner',
      'gsd-plan-checker',
    ]);
    const result = {
      researcher_model: researcherModel,
      planner_model: plannerModel,
      checker_model: checkerModel,
      research_enabled: config.workflowDefaults.research,
      plan_checker_enabled: config.workflowDefaults.plan_check,
      nyquist_validation_enabled: config.workflowDefaults.nyquist_validation,
      commit_docs: config.commit_docs,
      text_mode: config.workflowDefaults.text_mode,
      auto_advance: config.workflowDefaults.auto_advance,
      auto_chain_active: config.workflowDefaults.auto_chain_active,
      tdd_mode: config.workflowDefaults.tdd_mode,
      phase_found: phaseFound,
      phase_dir: phaseDir,
      phase_number: phaseFound ? (phaseDirMatch.normalized || normalizePhaseNumber(roadmapPhase?.phase_number || requestedPhase)) : null,
      phase_name: phaseDirMatch.phaseName || roadmapPhase?.phase_name || null,
      phase_slug: phaseDirMatch.phaseSlug || roadmapPhase?.phase_slug || null,
      padded_phase: phaseFound ? (phaseDirMatch.normalized || normalizePhaseNumber(roadmapPhase?.phase_number || requestedPhase)) : null,
      phase_req_ids: roadmapPhase?.phase_req_ids || null,
      has_research: artifacts.has_research,
      has_context: artifacts.has_context,
      has_reviews: artifacts.has_reviews,
      has_plans: artifacts.has_plans,
      plan_count: artifacts.plan_count,
      planning_exists: exists(path.join(cwd, '.planning'), 'd'),
      roadmap_exists: exists(path.join(cwd, '.planning', 'ROADMAP.md'), 'f'),
      state_path: exists(path.join(cwd, '.planning', 'STATE.md'), 'f') ? '.planning/STATE.md' : null,
      roadmap_path: exists(path.join(cwd, '.planning', 'ROADMAP.md'), 'f') ? '.planning/ROADMAP.md' : null,
      requirements_path: exists(path.join(cwd, '.planning', 'REQUIREMENTS.md'), 'f') ? '.planning/REQUIREMENTS.md' : null,
      context_path: artifacts.context_path,
      research_path: artifacts.research_path,
      verification_path: artifacts.verification_path,
      uat_path: artifacts.uat_path,
      reviews_path: artifacts.reviews_path,
      patterns_path: artifacts.patterns_path,
      task_tool_available: false,
      ...agentStatus,
    };
    if (config.response_language) {
      result.response_language = config.response_language;
    }
    process.stdout.write(JSON.stringify(result));
    break;
  }
  case 'init.execute-phase': {
    const requestedPhase = rest[0] || getStateField('current_phase') || '1';
    const config = readConfig();
    const phaseData = getPhasePlanIndexData(requestedPhase);
    const roadmapPhase = parseRoadmapPhase(requestedPhase);
    const phaseFound = !!phaseData.phase_dir || !!roadmapPhase;
    const phaseNumber = phaseData.phase || normalizePhaseNumber(roadmapPhase?.phase_number || requestedPhase);
    const phaseName = phaseData.phase_name || roadmapPhase?.phase_name || '';
    const phaseSlug = phaseData.phase_slug || roadmapPhase?.phase_slug || slugify(phaseName);
    const branchingStrategy = getConfigValue('git.branching_strategy', 'none') || 'none';
    const result = {
      executor_model: getConfiguredAgentModel('gsd-executor', 'claude-sonnet-4-6'),
      verifier_model: getConfiguredAgentModel('gsd-verifier', 'claude-sonnet-4-6'),
      commit_docs: config.commit_docs,
      sub_repos: Array.isArray(config.sub_repos) ? config.sub_repos : [],
      parallelization: config.parallelization !== false,
      context_window: config.context_window,
      branching_strategy: branchingStrategy,
      branch_name: computeBranchName(config, branchingStrategy, phaseNumber, phaseSlug),
      verifier_enabled: getConfigFlag('workflow.verifier', true),
      tdd_mode: config.workflowDefaults.tdd_mode,
      phase_found: phaseFound,
      phase_dir: phaseData.phase_dir || (roadmapPhase ? path.join('.planning', 'phases', phaseNumber + '-' + (roadmapPhase.phase_slug || slugify(phaseName))) : null),
      phase_number: phaseNumber,
      phase_name: phaseName || null,
      phase_slug: phaseSlug || null,
      phase_req_ids: roadmapPhase?.phase_req_ids || null,
      plans: phaseData.plan_files || [],
      summaries: phaseData.summary_files || [],
      incomplete_plans: phaseData.incomplete_plan_files || [],
      plan_count: (phaseData.plan_files || []).length,
      incomplete_count: (phaseData.incomplete_plan_files || []).length,
      state_exists: exists(path.join(cwd, '.planning', 'STATE.md'), 'f'),
      roadmap_exists: exists(path.join(cwd, '.planning', 'ROADMAP.md'), 'f'),
      config_exists: exists(path.join(cwd, '.planning', 'config.json'), 'f'),
      state_path: exists(path.join(cwd, '.planning', 'STATE.md'), 'f') ? '.planning/STATE.md' : null,
      roadmap_path: exists(path.join(cwd, '.planning', 'ROADMAP.md'), 'f') ? '.planning/ROADMAP.md' : null,
      config_path: exists(path.join(cwd, '.planning', 'config.json'), 'f') ? '.planning/config.json' : null,
      task_tool_available: false,
      ...getInstalledAgentStatus(['gsd-executor', 'gsd-verifier']),
    };
    if (config.response_language) {
      result.response_language = config.response_language;
    }
    process.stdout.write(JSON.stringify(result));
    break;
  }
  case 'init.verify-work': {
    const requestedPhase = rest[0] || getStateField('current_phase') || '1';
    const config = readConfig();
    const phaseData = getPhasePlanIndexData(requestedPhase);
    const roadmapPhase = parseRoadmapPhase(requestedPhase);
    const phaseFound = !!phaseData.phase_dir || !!roadmapPhase;
    const phaseNumber = phaseData.phase || normalizePhaseNumber(roadmapPhase?.phase_number || requestedPhase);
    const phaseName = phaseData.phase_name || roadmapPhase?.phase_name || '';
    const phaseSlug = phaseData.phase_slug || roadmapPhase?.phase_slug || slugify(phaseName);
    const phaseDir = phaseData.phase_dir || (roadmapPhase ? path.join('.planning', 'phases', phaseNumber + '-' + (roadmapPhase.phase_slug || phaseSlug)) : null);
    const artifacts = getPhaseArtifacts(phaseDir, phaseNumber);
    process.stdout.write(JSON.stringify({
      planner_model: getConfiguredAgentModel('gsd-planner', 'claude-sonnet-4-6'),
      checker_model: getConfiguredAgentModel('gsd-plan-checker', 'claude-sonnet-4-6'),
      commit_docs: config.commit_docs,
      phase_found: phaseFound,
      phase_dir: phaseDir,
      phase_number: phaseFound ? phaseNumber : null,
      phase_name: phaseName || null,
      phase_slug: phaseSlug || null,
      has_verification: Boolean(artifacts.verification_path),
      verification_path: artifacts.verification_path,
      has_uat: Boolean(artifacts.uat_path),
      uat_path: artifacts.uat_path,
      text_mode: config.workflowDefaults.text_mode,
      task_tool_available: false,
      ...getInstalledAgentStatus(['gsd-planner', 'gsd-plan-checker']),
    }));
    break;
  }
  case 'init.progress': {
    process.stdout.write(JSON.stringify(buildInitProgressPayload()));
    break;
  }
  case 'generate-slug': {
    const value = slugify(rest[0] || '');
    if (args.includes('--raw')) {
      process.stdout.write(value);
    } else {
      process.stdout.write(JSON.stringify({ slug: value }));
    }
    break;
  }
  case 'current-timestamp': {
    const value = currentTimestamp(rest);
    if (rest.includes('--raw') || args.includes('--raw')) {
      process.stdout.write(value);
    } else {
      process.stdout.write(JSON.stringify({ timestamp: value }));
    }
    break;
  }
  case 'summary-extract':
  case 'summary.extract': {
    const filePathArg = rest[0];
    const fieldsIndex = rest.indexOf('--fields');
    const pickIndex = rest.indexOf('--pick');
    const rawMode = rest.includes('--raw');
    const extracted = summaryExtract(
      filePathArg,
      fieldsIndex >= 0 ? rest[fieldsIndex + 1] : '',
      pickIndex >= 0 ? rest[pickIndex + 1] : '',
    );
    if (rawMode || (pickIndex >= 0 && (typeof extracted === 'string' || Array.isArray(extracted)))) {
      process.stdout.write(typeof extracted === 'string' ? extracted : JSON.stringify(extracted));
    } else {
      process.stdout.write(JSON.stringify(extracted));
    }
    break;
  }
  case 'history.digest':
  case 'history-digest': {
    process.stdout.write(JSON.stringify(getHistoryDigest()));
    break;
  }
  case 'intel.status':
  case 'intel status': {
    process.stdout.write(JSON.stringify(intelStatus()));
    break;
  }
  case 'intel.diff':
  case 'intel diff': {
    process.stdout.write(JSON.stringify(intelDiff()));
    break;
  }
  case 'intel.snapshot':
  case 'intel snapshot': {
    process.stdout.write(JSON.stringify(intelSnapshot()));
    break;
  }
  case 'intel.validate':
  case 'intel validate': {
    process.stdout.write(JSON.stringify(intelValidate()));
    break;
  }
  case 'intel.query':
  case 'intel query': {
    process.stdout.write(JSON.stringify(intelQuery(rest)));
    break;
  }
  case 'intel.extract-exports':
  case 'intel extract-exports': {
    process.stdout.write(JSON.stringify(intelExtractExports(rest)));
    break;
  }
  case 'intel.patch-meta':
  case 'intel patch-meta': {
    process.stdout.write(JSON.stringify(intelPatchMeta(rest)));
    break;
  }
  case 'intel.update':
  case 'intel update': {
    process.stdout.write(JSON.stringify(intelUpdate()));
    break;
  }
  case 'decisions.parse':
  case 'decisions parse': {
    process.stdout.write(JSON.stringify(decisionsParseQuery(rest)));
    break;
  }
  case 'verify.references':
  case 'verify-path-exists':
  case 'verify.path-exists':
  case 'verify.plan-structure':
  case 'verify.phase-completeness':
  case 'state.prune':
  case 'state prune':
  case 'state.signal-waiting':
  case 'state signal-waiting':
  case 'state.signal-resume':
  case 'state signal-resume':
  case 'state.update-progress':
  case 'state.sync':
  case 'state sync':
  case 'template.fill':
  case 'template.select':
  case 'template select':
  case 'verify-summary':
  case 'verify.summary':
  case 'verify.commits':
  case 'check-commit':
  case 'requirements.extract-from-plans':
  case 'requirements.mark-complete':
  case 'requirements mark-complete':
  case 'todo.complete':
  case 'todo complete':
  case 'state.get':
  case 'init.new-workspace':
  case 'init.list-workspaces':
  case 'init.remove-workspace':
  case 'validate.agents':
  case 'validate.consistency':
  case 'detect-custom-files': {
    if (query === 'verify.references') {
      process.stdout.write(JSON.stringify(verifyDocumentReferences(rest[0])));
    } else if (query === 'verify-path-exists' || query === 'verify.path-exists') {
      process.stdout.write(JSON.stringify(verifyPathExists(rest[0])));
    } else if (query === 'verify.plan-structure') {
      process.stdout.write(JSON.stringify(verifyPlanStructure(rest[0] || '')));
    } else if (query === 'verify.phase-completeness') {
      process.stdout.write(JSON.stringify(verifyPhaseCompleteness(rest[0] || '')));
    } else if (query === 'state.prune' || query === 'state prune') {
      process.stdout.write(JSON.stringify(statePrune(rest)));
    } else if (query === 'state.signal-waiting' || query === 'state signal-waiting') {
      process.stdout.write(JSON.stringify(stateSignalWaiting(rest)));
    } else if (query === 'state.signal-resume' || query === 'state signal-resume') {
      process.stdout.write(JSON.stringify(stateSignalResume()));
    } else if (query === 'state.update-progress') {
      process.stdout.write(JSON.stringify(stateUpdateProgress()));
    } else if (query === 'state.sync' || query === 'state sync') {
      process.stdout.write(JSON.stringify(stateSync(rest)));
    } else if (query === 'template.select' || query === 'template select') {
      process.stdout.write(JSON.stringify(templateSelect(rest[0] || '')));
    } else if (query === 'template.fill') {
      process.stdout.write(JSON.stringify(templateFill(rest)));
    } else if (query === 'verify-summary' || query === 'verify.summary') {
      process.stdout.write(JSON.stringify(verifySummaryDocument(rest[0], rest)));
    } else if (query === 'verify.commits') {
      process.stdout.write(JSON.stringify(verifyCommitHashes(rest)));
    } else if (query === 'check-commit') {
      process.stdout.write(JSON.stringify(checkCommit()));
    } else if (query === 'requirements.extract-from-plans') {
      process.stdout.write(JSON.stringify(requirementsExtractFromPlans(rest[0] || '')));
    } else if (query === 'requirements.mark-complete' || query === 'requirements mark-complete') {
      process.stdout.write(JSON.stringify(requirementsMarkComplete(rest)));
    } else if (query === 'todo.complete' || query === 'todo complete') {
      process.stdout.write(JSON.stringify(todoComplete(rest[0] || '')));
    } else if (query === 'state.get') {
      process.stdout.write(JSON.stringify(getStateValue(rest)));
    } else if (query === 'init.new-workspace') {
      process.stdout.write(JSON.stringify(initNewWorkspace()));
    } else if (query === 'init.list-workspaces') {
      process.stdout.write(JSON.stringify(initListWorkspaces()));
    } else if (query === 'init.remove-workspace') {
      process.stdout.write(JSON.stringify(initRemoveWorkspace(rest[0])));
    } else if (query === 'validate.agents') {
      process.stdout.write(JSON.stringify(validateAgentsInstalled()));
    } else if (query === 'validate.consistency') {
      process.stdout.write(JSON.stringify(validatePlanningConsistency()));
    } else {
      process.stdout.write(JSON.stringify(detectCustomFiles(rest)));
    }
    break;
  }
  case 'audit-uat': {
    process.stdout.write(JSON.stringify(auditUatArtifacts()));
    break;
  }
  case 'config-ensure-section': {
    process.stdout.write(JSON.stringify(ensureConfigSection()));
    break;
  }
  case 'security.scan-for-secrets':
  case 'security scan-for-secrets': {
    process.stdout.write(JSON.stringify(securityScanForSecrets(rest)));
    break;
  }
  case 'roadmap': {
    process.stdout.write(JSON.stringify(analyzeRoadmapForReporting()));
    break;
  }
  case 'phase-plan-index': {
    process.stdout.write(JSON.stringify(getPhasePlanIndexData(rest[0] || '')));
    break;
  }
  case 'phases.list': {
    const result = listPhasesQuery(rest);
    if (typeof result === 'string') {
      process.stdout.write(result);
    } else {
      process.stdout.write(JSON.stringify(result));
    }
    break;
  }
  case 'phase.list-artifacts':
  case 'phase list-artifacts': {
    process.stdout.write(JSON.stringify(phaseListArtifacts(rest)));
    break;
  }
  case 'phase.list-plans':
  case 'phase list-plans': {
    process.stdout.write(JSON.stringify(phaseListPlans(rest)));
    break;
  }
  case 'subagent-executions': {
    const runs = filterSubagentExecutionRuns(rest);
    process.stdout.write(JSON.stringify({
      total: runs.length,
      running: runs.filter((run) => run.status === 'running').length,
      completed: runs.filter((run) => run.status === 'completed').length,
      failed: runs.filter((run) => run.status === 'failed').length,
      abandoned: runs.filter((run) => run.status === 'abandoned').length,
      runs,
    }));
    break;
  }
  case 'state.begin-phase': {
    const phaseIndex = rest.indexOf('--phase');
    const nameIndex = rest.indexOf('--name');
    const plansIndex = rest.indexOf('--plans');
    const phaseValue = phaseIndex >= 0 ? rest[phaseIndex + 1] : (rest[0] || '');
    const nameValue = nameIndex >= 0 ? rest[nameIndex + 1] : '';
    const plansValue = plansIndex >= 0 ? rest[plansIndex + 1] : '';
    updateStateForExecution(phaseValue, nameValue, plansValue);
    process.stdout.write(JSON.stringify({
      phase: phaseValue,
      phase_name: nameValue,
      total_plans_in_phase: plansValue,
      current_step: 'execute',
      updated: true,
    }));
    break;
  }
  case 'state.update': {
    const fieldName = rest[0] || '';
    const value = rest[1] || '';
    process.stdout.write(JSON.stringify(stateUpdateField(fieldName, value)));
    break;
  }
  case 'state.add-blocker': {
    process.stdout.write(JSON.stringify(stateAddBlocker(rest)));
    break;
  }
  case 'state.resolve-blocker': {
    process.stdout.write(JSON.stringify(stateResolveBlocker(rest)));
    break;
  }
  case 'state.add-decision': {
    process.stdout.write(JSON.stringify(stateAddDecision(rest)));
    break;
  }
  case 'state.advance-plan': {
    process.stdout.write(JSON.stringify(stateAdvancePlan(rest)));
    break;
  }
  case 'state.record-metric': {
    process.stdout.write(JSON.stringify(stateRecordMetric(rest)));
    break;
  }
  case 'state.validate': {
    process.stdout.write(JSON.stringify(stateValidate()));
    break;
  }
  case 'state.patch': {
    const patch = parseSimpleJsonArg(rest[0]);
    process.stdout.write(JSON.stringify(statePatchObject(patch)));
    break;
  }
  case 'state.add-roadmap-evolution': {
    process.stdout.write(JSON.stringify(stateAddRoadmapEvolution(rest)));
    break;
  }
  case 'state.milestone-switch': {
    process.stdout.write(JSON.stringify(stateMilestoneSwitch(rest)));
    break;
  }
  case 'scan-sessions': {
    process.stdout.write(JSON.stringify(buildScanSessionsPayload(rest)));
    break;
  }
  case 'extract-messages':
  case 'extract.messages': {
    process.stdout.write(JSON.stringify(extractMessages(rest)));
    break;
  }
  case 'profile-sample': {
    process.stdout.write(JSON.stringify(profileSample(rest)));
    break;
  }
  case 'profile-questionnaire': {
    process.stdout.write(JSON.stringify(profileQuestionnaire(rest)));
    break;
  }
  case 'write-profile': {
    process.stdout.write(JSON.stringify(writeProfile(rest)));
    break;
  }
  case 'generate-dev-preferences': {
    process.stdout.write(JSON.stringify(generateDevPreferences(rest)));
    break;
  }
  case 'generate-tasktronaut-profile':
  case 'generate-claude-profile': {
    process.stdout.write(JSON.stringify(generateTasktronautProfile(rest)));
    break;
  }
  case 'find-phase': {
    const phaseInfo = findPhaseDirectory(rest[0] || '');
    const roadmapPhase = phaseInfo.found ? null : parseRoadmapPhase(rest[0] || '');
    process.stdout.write(JSON.stringify({
      found: phaseInfo.found || !!roadmapPhase,
      directory: phaseInfo.found
        ? phaseInfo.phaseDir
        : roadmapPhase
          ? path.join('.planning', 'phases', normalizePhaseNumber(roadmapPhase.phase_number) + '-' + roadmapPhase.phase_slug)
          : null,
      phase_number: phaseInfo.normalized || (roadmapPhase ? normalizePhaseNumber(roadmapPhase.phase_number) : ''),
      phase_name: phaseInfo.phaseName || roadmapPhase?.phase_name || '',
      phase_slug: phaseInfo.phaseSlug || roadmapPhase?.phase_slug || '',
    }));
    break;
  }
  case 'phases.clear': {
    if (!rest.includes('--confirm')) {
      process.stdout.write(JSON.stringify({ cleared: false, error: '--confirm required' }));
      break;
    }
    const phasesDir = path.join(cwd, '.planning', 'phases');
    let removed = 0;
    if (exists(phasesDir, 'd')) {
      for (const name of fs.readdirSync(phasesDir)) {
        fs.rmSync(path.join(phasesDir, name), { recursive: true, force: true });
        removed++;
      }
    }
    process.stdout.write(JSON.stringify({ cleared: true, removed }));
    break;
  }
  case 'phases.archive':
  case 'phases archive': {
    process.stdout.write(JSON.stringify(phasesArchive(rest)));
    break;
  }
  case 'validate.health': {
    process.stdout.write(JSON.stringify(validateHealth(rest)));
    break;
  }
  case 'resolve-model': {
    const agentName = rest.find((arg) => !String(arg).startsWith('--')) || '';
    const model = getConfiguredAgentModel(agentName, 'claude-sonnet-4-6');
    process.stdout.write(rest.includes('--raw') ? model : JSON.stringify({ model }));
    break;
  }
  case 'check.decision-coverage-plan': {
    process.stdout.write(JSON.stringify(checkDecisionCoveragePlan(rest[0] || '', rest[1] || '')));
    break;
  }
  case 'check.decision-coverage-verify': {
    process.stdout.write(JSON.stringify(checkDecisionCoverageVerify(rest[0] || '', rest[1] || '')));
    break;
  }
  case 'git.push':
  case 'git-push':
  case 'push': {
    const allowBehindPush = rest.includes('--allow-behind-push');
    process.stdout.write(JSON.stringify(pushLocalAheadCommits({ allow_behind_push: allowBehindPush })));
    break;
  }
  case 'commit': {
    const rawMsg = rest[0];
    const amend = rest.includes('--amend');
    const hasExplicitMsg = rawMsg !== undefined && rawMsg !== '';
    const msg = hasExplicitMsg ? rawMsg : 'chore: gsd update';
    const pushAfterCommit = rest.includes('--push');
    const allowBehindPush = rest.includes('--allow-behind-push');
    const noVerify = rest.includes('--no-verify');
    const files = [];
    for (let i = 1; i < rest.length; i++) {
      if (rest[i] === '--files') continue;
      if (String(rest[i]).startsWith('--')) continue;
      files.push(rest[i]);
    }
    let committed = false;
    let commitError = null;
    let commitHash = null;
    try {
      if (files.length > 0) {
        const addRes = runGit(['add', '--', ...files], cwd);
        if (!addRes.ok) {
          process.stdout.write(JSON.stringify({
            committed: false,
            pushed: false,
            reason: 'git-add-failed',
            error: addRes.stderr || addRes.error || null,
          }));
          break;
        }
      }
      const commitArgs = ['commit'];
      if (amend) commitArgs.push('--amend');
      if (noVerify) commitArgs.push('--no-verify');
      if (amend && !hasExplicitMsg) {
        commitArgs.push('--no-edit');
      } else {
        commitArgs.push('-m', msg);
      }
      const commitRes = runGit(commitArgs, cwd);
      if (commitRes.ok) {
        committed = true;
        const hashRes = runGit(['rev-parse', '--short', 'HEAD'], cwd);
        commitHash = hashRes.ok ? (hashRes.stdout || null) : null;
      } else {
        commitError = commitRes.stderr || commitRes.stdout || commitRes.error || 'commit failed';
      }
    } catch { /* nothing to commit */ }
    const pushResult = (committed && pushAfterCommit)
      ? pushLocalAheadCommits({ allow_behind_push: allowBehindPush })
      : {
          ok: true,
          pushed: false,
          reason: committed ? 'local-commit-only' : 'no-commit-created',
        };
    process.stdout.write(JSON.stringify({
      committed,
      hash: commitHash,
      reason: committed ? 'committed' : (commitError || 'nothing-to-commit'),
      pushed: pushResult.pushed === true,
      push: pushResult,
      files,
      message: (amend && !hasExplicitMsg) ? null : msg,
    }));
    break;
  }
  case 'commit-to-subrepo': {
    const filesIndex = rest.indexOf('--files');
    const endIndex = filesIndex >= 0 ? filesIndex : rest.length;
    const knownFlags = new Set(['--force', '--amend', '--no-verify', '--no-push', '--push', '--allow-behind-push']);
    const messageArgs = rest.slice(0, endIndex).filter((arg) => !knownFlags.has(arg));
    const message = messageArgs.join(' ').trim();
    const files = filesIndex >= 0 ? rest.slice(filesIndex + 1).filter((arg) => !arg.startsWith('--')) : [];
    if (!message) {
      process.stdout.write(JSON.stringify({ committed: false, reason: 'commit message required' }));
      break;
    }
    const config = readConfig();
    const subRepos = Array.isArray(config.sub_repos) ? config.sub_repos : [];
    if (subRepos.length === 0) {
      process.stdout.write(JSON.stringify({ committed: false, reason: 'no sub_repos configured in .planning/config.json' }));
      break;
    }
    if (files.length === 0) {
      process.stdout.write(JSON.stringify({ committed: false, reason: '--files required for commit-to-subrepo' }));
      break;
    }
    let invalidFileReason = '';
    for (const file of files) {
      try {
        resolveProjectPath(file);
      } catch (error) {
        invalidFileReason = String(error && error.message ? error.message : error);
        break;
      }
    }
    if (invalidFileReason) {
      process.stdout.write(JSON.stringify({ committed: false, reason: invalidFileReason }));
      break;
    }
    const addResult = spawnSync('git', ['add', '--', ...files], { cwd, stdio: 'pipe', encoding: 'utf8' });
    if ((addResult.status || 0) !== 0) {
      process.stdout.write(JSON.stringify({ committed: false, reason: addResult.stderr || 'git add failed' }));
      break;
    }
    const noVerify = rest.includes('--no-verify');
    const amendSubrepo = rest.includes('--amend');
    const commitSubArgs = ['commit'];
    if (amendSubrepo) commitSubArgs.push('--amend');
    if (noVerify) commitSubArgs.push('--no-verify');
    commitSubArgs.push('-m', message);
    const commitResult = spawnSync('git', commitSubArgs, { cwd, stdio: 'pipe', encoding: 'utf8' });
    if ((commitResult.status || 0) !== 0) {
      const reason = (commitResult.stderr || commitResult.stdout || 'commit failed').trim();
      process.stdout.write(JSON.stringify({ committed: false, reason }));
      break;
    }
    const hashResult = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd, stdio: 'pipe', encoding: 'utf8' });
    const pushAfterCommit = rest.includes('--push') && !rest.includes('--no-push');
    const allowBehindPush = rest.includes('--allow-behind-push');
    const normalizedPushResult = pushAfterCommit
      ? pushLocalAheadCommits({ allow_behind_push: allowBehindPush })
      : { ok: true, pushed: false, reason: 'local-commit-only' };
    process.stdout.write(JSON.stringify({
      committed: true,
      hash: ((hashResult.stdout || '').trim() || null),
      message,
      files,
      pushed: normalizedPushResult.pushed === true,
      push: normalizedPushResult,
    }));
    break;
  }
  case 'gap-analysis': {
    const phaseDirIndex = rest.indexOf('--phase-dir');
    const phaseDir = phaseDirIndex >= 0 ? rest[phaseDirIndex + 1] : '';
    if (!phaseDir) {
      process.stdout.write(JSON.stringify({ error: 'Usage: gap-analysis --phase-dir <path-to-phase-directory>' }));
      break;
    }
    process.stdout.write(JSON.stringify(runGapAnalysis(phaseDir)));
    break;
  }
  case 'config-new-project': {
    const dir = path.join(cwd, '.planning');
    if (!exists(dir, 'd')) fs.mkdirSync(dir, { recursive: true });
    try { fs.writeFileSync(path.join(dir, 'config.json'), rest[0] || '{}', 'utf8'); } catch { }
    break;
  }
  case 'config-set': {
    const cfgPath = path.join(cwd, '.planning', 'config.json');
    try {
      if (!exists(path.join(cwd, '.planning'), 'd')) fs.mkdirSync(path.join(cwd, '.planning'), { recursive: true });
      const cfg = exists(cfgPath, 'f') ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
      const keys = (rest[0] || '').split('.');
      let obj = cfg;
      for (let i = 0; i < keys.length - 1; i++) { if (!obj[keys[i]]) obj[keys[i]] = {}; obj = obj[keys[i]]; }
      const v = rest[1]; obj[keys[keys.length - 1]] = v === 'true' ? true : v === 'false' ? false : v;
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
    } catch { }
    break;
  }
  case 'config-get': {
    const key = rest[0] || '';
    const raw = rest.includes('--raw');
    const defaultIndex = rest.indexOf('--default');
    const defaultValue = defaultIndex >= 0 ? parseDefaultValue(rest[defaultIndex + 1]) : undefined;
    const value = getConfigValue(key, defaultValue);
    process.stdout.write(raw ? formatScalar(value) : formatScalar(value));
    break;
  }
  case 'roadmap.update-plan-progress': {
    const phaseIdx = rest.indexOf('--phase');
    const phaseValue = phaseIdx >= 0 ? rest[phaseIdx + 1] : (rest.find((arg) => !String(arg).startsWith('--')) || '');
    process.stdout.write(JSON.stringify(updateRoadmapPlanProgress(phaseValue)));
    break;
  }
  case 'generate-tasktronaut-md':
  case 'generate-claude-md': {
    let out = 'TASKTRONAUT.md';
    for (let i = 0; i < rest.length; i++) { if (rest[i] === '--output' && rest[i+1]) { out = rest[i+1]; i++; } }
    if (!exists(path.join(cwd, out), 'f')) {
      fs.writeFileSync(path.join(cwd, out), '# Project Guide\\n\\nGSD workflow active. Use /gsd-next to advance.\\n\\nSee \`.planning/\` for project state.\\n', 'utf8');
    }
    break;
  }
  case 'roadmap.get-phase': {
    const phase = rest[0] || '1';
    const pickIndex = rest.indexOf('--pick');
    const pick = pickIndex >= 0 ? rest[pickIndex + 1] : '';
    const raw = rest.includes('--raw');
    const roadmapPhase = parseRoadmapPhase(phase);
    if (!roadmapPhase) {
      process.stdout.write(pick === 'section' ? '' : JSON.stringify({ found: false, phase_number: phase, phase_name: null, goal: null, section: null }));
      break;
    }
    if (pick === 'section') {
      process.stdout.write(roadmapPhase.section || '');
      break;
    }
    const payload = {
      found: true,
      phase_number: roadmapPhase.phase_number,
      phase_name: roadmapPhase.phase_name,
      goal: roadmapPhase.goal,
      section: roadmapPhase.section,
      success_criteria: roadmapPhase.success_criteria || [],
    };
    process.stdout.write(raw ? JSON.stringify(payload, null, 2) : JSON.stringify(payload));
    break;
  }
  case 'roadmap.analyze': {
    process.stdout.write(JSON.stringify(analyzeRoadmap()));
    break;
  }
  case 'frontmatter.get': {
    const fieldFlagIndex = rest.indexOf('--field');
    const field = fieldFlagIndex >= 0 ? rest[fieldFlagIndex + 1] : rest[1];
    process.stdout.write(JSON.stringify(frontmatterGet(rest[0] || '', field)));
    break;
  }
  case 'frontmatter.set': {
    process.stdout.write(JSON.stringify(frontmatterSetQuery(rest)));
    break;
  }
  case 'frontmatter.merge': {
    process.stdout.write(JSON.stringify(frontmatterMergeQuery(rest)));
    break;
  }
  case 'frontmatter.validate': {
    process.stdout.write(JSON.stringify(frontmatterValidateQuery(rest)));
    break;
  }
  case 'uat.render-checkpoint': {
    const raw = rest.includes('--raw');
    const payload = renderUatCheckpoint(rest);
    if (raw && !payload.error && payload.checkpoint) {
      process.stdout.write(payload.checkpoint);
      break;
    }
    process.stdout.write(JSON.stringify(payload));
    break;
  }
  case 'audit-open': {
    const jsonOnly = rest.includes('--json');
    const payload = auditOpenArtifacts();
    if (jsonOnly) {
      process.stdout.write(JSON.stringify(payload));
    } else {
      process.stdout.write(JSON.stringify({ ...payload, report: formatAuditReport(payload) }));
    }
    break;
  }
  case 'route.next-action': {
    process.stdout.write(JSON.stringify(buildRouteNextActionPayload()));
    break;
  }
  case 'detect.phase-type': {
    process.stdout.write(JSON.stringify(buildDetectPhaseTypePayload(rest[0] || '')));
    break;
  }
  case 'workstream.get': {
    process.stdout.write(JSON.stringify(buildWorkstreamGetPayload()));
    break;
  }
  case 'workstream.list': {
    process.stdout.write(JSON.stringify(buildWorkstreamListPayload()));
    break;
  }
  case 'workstream.create': {
    process.stdout.write(JSON.stringify(buildWorkstreamCreatePayload(rest[0] || '')));
    break;
  }
  case 'workstream.set': {
    process.stdout.write(JSON.stringify(buildWorkstreamSetPayload(rest[0] || '')));
    break;
  }
  case 'workstream.status': {
    process.stdout.write(JSON.stringify(buildWorkstreamStatusPayload(rest[0] || '')));
    break;
  }
  case 'workstream.complete': {
    process.stdout.write(JSON.stringify(buildWorkstreamCompletePayload(rest[0] || '')));
    break;
  }
  case 'workstream.progress': {
    process.stdout.write(JSON.stringify(buildWorkstreamProgressPayload()));
    break;
  }
  case 'check.phase-ready': {
    process.stdout.write(JSON.stringify(buildPhaseReadyPayload(rest[0] || '')));
    break;
  }
  case 'check.config-gates': {
    process.stdout.write(JSON.stringify(buildCheckConfigGatesPayload(rest[0] || null)));
    break;
  }
  case 'check.completion': {
    process.stdout.write(JSON.stringify(buildCheckCompletionPayload(rest[0] || '', rest[1] || '')));
    break;
  }
  case 'check.gates': {
    process.stdout.write(JSON.stringify(buildCheckGatesPayload(rest)));
    break;
  }
  case 'check.verification-status': {
    process.stdout.write(JSON.stringify(buildCheckVerificationStatusPayload(rest[0] || '')));
    break;
  }
  case 'check.ship-ready': {
    process.stdout.write(JSON.stringify(buildCheckShipReadyPayload(rest[0] || '')));
    break;
  }
  case 'check': {
    if (rest[0] === 'auto-mode') {
      const config = readConfig();
      const pickIndex = rest.indexOf('--pick');
      const pick = pickIndex >= 0 ? rest[pickIndex + 1] : '';
      const payload = {
        auto_chain_active: config.workflowDefaults.auto_chain_active,
        auto_advance: config.workflowDefaults.auto_advance,
      };
      process.stdout.write(pick ? formatScalar(payload[pick]) : JSON.stringify(payload));
      break;
    }
    if (rest[0] === 'config-gates') {
      process.stdout.write(JSON.stringify(buildCheckConfigGatesPayload(rest[1] || null)));
      break;
    }
    if (rest[0] === 'phase-ready') {
      process.stdout.write(JSON.stringify(buildPhaseReadyPayload(rest[1] || '')));
      break;
    }
    if (rest[0] === 'completion') {
      process.stdout.write(JSON.stringify(buildCheckCompletionPayload(rest[1] || '', rest[2] || '')));
      break;
    }
    if (rest[0] === 'gates') {
      process.stdout.write(JSON.stringify(buildCheckGatesPayload(rest.slice(1))));
      break;
    }
    if (rest[0] === 'verification-status') {
      process.stdout.write(JSON.stringify(buildCheckVerificationStatusPayload(rest[1] || '')));
      break;
    }
    if (rest[0] === 'ship-ready') {
      process.stdout.write(JSON.stringify(buildCheckShipReadyPayload(rest[1] || '')));
      break;
    }
    process.stdout.write('');
    break;
  }
  case 'state.load': {
    const payload = buildStateLoadPayload();
    if (rest.includes('--raw')) {
      const config = payload.config || {};
      const rawLines = [
        'model_profile=' + formatScalar(config.model_profile),
        'commit_docs=' + formatScalar(config.commit_docs),
        'branching_strategy=' + formatScalar((config.git || {}).branching_strategy),
        'phase_branch_template=' + formatScalar((config.git || {}).phase_branch_template),
        'milestone_branch_template=' + formatScalar((config.git || {}).milestone_branch_template),
        'parallelization=' + formatScalar(config.parallelization),
        'research=' + formatScalar((config.workflow || {}).research),
        'plan_checker=' + formatScalar((config.workflow || {}).plan_check),
        'verifier=' + formatScalar((config.workflow || {}).verifier),
        'config_exists=' + formatScalar(payload.config_exists),
        'roadmap_exists=' + formatScalar(payload.roadmap_exists),
        'state_exists=' + formatScalar(payload.state_exists),
      ];
      process.stdout.write(rawLines.join('\\n'));
      break;
    }
    process.stdout.write(JSON.stringify(payload));
    break;
  }
  case 'state.json': {
    process.stdout.write(JSON.stringify(buildStateJsonPayload()));
    break;
  }
  case 'state-snapshot': {
    process.stdout.write(JSON.stringify(parseStateSnapshotData()));
    break;
  }
  case 'progress':
  case 'progress.json': {
    process.stdout.write(JSON.stringify(buildProgressJsonPayload()));
    break;
  }
  case 'progress.table': {
    const payload = progressTable();
    process.stdout.write(rest.includes('--raw') ? payload.rendered : JSON.stringify(payload));
    break;
  }
  case 'progress.bar': {
    const payload = buildProgressBarPayload();
    process.stdout.write(rest.includes('--raw') ? payload.bar : JSON.stringify(payload));
    break;
  }
  case 'stats':
  case 'stats.json': {
    process.stdout.write(JSON.stringify(buildStatsJsonPayload()));
    break;
  }
  case 'stats.table': {
    const payload = buildStatsJsonPayload();
    const barWidth = 10;
    const filled = Math.round((Number(payload.percent || 0) / 100) * barWidth);
    const bar = '[' + '█'.repeat(filled) + '░'.repeat(barWidth - filled) + ']';
    const lines = [];
    lines.push('# ' + (payload.milestone_version || '') + ' ' + (payload.milestone_name || '') + ' — Statistics');
    lines.push('');
    lines.push('**Progress:** ' + bar + ' ' + payload.phases_completed + '/' + payload.phases_total + ' phases (' + payload.percent + '%)');
    if (Number(payload.total_plans || 0) > 0) {
      lines.push('**Plans:** ' + payload.total_summaries + '/' + payload.total_plans + ' complete (' + payload.plan_percent + '%)');
    }
    lines.push('**Phases:** ' + payload.phases_completed + '/' + payload.phases_total + ' complete');
    if (Number(payload.requirements_total || 0) > 0) {
      lines.push('**Requirements:** ' + payload.requirements_complete + '/' + payload.requirements_total + ' complete');
    }
    lines.push('');
    lines.push('| Phase | Name | Plans | Completed | Status |');
    lines.push('|-------|------|-------|-----------|--------|');
    for (const phase of Array.isArray(payload.phases) ? payload.phases : []) {
      lines.push('| ' + phase.number + ' | ' + phase.name + ' | ' + phase.plans + ' | ' + phase.summaries + ' | ' + phase.status + ' |');
    }
    if (Number(payload.git_commits || 0) > 0) {
      lines.push('');
      lines.push('**Git:** ' + payload.git_commits + ' commits' + (payload.git_first_commit_date ? ' (since ' + payload.git_first_commit_date + ')' : ''));
    }
    if (payload.last_activity) {
      lines.push('**Last activity:** ' + payload.last_activity);
    }
    process.stdout.write(lines.join('\\n'));
    break;
  }
  case 'config-path': {
    process.stdout.write(JSON.stringify(configPath()));
    break;
  }
  case 'config-set-model-profile': {
    process.stdout.write(JSON.stringify(configSetModelProfile(rest[0] || '')));
    break;
  }
  case 'plan.task-structure': {
    process.stdout.write(JSON.stringify(planTaskStructure(rest[0] || '')));
    break;
  }
  case 'skill-manifest': {
    process.stdout.write(JSON.stringify(skillManifest(rest)));
    break;
  }
  case 'state.planned-phase': {
    const phaseIndex = rest.indexOf('--phase');
    const nameIndex = rest.indexOf('--name');
    const plansIndex = rest.indexOf('--plans');
    const phaseValue = phaseIndex >= 0 ? rest[phaseIndex + 1] : '';
    const nameValue = nameIndex >= 0 ? rest[nameIndex + 1] : '';
    const plansValue = plansIndex >= 0 ? rest[plansIndex + 1] : '';
    updateStateForExecution(phaseValue, nameValue, plansValue);
    break;
  }
  case 'verify.key-links': {
    const planFilePath = rest[0];
    if (!planFilePath) {
      process.stdout.write(JSON.stringify({ error: 'plan file path required' }));
      break;
    }
    try {
      const fullPath = resolveProjectPath(planFilePath);
      const content = fs.readFileSync(fullPath, 'utf8');
      const keyLinks = extractKeyLinks(content);
      if (keyLinks.length === 0) {
        process.stdout.write(JSON.stringify({ error: 'No must_haves.key_links found in frontmatter', path: planFilePath }));
        break;
      }
      const links = keyLinks.map((link) => {
        let sourceContent = '';
        let targetContent = '';
        try { sourceContent = link.from ? fs.readFileSync(resolveProjectPath(link.from), 'utf8') : ''; } catch {}
        try { targetContent = link.to ? fs.readFileSync(resolveProjectPath(link.to), 'utf8') : ''; } catch {}
        let verified = false;
        let detail = '';
        if (!sourceContent) {
          detail = 'Source file not found';
        } else if (link.pattern) {
          let regex = null;
          try { regex = new RegExp(link.pattern); } catch { regex = new RegExp(link.pattern.replace(/[.*+?^$(){}|[\\]\\\\]/g, '\\\\$&')); }
          if (regex.test(sourceContent)) {
            verified = true;
            detail = 'Pattern found in source';
          } else if (targetContent && regex.test(targetContent)) {
            verified = true;
            detail = 'Pattern found in target';
          } else {
            detail = 'Pattern not found in source or target';
          }
        } else if (link.to && sourceContent.includes(link.to)) {
          verified = true;
          detail = 'Target referenced in source';
        } else {
          detail = 'Target not referenced in source';
        }
        return {
          from: link.from || '',
          to: link.to || '',
          via: link.via || '',
          verified,
          detail,
        };
      });
      const verifiedCount = links.filter((link) => link.verified).length;
      process.stdout.write(JSON.stringify({
        all_verified: verifiedCount === links.length,
        verified: verifiedCount,
        total: links.length,
        links,
      }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ error: String(error && error.message ? error.message : error), path: planFilePath }));
    }
    break;
  }
  case 'verify.artifacts': {
    const planFilePath = rest[0];
    if (!planFilePath) {
      process.stdout.write(JSON.stringify({ error: 'plan file path required' }));
      break;
    }
    process.stdout.write(JSON.stringify(verifyArtifactsForPlan(planFilePath)));
    break;
  }
  case 'verify.schema-drift': {
    const phaseValue = rest[0] || '';
    const phaseData = getPhasePlanIndexData(phaseValue);
    if (!phaseData.phase_dir) {
      process.stdout.write(JSON.stringify({
        drift_detected: false,
        blocking: false,
        schema_files: [],
        orms: [],
        unpushed_orms: [],
        skipped: true,
        message: 'Phase directory not found',
      }));
      break;
    }
    const changedFiles = [];
    for (const plan of phaseData.plans || []) {
      for (const filePath of Array.isArray(plan.files_modified) ? plan.files_modified : []) {
        changedFiles.push(String(filePath));
      }
    }
    let executionLog = '';
    const phaseAbs = path.join(cwd, phaseData.phase_dir);
    for (const summaryFile of phaseData.summary_files || []) {
      try {
        executionLog += fs.readFileSync(path.join(phaseAbs, summaryFile), 'utf8') + '\\n';
      } catch {}
    }
    executionLog += '\\n' + readRecentCommitMessages(cwd, 50);
    const skipCheck = String(process.env.GSD_SKIP_SCHEMA_CHECK || '').toLowerCase() === 'true';
    const result = checkSchemaDrift(changedFiles, executionLog, { skipCheck });
    process.stdout.write(JSON.stringify({
      drift_detected: result.driftDetected,
      blocking: result.blocking,
      schema_files: result.schemaFiles,
      orms: result.orms,
      unpushed_orms: result.unpushedOrms,
      skipped: result.skipped || false,
      message: result.message,
    }));
    break;
  }
  case 'verify.codebase-drift': {
    const codebaseDir = path.join(cwd, '.planning', 'codebase');
    const structurePath = path.join(codebaseDir, 'STRUCTURE.md');
    if (!exists(structurePath, 'f')) {
      process.stdout.write(JSON.stringify(buildSkippedCodebaseDrift('no-structure-md')));
      break;
    }
    let structureMd = '';
    try {
      structureMd = fs.readFileSync(structurePath, 'utf8');
    } catch (error) {
      process.stdout.write(JSON.stringify(buildSkippedCodebaseDrift('cannot-read-structure-md: ' + String(error && error.message ? error.message : error))));
      break;
    }
    const revProbe = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' });
    if (revProbe.status !== 0) {
      process.stdout.write(JSON.stringify(buildSkippedCodebaseDrift('not-a-git-repo')));
      break;
    }
    const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    const lastMapped = readMappedCommit(structurePath);
    let base = lastMapped || EMPTY_TREE;
    if (lastMapped) {
      const verify = spawnSync('git', ['cat-file', '-t', lastMapped], { cwd, encoding: 'utf8' });
      if (verify.status !== 0) {
        base = EMPTY_TREE;
      }
    }
    const diff = spawnSync('git', ['diff', '--name-status', base, 'HEAD'], { cwd, encoding: 'utf8' });
    if (diff.status !== 0) {
      process.stdout.write(JSON.stringify(buildSkippedCodebaseDrift('git-diff-failed')));
      break;
    }
    const added = [];
    const modified = [];
    const deleted = [];
    for (const line of String(diff.stdout || '').split(/\\r?\\n/)) {
      if (!line.trim()) continue;
      const match = line.match(/^([A-Z])\\d*\\t(.+?)(?:\\t(.+))?$/);
      if (!match) continue;
      const status = match[1];
      const filePath = match[3] || match[2];
      if (status === 'A' || status === 'R' || status === 'C') added.push(filePath);
      else if (status === 'M') modified.push(filePath);
      else if (status === 'D') deleted.push(filePath);
    }
    const configuredThreshold = getConfigValue('workflow.drift_threshold', 3);
    const threshold = Number.isInteger(configuredThreshold) && configuredThreshold >= 1
      ? configuredThreshold
      : 3;
    const action = getConfigValue('workflow.drift_action', 'warn') === 'auto-remap' ? 'auto-remap' : 'warn';
    const result = detectCodebaseDrift({
      addedFiles: added,
      modifiedFiles: modified,
      deletedFiles: deleted,
      structureMd,
      threshold,
      action,
    });
    process.stdout.write(JSON.stringify({
      skipped: !!result.skipped,
      reason: result.reason || null,
      action_required: !!result.actionRequired,
      directive: result.directive,
      spawn_mapper: !!result.spawnMapper,
      affected_paths: result.affectedPaths || [],
      elements: result.elements || [],
      threshold,
      action,
      last_mapped_commit: lastMapped,
      message: result.message || '',
    }));
    break;
  }
  case 'phase.complete': {
    const phaseValue = rest[0] || '';
    if (!phaseValue) {
      process.stdout.write(JSON.stringify({ error: 'phase number required for phase complete' }));
      break;
    }
    const phaseData = getPhasePlanIndexData(phaseValue);
    const phaseInfo = findPhaseDirectory(phaseValue);
    const phaseNumber = phaseData.phase || normalizePhaseNumber(phaseValue);
    const planCount = (phaseData.plan_files || []).length;
    const summaryCount = (phaseData.summary_files || []).length;
    const today = new Date().toISOString().split('T')[0];
    const warnings = [];
    if (phaseData.phase_dir) {
      const phaseAbs = path.join(cwd, phaseData.phase_dir);
      for (const file of fs.readdirSync(phaseAbs).filter((name) => name.includes('-UAT') && name.endsWith('.md'))) {
        const content = fs.readFileSync(path.join(phaseAbs, file), 'utf8');
        if (/result:\\s*pending/i.test(content)) warnings.push(file + ': has pending tests');
        if (/result:\\s*blocked/i.test(content)) warnings.push(file + ': has blocked tests');
        if (/status:\\s*partial/i.test(content)) warnings.push(file + ': testing incomplete (partial)');
      }
      for (const file of fs.readdirSync(phaseAbs).filter((name) => name.includes('-VERIFICATION') && name.endsWith('.md'))) {
        const content = fs.readFileSync(path.join(phaseAbs, file), 'utf8');
        if (/status:\\s*human_needed/i.test(content)) warnings.push(file + ': needs human verification');
        if (/status:\\s*gaps_found/i.test(content)) warnings.push(file + ': has unresolved gaps');
      }
    }
    const roadmapUpdate = updateRoadmapPlanProgress(phaseValue);
    if (roadmapUpdate.updated) {
      const roadmapPath = path.join(cwd, '.planning', 'ROADMAP.md');
      let roadmapContent = fs.readFileSync(roadmapPath, 'utf8');
      roadmapContent = roadmapContent.split(/\\r?\\n/).map((line) => {
        const trimmed = line.trim();
        if (!/^-\s*\[[ x]\]\s+/i.test(trimmed)) return line;
        if (!new RegExp('Phase\\\\s+' + phaseNumber.replace(/[.*+?^$(){}|[\\]\\\\]/g, '\\\\$&') + '[:\\\\s]', 'i').test(line)) return line;
        if (/\\(completed\\s+\\d{4}-\\d{2}-\\d{2}\\)$/i.test(line)) {
          return line.replace(/\\(completed\\s+\\d{4}-\\d{2}-\\d{2}\\)$/i, '(completed ' + today + ')').replace(/\\[[ ]\\]/, '[x]');
        }
        return line.replace(/\\[[ ]\\]/, '[x]') + ' (completed ' + today + ')';
      }).join('\\n');
      fs.writeFileSync(roadmapPath, roadmapContent, 'utf8');
    }
    const requirementsPath = path.join(cwd, '.planning', 'REQUIREMENTS.md');
    let requirementsUpdated = false;
    if (exists(requirementsPath, 'f')) {
      const requirementIds = readPhaseRequirementIds(phaseValue);
      if (requirementIds.length > 0) {
        let requirementsContent = fs.readFileSync(requirementsPath, 'utf8');
        for (const requirementId of requirementIds) {
          const reqEscaped = requirementId.replace(/[.*+?^$(){}|[\\]\\\\]/g, '\\\\$&');
          requirementsContent = requirementsContent.replace(new RegExp('(-\\\\s*\\\\[)[ ](\\\\]\\\\s*\\\\*\\\\*' + reqEscaped + '\\\\*\\\\*)', 'gi'), '$1x$2');
          requirementsContent = requirementsContent.replace(new RegExp('(\\\\|\\\\s*' + reqEscaped + '\\\\s*\\\\|[^|]+\\\\|)\\\\s*(?:Pending|In Progress)\\\\s*(\\\\|)', 'gi'), '$1 Complete $2');
        }
        fs.writeFileSync(requirementsPath, requirementsContent, 'utf8');
        requirementsUpdated = true;
      }
    }
    const nextPhase = findNextPhaseInfo(phaseNumber);
    const statePath = path.join(cwd, '.planning', 'STATE.md');
    let stateUpdated = false;
    if (exists(statePath, 'f')) {
      let stateContent = fs.readFileSync(statePath, 'utf8');
      stateContent = upsertLine(stateContent, 'current_phase', nextPhase ? nextPhase.phase : phaseNumber);
      stateContent = upsertLine(stateContent, 'current_phase_name', nextPhase ? nextPhase.name : (phaseInfo?.phaseName || ''));
      stateContent = upsertLine(stateContent, 'current_step', nextPhase ? 'plan' : 'complete');
      stateContent = upsertLine(stateContent, 'last_activity', new Date().toISOString());
      fs.writeFileSync(statePath, stateContent, 'utf8');
      stateUpdated = true;
    }
    process.stdout.write(JSON.stringify({
      completed_phase: phaseNumber,
      phase_name: phaseInfo?.phaseName || null,
      plans_executed: summaryCount + '/' + planCount,
      next_phase: nextPhase ? nextPhase.phase : null,
      next_phase_name: nextPhase ? nextPhase.name : null,
      is_last_phase: !nextPhase,
      date: today,
      roadmap_updated: roadmapUpdate.updated === true,
      state_updated: stateUpdated,
      requirements_updated: requirementsUpdated,
      warnings,
      has_warnings: warnings.length > 0,
    }));
    break;
  }
  case 'phase.add': {
    const description = rest.join(' ').trim();
    process.stdout.write(JSON.stringify(phaseAdd(description)));
    break;
  }
  case 'phase.add-batch':
  case 'phase add-batch': {
    process.stdout.write(JSON.stringify(phaseAddBatch(rest)));
    break;
  }
  case 'phase.insert': {
    const afterPhase = rest[0] || '';
    const description = rest.slice(1).join(' ').trim();
    process.stdout.write(JSON.stringify(phaseInsert(afterPhase, description)));
    break;
  }
  case 'phase.next-decimal':
  case 'phase next-decimal': {
    process.stdout.write(JSON.stringify(phaseNextDecimal(rest)));
    break;
  }
  case 'phase.scaffold':
  case 'phase scaffold': {
    process.stdout.write(JSON.stringify(phaseScaffold(rest)));
    break;
  }
  case 'phase.remove': {
    process.stdout.write(JSON.stringify(phaseRemove(rest)));
    break;
  }
  case 'milestone.complete': {
    process.stdout.write(JSON.stringify(milestoneComplete(rest)));
    break;
  }
  case 'learnings.copy': {
    process.stdout.write(JSON.stringify(learningsCopy()));
    break;
  }
  case 'learnings.list':
  case 'learnings list': {
    process.stdout.write(JSON.stringify(learningsList()));
    break;
  }
  case 'learnings.query':
  case 'learnings query': {
    process.stdout.write(JSON.stringify(learningsQuery(rest)));
    break;
  }
  case 'learnings.prune':
  case 'learnings prune': {
    process.stdout.write(JSON.stringify(learningsPrune(rest)));
    break;
  }
  case 'learnings.delete':
  case 'learnings delete': {
    process.stdout.write(JSON.stringify(learningsDelete(rest)));
    break;
  }
  case 'roadmap.annotate-dependencies': {
    process.stdout.write(JSON.stringify(annotateRoadmapDependencies(rest[0] || '')));
    break;
  }
  case 'list-todos':
  case 'list.todos': {
    process.stdout.write(JSON.stringify(listPendingTodos(rest[0] || null)));
    break;
  }
  case 'agent-skills': {
    process.stdout.write(getAgentSkillsBlock(rest[0] || ''));
    break;
  }
  case 'state.record-session': {
    process.stdout.write(JSON.stringify(recordStateSession(rest)));
    break;
  }
  case 'todo.match-phase': {
    process.stdout.write(JSON.stringify(todoMatchPhase(rest[0] || '')));
    break;
  }
  case 'help':
  case 'help.all': {
    const ref = [
      '=== gsd-sdk query — command reference ===',
      '',
      '── INIT (read project context) ───────────────────────────────',
      '  init.new-project                   scaffold + detect existing code',
      '  init.resume                        read project state for resuming',
      '  init.phase-op [N]                  phase context + agent status',
      '  init.plan-phase [N]                planner context for phase N',
      '  init.execute-phase [N]             executor context for phase N',
      '  init.verify-work                   verifier context',
      '  init.progress                      progress summary',
      '  init.map-project                   classify workspace (code/docs/empty)',
      '  init.map-codebase                  codebase mapping context',
      '  init.quick                         quick-task context',
      '  init.milestone-op                  milestone operation context',
      '  init.new-milestone                 new milestone init',
      '  init.new-workspace                 new workspace init',
      '  init.list-workspaces               list workspaces',
      '  init.remove-workspace              remove workspace',
      '  init.resume                        resume project state',
      '  init.todos                         todos context',
      '  init.ingest-docs                   doc ingestion context',
      '',
      '── STATE (read/write STATE.md) ───────────────────────────────',
      '  state.load                         read full state + config JSON',
      '  state.json                         compact state JSON',
      '  state.validate                     check STATE.md for issues',
      '  state.patch \'{"field":"value"}\'    set arbitrary fields',
      '  state.update-progress              recalculate progress from plans/summaries',
      '  state.sync [--verify]              sync state fields with disk reality',
      '  state.begin-phase --phase N        set current_phase=N, current_step=execute',
      '  state.planned-phase --phase N      set current_step=plan',
      '  state.advance-plan                 advance current_plan to next incomplete plan',
      '    [--phase N] [--current-plan ID]',
      '  state.add-decision TEXT            append decision to STATE.md',
      '    [--phase N] [--rationale TEXT]   (positional arg OR --text TEXT)',
      '  state.add-blocker TEXT             append blocker',
      '    [--phase N] [--reason TEXT]',
      '  state.resolve-blocker TEXT         mark blocker resolved',
      '  state.record-metric --key K --value V [--unit U]',
      '  state.record-session LABEL STOPPED_AT NEXT_STEP',
      '    (3 positional args)',
      '  state.add-roadmap-evolution        record roadmap change',
      '    --phase N --action ACT --note TXT [--after N] [--urgent]',
      '  state.milestone-switch --milestone ID --name NAME',
      '  state.signal-waiting               write WAITING.json signal',
      '    [--type TYPE] [--question Q] [--options A|B|C] [--phase N]',
      '  state.signal-resume                remove WAITING.json',
      '  state.prune                        prune stale state fields',
      '',
      '── ROADMAP ────────────────────────────────────────────────────',
      '  roadmap.analyze                    parse ROADMAP.md into JSON',
      '  roadmap.get-phase N                phase detail JSON',
      '  roadmap.update-plan-progress N     mark plan N complete in ROADMAP.md',
      '  roadmap.annotate-dependencies      annotate phase deps',
      '',
      '── PHASE ──────────────────────────────────────────────────────',
      '  phase.complete N                   mark phase N complete, advance STATE.md',
      '  phase.add --phase N --name NAME    add phase to ROADMAP.md',
      '  phase.insert --after N ...         insert phase after N',
      '  phase.remove --phase N             remove phase',
      '  phase.scaffold --phase N           create phase directory',
      '  phase.list-plans [N]               list plans for phase N',
      '  phase.list-artifacts [N]           list phase artifacts',
      '',
      '── PROGRESS ───────────────────────────────────────────────────',
      '  progress                           progress JSON',
      '  progress.bar [--raw]               ASCII progress bar',
      '  progress.table                     phase table',
      '',
      '── PLAN ───────────────────────────────────────────────────────',
      '  plan.task-structure FILE           parse plan file structure',
      '',
      '── COMMIT ─────────────────────────────────────────────────────',
      '  commit "message" [--files f1 f2]   git commit with optional file list',
      '  commit-to-subrepo "msg" --subrepo PATH [--files f1 f2]',
      '',
      '── CHECK / VERIFY ─────────────────────────────────────────────',
      '  check.phase-ready [N]              phase readiness check',
      '  check.completion                   task completion check',
      '  check.gates                        gate status',
      '  check.ship-ready                   ship-readiness check',
      '  check.config-gates                 config gate validation',
      '  check.verification-status          verify status',
      '  check.decision-coverage-verify     decision coverage',
      '  verify.artifacts [N]               artifact verification',
      '  verify.key-links                   key link verification',
      '  verify.schema-drift                schema drift check',
      '  verify.codebase-drift              codebase drift check',
      '',
      '── SECURITY ───────────────────────────────────────────────────',
      '  security.scan-for-secrets [--dir D] scan directory for secrets',
      '',
      '── GENERATE ───────────────────────────────────────────────────',
      '  generate-claude-md [--output F]    generate CLAUDE.md / instruction file',
      '',
      '── TODO ───────────────────────────────────────────────────────',
      '  todo.match-phase PHASE             match todos to phase',
      '  todo.complete ID                   mark todo complete',
      '',
      '── MISC ───────────────────────────────────────────────────────',
      '  route.next-action                  determine next GSD action',
      '  detect.phase-type [N]              detect phase type',
      '  frontmatter.get FILE KEY           get frontmatter field',
      '  frontmatter.set FILE KEY VALUE     set frontmatter field',
      '  frontmatter.merge FILE JSON        merge frontmatter',
      '  frontmatter.validate FILE          validate frontmatter',
      '  learnings.list                     list learnings',
      '  learnings.query TEXT               search learnings',
      '  learnings.copy --from F --to T     copy learnings',
      '  learnings.prune                    prune old learnings',
      '  learnings.delete ID                delete learning',
      '  workstream.list/get/create/set/status/complete/progress',
      '  uat.render-checkpoint              UAT checkpoint render',
      '  scan-sessions                      scan task sessions',
      '  extract.messages                   extract messages',
      '',
      '  gsd-sdk query help                 show this reference',
    ].join('\\n');
    process.stderr.write(ref + '\\n');
    process.exit(0);
    break;
  }
  default:
    process.stdout.write('');
    break;
}


`

const GSD_TOOLS_WRAPPER = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const command = args[0];
const cwd = process.cwd();
const graphPath = path.join(cwd, '.planning', 'graphs', 'graph.json');

function print(value) {
  process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

function collectStringMatches(value, query, location, results, budget) {
  if (results.length >= budget) return;
  if (typeof value === 'string') {
    if (value.toLowerCase().includes(query)) {
      results.push({ path: location || '$', value: value.slice(0, 300) });
    }
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length && results.length < budget; index++) {
      collectStringMatches(value[index], query, location + '[' + index + ']', results, budget);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (results.length >= budget) break;
      const nextLocation = location ? location + '.' + key : key;
      collectStringMatches(child, query, nextLocation, results, budget);
    }
  }
}

if (command === 'graphify' && args[1] === 'status') {
  if (!fs.existsSync(graphPath)) {
    print({ exists: false, stale: true, age_hours: null });
    process.exit(0);
  }
  const ageMs = Date.now() - fs.statSync(graphPath).mtimeMs;
  const ageHours = Number((ageMs / (1000 * 60 * 60)).toFixed(1));
  print({ exists: true, stale: ageHours > 24, age_hours: ageHours, path: '.planning/graphs/graph.json' });
  process.exit(0);
}

if (command === 'graphify' && args[1] === 'query') {
  if (!fs.existsSync(graphPath)) {
    print({ query: args[2] || '', results: [], note: 'graph.json not found' });
    process.exit(0);
  }

  const query = String(args[2] || '').toLowerCase();
  const budgetIndex = args.indexOf('--budget');
  const budget = budgetIndex >= 0 ? Math.max(1, Number(args[budgetIndex + 1] || 5)) : 5;
  const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
  const results = [];
  collectStringMatches(graph, query, '$', results, Math.min(budget, 10));
  print({ query: args[2] || '', results });
  process.exit(0);
}

if (command === 'gap-analysis') {
  const phaseDirIndex = args.indexOf('--phase-dir');
  const phaseDir = phaseDirIndex >= 0 ? args[phaseDirIndex + 1] : '';
  if (!phaseDir) {
    print('## Post-Planning Gap Analysis\\n\\nNo phase directory provided.');
    process.exit(0);
  }
  const configPath = path.join(cwd, '.planning', 'config.json');
  let enabled = true;
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (cfg && cfg.workflow && typeof cfg.workflow.post_planning_gaps === 'boolean') {
      enabled = cfg.workflow.post_planning_gaps;
    }
  } catch {}
  if (!enabled) {
    print('workflow.post_planning_gaps disabled - skipping post-planning gap analysis');
    process.exit(0);
  }
  function escapeRegex(value) {
    return String(value || '').replace(/[.*+?^$(){}|[\\]\\\\]/g, '\\\\$&');
  }
  function parseRequirements(content) {
    if (!content || typeof content !== 'string') return [];
    const out = [];
    const seen = new Set();
    const checkboxRe = /^\\s*-\\s*\\[[x ]\\]\\s*\\*\\*(REQ-[A-Za-z0-9_-]+)\\*\\*\\s*(.*)$/gm;
    let checkboxMatch = checkboxRe.exec(content);
    while (checkboxMatch) {
      const id = checkboxMatch[1];
      if (!seen.has(id)) {
        seen.add(id);
        out.push({ id, source: 'REQUIREMENTS.md' });
      }
      checkboxMatch = checkboxRe.exec(content);
    }
    const tableRe = /\\|\\s*(REQ-[A-Za-z0-9_-]+)\\s*\\|/g;
    let tableMatch = tableRe.exec(content);
    while (tableMatch) {
      const id = tableMatch[1];
      if (!seen.has(id)) {
        seen.add(id);
        out.push({ id, source: 'REQUIREMENTS.md' });
      }
      tableMatch = tableRe.exec(content);
    }
    return out;
  }
  function stripFences(content) {
    return String(content || '').replace(new RegExp('\\\\x60{3}[\\\\s\\\\S]*?\\\\x60{3}', 'g'), ' ').replace(/~~~[\\s\\S]*?~~~/g, ' ');
  }
  function parseDecisions(content) {
    const cleaned = stripFences(content);
    const matches = [...cleaned.matchAll(new RegExp('<decisions>([\\\\s\\\\S]*?)<\\\\/decisions>', 'g'))];
    if (matches.length === 0) return [];
    const block = matches.map((match) => match[1]).join('\\n\\n');
    const lines = block.split(/\\r?\\n/);
    const out = [];
    let inDiscretion = false;
    const nonTrackableTags = new Set(['informational', 'folded', 'deferred']);
    for (const line of lines) {
      const headingMatch = line.trim().match(/^###\\s+(.+?)\\s*$/);
      if (headingMatch) {
        const normalizedHeading = headingMatch[1].toLowerCase().replace(/[\\u2018\\u2019\\u201A\\u201B\\u201C\\u201D\\u201E\\u201F'"]/g, '').trim();
        inDiscretion = normalizedHeading === 'claudes discretion' || normalizedHeading === 'claude discretion';
        continue;
      }
      const decisionMatch = line.match(/^\\s*-\\s+\\*\\*(D-\\d+)(?:\\s*\\[([^\\]]+)\\])?\\s*:\\*\\*\\s*(.*)$/);
      if (!decisionMatch) continue;
      const tags = decisionMatch[2] ? decisionMatch[2].split(',').map((tag) => tag.trim().toLowerCase()).filter(Boolean) : [];
      if (inDiscretion || tags.some((tag) => nonTrackableTags.has(tag))) continue;
      out.push({ id: decisionMatch[1], source: 'CONTEXT.md' });
    }
    return out;
  }
  function naturalSortKey(value) {
    return String(value || '').replace(/(\\d+)/g, (_, digits) => digits.padStart(8, '0'));
  }
  const absPhaseDir = path.isAbsolute(phaseDir) ? phaseDir : path.join(cwd, phaseDir);
  const reqPath = path.join(cwd, '.planning', 'REQUIREMENTS.md');
  const requirements = fs.existsSync(reqPath) ? parseRequirements(fs.readFileSync(reqPath, 'utf8')) : [];
  const contextPath = path.join(absPhaseDir, 'CONTEXT.md');
  const decisions = fs.existsSync(contextPath) ? parseDecisions(fs.readFileSync(contextPath, 'utf8')) : [];
  const items = [...requirements, ...decisions];
  if (items.length === 0) {
    print('## Post-Planning Gap Analysis\\n\\nNo requirements or decisions to check.');
    process.exit(0);
  }
  let planText = '';
  try {
    const files = fs.existsSync(absPhaseDir) ? fs.readdirSync(absPhaseDir).filter((file) => /-PLAN\\.md$/.test(file)) : [];
    planText = files.map((file) => {
      try { return fs.readFileSync(path.join(absPhaseDir, file), 'utf8'); } catch { return ''; }
    }).join('\\n');
  } catch {}
  const rows = items.map((item) => {
    const regex = new RegExp('\\\\b' + escapeRegex(item.id) + '\\\\b');
    return { source: item.source, item: item.id, status: regex.test(planText) ? 'Covered' : 'Not covered' };
  }).sort((a, b) => {
    const sourceOrder = { 'REQUIREMENTS.md': 0, 'CONTEXT.md': 1 };
    const sourceDelta = (sourceOrder[a.source] || 99) - (sourceOrder[b.source] || 99);
    if (sourceDelta !== 0) return sourceDelta;
    return naturalSortKey(a.item).localeCompare(naturalSortKey(b.item));
  });
  const uncovered = rows.filter((row) => row.status === 'Not covered').length;
  const lines = [
    '## Post-Planning Gap Analysis',
    '',
    '| Source | Item | Status |',
    '|--------|------|--------|',
    ...rows.map((row) => '| ' + row.source + ' | ' + row.item + ' | ' + (row.status === 'Covered' ? '✓ Covered' : '✗ Not covered') + ' |'),
    '',
    uncovered === 0
      ? '✓ All ' + rows.length + ' items covered by plans'
      : '⚠ ' + uncovered + ' of ' + rows.length + ' items not covered by any plan',
  ];
  print(lines.join('\\n'));
  process.exit(0);
}

print({ error: 'Unsupported command', args });
`

function buildPowerShellNodeBridge(nodePath: string, jsFileName: string): string {
	const escapedNodePath = nodePath.replace(/'/g, "''")
	const escapedJsFileName = jsFileName.replace(/'/g, "''")

	return [
		`$ErrorActionPreference = 'Stop'`,
		`$scriptPath = Join-Path -Path $PSScriptRoot -ChildPath '${escapedJsFileName}'`,
		`$inputData = [Console]::In.ReadToEnd()`,
		`$inputData | & '${escapedNodePath}' $scriptPath @args`,
		`if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }`,
		`exit 0`,
	].join("\n")
}

function buildCmdNodeBridge(nodePath: string, jsFileName: string): string {
	const maybeNodePath = nodePath.replace(/\\/g, "\\\\")
	return (
		[
			`@echo off`,
			`set SCRIPT_DIR=%~dp0`,
			`where node >nul 2>nul`,
			`if %ERRORLEVEL%==0 (`,
			`  node "%SCRIPT_DIR%${jsFileName}" %*`,
			`) else (`,
			`  "${maybeNodePath}" "%SCRIPT_DIR%${jsFileName}" %*`,
			`)`,
		].join("\r\n") + "\r\n"
	)
}

function buildShellNodeBridge(nodePath: string, jsFileName: string): string {
	const escapedNodePath = nodePath.replace(/'/g, `'\\''`)
	const escapedJsFileName = jsFileName.replace(/'/g, `'\\''`)

	return (
		[
			`#!/bin/sh`,
			`SCRIPT_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"`,
			`if command -v node >/dev/null 2>&1; then`,
			`  exec node "$SCRIPT_DIR/${escapedJsFileName}" "$@"`,
			`fi`,
			`exec '${escapedNodePath}' "$SCRIPT_DIR/${escapedJsFileName}" "$@"`,
		].join("\n") + "\n"
	)
}

async function writeWorkspaceHookScript(hooksDir: string, hookName: string, scriptContent: string): Promise<void> {
	const hookPath = path.join(hooksDir, hookName)

	if (process.platform === "win32") {
		const jsPath = `${hookPath}.js`
		const ps1Path = `${hookPath}.ps1`

		await writeFile(jsPath, scriptContent, "utf8")
		await writeFile(ps1Path, buildPowerShellNodeBridge(process.execPath, path.basename(jsPath)), "utf8")
		return
	}

	await writeFile(hookPath, scriptContent, "utf8")
	await chmod(hookPath, 0o755)
}

async function writeWorkspaceCliScript(binDir: string, commandName: string, scriptContent: string): Promise<void> {
	const jsFileName = `${commandName}.js`
	const jsPath = path.join(binDir, jsFileName)
	await writeFile(jsPath, scriptContent, "utf8")

	if (process.platform === "win32") {
		await writeFile(path.join(binDir, `${commandName}.cmd`), buildCmdNodeBridge(process.execPath, jsFileName), "utf8")
		return
	}

	const launcherPath = path.join(binDir, commandName)
	await writeFile(launcherPath, buildShellNodeBridge(process.execPath, jsFileName), "utf8")
	await chmod(launcherPath, 0o755)
}

function hashManagedAsset(content: string): string {
	return createHash("sha256").update(content).digest("hex")
}

function buildGsdSdkShim(): string {
	return GSD_SDK_SHIM
}

type ManagedAssetRecord = {
	path: string
	sha256: string
	kind: "hook" | "agent" | "research-asset" | "cli" | "rules"
}

export function buildManagedAssetManifest(workspacePath: string): {
	version: 1
	generatedAt: string
	workspacePath: string
	assets: ManagedAssetRecord[]
} {
	const assets: ManagedAssetRecord[] = []
	const gsdSdkShim = buildGsdSdkShim()

	assets.push({
		path: ".tasktronautrules/gsd.md",
		sha256: hashManagedAsset(TASKTRONAUTRULES_TEMPLATE),
		kind: "rules",
	})

	const hooks: Array<[string, string]> = [
		["PreCompact", HOOK_PRE_COMPACT],
		["TaskStart", HOOK_TASK_START],
		["UserPromptSubmit", HOOK_USER_PROMPT_SUBMIT],
		["PostToolUse", HOOK_POST_TOOL_USE],
		["gsd-sdk", gsdSdkShim],
	]
	for (const [name, content] of hooks) {
		assets.push({
			path: path.join(".tasktronautrules", "hooks", process.platform === "win32" ? `${name}.js` : name),
			sha256: hashManagedAsset(content),
			kind: "hook",
		})
	}

	for (const agent of GSD_AGENTS) {
		assets.push({
			path: path.join(".tasktronaut", "agents", `${agent.name}.md`),
			sha256: hashManagedAsset(agent.content),
			kind: "agent",
		})
	}

	for (const asset of GSD_RESEARCH_ASSETS) {
		assets.push({
			path: path.join(".tasktronaut", asset.targetPath),
			sha256: hashManagedAsset(asset.content),
			kind: "research-asset",
		})
	}

	assets.push({
		path: path.join(".tasktronaut", "bin", "gsd-tools.js"),
		sha256: hashManagedAsset(GSD_TOOLS_WRAPPER),
		kind: "cli",
	})
	assets.push({
		path: path.join(".tasktronaut", "bin", "gsd-sdk.js"),
		sha256: hashManagedAsset(gsdSdkShim),
		kind: "cli",
	})

	return {
		version: 1,
		generatedAt: new Date().toISOString(),
		workspacePath,
		assets,
	}
}

export async function verifyManagedAssetManifest(
	workspacePath: string,
	manifest: ReturnType<typeof buildManagedAssetManifest>,
) {
	const mismatches: Array<{ path: string; expected: string; actual: string | null }> = []

	for (const asset of manifest.assets) {
		const absolutePath = path.join(workspacePath, asset.path)
		try {
			const content = await readFile(absolutePath, "utf8")
			const actual = hashManagedAsset(content)
			if (actual !== asset.sha256) {
				mismatches.push({ path: asset.path, expected: asset.sha256, actual })
			}
		} catch {
			mismatches.push({ path: asset.path, expected: asset.sha256, actual: null })
		}
	}

	return mismatches
}

export async function verifyManagedAssetsForWorkspace(workspacePath: string) {
	const manifest = buildManagedAssetManifest(workspacePath)
	const mismatches = await verifyManagedAssetManifest(workspacePath, manifest)
	return {
		workspacePath,
		assetCount: manifest.assets.length,
		mismatches,
		ok: mismatches.length === 0,
	}
}

const TASKTRONAUTRULES_TEMPLATE = `# GSD (Get Shit Done) Workflow v1.5
# Bundled with this extension. No external downloads required.

## gsd-sdk

gsd-sdk is bundled at \`.tasktronaut/bin/gsd-sdk\` (or \`.cmd\` on Windows).
Tasktronaut adds \`.tasktronaut/bin\` to terminal PATH for workspace tasks, so
\`gsd-sdk query ...\` should work without a separate global install.
If a shell cannot resolve \`gsd-sdk\`, run it explicitly as:
  .tasktronaut/bin/gsd-sdk query ...

## Runtime Constraints

The Task subagent spawning tool is NOT available in this runtime.
Use Tasktronaut's named subagent tools instead when available:
- \`use_subagent_gsd_codebase_mapper\`
- \`use_subagent_gsd_executor\`
- \`use_subagent_gsd_pattern_mapper\`
- \`use_subagent_gsd_planner\`
- \`use_subagent_gsd_plan_checker\`
- \`use_subagent_gsd_ui_researcher\`
- \`use_subagent_gsd_ui_checker\`
- \`use_subagent_gsd_security_auditor\`
- \`use_subagent_gsd_nyquist_auditor\`
- \`use_subagent_gsd_project_researcher\`
- \`use_subagent_gsd_research_synthesizer\`
- \`use_subagent_gsd_roadmapper\`
- \`use_subagent_gsd_phase_researcher\`
- \`use_subagent_gsd_verifier\`

When a workflow still calls generic \`Task(prompt="...", subagent_type="...")\`,
do NOT assume it works. Prefer the matching named Tasktronaut subagent tool
above. If no named tool is available, execute the step inline in the current
context window.

gsd-sdk continues to return \`task_tool_available: false\` because the generic
Claude-style Task API is not present, even though Tasktronaut-native named
subagent tools may be installed under \`.tasktronaut/agents\`.


## Overview
GSD is a spec-driven workflow for AI-assisted development.
It prevents context rot by using fresh context windows per execution phase.
State lives in .planning/ at the workspace root.

## Directory Convention
- .planning/PROJECT.md   — vision, goals, constraints
- .planning/ROADMAP.md   — phased delivery plan
- .planning/STATE.md     — current phase / step
- .planning/PLANS/       — XML task plans per phase
- .planning/SUMMARIES/   — phase completion summaries

## Slash Commands
When the user runs a /gsd-* command, execute the matching workflow below.
Do not apply GSD workflows unless the user explicitly invokes a /gsd-* command.

### /gsd-new-project
1. Ask discovery questions: goals, constraints, tech stack, timeline.
2. Write .planning/PROJECT.md with vision and constraints.
3. Write .planning/ROADMAP.md with 3-7 phases.
4. Write .planning/STATE.md: current_phase: 1, current_step: discuss.

### /gsd-discuss-phase
1. Read STATE.md for current phase.
2. Ask questions: approach, risks, acceptance criteria, dependencies.
3. Write decisions to .planning/PLANS/phase-N-decisions.md.
4. Update STATE.md: current_step: plan.

### /gsd-plan-phase
1. Read STATE.md, PROJECT.md, ROADMAP.md, and phase decisions.
2. Scan relevant source directories.
3. Write .planning/PLANS/phase-N.xml with tasks: id, description, files_affected, acceptance_criteria.
4. Update STATE.md: current_step: execute.

### /gsd-execute-phase
1. Read STATE.md and phase-N.xml plan.
2. Group independent tasks into waves; execute each wave.
3. Commit after each task: git commit -m "task(N.M): description".
4. Update STATE.md: current_step: verify on completion.

### /gsd-verify-work
1. Read acceptance criteria from phase-N.xml.
2. Verify each criterion is met.
3. On pass: write .planning/SUMMARIES/phase-N.md, advance STATE.md to next phase.
4. On fail: write fix plan and re-enter execute.

### /gsd-next
Read STATE.md and run the appropriate next /gsd-* command automatically.

### /gsd-quick
Run a single task outside the phase workflow. Commit as: quick: description.

## Tasktronaut Tool Mapping

\`AskUserQuestion\` is a Claude Code CLI tool that is NOT available in Tasktronaut.
Use \`ask_followup_question\` instead — it renders clickable option buttons in the UI.

**Single-question pattern** (workflow says \`Use AskUserQuestion: ...options\`):

\`\`\`xml
<ask_followup_question>
<question>Your question here?</question>
<options>["Option A", "Option B", "Option C"]</options>
</ask_followup_question>
\`\`\`

**Multi-question batch** (\`AskUserQuestion([{...}, {...}])\`): ask each question
sequentially as separate \`ask_followup_question\` calls.

**Options format**: use the \`label\` value only — drop \`description\` and \`header\` fields.
For simple string options (\`"Map codebase first"\`), use the string as-is.

## Rules
- Never skip discuss — decisions made here prevent rework.
- Plans are immutable once execution starts.
- One commit per task, no bundling.
- Verify against original acceptance criteria, not the implementation.
- On context pressure (>150k tokens), save STATE.md and open a fresh task.
`

const TASKTRONAUTRULES_TOOL_MAPPING_MARKER = "## Tasktronaut Tool Mapping"

export async function installGsdToWorkspace(workspacePath: string): Promise<void> {
	const tasktronautRulesDir = path.join(workspacePath, ".tasktronautrules")
	const hooksDir = path.join(tasktronautRulesDir, "hooks")
	const managedManifest = buildManagedAssetManifest(workspacePath)

	try {
		// Create .tasktronautrules/ and .tasktronautrules/hooks/ if needed
		await mkdir(hooksDir, { recursive: true })

		// Write the GSD rules file if absent, or patch it if it's missing the tool mapping section
		const gsdRulesPath = path.join(tasktronautRulesDir, "gsd.md")
		if (!existsSync(gsdRulesPath)) {
			await writeFile(gsdRulesPath, TASKTRONAUTRULES_TEMPLATE, "utf8")
			Logger.info("[GSD] Wrote .tasktronautrules/gsd.md")
		} else {
			const existing = await readFile(gsdRulesPath, "utf8")
			if (!existing.includes(TASKTRONAUTRULES_TOOL_MAPPING_MARKER) && existing.includes("## Rules\n")) {
				const toolMappingSection = `## Tasktronaut Tool Mapping

\`AskUserQuestion\` is a Claude Code CLI tool that is NOT available in Tasktronaut.
Use \`ask_followup_question\` instead — it renders clickable option buttons in the UI.

**Single-question pattern** (workflow says \`Use AskUserQuestion: ...options\`):

\`\`\`xml
<ask_followup_question>
<question>Your question here?</question>
<options>["Option A", "Option B", "Option C"]</options>
</ask_followup_question>
\`\`\`

**Multi-question batch** (\`AskUserQuestion([{...}, {...}])\`): ask each question
sequentially as separate \`ask_followup_question\` calls.

**Options format**: use the \`label\` value only — drop \`description\` and \`header\` fields.
For simple string options (\`"Map codebase first"\`), use the string as-is.

`
				const patched = existing.replace("## Rules\n", toolMappingSection + "## Rules\n")
				await writeFile(gsdRulesPath, patched, "utf8")
				Logger.info("[GSD] Patched .tasktronautrules/gsd.md with Tasktronaut tool mapping")
			}
		}

		// Write hook scripts and make them executable
		const gsdSdkShim = buildGsdSdkShim()
		const hooks: Array<[string, string]> = [
			["PreCompact", HOOK_PRE_COMPACT],
			["TaskStart", HOOK_TASK_START],
			["UserPromptSubmit", HOOK_USER_PROMPT_SUBMIT],
			["PostToolUse", HOOK_POST_TOOL_USE],
			["gsd-sdk", gsdSdkShim],
		]

		for (const [name, content] of hooks) {
			await writeWorkspaceHookScript(hooksDir, name, content)
		}

		Logger.info("[GSD] Installed GSD v1.5 hooks to .tasktronautrules/hooks/")

		const tasktronautDir = path.join(workspacePath, ".tasktronaut")
		const agentsDir = path.join(tasktronautDir, "agents")
		const binDir = path.join(tasktronautDir, "bin")

		// Install Tasktronaut-native agents and supporting research assets to .tasktronaut/.
		// These are managed extension assets, so refresh them on activation rather than
		// freezing the workspace at first install. That keeps the local gsd-sdk surface
		// and bundled workflow docs aligned with the currently installed extension version.
		await mkdir(agentsDir, { recursive: true })
		await mkdir(binDir, { recursive: true })
		for (const agent of GSD_AGENTS) {
			const agentPath = path.join(agentsDir, `${agent.name}.md`)
			await writeFile(agentPath, agent.content, "utf8")
		}
		for (const asset of GSD_RESEARCH_ASSETS) {
			const assetPath = path.join(tasktronautDir, asset.targetPath)
			await mkdir(path.dirname(assetPath), { recursive: true })
			await writeFile(assetPath, asset.content, "utf8")
		}
		await writeWorkspaceCliScript(binDir, "gsd-tools", GSD_TOOLS_WRAPPER)
		await writeWorkspaceCliScript(binDir, "gsd-sdk", gsdSdkShim)
		const manifestPath = path.join(tasktronautDir, "managed-manifest.json")
		await writeFile(manifestPath, JSON.stringify(managedManifest, null, 2) + "\n", "utf8")
		const mismatches = await verifyManagedAssetManifest(workspacePath, managedManifest)
		if (mismatches.length > 0) {
			Logger.warn(
				`[GSD] Managed asset verification mismatch after install: ${mismatches
					.slice(0, 5)
					.map((mismatch) => mismatch.path)
					.join(", ")}`,
			)
		} else {
			Logger.info(`[GSD] Managed asset manifest verified (${managedManifest.assets.length} assets)`)
		}
		Logger.info("[GSD] Installed Tasktronaut agents and research assets to .tasktronaut/")
	} catch (error) {
		Logger.warn(`[GSD] Failed to install GSD Tasktronaut rules: ${error instanceof Error ? error.message : String(error)}`)
	}
}
